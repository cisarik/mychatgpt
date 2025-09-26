import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY } from '../utils.js';

const state = {
  items: [],
  busy: false
};

let settingsState = normalizeSettings();

const elements = {
  refreshButton: document.getElementById('refresh-button'),
  refreshLabel: document.querySelector('.refresh-label'),
  status: document.getElementById('status-line'),
  tableBody: document.getElementById('items-body'),
  emptyState: document.getElementById('empty-state')
};

const settingsElements = {
  riskyEnabled: document.getElementById('risky-enabled-toggle'),
  stepTimeout: document.getElementById('risky-step-timeout'),
  waitOpen: document.getElementById('risky-wait-open'),
  waitClick: document.getElementById('risky-wait-click'),
  betweenTabs: document.getElementById('risky-between-tabs')
};

elements.refreshButton.addEventListener('click', onRefreshClick);

settingsElements.riskyEnabled.addEventListener('change', () => {
  updateSettings((prev) => ({
    ...prev,
    risky: { ...prev.risky, enabled: settingsElements.riskyEnabled.checked }
  }));
});

settingsElements.stepTimeout.addEventListener('change', () => onNumericSetting('risky_step_timeout_ms', settingsElements.stepTimeout.value));
settingsElements.waitOpen.addEventListener('change', () => onNumericSetting('risky_wait_after_open_ms', settingsElements.waitOpen.value));
settingsElements.waitClick.addEventListener('change', () => onNumericSetting('risky_wait_after_click_ms', settingsElements.waitClick.value));
settingsElements.betweenTabs.addEventListener('change', () => onNumericSetting('risky_between_tabs_ms', settingsElements.betweenTabs.value));

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'listUpdated') {
    reload();
  } else if (message.type === 'refreshSummary') {
    updateSummary(message.stats);
    setBusy(false);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    settingsState = normalizeSettings(changes[SETTINGS_KEY].newValue);
    applySettingsToUi();
  }
});

loadSettings();
reload();

async function onRefreshClick() {
  if (state.busy) {
    return;
  }
  setBusy(true);
  setStatus('Working…');
  const response = await sendMessageSafe({ type: 'refreshAll' });
  if (!response?.ok) {
    setStatus(shortError(response));
    setBusy(false);
    return;
  }
  if (response.stats) {
    updateSummary(response.stats);
  }
  setBusy(false);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  settingsState = normalizeSettings(stored?.[SETTINGS_KEY]);
  applySettingsToUi();
}

async function reload() {
  const response = await sendMessageSafe({ type: 'getList' });
  if (!response?.ok) {
    setStatus(shortError(response));
    return;
  }
  state.items = response.items || [];
  render();
}

function render() {
  elements.tableBody.innerHTML = '';
  if (!state.items.length) {
    elements.emptyState.hidden = false;
    return;
  }
  elements.emptyState.hidden = true;
  const fragment = document.createDocumentFragment();
  state.items.forEach((item) => {
    const row = document.createElement('tr');
    if (item.deletedAt) {
      row.classList.add('is-deleted');
    }
    row.appendChild(cell(formatTime(item.createdAt), 'col-time'));
    row.appendChild(cell(previewText(item.userText)));
    row.appendChild(cell(item.backupSaved ? 'Yes' : 'No'));
    row.appendChild(cell(formatTurns(item)));
    row.appendChild(cell(item.eligible ? 'Eligible' : item.eligibilityReason || '—'));
    row.appendChild(cell(renderDeletionStatus(item), null, true));
    row.appendChild(cell(formatDeletedAt(item.deletedAt)));
    fragment.appendChild(row);
  });
  elements.tableBody.appendChild(fragment);
}

function cell(content, className, allowElement = false) {
  const td = document.createElement('td');
  if (className) {
    td.className = className;
  }
  if (allowElement && content instanceof HTMLElement) {
    td.appendChild(content);
  } else {
    td.textContent = typeof content === 'string' ? content : String(content ?? '—');
  }
  return td;
}

function renderDeletionStatus(item) {
  if (!item.lastDeletionOutcome) {
    return '—';
  }
  const ok = item.lastDeletionOutcome === 'ok';
  const pill = document.createElement('span');
  pill.className = 'status-pill ' + (ok ? 'status-pill--ok' : 'status-pill--fail');
  pill.textContent = ok ? 'OK' : 'FAIL';
  if (item.lastDeletionReason) {
    pill.title = item.lastDeletionReason;
  }
  return pill;
}

function formatTurns(item) {
  const user = Number.isFinite(item?.counts?.user) ? item.counts.user : 0;
  const assistant = Number.isFinite(item?.counts?.assistant) ? item.counts.assistant : 0;
  return `${user}/${assistant}`;
}

function previewText(text) {
  if (!text) {
    return '—';
  }
  const trimmed = text.trim();
  if (trimmed.length <= 160) {
    return trimmed;
  }
  return `${trimmed.slice(0, 157)}…`;
}

function formatTime(value) {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleTimeString();
}

function formatDeletedAt(value) {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
}

function setBusy(flag) {
  state.busy = flag;
  elements.refreshButton.disabled = flag;
  elements.refreshButton.classList.toggle('is-loading', flag);
  elements.refreshLabel.textContent = flag ? 'Working…' : 'Refresh';
}

function setStatus(message) {
  elements.status.textContent = message || '';
}

function updateSummary(stats) {
  const backedUp = stats?.backedUpOnly ?? 0;
  const deleted = stats?.deleted ?? 0;
  const skipped = stats?.skipped ?? 0;
  const failed = stats?.failed ?? 0;
  setStatus(`Backed up: ${backedUp} • Deleted: ${deleted} • Skipped: ${skipped} • Failed: ${failed}`);
}

function shortError(response) {
  const code = response?.error;
  if (!code) {
    return 'Action failed';
  }
  return `Error: ${code}`;
}

function onNumericSetting(key, rawValue) {
  const value = parseNumeric(rawValue);
  updateSettings((prev) => ({
    ...prev,
    risky: { ...prev.risky, [key]: value ?? DEFAULT_SETTINGS.risky[key] }
  }));
}

function parseNumeric(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function updateSettings(updater) {
  const nextRaw = typeof updater === 'function' ? updater(settingsState) : updater;
  settingsState = normalizeSettings(nextRaw);
  chrome.storage.local.set({ [SETTINGS_KEY]: settingsState });
  applySettingsToUi();
}

function applySettingsToUi() {
  settingsElements.riskyEnabled.checked = Boolean(settingsState.risky?.enabled);
  settingsElements.stepTimeout.value = settingsState.risky?.risky_step_timeout_ms ?? DEFAULT_SETTINGS.risky.risky_step_timeout_ms;
  settingsElements.waitOpen.value = settingsState.risky?.risky_wait_after_open_ms ?? DEFAULT_SETTINGS.risky.risky_wait_after_open_ms;
  settingsElements.waitClick.value = settingsState.risky?.risky_wait_after_click_ms ?? DEFAULT_SETTINGS.risky.risky_wait_after_click_ms;
  settingsElements.betweenTabs.value = settingsState.risky?.risky_between_tabs_ms ?? DEFAULT_SETTINGS.risky.risky_between_tabs_ms;
}

async function sendMessageSafe(payload) {
  try {
    return await chrome.runtime.sendMessage(payload);
  } catch (error) {
    return { ok: false, error: error?.message || 'message_failed' };
  }
}
