import { app, api } from './comfy/index.js';

const BUTTON_CLASS = 'comfy-direct-download';
const ITEM_ATTR = 'data-direct-download-init';
const FOOTER_ATTR = 'data-direct-download-footer-init';
const LABEL_CLASS = 'direct-download-label';
const DIALOG_KEY = 'global-missing-models-warning';
const LABELS = {
  idle: 'Download directly',
  loading: 'Downloading...',
  success: 'Downloaded',
  exists: 'Already exists',
  error: 'Retry download'
};
const BULK_LABEL = 'Download All Directly';
const PROGRESS_VAR = '--direct-download-progress';
const STYLE_ID = 'direct-download-style';
const ATTACH_DEBOUNCE_MS = 120;
const FALLBACK_DIALOG_BUTTON_CLASS =
  'relative inline-flex items-center justify-center gap-2 cursor-pointer touch-manipulation whitespace-nowrap appearance-none border-none rounded-md text-sm font-medium font-inter transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 text-secondary-foreground bg-secondary-background hover:bg-secondary-background-hover h-8 rounded-lg p-2 text-xs';
const PANEL_BUTTON_CLASS = `${FALLBACK_DIALOG_BUTTON_CLASS} w-full`;
const PANEL_BUTTON_ROW_CLASS = 'flex w-full items-start py-1';
const PANEL_ROW_SELECTOR = 'div.flex.w-full.flex-col.pb-3';
const PANEL_GROUP_SELECTOR =
  'div.flex.w-full.flex-col.border-t.border-interface-stroke.py-2';
const MISSING_MODEL_ROW_ICON_SELECTOR =
  'i[class*="icon-[lucide--file-check]"]';
const BADGE_DIRECTORY_MAP = {
  VAE: 'vae',
  DIFFUSION: 'diffusion_models',
  'TEXT ENCODER': 'text_encoders',
  LORA: 'loras',
  CHECKPOINT: 'checkpoints'
};

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
    .${BUTTON_CLASS} .p-button-icon,
    .${BUTTON_CLASS} .${LABEL_CLASS} {
      position: relative;
      z-index: 1;
    }

    .${BUTTON_CLASS}.direct-download-success {
      outline: 1px solid rgba(34, 197, 94, 0.6);
      outline-offset: -1px;
    }

    .${BUTTON_CLASS}.direct-download-error {
      outline: 1px solid rgba(239, 68, 68, 0.6);
      outline-offset: -1px;
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

function getLabelElement(button) {
  return (
    button.querySelector('.p-button-label') ||
    button.querySelector(`.${LABEL_CLASS}`)
  );
}

function resetProgressVisual(button) {
  button.classList.remove('progress-indeterminate');
  button.style.removeProperty(PROGRESS_VAR);
}

function updateProgressVisual(button, downloaded, total) {
  const labelEl = getLabelElement(button);
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
  const labelEl = getLabelElement(button);
  if (!labelEl) return;
  button.classList.remove(
    'p-button-success',
    'p-button-danger',
    'direct-download-success',
    'direct-download-error'
  );

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
      button.classList.add('direct-download-success');
      button.disabled = true;
      button.classList.remove('progress-indeterminate');
      button.style.setProperty(PROGRESS_VAR, '1');
      break;
    case 'exists':
      labelEl.textContent = LABELS.exists;
      button.classList.add('p-button-success');
      button.classList.add('direct-download-success');
      button.disabled = true;
      button.classList.remove('progress-indeterminate');
      button.style.setProperty(PROGRESS_VAR, '1');
      break;
    case 'error':
      labelEl.textContent = message || LABELS.error;
      button.classList.add('p-button-danger');
      button.classList.add('direct-download-error');
      button.disabled = false;
      resetProgressVisual(button);
      break;
    default:
      labelEl.textContent = button.dataset.directDownloadLabel || LABELS.idle;
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
    `<span class="p-button-label ${LABEL_CLASS}">${LABELS.idle}</span>`;
  button.dataset.directDownloadLabel = LABELS.idle;
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
  let outcome = null;
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
        return { status: 'exists' };
      }
      if (json.status === 'downloaded') {
        setButtonState(button, 'success');
        if (json.path) button.title = json.path;
        return { status: 'success' };
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
            outcome = 'success';
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
    return { status: outcome || 'success' };
  } catch (error) {
    console.error('Direct model download failed', error);
    setButtonState(button, 'error', error?.message || LABELS.error);
    button.title = error?.message || LABELS.error;
    setTimeout(() => {
      setButtonState(button, 'idle');
      button.title = originalTitle;
    }, 3500);
    return { status: 'error', error };
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

function looksLikeUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function getDirectoryFromBadge(label) {
  if (!label) return null;
  const trimmed = label.trim();
  if (!trimmed) return null;
  return BADGE_DIRECTORY_MAP[trimmed] || trimmed.toLowerCase().replace(/\s+/g, '_');
}

function findMissingModelsDialog() {
  return (
    document.querySelector(`.p-dialog[aria-labelledby="${DIALOG_KEY}"]`) ||
    document.querySelector(`[aria-labelledby="${DIALOG_KEY}"]`)
  );
}

function getVueComponentFromElement(element) {
  return (
    element?.__vueParentComponent ||
    element?.__vnode?.component ||
    null
  );
}

function findVueInstanceInDomChain(element) {
  let current = element;
  while (current) {
    const instance = getVueComponentFromElement(current);
    if (instance) return instance;
    current = current.parentElement || null;
  }
  return null;
}

function unwrapMaybeRef(value) {
  return value && typeof value === 'object' && 'value' in value
    ? value.value
    : value;
}

function findVuePropsWithModels(element) {
  let instance = findVueInstanceInDomChain(element);
  while (instance) {
    const props = instance.props || instance.vnode?.props;
    if (props && Array.isArray(props.missingModels)) {
      return props;
    }
    instance = instance.parent;
  }
  return null;
}

function findVueComponentWithModel(element) {
  let instance = findVueInstanceInDomChain(element);
  while (instance) {
    const props = instance.props || instance.vnode?.props;
    const model = props?.model;
    if (
      model &&
      typeof model.name === 'string' &&
      model.representative &&
      typeof model.representative === 'object'
    ) {
      const root =
        instance.vnode?.el instanceof Element
          ? instance.vnode.el
          : instance.subTree?.el instanceof Element
            ? instance.subTree.el
            : null;
      if (root) {
        return { element: root, props };
      }
    }
    instance = instance.parent;
  }
  return null;
}

function findPiniaInstance(vueApp) {
  const globalPinia = vueApp?.config?.globalProperties?.$pinia;
  if (globalPinia?._s?.get) return globalPinia;
  const provides = vueApp?._context?.provides;
  if (!provides) return null;
  for (const value of Object.values(provides)) {
    if (value?._s?.get) return value;
  }
  return null;
}

function getPiniaStores(pinia) {
  const registry = pinia?._s;
  if (!registry) return [];
  if (typeof registry.values === 'function') {
    return Array.from(registry.values());
  }
  return Object.values(registry);
}

function getMissingModelStoreData(fallbackPaths) {
  const appRoot = document.querySelector('#vue-app');
  const vueApp = appRoot?.__vue_app__;
  if (!vueApp) {
    return {
      missingModelCandidates: null,
      folderPaths: fallbackPaths,
      fileSizes: null
    };
  }

  const pinia = findPiniaInstance(vueApp);
  if (!pinia) {
    return {
      missingModelCandidates: null,
      folderPaths: fallbackPaths,
      fileSizes: null
    };
  }

  const store = getPiniaStores(pinia).find((entry) =>
    Array.isArray(unwrapMaybeRef(entry?.missingModelCandidates))
  );
  const missingModelCandidates = unwrapMaybeRef(store?.missingModelCandidates);
  const storeFolderPaths = unwrapMaybeRef(store?.folderPaths);
  const storeFileSizes = unwrapMaybeRef(store?.fileSizes);

  return {
    missingModelCandidates: Array.isArray(missingModelCandidates)
      ? missingModelCandidates
      : null,
    folderPaths:
      storeFolderPaths && typeof storeFolderPaths === 'object'
        ? storeFolderPaths
        : fallbackPaths,
    fileSizes:
      storeFileSizes && typeof storeFileSizes === 'object'
        ? storeFileSizes
        : null
  };
}

function getDialogStoreData() {
  const appRoot = document.querySelector('#vue-app');
  const vueApp = appRoot?.__vue_app__;
  if (!vueApp) return null;
  const pinia = findPiniaInstance(vueApp);
  if (!pinia) return null;
  const dialogStore = pinia._s?.get?.('dialog');
  if (!dialogStore) return null;
  const stack = dialogStore.dialogStack?.value || dialogStore.dialogStack;
  if (!Array.isArray(stack)) return null;
  const dialog = stack.find((item) => item.key === DIALOG_KEY);
  const contentProps = dialog?.contentProps || dialog?.props;
  if (!contentProps) return null;
  return {
    missingModels: contentProps.missingModels,
    paths: contentProps.paths
  };
}

function getDialogModelData(dialog, fallbackPaths) {
  const storeData = getDialogStoreData();
  if (storeData?.missingModels) {
    return {
      missingModels: storeData.missingModels,
      paths:
        storeData.paths && Object.keys(storeData.paths).length
          ? storeData.paths
          : fallbackPaths
    };
  }
  const listContainer = getDialogListContainer(dialog);
  const footerButton = dialog?.querySelector('.p-dialog-footer button');
  const props = findVuePropsWithModels(
    footerButton || listContainer || dialog
  );
  if (!props) {
    return { missingModels: null, paths: fallbackPaths };
  }
  const paths =
    props.paths && Object.keys(props.paths).length ? props.paths : fallbackPaths;
  return { missingModels: props.missingModels, paths };
}

function getDialogButtonClass(dialog) {
  const footerButton = dialog?.querySelector('.p-dialog-footer button');
  const className = footerButton?.className?.trim();
  return className || FALLBACK_DIALOG_BUTTON_CLASS;
}

function createDialogButton(baseClassName, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${baseClassName} ${BUTTON_CLASS}`.trim();
  const labelSpan = document.createElement('span');
  labelSpan.className = LABEL_CLASS;
  labelSpan.textContent = label;
  button.appendChild(labelSpan);
  button.dataset.directDownloadLabel = label;
  return button;
}

function createPanelButton(label) {
  const container = document.createElement('div');
  container.className = PANEL_BUTTON_ROW_CLASS;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${PANEL_BUTTON_CLASS} ${BUTTON_CLASS}`.trim();
  button.style.width = '100%';
  setPanelButtonContent(button, label);
  container.appendChild(button);
  return { container, button };
}

function setPanelButtonContent(button, label) {
  button.innerHTML =
    '<i class="text-foreground mr-1 icon-[lucide--download] size-4 shrink-0" aria-hidden="true"></i>' +
    `<span class="text-foreground min-w-0 truncate text-sm ${LABEL_CLASS}">${label}</span>`;
  button.dataset.directDownloadLabel = label;
}

function ensureButtonLabel(button, label) {
  let labelEl = getLabelElement(button) || button.querySelector('span');
  if (!labelEl) {
    labelEl = document.createElement('span');
    button.appendChild(labelEl);
  }
  labelEl.classList.add(LABEL_CLASS);
  labelEl.textContent = label;
  button.dataset.directDownloadLabel = label;
}

function extractDialogModelInfo(row) {
  const nameEl = row.querySelector('span[title]');
  let filename =
    nameEl?.getAttribute('title')?.trim() || nameEl?.textContent?.trim();
  const badgeEl = row.querySelector('span.uppercase');
  let directory = getDirectoryFromBadge(badgeEl?.textContent);
  const urlEl = Array.from(row.querySelectorAll('[title]')).find((element) =>
    looksLikeUrl(element.getAttribute('title'))
  );
  const linkEl = row.querySelector('a[href]');
  const url =
    urlEl?.getAttribute('title')?.trim() ||
    (looksLikeUrl(linkEl?.getAttribute('href'))
      ? linkEl?.getAttribute('href')?.trim()
      : null);

  if (!directory && filename?.includes(' / ')) {
    const parts = filename.split(' / ');
    directory = parts.shift()?.trim() || null;
    filename = parts.join(' / ').trim();
  }

  if (!filename || !directory) return null;

  return {
    url,
    directory,
    filename
  };
}

function getDialogListContainer(dialog) {
  return dialog?.querySelector('.p-dialog-content .scrollbar-custom') || null;
}

function getDialogRows(listContainer) {
  if (!listContainer) return [];
  const rows = Array.from(listContainer.children);
  const filtered = rows.filter((row) => row.querySelector('span[title]'));
  return filtered.length ? filtered : rows;
}

function getPanelRowRoot(element) {
  return element?.closest?.(PANEL_ROW_SELECTOR) || null;
}

function isMissingModelPanelRow(row) {
  return !!(
    row?.querySelector?.(MISSING_MODEL_ROW_ICON_SELECTOR) &&
    row.querySelector('p[title]')
  );
}

function findMissingModelPanelRows() {
  const rows = new Map();

  const addRow = (row, props) => {
    const root = getPanelRowRoot(row) || row;
    if (!isMissingModelPanelRow(root) || rows.has(root)) return;
    rows.set(root, props || null);
  };

  document.querySelectorAll(PANEL_ROW_SELECTOR).forEach((row) => {
    if (!isMissingModelPanelRow(row)) return;
    const match =
      findVueComponentWithModel(row) ||
      findVueComponentWithModel(row.querySelector(MISSING_MODEL_ROW_ICON_SELECTOR));
    addRow(match?.element || row, match?.props);
  });

  if (!rows.size) {
    document
      .querySelectorAll(MISSING_MODEL_ROW_ICON_SELECTOR)
      .forEach((icon) => {
        const match = findVueComponentWithModel(icon);
        addRow(match?.element || icon, match?.props);
      });
  }

  return Array.from(rows.entries()).map(([element, props]) => ({
    element,
    props
  }));
}

function stripPanelCountSuffix(label) {
  if (typeof label !== 'string') return null;
  const stripped = label.replace(/\s*\(\d+\)\s*$/, '').trim();
  return stripped || null;
}

function getPanelRowModelName(row) {
  const nameEl = row?.querySelector('p[title]');
  return (
    nameEl?.getAttribute('title')?.trim() ||
    stripPanelCountSuffix(nameEl?.textContent) ||
    null
  );
}

function getPanelGroupDirectory(row) {
  const group = row?.closest(PANEL_GROUP_SELECTOR);
  const header = group?.querySelector(
    ':scope > .flex.h-8.w-full.items-center p'
  );
  return stripPanelCountSuffix(header?.textContent);
}

function findStoreMissingModelInfo(modelName, directoryHint, storeData) {
  const candidates = storeData?.missingModelCandidates;
  if (!modelName || !Array.isArray(candidates)) return null;

  let matches = candidates.filter((candidate) => candidate?.name === modelName);
  if (!matches.length) return null;

  if (directoryHint) {
    const exactMatches = matches.filter(
      (candidate) => candidate?.directory === directoryHint
    );
    if (exactMatches.length) {
      matches = exactMatches;
    }
  }

  const candidate =
    matches.find(
      (entry) => entry?.url && entry?.directory && typeof entry.name === 'string'
    ) || matches[0];
  if (!candidate?.url || !candidate?.directory || !candidate?.name) {
    return null;
  }

  return {
    url: candidate.url,
    directory: candidate.directory,
    filename: candidate.name
  };
}

function getPanelPathMap(folderPaths, storeData) {
  return storeData?.folderPaths && typeof storeData.folderPaths === 'object'
    ? storeData.folderPaths
    : folderPaths;
}

function getPanelModelInfo(props, row, storeData) {
  const representative = props?.model?.representative;
  const info = {
    url: representative?.url || null,
    directory:
      props?.directory || representative?.directory || getPanelGroupDirectory(row),
    filename: props?.model?.name || representative?.name || getPanelRowModelName(row)
  };

  if (info.url && info.directory && info.filename) {
    return info;
  }

  const fallbackInfo = findStoreMissingModelInfo(
    info.filename || getPanelRowModelName(row),
    info.directory,
    storeData
  );
  if (!fallbackInfo) {
    return info;
  }

  return {
    url: info.url || fallbackInfo.url,
    directory: info.directory || fallbackInfo.directory,
    filename: info.filename || fallbackInfo.filename
  };
}

function findMissingModelPanelRowsByButton() {
  const rows = new Map();
  document
    .querySelectorAll('.flex.w-full.items-start.py-1 > button')
    .forEach((button) => {
      const row = getPanelRowRoot(button);
      if (!isMissingModelPanelRow(row) || rows.has(row)) return;
      rows.set(row, null);
    });
  return Array.from(rows.entries()).map(([element, props]) => ({
    element,
    props
  }));
}

function getPanelBulkRowData() {
  const rows = findMissingModelPanelRows();
  if (rows.length) return rows;
  return findMissingModelPanelRowsByButton();
}

function getButtonText(button) {
  return (
    button?.textContent ||
    button?.getAttribute?.('aria-label') ||
    ''
  ).trim();
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals =
    unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')} ${units[unitIndex]}`;
}

function extractSizeLabel(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\(([^()]+)\)\s*$/);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function getDirectDownloadLabel(url, fileSizes, fallbackText) {
  const knownSize = formatFileSize(fileSizes?.[url]);
  const fallbackSize = extractSizeLabel(fallbackText);
  const sizeLabel = knownSize || fallbackSize;
  return sizeLabel ? `${LABELS.idle} (${sizeLabel})` : LABELS.idle;
}

function isPanelActionButton(button) {
  const className = button?.className;
  if (typeof className !== 'string') return false;
  return (
    className.includes('inline-flex') &&
    className.includes('bg-secondary-background') &&
    className.includes('rounded-lg') &&
    className.includes('shrink-0')
  );
}

function findPanelBulkButtons() {
  const seenScopes = new Set();
  return Array.from(document.querySelectorAll('button')).filter((button) => {
    if (!(button instanceof HTMLButtonElement)) return false;
    if (button.closest(PANEL_ROW_SELECTOR)) return false;

    const text = getButtonText(button);
    const isPatched = button.dataset.directDownloadPanelBulk === '1';
    if (!isPanelActionButton(button)) return false;
    if (!isPatched && !/download\s+all/i.test(text)) return false;

    const scope = findPanelBulkScope(button);
    if (scope === document) return false;
    if (!scope.querySelector(PANEL_ROW_SELECTOR)) return false;
    if (seenScopes.has(scope)) return false;
    seenScopes.add(scope);
    return true;
  });
}

function findPanelBulkScope(button) {
  let current = button?.parentElement || null;
  while (current && current !== document.body) {
    if (current.querySelector(PANEL_ROW_SELECTOR)) {
      return current;
    }
    current = current.parentElement;
  }
  return document;
}

function getPanelInputContainer(row) {
  return (
    row?.querySelector(':scope > .mt-1.flex.flex-col.gap-1') ||
    row?.querySelector('.mt-1.flex.flex-col.gap-1') ||
    row
  );
}

function getExistingPanelDownloadButton(inputContainer) {
  return (
    inputContainer?.querySelector(':scope > .flex.w-full.items-start.py-1 button') ||
    inputContainer?.querySelector('.flex.w-full.items-start.py-1 button') ||
    null
  );
}

function attachPanelRowButtons(folderPaths) {
  const rows = findMissingModelPanelRows();
  const fallbackRows = rows.length ? [] : findMissingModelPanelRowsByButton();
  const allRows = rows.length ? rows : fallbackRows;
  const storeData = getMissingModelStoreData(folderPaths);
  const pathMap = getPanelPathMap(folderPaths, storeData);
  allRows.forEach(({ element: row, props }) => {
    const inputContainer = getPanelInputContainer(row);
    if (!inputContainer) return;

    const info = getPanelModelInfo(props, row, storeData);
    if (!info.url || !info.directory || !info.filename) return;

    const paths = pathMap?.[info.directory] || [];
    const destination = paths[0];
    const destinationLabel = destination ? `${destination}/${info.filename}` : '';
    const payload = buildPayload(info, destination);
    if (!payload) return;

    const existingButton = getExistingPanelDownloadButton(inputContainer);
    let button = existingButton;

    if (!button) {
      const created = createPanelButton(LABELS.idle);
      inputContainer.appendChild(created.container);
      button = created.button;
    }

    if (!(button instanceof HTMLButtonElement)) return;
    const idleLabel = getDirectDownloadLabel(
      info.url,
      storeData.fileSizes,
      getButtonText(button)
    );

    button.classList.add(BUTTON_CLASS);
    button.dataset.directDownloadPanelRow = '1';
    button.dataset.directDownloadPayload = JSON.stringify(payload);
    button.dataset.directDownloadLabel = idleLabel;
    button.title = destinationLabel || info.directory;
    button.setAttribute('aria-label', `${LABELS.idle} ${info.filename}`);
    setPanelButtonContent(button, idleLabel);

    if (button.dataset.directDownloadPanelRowBound === '1') {
      return;
    }

    button.dataset.directDownloadPanelRowBound = '1';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      if (button.disabled) return;
      performDownload(button, payload);
    }, true);
  });
}

function attachPanelButtons(folderPaths) {
  attachPanelRowButtons(folderPaths);
  attachPanelBulkButtons(folderPaths);
}

function buildPayload(info, destination) {
  if (!info?.url || !info?.directory || !info?.filename) return null;
  const payload = {
    url: info.url,
    directory: info.directory,
    filename: info.filename
  };
  if (destination) {
    payload.destination = destination;
  }
  return payload;
}

function parseButtonPayload(button) {
  const rawPayload = button?.dataset?.directDownloadPayload;
  if (!rawPayload) return null;
  try {
    return JSON.parse(rawPayload);
  } catch (error) {
    console.warn('[DirectDownload] invalid payload', error, rawPayload);
    return null;
  }
}

function collectDownloadTargets(buttons) {
  return Array.from(buttons)
    .filter((rowButton) => rowButton instanceof HTMLButtonElement && !rowButton.disabled)
    .map((rowButton) => {
      const payload = parseButtonPayload(rowButton);
      if (!payload) return null;
      return { button: rowButton, payload };
    })
    .filter(Boolean);
}

async function performBulkDownload(button, targets) {
  if (!targets.length) {
    setButtonState(button, 'error', 'No downloadable models');
    setTimeout(() => setButtonState(button, 'idle'), 2500);
    return;
  }

  setButtonState(button, 'loading');
  updateProgressVisual(button, 0, targets.length);
  let completed = 0;

  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const result = await performDownload(target.button, target.payload);
      completed += 1;
      updateProgressVisual(button, completed, targets.length);
      return result;
    })
  );

  const hadError = results.some((result) => {
    if (result.status === 'rejected') return true;
    return result.value?.status === 'error';
  });

  if (hadError) {
    setButtonState(button, 'error', 'Some downloads failed');
    setTimeout(() => setButtonState(button, 'idle'), 3500);
    return;
  }

  setButtonState(button, 'success');
}

function findMatchingModel(models, filename, directory) {
  if (!Array.isArray(models) || !filename) return null;
  if (directory) {
    const exact = models.find(
      (model) => model.name === filename && model.directory === directory
    );
    if (exact) return exact;
  }
  return models.find((model) => model.name === filename) || null;
}

function attachDialogRowButtons(dialog, folderPaths, baseClassName) {
  const listContainer = getDialogListContainer(dialog);
  if (!listContainer) return;
  const dialogData = getDialogModelData(dialog, folderPaths);
  const rows = getDialogRows(listContainer);

  rows.forEach((row, index) => {
    if (
      row.querySelector(`.${BUTTON_CLASS}[data-direct-download-row="1"]`)
    ) {
      return;
    }

    const rowInfo = extractDialogModelInfo(row);
    const modelFromProps = findMatchingModel(
      dialogData.missingModels,
      rowInfo?.filename,
      rowInfo?.directory
    );
    const indexedModel =
      !modelFromProps &&
      Array.isArray(dialogData.missingModels) &&
      dialogData.missingModels[index]
        ? dialogData.missingModels[index]
        : null;
    const model = modelFromProps || indexedModel;

    const info = {
      url: model?.url || rowInfo?.url,
      directory: model?.directory || rowInfo?.directory,
      filename: model?.name || rowInfo?.filename
    };

    if (!info.filename || !info.directory) return;

    const actionContainer =
      row.querySelector('.flex.shrink-0.items-center.gap-2') ||
      row.querySelector(':scope > div:last-child');
    if (!actionContainer) return;

    const button = createDialogButton(baseClassName, LABELS.idle);
    button.dataset.directDownloadRow = '1';
    actionContainer.appendChild(button);

    if (!info.url) {
      button.disabled = true;
      button.title = 'Download URL unavailable';
      return;
    }

    const paths = dialogData.paths?.[info.directory] || [];
    const destination = paths[0];
    const destinationLabel = destination ? `${destination}/${info.filename}` : '';
    const payload = buildPayload(info, destination);
    if (!payload) return;
    button.dataset.directDownloadPayload = JSON.stringify(payload);
    button.title = destinationLabel || info.directory;
    button.addEventListener('click', () => {
      if (button.disabled) return;
      performDownload(button, payload);
    });
  });
}

function attachDialogFooterButton(dialog, folderPaths, baseClassName) {
  const footer = dialog?.querySelector('.p-dialog-footer');
  if (!footer) return;
  const actionRow = footer.querySelector('.flex.justify-end');
  if (!actionRow) return;
  if (actionRow.getAttribute(FOOTER_ATTR) === '1') return;

  const button = createDialogButton(baseClassName, BULK_LABEL);
  button.dataset.directDownloadFooter = '1';
  actionRow.appendChild(button);
  actionRow.setAttribute(FOOTER_ATTR, '1');

  button.addEventListener('click', async () => {
    if (button.disabled) return;
    attachDialogRowButtons(dialog, folderPaths, baseClassName);

    const listContainer = getDialogListContainer(dialog);
    if (!listContainer) return;

    const targets = collectDownloadTargets(
      listContainer.querySelectorAll(
        `.${BUTTON_CLASS}[data-direct-download-row="1"]`
      )
    );
    await performBulkDownload(button, targets);
  });
}

function attachPanelBulkButtons(folderPaths) {
  findPanelBulkButtons().forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;

    button.classList.add(BUTTON_CLASS);
    button.dataset.directDownloadPanelBulk = '1';
    button.dataset.directDownloadLabel = BULK_LABEL;
    button.type = 'button';
    button.title = BULK_LABEL;
    button.setAttribute('aria-label', BULK_LABEL);
    ensureButtonLabel(button, BULK_LABEL);

    if (button.dataset.directDownloadPanelBulkBound === '1') {
      return;
    }

    button.dataset.directDownloadPanelBulkBound = '1';
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      if (button.disabled) return;

      attachPanelRowButtons(folderPaths);
      const scope = findPanelBulkScope(button);
      const targets = collectDownloadTargets(
        scope.querySelectorAll(
          `.${BUTTON_CLASS}[data-direct-download-panel-row="1"]`
        )
      );
      await performBulkDownload(button, targets);
    }, true);
  });
}

function attachDialogButtons(folderPaths) {
  const dialog = findMissingModelsDialog();
  if (!dialog) return;
  const baseClassName = getDialogButtonClass(dialog);
  attachDialogRowButtons(dialog, folderPaths, baseClassName);
  attachDialogFooterButton(dialog, folderPaths, baseClassName);
}

function attachLegacyButtons(folderPaths) {
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

    const payload = buildPayload(info, destination);
    if (!payload) {
      button.disabled = true;
      button.title = 'Download URL unavailable';
      return;
    }
    console.debug('[DirectDownload] enabled', payload);
    if (!destinationLabel) {
      button.title = info.directory;
    }
    button.addEventListener('click', () => {
      if (button.disabled) return;
      performDownload(button, payload);
    });

    markInitialised(item);
  });
}

function attachAllButtons(folderPaths) {
  attachLegacyButtons(folderPaths);
  attachDialogButtons(folderPaths);
  attachPanelButtons(folderPaths);
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

  let attachTimer = null;
  const scheduleAttach = () => {
    if (attachTimer !== null) {
      clearTimeout(attachTimer);
    }
    attachTimer = window.setTimeout(() => {
      attachTimer = null;
      attachAllButtons(folderPaths);
    }, ATTACH_DEBOUNCE_MS);
  };

  const observer = new MutationObserver(() => scheduleAttach());
  observer.observe(document.body, { childList: true, subtree: true });
  attachAllButtons(folderPaths);
}

app.registerExtension({
  name: 'direct-model-downloader',
  setup() {
    void bootstrap();
  }
});
