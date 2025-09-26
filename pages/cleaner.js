import { DEFAULT_SETTINGS, normalizeSettings } from '../utils.js';

const listHost = document.getElementById('backup-list');
const selectionCountEl = document.getElementById('selection-count');
const refreshButton = document.getElementById('refresh');
const openSelectedButton = document.getElementById('open-selected');
const deleteSelectedButton = document.getElementById('delete-selected');
const settingsForm = document.getElementById('settings-form');
const logsSection = document.getElementById('logs-section');
const logsOutput = document.getElementById('logs-output');
const refreshLogsButton = document.getElementById('refresh-logs');
const clearLogsButton = document.getElementById('clear-logs');

let backups = [];
let selectedIds = new Set();
let settings = { ...DEFAULT_SETTINGS };

/**
 * Slovensky: Inicializácia udalostí a prvotné načítanie dát.
 */
async function bootstrap() {
  bindEvents();
  await loadSettings();
  await loadBackups();
  updateSelectionState();
}

function bindEvents() {
  refreshButton.addEventListener('click', () => {
    void loadBackups();
  });
  openSelectedButton.addEventListener('click', () => {
    void openSelected();
  });
  deleteSelectedButton.addEventListener('click', () => {
    void deleteSelected();
  });
  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings();
  });
  refreshLogsButton.addEventListener('click', () => {
    void loadLogs();
  });
  clearLogsButton.addEventListener('click', () => {
    void clearLogs();
  });
}

async function loadSettings() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response?.ok) {
      settings = normalizeSettings(response.settings || {});
    }
  } catch (_error) {
    settings = { ...DEFAULT_SETTINGS };
  }
  applySettingsToForm();
  toggleLogsSection();
}

function applySettingsToForm() {
  settingsForm.maxMessageCount.value = settings.maxMessageCount;
  settingsForm.maxAgeMinutes.value = settings.maxAgeMinutes;
  settingsForm.maxPromptLength.value = settings.maxPromptLength;
  settingsForm.batchSize.value = settings.batchSize;
  settingsForm.debugEnabled.checked = Boolean(settings.debugEnabled);
  refreshOpenButtonLabel();
}

async function saveSettings() {
  const next = {
    maxMessageCount: Number.parseInt(settingsForm.maxMessageCount.value, 10),
    maxAgeMinutes: Number.parseInt(settingsForm.maxAgeMinutes.value, 10),
    maxPromptLength: Number.parseInt(settingsForm.maxPromptLength.value, 10),
    batchSize: Number.parseInt(settingsForm.batchSize.value, 10),
    debugEnabled: settingsForm.debugEnabled.checked
  };
  const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', update: next });
  if (response?.ok) {
    settings = normalizeSettings(response.settings || {});
    applySettingsToForm();
    toggleLogsSection();
    await showStatus('Settings saved');
  } else {
    await showStatus('Failed to save settings');
  }
}

function toggleLogsSection() {
  logsSection.hidden = !settings.debugEnabled;
  if (!settings.debugEnabled) {
    logsOutput.textContent = '(debug disabled)';
  } else {
    void loadLogs();
  }
}

function refreshOpenButtonLabel() {
  openSelectedButton.textContent = `Open next (${settings.batchSize})`;
}

async function loadLogs() {
  if (!settings.debugEnabled) {
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
  if (response?.ok && Array.isArray(response.logs)) {
    const formatted = response.logs
      .map((entry) => formatLog(entry))
      .join('\n');
    logsOutput.textContent = formatted || '(no entries)';
  }
}

async function clearLogs() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
  logsOutput.textContent = '(cleared)';
}

function formatLog(entry) {
  const date = new Date(entry.timestamp || Date.now()).toISOString();
  const scope = entry.scope || 'general';
  const level = entry.level || 'info';
  const message = entry.message || '';
  const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
  return `[${date}] [${level}] [${scope}] ${message}${meta}`;
}

async function loadBackups() {
  const response = await chrome.runtime.sendMessage({ type: 'LIST_BACKUPS' });
  if (!response?.ok) {
    await showStatus('Failed to load backups');
    return;
  }
  backups = Array.isArray(response.items) ? response.items : [];
  renderBackups();
}

function renderBackups() {
  listHost.innerHTML = '';
  if (!backups.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No captured conversations yet.';
    listHost.appendChild(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  backups.forEach((item) => {
    const card = renderBackupCard(item);
    fragment.appendChild(card);
  });
  listHost.appendChild(fragment);
  syncSelectionWithList();
}

function renderBackupCard(item) {
  const wrapper = document.createElement('article');
  wrapper.className = 'backup-card';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'backup-select';
  checkbox.dataset.id = item.id;
  checkbox.checked = selectedIds.has(item.id);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      selectedIds.add(item.id);
    } else {
      selectedIds.delete(item.id);
    }
    updateSelectionState();
  });

  const main = document.createElement('div');
  main.className = 'backup-main';

  const title = document.createElement('h3');
  title.className = 'backup-title';
  title.textContent = item.title || 'Untitled';

  const meta = document.createElement('p');
  meta.className = 'backup-meta';
  const created = new Date(item.createdAt || item.timestamp || Date.now());
  meta.textContent = `${created.toLocaleString()} • messages: ${item.messageCount ?? 0}`;

  const prompt = document.createElement('p');
  prompt.className = 'backup-prompt';
  prompt.textContent = item.questionText || '';

  main.appendChild(title);
  main.appendChild(meta);
  if (prompt.textContent) {
    main.appendChild(prompt);
  }

  const actions = document.createElement('div');
  actions.className = 'backup-actions';

  const openLink = document.createElement('a');
  openLink.href = item.url || `https://chatgpt.com/c/${item.convoId}`;
  openLink.target = '_blank';
  openLink.rel = 'noopener noreferrer';
  openLink.textContent = 'Open';
  openLink.className = 'link-button';

  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'secondary';
  exportButton.textContent = 'Export';
  exportButton.addEventListener('click', () => {
    void exportBackup(item.id);
  });

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'secondary';
  deleteButton.textContent = 'Delete';
  deleteButton.addEventListener('click', () => {
    void deleteOne(item.id);
  });

  actions.appendChild(openLink);
  actions.appendChild(exportButton);
  actions.appendChild(deleteButton);

  wrapper.appendChild(checkbox);
  wrapper.appendChild(main);
  wrapper.appendChild(actions);
  return wrapper;
}

function syncSelectionWithList() {
  const availableIds = new Set(backups.map((item) => item.id));
  selectedIds.forEach((id) => {
    if (!availableIds.has(id)) {
      selectedIds.delete(id);
    }
  });
  updateSelectionState();
}

function updateSelectionState() {
  const count = selectedIds.size;
  selectionCountEl.textContent = `${count} selected`;
  openSelectedButton.disabled = count === 0;
  deleteSelectedButton.disabled = count === 0;
}

async function openSelected() {
  const ordered = backups
    .filter((item) => selectedIds.has(item.id))
    .map((item) => item.url || `https://chatgpt.com/c/${item.convoId}`);
  if (!ordered.length) {
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'OPEN_BATCH', urls: ordered });
  if (response?.ok) {
    await showStatus(`Opened ${response.opened ?? 0} tabs`);
  } else {
    await showStatus('Unable to open tabs');
  }
}

async function deleteSelected() {
  const items = Array.from(selectedIds);
  for (const id of items) {
    await chrome.runtime.sendMessage({ type: 'DELETE_BACKUP', id });
    selectedIds.delete(id);
  }
  await loadBackups();
  await showStatus('Deleted selected backups');
}

async function deleteOne(id) {
  await chrome.runtime.sendMessage({ type: 'DELETE_BACKUP', id });
  selectedIds.delete(id);
  await loadBackups();
  await showStatus('Backup deleted');
}

async function exportBackup(id) {
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_BACKUP', id });
  if (!response?.ok) {
    await showStatus('Failed to export');
    return;
  }
  const blob = new Blob([response.html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = response.filename || 'backup.html';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

async function showStatus(text) {
  const banner = document.createElement('div');
  banner.className = 'toast inline';
  banner.textContent = text;
  document.body.appendChild(banner);
  setTimeout(() => {
    banner.classList.add('show');
  }, 10);
  setTimeout(() => {
    banner.classList.remove('show');
    banner.remove();
  }, 2000);
}

void bootstrap();
