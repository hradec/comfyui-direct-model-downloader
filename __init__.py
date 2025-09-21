"""Frontend helper for downloading missing models directly from the dialog."""

from __future__ import annotations

import json
import threading
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
            try:
                async with ClientSession(timeout=timeout) as session:
                    async with session.get(url) as remote_response:
                        remote_response.raise_for_status()
                        total_bytes = int(remote_response.headers.get("content-length") or 0)
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
                        downloaded = 0
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

                await send_event({
                    "status": "completed",
                    "path": str(target_path)
                })
                tqdm.write(f"Saved to {target_path}")
            except Exception as exc:  # pragma: no cover - runtime protection
                if target_path.exists():
                    target_path.unlink()
                app.logger.log_error(f"Failed to download model from {url}: {exc}")
                await send_event({
                    "status": "error",
                    "message": str(exc)
                })
            finally:
                await stream_response.write_eof()

            return stream_response

        aiohttp_app.router.add_post(_ROUTE_PATH, download_model)
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
        try:
            with requests.get(url, stream=True, timeout=60) as response:
                response.raise_for_status()
                total = int(response.headers.get("content-length") or 0)
                progress = tqdm(
                    total=total or None,
                    unit="B",
                    unit_scale=True,
                    unit_divisor=1024,
                    leave=False,
                    desc=f"Downloading {destination.name}"
                )
                try:
                    with temp_path.open("wb") as handle:
                        for chunk in response.iter_content(chunk_size=1024 * 1024):
                            if not chunk:
                                continue
                            handle.write(chunk)
                            progress.update(len(chunk))
                finally:
                    progress.close()
        except Exception as exc:
            if temp_path.exists():
                temp_path.unlink()
            raise RuntimeError(f"Failed to download {url}: {exc}") from exc

        temp_path.replace(destination)
        app.logger.logging.info("Saved model to %s", destination)
        return (str(destination),)


NODE_CLASS_MAPPINGS.update({
    "DirectModelDownload": DirectModelDownloaderNode,
})

NODE_DISPLAY_NAME_MAPPINGS.update({
    "DirectModelDownload": "Download Model",
})
