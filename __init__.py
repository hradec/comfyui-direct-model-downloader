"""Frontend helper for downloading missing models directly from the dialog."""

from __future__ import annotations

import asyncio
import errno
import importlib.resources
import json
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from aiohttp import ClientSession, ClientTimeout, web
import requests
from urllib.parse import urlparse

import app.logger
import folder_paths
from folder_paths import folder_names_and_paths
from tqdm.auto import tqdm

NODE_CLASS_MAPPINGS: dict[str, Any] = {}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, Any] = {}
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

_ROUTE_PATH = "/internal/download_model"
_BACKEND_REGISTERED = False

# Hugging Face hosts that may require a private/gated-model token.
_HF_HOSTS = ("huggingface.co", "hf.co")


def _auth_headers(url: str) -> dict[str, str]:
    """Return request headers for this URL.

    A Hugging Face download needs `Authorization: Bearer $HF_TOKEN` for private
    or gated repositories. The token is attached only to Hugging Face hosts so it
    can never leak to an arbitrary download URL. Without `HF_TOKEN` set in the
    ComfyUI server environment the downloads behave exactly as before.
    """

    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        return {}

    host = (urlparse(url).hostname or "").lower()
    if not any(host == domain or host.endswith(f".{domain}") for domain in _HF_HOSTS):
        return {}

    app.logger.logging.info("Using HF_TOKEN from the environment for %s", host)
    return {"Authorization": f"Bearer {token}"}


# --- model disk manager -----------------------------------------------------------
# Keeps the model folders from filling the filesystem. Only models whose download url
# we know are eviction candidates, and they go least-recently-used first.
# ponytail: "used" is the filesystem atime (this NFS mount is relatime, so it moves at
# most once a day) plus the plugin's own records where those are newer. A per-load hook
# inside ComfyUI path resolution would be exact but means monkeypatching core lookup.
_MODEL_URLS_PATH = Path(__file__).with_name("model_urls.json")
_MODEL_DISK_LOG_PATH = Path(__file__).with_name("model_disk_log.json")
_DISK_ROUTE = "/internal/model_disk"
_GIB = 1024 ** 3
_MIN_FREE_GB = float(os.environ.get("DIRECT_MODEL_MIN_FREE_GB", "100"))
_GRACE_DAYS = float(os.environ.get("DIRECT_MODEL_GRACE_DAYS", "7"))
_AUTOPRUNE = os.environ.get("DIRECT_MODEL_AUTOPRUNE", "1") != "0"
_MODEL_SUFFIXES = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx", ".npz", ".pkl"}
_SKIPPED_DIR_NAMES = {".cache", ".git", "__pycache__"}
_TEMPLATE_PACKAGES = ("comfyui_workflow_templates_json",)
_DISK_LOG_LIMIT = 500
_registry_seeded = False


def _load_url_registry() -> dict[str, Any]:
    """Read the saved url table, keyed "directory/filename" -> {url, source, size, seen}."""
    if not _MODEL_URLS_PATH.exists():
        return {}

    try:
        stored = json.loads(_MODEL_URLS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        app.logger.logging.warning("Ignoring unreadable model url registry %s: %s", _MODEL_URLS_PATH, exc)
        return {}

    return stored if isinstance(stored, dict) else {}


def _save_url_registry(registry: dict[str, Any]) -> None:
    """Write the registry through a temporary file so a crash cannot truncate it."""
    temp_path = _MODEL_URLS_PATH.with_name(_MODEL_URLS_PATH.name + ".tmp")
    temp_path.write_text(json.dumps(registry, indent=1, sort_keys=True), encoding="utf-8")
    temp_path.replace(_MODEL_URLS_PATH)


def _registry_key(directory: str, filename: str) -> str:
    """Registry key for one model; the folder key keeps same-named files apart."""
    return f"{directory}/{Path(filename).name}"


def _lookup_url(registry: dict[str, Any], directory: str, filename: str) -> dict[str, Any] | None:
    """Find the url record for a file, tolerating that it lives under another folder key."""
    entry = registry.get(_registry_key(directory, filename))
    if isinstance(entry, dict):
        return entry

    # ponytail: suffix scan over a few hundred keys, cheap enough for a prune pass.
    suffix = f"/{Path(filename).name}"
    for key, value in registry.items():
        if key.endswith(suffix) and isinstance(value, dict):
            return value
    return None


def _remember_url(
    registry: dict[str, Any],
    directory: str,
    filename: str,
    url: str,
    source: str,
    size: int | None = None,
) -> bool:
    """Add or refresh one url; returns True when the registry actually changed."""
    key = _registry_key(directory, filename)
    entry = registry.get(key)
    if isinstance(entry, dict) and entry.get("url") == url and entry.get("size") == size:
        return False

    merged = dict(entry) if isinstance(entry, dict) else {}
    merged.update({"url": url, "source": source, "size": size, "seen": int(time.time())})
    registry[key] = merged
    return True


def _collect_template_entries(node: Any, found: dict[str, dict[str, str]], depth: int = 0) -> None:
    """Pick out {name, url, directory} triples at any nesting inside a template document."""
    if depth > 12:
        return

    if isinstance(node, dict):
        name = node.get("name")
        url = node.get("url")
        directory = node.get("directory")
        if isinstance(name, str) and isinstance(directory, str) and isinstance(url, str) and url.startswith("http"):
            found[_registry_key(directory, name)] = {"url": url}
        for value in node.values():
            _collect_template_entries(value, found, depth + 1)
    elif isinstance(node, list):
        for value in node:
            _collect_template_entries(value, found, depth + 1)


def _seed_registry_from_templates(registry: dict[str, Any]) -> int:
    """Harvest the model urls that ship with ComfyUI's own workflow templates."""
    found: dict[str, dict[str, str]] = {}
    for package_name in _TEMPLATE_PACKAGES:
        try:
            package_root = importlib.resources.files(package_name)
        except (ImportError, ModuleNotFoundError, OSError, TypeError) as exc:
            app.logger.logging.info("Template package %s unavailable: %s", package_name, exc)
            continue

        for json_file in package_root.rglob("*.json"):
            try:
                document = json.loads(json_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            _collect_template_entries(document, found)

    added = 0
    for key, entry in found.items():
        if key in registry:
            continue
        registry[key] = {"url": entry["url"], "source": "template", "size": None, "seen": int(time.time())}
        added += 1
    return added


def _url_registry() -> dict[str, Any]:
    """Saved registry, merged once per process with the ComfyUI template urls."""
    global _registry_seeded

    registry = _load_url_registry()
    if not _registry_seeded:
        _registry_seeded = True
        added = _seed_registry_from_templates(registry)
        if added:
            _save_url_registry(registry)
            app.logger.logging.info("Recorded %d model urls from ComfyUI workflow templates", added)

    return registry


def _model_roots() -> list[tuple[str, Path]]:
    """Every folder ComfyUI treats as a model location, paired with its folder key."""
    roots: list[tuple[str, Path]] = []
    seen: set[Path] = set()
    for category in folder_names_and_paths:
        try:
            paths = folder_paths.get_folder_paths(category)
        except KeyError:
            continue
        for path in paths:
            resolved = Path(path).expanduser()
            if resolved.is_dir() and resolved not in seen:
                seen.add(resolved)
                roots.append((category, resolved))
    return roots


def _filesystem_groups() -> dict[int, dict[str, Any]]:
    """Model roots grouped per filesystem, so pruning only ever touches the full disk."""
    groups: dict[int, dict[str, Any]] = {}
    for category, root in _model_roots():
        try:
            device = os.stat(root).st_dev
            usage = shutil.disk_usage(root)
        except OSError:
            continue
        group = groups.setdefault(device, {"roots": [], "free": usage.free, "total": usage.total})
        group["roots"].append((category, root))
    return groups


def _scan_model_tree(registry: dict[str, Any], roots: list[tuple[str, Path]]) -> tuple[list[dict[str, Any]], int]:
    """Model files on disk: those whose url is known (with size and last access), plus
    the byte count of the ones we could never re-download."""
    items: list[dict[str, Any]] = []
    unknown_bytes = 0
    for category, root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            # caches and version control hold files that are not ours to prune
            dirnames[:] = [name for name in dirnames if name not in _SKIPPED_DIR_NAMES]
            for filename in filenames:
                if Path(filename).suffix.lower() not in _MODEL_SUFFIXES:
                    continue
                model_path = Path(dirpath) / filename
                try:
                    info = model_path.stat()
                except OSError:
                    continue
                entry = _lookup_url(registry, category, filename)
                if not entry or not entry.get("url"):
                    unknown_bytes += info.st_size
                    continue
                items.append({
                    "path": str(model_path),
                    "url": entry["url"],
                    "size": info.st_size,
                    # the plugin's own record wins when it is newer than the atime
                    "last_access": max(info.st_atime, float(entry.get("used") or 0)),
                })
    return items, unknown_bytes


def _append_disk_log(entry: dict[str, Any]) -> None:
    """Append one pruning record; the log doubles as the list of recoverable models."""
    log: list[Any] = []
    if _MODEL_DISK_LOG_PATH.exists():
        try:
            stored = json.loads(_MODEL_DISK_LOG_PATH.read_text(encoding="utf-8"))
            if isinstance(stored, list):
                log = stored
        except (OSError, ValueError):
            log = []

    log.append(entry)
    _MODEL_DISK_LOG_PATH.write_text(json.dumps(log[-_DISK_LOG_LIMIT:], indent=1), encoding="utf-8")


def _delete_pruned_model(item: dict[str, Any]) -> bool:
    """Remove one model file and record it, so the url stays available for a re-download."""
    model_path = Path(item["path"])
    if not model_path.exists():
        return False

    try:
        model_path.unlink()
    except OSError as exc:
        app.logger.logging.error("Could not prune %s: %s", model_path, exc)
        return False

    for sidecar_name in (model_path.name + ".lock", model_path.name + ".metadata"):
        sidecar = model_path.with_name(sidecar_name)
        if sidecar.exists():
            sidecar.unlink()

    _append_disk_log({
        "path": str(model_path),
        "url": item["url"],
        "size": item["size"],
        "last_access": int(item["last_access"]),
        "deleted_at": int(time.time()),
    })
    app.logger.logging.warning(
        "Pruned %s (%s, last used %s) for disk space; re-downloadable from %s",
        model_path,
        _format_size(item["size"]),
        time.strftime("%Y-%m-%d", time.localtime(item["last_access"])),
        item["url"],
    )
    return True


def _prune_for_space(
    min_free_gb: float,
    grace_days: float,
    dry_run: bool = True,
    dest_dir: Path | None = None,
    extra_bytes: int = 0,
) -> dict[str, Any]:
    """Free space by deleting the least recently used re-downloadable models.

    Files without a known url are never touched, and neither is anything accessed within
    `grace_days`. With `dest_dir` only the filesystem holding that folder is considered.
    """
    registry = _url_registry()
    target_bytes = int(min_free_gb * _GIB) + max(extra_bytes, 0)
    cutoff = time.time() - grace_days * 86400
    wanted_device = None
    if dest_dir:
        try:
            wanted_device = os.stat(dest_dir).st_dev
        except OSError:
            wanted_device = None

    report: dict[str, Any] = {
        "min_free_gb": min_free_gb,
        "grace_days": grace_days,
        "dry_run": dry_run,
        "filesystems": [],
    }

    for device, group in _filesystem_groups().items():
        if wanted_device is not None and device != wanted_device:
            continue

        prunable, unknown_bytes = _scan_model_tree(registry, group["roots"])
        candidates = sorted(prunable, key=lambda item: item["last_access"])
        eligible = [item for item in candidates if item["last_access"] <= cutoff]
        needed = max(target_bytes - group["free"], 0)
        selected: list[dict[str, Any]] = []
        selected_bytes = 0
        deleted_bytes = 0
        for item in eligible:
            if selected_bytes >= needed:
                break
            selected.append(item)
            selected_bytes += item["size"]
            if not dry_run and _delete_pruned_model(item):
                deleted_bytes += item["size"]

        report["filesystems"].append({
            "roots": [str(root) for _, root in group["roots"]],
            "pressure": needed > 0,
            "free_gb": round(group["free"] / _GIB, 1),
            "total_gb": round(group["total"] / _GIB, 1),
            "needed_gb": round(needed / _GIB, 1),
            "prunable_gb": round(sum(item["size"] for item in eligible) / _GIB, 1),
            "unknown_url_gb": round(unknown_bytes / _GIB, 1),
            "selected_count": len(selected),
            "selected_gb": round(selected_bytes / _GIB, 1),
            "deleted_gb": round(deleted_bytes / _GIB, 1),
            "selected": [
                {
                    "path": item["path"],
                    "size_gb": round(item["size"] / _GIB, 2),
                    "last_access": time.strftime("%Y-%m-%d", time.localtime(item["last_access"])),
                    "url": item["url"],
                }
                for item in selected[:60]
            ],
        })

    return report


def _guard_free_space(dest_dir: Path, incoming_bytes: int = 0) -> None:
    """Make room before a download so the write itself does not fail with ENOSPC."""
    if not _AUTOPRUNE:
        return

    try:
        usage = shutil.disk_usage(dest_dir)
    except OSError:
        return

    if usage.free - incoming_bytes >= _MIN_FREE_GB * _GIB:
        return

    result = _prune_for_space(_MIN_FREE_GB, _GRACE_DAYS, False, dest_dir, incoming_bytes)
    app.logger.logging.warning("Disk guard before download to %s: %s", dest_dir, json.dumps(result)[:1000])


def _format_size(num_bytes: int | float | None) -> str | None:
    if not isinstance(num_bytes, (int, float)) or num_bytes <= 0:
        return None

    units = ["B", "KB", "MB", "GB", "TB"]
    value = float(num_bytes)
    unit_index = 0
    while value >= 1024 and unit_index < len(units) - 1:
        value /= 1024
        unit_index += 1

    if unit_index == 0:
        precision = 0
    elif value >= 100:
        precision = 0
    elif value >= 10:
        precision = 1
    else:
        precision = 2

    formatted = f"{value:.{precision}f}".rstrip("0").rstrip(".")
    return f"{formatted} {units[unit_index]}"


def _build_download_error_message(
    exc: Exception,
    target_path: Path,
    total_bytes: int | None = None,
    downloaded_bytes: int | None = None,
) -> str:
    if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
        parts = [f"No space left on device while writing to '{target_path}'."]

        downloaded_label = _format_size(downloaded_bytes)
        if downloaded_label:
            parts.append(f"Downloaded before failure: {downloaded_label}.")

        total_label = _format_size(total_bytes)
        if total_label:
            parts.append(f"Expected size: {total_label}.")

        try:
            free_bytes = shutil.disk_usage(target_path.parent).free
        except OSError:
            free_bytes = None

        free_label = _format_size(free_bytes)
        if free_label:
            parts.append(f"Free space reported on destination drive: {free_label}.")

        parts.append("The direct downloader writes to the destination folder on that drive.")
        return " ".join(parts)

    return str(exc)


def _schedule_backend_registration(delay: float = 0.5) -> None:
    timer = threading.Timer(delay, _register_backend_route)
    timer.daemon = True
    timer.start()


def _register_backend_route() -> None:
    """Register the backend streaming download endpoint once the server is ready."""

    global _BACKEND_REGISTERED

    if _BACKEND_REGISTERED:
        return

    try:
        from server import PromptServer
    except Exception:  # pragma: no cover - server not ready yet
        _schedule_backend_registration()
        return

    instance = getattr(PromptServer, "instance", None)
    if instance is None or getattr(instance, "app", None) is None or getattr(instance, "loop", None) is None:
        _schedule_backend_registration()
        return

    aiohttp_app = instance.app
    loop = instance.loop

    def ensure_route() -> None:
        global _BACKEND_REGISTERED

        if _BACKEND_REGISTERED:
            return

        if any(getattr(route.resource, "canonical", None) == _ROUTE_PATH for route in aiohttp_app.router.routes()):
            _BACKEND_REGISTERED = True
            return

        async def download_model(request: web.Request) -> web.StreamResponse | web.Response:
            payload = await request.json()
            url = payload.get("url")
            directory = payload.get("directory")
            filename = payload.get("filename")
            destination = payload.get("destination")

            if not url or not directory or not filename:
                return web.json_response({"error": "Missing required parameters"}, status=400)

            if directory not in folder_names_and_paths:
                return web.json_response({"error": f"Unknown directory '{directory}'"}, status=400)

            allowed_dirs = [Path(path).expanduser().resolve() for path in folder_names_and_paths[directory][0]]
            if not allowed_dirs:
                return web.json_response({"error": f"No paths configured for '{directory}'"}, status=400)

            if destination:
                dest_dir = Path(destination).expanduser().resolve()
            else:
                dest_dir = allowed_dirs[0]

            if not any(dest_dir == allowed or dest_dir.is_relative_to(allowed) for allowed in allowed_dirs):
                return web.json_response({"error": "Destination path is not allowed"}, status=400)

            dest_filename = Path(filename).name
            target_path = dest_dir / dest_filename

            if target_path.exists():
                return web.json_response({
                    "status": "exists",
                    "path": str(target_path)
                })

            stream_response = web.StreamResponse(
                status=200,
                headers={"Content-Type": "application/jsonl; charset=utf-8"}
            )
            await stream_response.prepare(request)

            async def send_event(data: dict[str, Any]) -> None:
                payload_bytes = (json.dumps(data) + "\n").encode("utf-8")
                await stream_response.write(payload_bytes)
                await stream_response.drain()

            timeout = ClientTimeout(total=None)
            total_bytes = 0
            downloaded = 0
            try:
                for attempt in (1, 2):
                    try:
                        # Free space before writing; the announced size is unknown until
                        # the response headers arrive, so the first pass keeps the floor.
                        await asyncio.to_thread(_guard_free_space, dest_dir, total_bytes)
                        async with ClientSession(timeout=timeout) as session:
                            async with session.get(url, headers=_auth_headers(url)) as remote_response:
                                remote_response.raise_for_status()
                                total_bytes = int(remote_response.headers.get("content-length") or 0)
                                # Record the url before any bytes land: a model pruned later
                                # must always be fetchable again.
                                registry = _url_registry()
                                if _remember_url(registry, directory, dest_filename, url, "download", total_bytes or None):
                                    _save_url_registry(registry)
                                await send_event({
                                    "status": "start",
                                    "total": total_bytes or None,
                                    "path": str(target_path)
                                })

                                progress_bar = tqdm(
                                    total=total_bytes or None,
                                    unit="B",
                                    unit_scale=True,
                                    unit_divisor=1024,
                                    leave=False,
                                    desc=f"Downloading {target_path.name}"
                                )
                                try:
                                    target_path.parent.mkdir(parents=True, exist_ok=True)
                                    with target_path.open("wb") as handle:
                                        async for chunk in remote_response.content.iter_chunked(1024 * 1024):
                                            if not chunk:
                                                continue
                                            handle.write(chunk)
                                            downloaded += len(chunk)
                                            progress_bar.update(len(chunk))
                                            await send_event({
                                                "status": "progress",
                                                "downloaded": downloaded,
                                                "total": total_bytes or None
                                            })
                                finally:
                                    progress_bar.close()
                        break
                    except OSError as exc:
                        if not _AUTOPRUNE or exc.errno != errno.ENOSPC or attempt == 2:
                            raise
                        downloaded = 0
                        app.logger.logging.warning(
                            "Out of space writing %s; pruning least recently used models and retrying once",
                            target_path,
                        )
                        await asyncio.to_thread(
                            _prune_for_space, _MIN_FREE_GB, _GRACE_DAYS, False, dest_dir, total_bytes
                        )

                await send_event({
                    "status": "completed",
                    "path": str(target_path)
                })
                tqdm.write(f"Saved to {target_path}")
            except Exception as exc:  # pragma: no cover - runtime protection
                error_message = _build_download_error_message(
                    exc,
                    target_path,
                    total_bytes=total_bytes or None,
                    downloaded_bytes=downloaded or None,
                )
                try:
                    if target_path.exists():
                        target_path.unlink()
                except OSError as cleanup_exc:
                    app.logger.logging.warning(
                        "Failed to remove partial download %s: %s",
                        target_path,
                        cleanup_exc,
                    )
                app.logger.logging.error(
                    "Failed to download model from %s to %s: %s",
                    url,
                    target_path,
                    error_message,
                )
                try:
                    await send_event({
                        "status": "error",
                        "message": error_message,
                        "path": str(target_path),
                    })
                except ConnectionResetError:
                    pass
            finally:
                try:
                    await stream_response.write_eof()
                except ConnectionResetError:
                    pass

            return stream_response

        async def model_disk(request: web.Request) -> web.Response:
            """Report or act on model-disk pressure. GET previews, POST may prune."""
            body: dict[str, Any] = {}
            if request.method == "POST":
                body = await request.json()

            dry_run = bool(body.get("dry_run", True))
            min_free_gb = float(body.get("min_free_gb", _MIN_FREE_GB))
            grace_days = float(body.get("grace_days", _GRACE_DAYS))
            destination = body.get("destination")
            dest_dir = Path(destination).expanduser() if destination else None

            report = await asyncio.to_thread(
                _prune_for_space, min_free_gb, grace_days, dry_run, dest_dir
            )
            return web.json_response(report)

        aiohttp_app.router.add_post(_ROUTE_PATH, download_model)
        aiohttp_app.router.add_get(_DISK_ROUTE, model_disk)
        aiohttp_app.router.add_post(_DISK_ROUTE, model_disk)
        _BACKEND_REGISTERED = True
        aiohttp_app.logger.info("Direct model downloader route registered at /internal/download_model")

    loop.call_soon_threadsafe(ensure_route)


_register_backend_route()


class DirectModelDownloaderNode:
    CATEGORY = "utils/download"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("model_path",)
    FUNCTION = "download"

    _ROOT_CACHE: dict[str, str] | None = None
    _MODEL_TYPES_BY_ROOT: dict[str, List[str]] | None = None

    @classmethod
    def _build_directory_maps(cls) -> tuple[dict[str, str], dict[str, List[str]]]:
        if cls._ROOT_CACHE is not None and cls._MODEL_TYPES_BY_ROOT is not None:
            return cls._ROOT_CACHE, cls._MODEL_TYPES_BY_ROOT

        root_map: dict[str, str] = {}
        model_types: dict[str, set[str]] = {}

        for category in folder_names_and_paths.keys():
            try:
                paths = folder_paths.get_folder_paths(category)
            except KeyError:
                continue
            for path in paths:
                p = Path(path).expanduser()
                if not p.name:
                    continue
                root = str(p.parent)
                label = root
                root_map[label] = root
                model_types.setdefault(root, set()).add(p.name)

        if not root_map:
            raise RuntimeError("No model paths discovered in folder configuration")

        cls._ROOT_CACHE = root_map
        cls._MODEL_TYPES_BY_ROOT = {root: sorted(children) for root, children in model_types.items()}
        return cls._ROOT_CACHE, cls._MODEL_TYPES_BY_ROOT

    @classmethod
    def INPUT_TYPES(cls):
        root_map, model_types = cls._build_directory_maps()
        root_choices = sorted(root_map.keys())
        default_root = root_choices[0]
        default_model_types = model_types.get(root_map[default_root], [])
        default_model_type = default_model_types[0] if default_model_types else ""
        all_model_type_choices = sorted({mt for mts in model_types.values() for mt in mts})
        if not all_model_type_choices:
            all_model_type_choices = [default_model_type] if default_model_type else [""]
        return {
            "required": {
                "url": ("STRING", {"default": "", "multiline": False}),
                "models_path": (
                    root_choices,
                    {"default": default_root}
                ),
                "model_type": (
                    all_model_type_choices,
                    {"default": default_model_type or all_model_type_choices[0]}
                ),
            },
            "optional": {
                "filename": ("STRING", {"default": "", "multiline": False}),
                "overwrite": ("BOOLEAN", {"default": False}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, _url=None, _model_directory=None, _filename=None, overwrite=None):
        # Always allow execution if overwrite requested; otherwise, rerun only if file missing.
        return True

    def _stream_model(self, url: str, temp_path: Path, label: str) -> tuple[int, int]:
        """Stream one model into `temp_path`; returns (total_bytes, downloaded_bytes)."""
        total = 0
        downloaded = 0
        with requests.get(url, stream=True, timeout=60, headers=_auth_headers(url)) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or 0)
            progress = tqdm(
                total=total or None,
                unit="B",
                unit_scale=True,
                unit_divisor=1024,
                leave=False,
                desc=f"Downloading {label}"
            )
            try:
                with temp_path.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if not chunk:
                            continue
                        handle.write(chunk)
                        downloaded += len(chunk)
                        progress.update(len(chunk))
            finally:
                progress.close()
        return total, downloaded

    def download(self, url: str, models_path: str, model_type: str, filename: str = "", overwrite: bool = False):
        if not url:
            raise ValueError("URL must not be empty")

        root_map, model_types = self._build_directory_maps()
        if models_path not in root_map:
            raise ValueError(f"Unknown models path selection: {models_path}")

        root_path = Path(root_map[models_path]).expanduser()
        model_type_clean = model_type.strip()
        if not model_type_clean:
            raise ValueError("Model type must be provided")

        valid_types = model_types.get(str(root_path), [])
        if valid_types and model_type_clean not in valid_types:
            raise ValueError(
                f"Model type '{model_type}' not recognised for models path '{models_path}'."
            )

        dest_dir = root_path / model_type_clean
        dest_dir.mkdir(parents=True, exist_ok=True)

        chosen_filename = filename.strip()
        if not chosen_filename:
            parsed = urlparse(url)
            chosen_filename = Path(parsed.path).name
        if not chosen_filename:
            raise ValueError("Unable to determine filename from URL; please provide one explicitly")

        destination = dest_dir / chosen_filename
        if destination.exists() and not overwrite:
            app.logger.logging.info("Model already exists at %s; skipping download", destination)
            return (str(destination),)

        temp_path = destination.with_suffix(destination.suffix + ".download")
        if temp_path.exists():
            temp_path.unlink()

        app.logger.logging.info("Downloading %s to %s", url, destination)
        # Keep the filesystem ahead of the download, and remember the url so a model
        # pruned later can always be fetched again.
        _guard_free_space(dest_dir, 0)
        registry = _url_registry()
        if _remember_url(registry, model_type_clean, chosen_filename, url, "node"):
            _save_url_registry(registry)

        total = 0
        downloaded = 0
        try:
            for attempt in (1, 2):
                try:
                    total, downloaded = self._stream_model(url, temp_path, destination.name)
                    break
                except OSError as exc:
                    if not _AUTOPRUNE or exc.errno != errno.ENOSPC or attempt == 2:
                        raise
                    downloaded = 0
                    app.logger.logging.warning(
                        "Out of space writing %s; pruning least recently used models and retrying once",
                        destination,
                    )
                    _prune_for_space(_MIN_FREE_GB, _GRACE_DAYS, False, dest_dir, total)
        except Exception as exc:
            if temp_path.exists():
                temp_path.unlink()
            error_message = _build_download_error_message(
                exc,
                destination,
                total_bytes=total or None,
                downloaded_bytes=downloaded or None,
            )
            app.logger.logging.error(
                "Failed to download model from %s to %s: %s",
                url,
                destination,
                error_message,
            )
            raise RuntimeError(error_message) from exc

        temp_path.replace(destination)
        app.logger.logging.info("Saved model to %s", destination)
        return (str(destination),)


NODE_CLASS_MAPPINGS.update({
    "DirectModelDownload": DirectModelDownloaderNode,
})

NODE_DISPLAY_NAME_MAPPINGS.update({
    "DirectModelDownload": "Download Model",
})
