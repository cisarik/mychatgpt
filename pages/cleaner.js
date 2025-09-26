import { getConvoIdFromUrl, getConvoUrl, normalizeSettings, SETTINGS_KEY } from '../utils.js';

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
  deleteCurrentTab: document.getElementById('delete-current-tab-button'),
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

const confirmElements = {
  container: document.getElementById('inline-confirm'),
  accept: document.getElementById('inline-confirm-accept'),
  cancel: document.getElementById('inline-confirm-cancel')
};

const confirmState = {
  resolver: null
};

elements.scan.addEventListener('click', async () => {
  setStatus('Scanning…');
  const response = await sendMessageSafe({ type: 'scanAllChatgptTabs' });
  setStatus(response?.ok ? 'Scan done' : shortError(response));
});

elements.refresh.addEventListener('click', () => reload());

elements.forceCapture.addEventListener('click', async () => {
  setStatus('Capturing…');
  const response = await sendMessageSafe({ type: 'captureActiveTabNow' });
  setStatus(response?.ok ? 'Capture saved' : shortError(response));
});

elements.probe.addEventListener('click', async () => {
  setStatus('Probing…');
  const response = await sendMessageSafe({ type: 'probeActiveTab' });
  setStatus(response?.ok ? 'Probe sent' : shortError(response));
});

elements.deleteCurrentTab.addEventListener('click', async () => {
  if (state.deletionRunning) {
    return;
  }
  const convoId = await getActiveConvoId();
  if (!convoId) {
    setStatus('Error: not a ChatGPT tab');
    return;
  }
  const item = findItem(convoId);
  if (item && !item.eligible) {
    const confirmed = await requestInlineConfirm();
    if (!confirmed) {
      setStatus('Cancelled');
      return;
    }
  }
  state.deletionRunning = true;
  updateButtons();
  setStatus('Deleting current…');
  const response = await sendMessageSafe({ type: 'deleteCurrentTab' });
  state.deletionRunning = false;
  updateButtons();
  await reload();
  setStatus(response?.ok ? 'Deleted ✓' : 'Failed — see tab console');
});

elements.deleteButton.addEventListener('click', async () => {
  if (!state.selected.size || state.deletionRunning) {
    return;
  }
  if (selectionNeedsConfirm()) {
    const confirmed = await requestInlineConfirm();
    if (!confirmed) {
      setStatus('Cancelled');
      return;
    }
  }
  state.deletionRunning = true;
  updateButtons();
  setStatus('Deleting…');
  const response = await sendMessageSafe({
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
  const response = await sendMessageSafe({ type: 'deleteSelected', cancel: true });
  setStatus(response?.ok ? 'Cancel sent' : shortError(response));
});

elements.reEvaluate.addEventListener('click', async () => {
  setStatus('Re-checking…');
  const ids = state.selected.size ? Array.from(state.selected) : undefined;
  const response = await sendMessageSafe({ type: 'reEvaluateSelected', convoIds: ids });
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

confirmElements.accept.addEventListener('click', () => resolveConfirm(true));
confirmElements.cancel.addEventListener('click', () => resolveConfirm(false));

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
  resolveConfirm(false);
  const response = await sendMessageSafe({ type: 'getList', showAll: state.showAll });
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
  if (!state.deletionRunning) {
    setStatus(`Loaded ${state.items.length}`);
  }
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
  const outcomeOk = item.lastDeletionOutcome === 'ok';
  const badge = document.createElement('span');
  badge.className = 'status-pill ' + (outcomeOk ? 'status-pill--ok' : 'status-pill--fail');
  badge.textContent = outcomeOk ? 'OK' : 'FAIL';
  if (item.lastDeletionReason) {
    badge.title = item.lastDeletionReason;
  }
  if (!outcomeOk) {
    return badge;
  }
  if (!item.deletedAt) {
    return badge;
  }
  const wrapper = document.createElement('span');
  const when = document.createElement('span');
  when.className = 'status-muted';
  when.textContent = formatTime(item.deletedAt);
  const deletedAtDate = new Date(item.deletedAt);
  if (!Number.isNaN(deletedAtDate.getTime())) {
    badge.title = deletedAtDate.toLocaleString();
  }
  wrapper.appendChild(badge);
  wrapper.appendChild(document.createTextNode(' '));
  wrapper.appendChild(when);
  return wrapper;
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
  updateButtons();
}

function setStatus(message) {
  elements.status.textContent = message || '';
}

function shortError(response) {
  return response?.error ? `Error: ${response.error}` : 'Action failed';
}

function updateButtons() {
  const busy = state.deletionRunning;
  const riskyEnabled = Boolean(settingsState.risky?.enabled);
  elements.deleteButton.disabled = !state.selected.size || busy || !riskyEnabled;
  elements.cancelButton.disabled = !busy;
  elements.deleteCurrentTab.disabled = busy || !riskyEnabled;
  elements.forceCapture.disabled = busy;
  elements.probe.disabled = busy;
  elements.scan.disabled = busy;
  elements.refresh.disabled = busy;
  elements.reEvaluate.disabled = busy;
  elements.selectAll.disabled = busy;
}

function selectionNeedsConfirm() {
  if (!state.selected.size) {
    return false;
  }
  for (const id of state.selected) {
    const item = findItem(id);
    if (item && !item.eligible) {
      return true;
    }
  }
  return false;
}

function findItem(convoId) {
  return state.items.find((item) => item.convoId === convoId);
}

function requestInlineConfirm() {
  resolveConfirm(false);
  confirmElements.container.hidden = false;
  queueMicrotask(() => confirmElements.accept.focus());
  return new Promise((resolve) => {
    confirmState.resolver = (value) => {
      confirmState.resolver = null;
      hideInlineConfirm();
      resolve(value);
    };
  });
}

function resolveConfirm(value) {
  if (typeof value !== 'boolean') {
    value = false;
  }
  if (confirmState.resolver) {
    const resolver = confirmState.resolver;
    confirmState.resolver = null;
    hideInlineConfirm();
    resolver(value);
  } else {
    hideInlineConfirm();
  }
}

function hideInlineConfirm() {
  confirmElements.container.hidden = true;
}

async function getActiveConvoId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return null;
  }
  return getConvoIdFromUrl(tab.url);
}

async function sendMessageSafe(payload) {
  try {
    return await chrome.runtime.sendMessage(payload);
  } catch (error) {
    return { ok: false, error: error?.message || 'message_failed' };
  }
}
