import { getConvoUrl, normalizeSettings, SETTINGS_KEY } from '../utils.js';

const state = {
  items: [],
  selected: new Set(),
  showAll: false,
  deletionRunning: false
};

let settingsState = normalizeSettings();

const elements = {
  scan: document.getElementById('scan-button'),
  refresh: document.getElementById('refresh-button'),
  forceCapture: document.getElementById('force-capture-button'),
  probe: document.getElementById('probe-button'),
  deleteButton: document.getElementById('delete-button'),
  cancelButton: document.getElementById('cancel-deletion-button'),
  reEvaluate: document.getElementById('re-evaluate-button'),
  showAll: document.getElementById('show-all-toggle'),
  status: document.getElementById('status-line'),
  tableBody: document.getElementById('items-body'),
  emptyState: document.getElementById('empty-state'),
  selectAll: document.getElementById('select-all')
};

const settingsElements = {
  riskyEnabled: document.getElementById('risky-enabled-toggle'),
  dryRun: document.getElementById('dry-run-toggle')
};

elements.scan.addEventListener('click', async () => {
  setStatus('Scanning…');
  const response = await chrome.runtime.sendMessage({ type: 'scanAllChatgptTabs' });
  setStatus(response?.ok ? 'Scan done' : shortError(response));
});

elements.refresh.addEventListener('click', () => reload());

elements.forceCapture.addEventListener('click', async () => {
  setStatus('Capturing…');
  const response = await chrome.runtime.sendMessage({ type: 'captureActiveTabNow' });
  setStatus(response?.ok ? 'Capture saved' : shortError(response));
});

elements.probe.addEventListener('click', async () => {
  setStatus('Probing…');
  const response = await chrome.runtime.sendMessage({ type: 'probeActiveTab' });
  setStatus(response?.ok ? 'Probe sent' : shortError(response));
});

elements.deleteButton.addEventListener('click', async () => {
  if (!state.selected.size || state.deletionRunning) {
    return;
  }
  state.deletionRunning = true;
  updateButtons();
  setStatus('Deleting…');
  const response = await chrome.runtime.sendMessage({
    type: 'deleteSelected',
    convoIds: Array.from(state.selected)
  });
  if (!response?.ok) {
    state.deletionRunning = false;
    updateButtons();
    setStatus(shortError(response));
  }
});

elements.cancelButton.addEventListener('click', async () => {
  if (!state.deletionRunning) {
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'deleteSelected', cancel: true });
  setStatus(response?.ok ? 'Cancel sent' : shortError(response));
});

elements.reEvaluate.addEventListener('click', async () => {
  setStatus('Re-checking…');
  const ids = state.selected.size ? Array.from(state.selected) : undefined;
  const response = await chrome.runtime.sendMessage({ type: 'reEvaluateSelected', convoIds: ids });
  setStatus(response?.ok ? 'Eligibility updated' : shortError(response));
});

elements.showAll.addEventListener('change', () => {
  state.showAll = elements.showAll.checked;
  reload();
});

elements.selectAll.addEventListener('change', () => {
  if (!state.items.length) {
    elements.selectAll.checked = false;
    return;
  }
  if (elements.selectAll.checked) {
    state.items.forEach((item) => state.selected.add(item.convoId));
  } else {
    state.selected.clear();
  }
  render();
});

settingsElements.riskyEnabled.addEventListener('change', () => {
  settingsState = {
    ...settingsState,
    risky: { ...settingsState.risky, enabled: settingsElements.riskyEnabled.checked }
  };
  chrome.storage.local.set({ [SETTINGS_KEY]: settingsState });
  setStatus(settingsElements.riskyEnabled.checked ? 'Risky on' : 'Risky off');
});

settingsElements.dryRun.addEventListener('change', () => {
  settingsState = {
    ...settingsState,
    risky: { ...settingsState.risky, dry_run: settingsElements.dryRun.checked }
  };
  chrome.storage.local.set({ [SETTINGS_KEY]: settingsState });
  setStatus(settingsElements.dryRun.checked ? 'Dry run on' : 'Dry run off');
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'listUpdated') {
    reload();
  } else if (message.type === 'deleteProgress') {
    state.deletionRunning = true;
    const payload = message.payload || {};
    setStatus(`Deleting ${payload.done || 0}/${payload.total || 0}`);
    if (payload.done >= payload.total) {
      state.deletionRunning = false;
      state.selected.clear();
      updateButtons();
      setStatus('Delete done');
    }
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

async function loadSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  settingsState = normalizeSettings(stored?.[SETTINGS_KEY]);
  applySettingsToUi();
}

async function reload() {
  const response = await chrome.runtime.sendMessage({ type: 'getList', showAll: state.showAll });
  if (!response?.ok) {
    setStatus(shortError(response));
    return;
  }
  state.items = response.items || [];
  const present = new Set(state.items.map((item) => item.convoId));
  Array.from(state.selected).forEach((id) => {
    if (!present.has(id)) {
      state.selected.delete(id);
    }
  });
  render();
  setStatus(`Loaded ${state.items.length}`);
}

function render() {
  elements.tableBody.innerHTML = '';
  if (!state.items.length) {
    elements.emptyState.hidden = false;
    elements.selectAll.checked = false;
    updateButtons();
    return;
  }
  elements.emptyState.hidden = true;
  const fragment = document.createDocumentFragment();
  state.items.forEach((item) => {
    const row = document.createElement('tr');
    const checkboxCell = document.createElement('td');
    checkboxCell.className = 'col-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(item.convoId);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        state.selected.add(item.convoId);
      } else {
        state.selected.delete(item.convoId);
        elements.selectAll.checked = false;
      }
      updateButtons();
    });
    checkboxCell.appendChild(checkbox);
    row.appendChild(checkboxCell);

    row.appendChild(cell(formatTime(item.createdAt), 'col-time'));
    row.appendChild(cell(item.userText || '—'));
    row.appendChild(cell(item.assistantHTML ? 'Yes' : 'No'));
    row.appendChild(cell(`${item.counts?.user || 0}/${item.counts?.assistant || 0}`));
    row.appendChild(cell(item.eligible ? '—' : item.eligibilityReason || '—'));
    row.appendChild(cell(formatDeletion(item)));

    const actionsCell = document.createElement('td');
    actionsCell.className = 'col-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Open';
    openBtn.className = 'secondary';
    openBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: getConvoUrl(item.convoId) });
    });
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = 'Export';
    exportBtn.className = 'secondary';
    exportBtn.addEventListener('click', () => exportItem(item));
    actionsCell.appendChild(openBtn);
    actionsCell.appendChild(exportBtn);
    row.appendChild(actionsCell);

    fragment.appendChild(row);
  });
  elements.tableBody.appendChild(fragment);
  elements.selectAll.checked = state.items.every((item) => state.selected.has(item.convoId));
  updateButtons();
}

function cell(content, className) {
  const td = document.createElement('td');
  if (className) {
    td.className = className;
  }
  if (typeof content === 'string') {
    td.textContent = content;
  } else if (content instanceof HTMLElement) {
    td.appendChild(content);
  }
  return td;
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

function formatDeletion(item) {
  if (!item.lastDeletionAttemptAt) {
    return '—';
  }
  const badge = document.createElement('span');
  badge.className = 'status-pill ' + (item.lastDeletionOutcome === 'ok' ? 'status-pill--ok' : 'status-pill--fail');
  badge.textContent = item.lastDeletionOutcome === 'ok' ? 'OK' : 'FAIL';
  if (item.lastDeletionReason) {
    badge.title = item.lastDeletionReason;
  }
  return badge;
}

function exportItem(item) {
  const data = {
    convoId: item.convoId,
    createdAt: item.createdAt,
    userText: item.userText,
    assistantHTML: item.assistantHTML
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${item.convoId}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus('Exported');
}

function applySettingsToUi() {
  settingsElements.riskyEnabled.checked = Boolean(settingsState.risky?.enabled);
  settingsElements.dryRun.checked = Boolean(settingsState.risky?.dry_run);
}

function setStatus(message) {
  elements.status.textContent = message || '';
}

function shortError(response) {
  return response?.error ? `Error: ${response.error}` : 'Action failed';
}

function updateButtons() {
  elements.deleteButton.disabled = !state.selected.size || state.deletionRunning;
  elements.cancelButton.disabled = !state.deletionRunning;
}
