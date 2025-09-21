import { app, api } from './comfy/index.js';

const BUTTON_CLASS = 'comfy-direct-download';
const ITEM_ATTR = 'data-direct-download-init';
const LABELS = {
  idle: 'Download directly',
  loading: 'Downloading...',
  success: 'Downloaded',
  exists: 'Already exists',
  error: 'Retry download'
};
const PROGRESS_VAR = '--direct-download-progress';
const STYLE_ID = 'direct-download-style';

ensureStyles();

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${BUTTON_CLASS} {
      position: relative;
      overflow: hidden;
    }

    .${BUTTON_CLASS}::before {
      content: '';
      position: absolute;
      inset: 0;
      width: calc(var(${PROGRESS_VAR}, 0) * 100%);
      background: rgba(34, 197, 94, 0.35);
      transition: width 0.18s ease-out;
      z-index: 0;
    }

    .${BUTTON_CLASS}.progress-indeterminate::before {
      width: 140%;
      background: linear-gradient(
        90deg,
        rgba(34, 197, 94, 0.15) 0%,
        rgba(34, 197, 94, 0.45) 50%,
        rgba(34, 197, 94, 0.15) 100%
      );
      animation: direct-download-indeterminate 1s linear infinite;
    }

    .${BUTTON_CLASS} .p-button-label,
    .${BUTTON_CLASS} .p-button-icon {
      position: relative;
      z-index: 1;
    }

    @keyframes direct-download-indeterminate {
      from {
        transform: translateX(-20%);
      }
      to {
        transform: translateX(0);
      }
    }
  `;
  document.head.appendChild(style);
}

function resetProgressVisual(button) {
  button.classList.remove('progress-indeterminate');
  button.style.removeProperty(PROGRESS_VAR);
}

function updateProgressVisual(button, downloaded, total) {
  const labelEl = button.querySelector('.p-button-label');
  if (!labelEl) return;

  if (total && total > 0) {
    const ratio = Math.min(downloaded / total, 1);
    button.classList.remove('progress-indeterminate');
    button.style.setProperty(PROGRESS_VAR, ratio.toString());
    const percent = Math.round(ratio * 100);
    labelEl.textContent = `${LABELS.loading} ${percent}%`;
  } else {
    button.classList.add('progress-indeterminate');
    button.style.removeProperty(PROGRESS_VAR);
    labelEl.textContent = LABELS.loading;
  }
}

function setButtonState(button, state, message) {
  const labelEl = button.querySelector('.p-button-label');
  if (!labelEl) return;
  button.classList.remove('p-button-success', 'p-button-danger');

  switch (state) {
    case 'loading':
      labelEl.textContent = LABELS.loading;
      button.disabled = true;
      button.classList.remove('progress-indeterminate');
      button.style.setProperty(PROGRESS_VAR, '0');
      break;
    case 'success':
      labelEl.textContent = LABELS.success;
      button.classList.add('p-button-success');
      button.disabled = true;
      button.classList.remove('progress-indeterminate');
      button.style.setProperty(PROGRESS_VAR, '1');
      break;
    case 'exists':
      labelEl.textContent = LABELS.exists;
      button.classList.add('p-button-success');
      button.disabled = true;
      button.classList.remove('progress-indeterminate');
      button.style.setProperty(PROGRESS_VAR, '1');
      break;
    case 'error':
      labelEl.textContent = message || LABELS.error;
      button.classList.add('p-button-danger');
      button.disabled = false;
      resetProgressVisual(button);
      break;
    default:
      labelEl.textContent = LABELS.idle;
      button.disabled = false;
      resetProgressVisual(button);
  }
}

function createButton(destinationLabel) {
  const container = document.createElement('div');
  container.className = 'p-buttonset';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'p-button p-component p-button-sm p-button-outlined ' + BUTTON_CLASS;
  button.innerHTML = '<span class="p-button-icon p-button-icon-left pi pi-cloud-download" aria-hidden="true"></span>' +
    `<span class="p-button-label">${LABELS.idle}</span>`;
  if (destinationLabel) {
    button.title = destinationLabel;
  }
  container.appendChild(button);
  return { container, button };
}

function extractModelInfo(root) {
  const labelSpan = root.querySelector('span[title]');
  const downloadButtons = Array.from(root.querySelectorAll('button'))
    .filter((btn) => !btn.classList.contains(BUTTON_CLASS));
  const downloadButton = downloadButtons.find((btn) =>
    /download/i.test(btn.textContent || '')
  );
  const url = downloadButton?.getAttribute('title')?.trim();
  const label = labelSpan?.textContent?.trim();
  if (!url || !label) return null;
  const parts = label.split(' / ');
  if (parts.length < 2) return null;
  const directory = parts.shift().trim();
  const filename = parts.join(' / ').trim();
  if (!directory || !filename) return null;
  return {
    url,
    directory,
    filename
  };
}

async function performDownload(button, payload) {
  const originalTitle = button.title;
  setButtonState(button, 'loading');
  try {
    const response = await fetch(api.internalURL('/download_model'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      if (contentType.includes('application/json')) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error || response.statusText);
      }
      throw new Error(response.statusText);
    }

    if (!contentType.includes('jsonl')) {
      const json = await response.json();
      if (json.status === 'exists') {
        setButtonState(button, 'exists');
        if (json.path) button.title = json.path;
        return;
      }
      if (json.status === 'downloaded') {
        setButtonState(button, 'success');
        if (json.path) button.title = json.path;
        return;
      }
      throw new Error(json?.error || 'Unexpected response');
    }

    if (!response.body) {
      throw new Error('Streaming not supported in this browser');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    let total = null;
    let lastProgressUpdate = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          console.error('Direct download progress parse error', error, line);
          continue;
        }

        switch (event.status) {
          case 'start':
            total = typeof event.total === 'number' ? event.total : null;
            if (event.path) button.title = event.path;
            if (total === null) {
              button.classList.add('progress-indeterminate');
            }
            break;
          case 'progress':
            if (typeof event.total === 'number') {
              total = event.total;
            }
            {
              const downloadedValue = event.downloaded ?? 0;
              const now = performance.now();
              const shouldUpdate =
                now - lastProgressUpdate > 120 ||
                (total && downloadedValue >= total);
              if (shouldUpdate) {
                updateProgressVisual(button, downloadedValue, total);
                lastProgressUpdate = now;
              }
            }
            break;
          case 'completed':
            finished = true;
            updateProgressVisual(button, total ?? event.downloaded ?? 1, total ?? event.downloaded ?? 1);
            setButtonState(button, 'success');
            if (event.path) button.title = event.path;
            if (typeof reader.cancel === 'function') {
              await reader.cancel();
            }
            break;
          case 'error':
            throw new Error(event.message || 'Download failed');
          default:
            break;
        }

        if (finished) {
          break;
        }
      }
      if (finished) break;
    }

    if (!finished) {
      throw new Error('Download interrupted');
    }
  } catch (error) {
    console.error('Direct model download failed', error);
    setButtonState(button, 'error', error?.message || LABELS.error);
    button.title = error?.message || LABELS.error;
    setTimeout(() => {
      setButtonState(button, 'idle');
      button.title = originalTitle;
    }, 3500);
  }
}

function isAlreadyInitialised(element) {
  return element?.getAttribute?.(ITEM_ATTR) === '1';
}

function markInitialised(element) {
  element?.setAttribute?.(ITEM_ATTR, '1');
}

function findFileDownloadRoot(listItem) {
  return (
    listItem.querySelector(':scope .flex.flex-row.items-center.gap-2') ||
    listItem.querySelector('.flex.flex-row.items-center.gap-2') ||
    listItem
  );
}

function attachButtons(folderPaths) {
  console.debug('[DirectDownload] scanning for missing models');
  const listItems = document.querySelectorAll(
    '.comfy-missing-models li, .comfy-missing-models .p-listbox-item, .comfy-missing-models .p-listbox-option'
  );
  listItems.forEach((item) => {
    if (isAlreadyInitialised(item)) return;
    const downloadRoot = findFileDownloadRoot(item);
    if (!downloadRoot) return;
    const info = extractModelInfo(downloadRoot);
    if (!info) {
      console.debug('[DirectDownload] unable to read model info for', downloadRoot);
      return;
    }

    const paths = folderPaths?.[info.directory] || [];
    const destination = paths[0];
    const destinationLabel = destination ? `${destination}/${info.filename}` : '';
    const { container, button } = createButton(destinationLabel);
    downloadRoot.appendChild(container);

    if (destination) {
      const payload = {
        url: info.url,
        directory: info.directory,
        filename: info.filename,
        destination
      };
      console.debug('[DirectDownload] enabled', payload);
      button.addEventListener('click', () => {
        if (button.disabled) return;
        performDownload(button, payload);
      });
    } else {
      button.disabled = true;
      button.title = `No configured path for ${info.directory}`;
    }

    markInitialised(item);
  });
}

async function bootstrap() {
  console.debug('[DirectDownload] bootstrap start');
  let folderPaths = null;
  try {
    folderPaths = await api.getFolderPaths();
  } catch (error) {
    console.error('Unable to load model folder paths for direct download', error);
    return;
  }

  const observer = new MutationObserver(() => attachButtons(folderPaths));
  observer.observe(document.body, { childList: true, subtree: true });
  attachButtons(folderPaths);
}

app.registerExtension({
  name: 'direct-model-downloader',
  setup() {
    void bootstrap();
  }
});
