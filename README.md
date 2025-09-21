# Direct Model Downloader (ComfyUI Extension)

This extension adds two complementary features that make it easier to fetch missing model files in ComfyUI:

1. **Missing Models dialog helper** – a “Download directly” button beside each missing model entry that downloads files asynchronously (with streamed progress) right into the correct directory.
   <img width="520" height="247" alt="image" src="https://github.com/user-attachments/assets/2c8cec9d-45eb-4677-8712-28e55f52bc03" />
   <img width="1226" height="651" alt="image" src="https://github.com/user-attachments/assets/82d7a29c-089b-463b-8894-79fa3fdf445a" />

2. **Workflow node (`DirectModelDownload`)** – a utility node that can download a model as part of a workflow by specifying a URL and selecting the model path to use and the sub-folder inside the model path. You also have to specify the name of the file on disk.
   ![2025-09-21_02-24](https://github.com/user-attachments/assets/bddbe82e-db9f-4978-9d3d-b60b8079ea1a)

---

## Installation

1. Clone or copy this directory into `ComfyUI/custom_nodes/`.
2. Ensure the environment has the dependencies already used by ComfyUI (`aiohttp`, `tqdm`, `requests`). Most setups will already include these.
3. Restart ComfyUI so the new route, front-end assets, and node class are registered.
4. For the UI button to load, perform a hard refresh in the browser after restarting the server.

---

## Usage

### Missing Models Dialog

1. Load a workflow that references missing model files.
2. When the dialog appears, click **Download directly** next to any entry.
3. Watch the button fill from left to right; once complete it turns green and disables itself.
4. Errors will re-enable the button and show a tooltip; try again after resolving connectivity issues.

### `DirectModelDownload` Node

1. Add the node from `utils/download` category.
2. Paste the URL.
3. Select a models root (e.g., `/path/to/ComfyUI/models`).
4. Pick the subfolder (e.g., `checkpoints`).
5. Optionally set a custom filename or enable overwrite.
6. The node outputs the final path, which can be fed into loaders or monitoring nodes.

---

## Features

### 1. UI Download Button

- Injects a “Download directly” button into the Missing Models dialog.
- Reads folder-path metadata from the server so it knows exactly where each file belongs.
- Streams progress via `/internal/download_model` and fills the button background as bytes arrive.
- Handles indeterminate downloads (when the remote server does not report content length).
- Retries gracefully on errors and provides tooltips/state messages.

### 2. `DirectModelDownload` Node

- Lives under `utils/download` in the node browser.
- Inputs:
  - `url`: Source URL for the model file.
  - `models_path`: Dropdown listing every root model directory known to ComfyUI (including extra paths from `extra_model_paths.yaml`).
  - `model_type`: Dropdown of sub-folders available beneath the selected models path (e.g., `checkpoints`, `loras`, `vae`).
  - Optional `filename` override (defaults to the filename inferred from the URL).
  - Optional `overwrite` flag to re-download existing files.
- Output: The absolute path of the downloaded model file.
- Creates directories on demand and validates that the target path belongs to a registered models folder.

### 3. Streaming Backend Route

- Registers `POST /internal/download_model` on startup (only once, even if custom nodes are reloaded).
- Uses `aiohttp` to download files chunk-by-chunk while sending JSONL events back to the client:
  - `start` – includes total size (if known) and destination path.
  - `progress` – emits `downloaded` bytes and `total`.
  - `completed` – signals success along with the final path.
  - `error` – returns the error message (and cleans up partial files).
- Mirrors progress to the console using `tqdm` for developer insights.

---

## Development Notes

- The front-end script lives in `web/direct-model-download.js`. It uses vanilla DOM manipulation so it works with the compiled Vue bundle shipped in `comfyui_frontend_package`.
- The backend route is registered lazily: when the plugin loads, it waits until `PromptServer.instance` is available, then injects the route only once.
- The node uses `folder_paths.get_folder_paths` so the dropdowns stay in sync with ComfyUI’s model search paths, including extra folders defined by users.
- Console output is kept clean but informative (`tqdm` progress + log messages).

### Adding to a Git repository

1. Initialize a new repository with this directory as the root, or symlink it into an existing repo.
2. Commit the following files:
   - `__init__.py`
   - `web/direct-model-download.js`
   - `README.md`
3. Optionally include packaging metadata (e.g., `pyproject.toml`) if you plan to distribute it as a pip package.

---

## License

Follow the same licensing terms as upstream ComfyUI (MIT). If you redistributethe plugin separately, keep attribution to the ComfyUI project and link back to the original source.

