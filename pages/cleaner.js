import { DEFAULT_SETTINGS, DeletionStrategyIds, normalizeSettings } from '../utils.js';

const tableBody = document.getElementById('backup-body');
const selectAllInput = document.getElementById('select-all');
const selectionCounter = document.getElementById('selection-counter');
const openNextButton = document.getElementById('open-next-button');
const refreshButton = document.getElementById('refresh-button');
const scanButton = document.getElementById('scan-button');
const emptyState = document.getElementById('empty-state');
const settingsForm = document.getElementById('settings-form');
const debugPanel = document.getElementById('debug-panel');
const logsOutput = document.getElementById('logs-output');
const refreshLogsButton = document.getElementById('refresh-logs');
const clearLogsButton = document.getElementById('clear-logs');
const statusRoot = document.getElementById('status-root');

let backups = [];
let selectedIds = new Set();
let settings = { ...DEFAULT_SETTINGS };

void bootstrap();

/** Slovensky: Inicializuje rozhranie čističa. */
async function bootstrap() {
  bindEvents();
  await loadSettings();
  await loadBackups();
  updateSelectionState();
}

/** Slovensky: Naviaže udalosti na prvky UI. */
function bindEvents() {
  refreshButton.addEventListener('click', () => {
    void loadBackups();
  });
  scanButton.addEventListener('click', () => {
    void requestManualScan();
  });
  openNextButton.addEventListener('click', () => {
    void openSelected();
  });
  selectAllInput.addEventListener('change', () => {
    toggleSelectAll(selectAllInput.checked);
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

/** Slovensky: Načíta nastavenia zo služby v pozadí. */
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
  toggleDebugPanel();
}

/** Slovensky: Aplikuje nastavenia do formulára. */
function applySettingsToForm() {
  settingsForm.maxMessageCount.value = settings.maxMessageCount;
  settingsForm.maxAgeMinutes.value = settings.maxAgeMinutes;
  settingsForm.maxPromptLength.value = settings.maxPromptLength;
  settingsForm.maxAnswerLength.value = settings.maxAnswerLength;
  settingsForm.batchSize.value = settings.batchSize;
  settingsForm.deletionStrategyId.value = settings.deletionStrategyId || DeletionStrategyIds.MANUAL_OPEN;
  settingsForm.debugLogs.checked = Boolean(settings.debugLogs);
  updateBatchLabel();
}

/** Slovensky: Uloží nastavenia cez background. */
async function saveSettings() {
  const update = {
    maxMessageCount: Number.parseInt(settingsForm.maxMessageCount.value, 10),
    maxAgeMinutes: Number.parseInt(settingsForm.maxAgeMinutes.value, 10),
    maxPromptLength: Number.parseInt(settingsForm.maxPromptLength.value, 10),
    maxAnswerLength: Number.parseInt(settingsForm.maxAnswerLength.value, 10),
    batchSize: Number.parseInt(settingsForm.batchSize.value, 10),
    deletionStrategyId: settingsForm.deletionStrategyId.value,
    debugLogs: settingsForm.debugLogs.checked
  };
  const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', update });
  if (response?.ok) {
    settings = normalizeSettings(response.settings || {});
    applySettingsToForm();
    toggleDebugPanel();
    await showStatus('Settings saved');
  } else {
    await showStatus('Failed to save settings');
  }
}

/** Slovensky: Prepína panel debug logu. */
function toggleDebugPanel() {
  debugPanel.hidden = !settings.debugLogs;
  if (settings.debugLogs) {
    void loadLogs();
  } else {
    logsOutput.textContent = '(debug disabled)';
  }
}

/** Slovensky: Aktualizuje text tlačidla pre otváranie dávky. */
function updateBatchLabel() {
  openNextButton.textContent = `Open next (${settings.batchSize})`;
}

/** Slovensky: Načíta uložené logy. */
async function loadLogs() {
  if (!settings.debugLogs) {
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
  if (response?.ok && Array.isArray(response.logs)) {
    const formatted = response.logs.map(formatLogEntry).join('\n');
    logsOutput.textContent = formatted || '(no entries)';
  }
}

/** Slovensky: Vymaže debug logy. */
async function clearLogs() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
  logsOutput.textContent = '(cleared)';
}

/** Slovensky: Formátuje položku logu. */
function formatLogEntry(entry) {
  const date = new Date(entry.timestamp || Date.now()).toISOString();
  const scope = entry.scope || 'general';
  const level = entry.level || 'info';
  const message = entry.message || '';
  const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
  return `[${date}] [${level}] [${scope}] ${message}${meta}`;
}

/** Slovensky: Načíta zálohy z pozadia. */
async function loadBackups() {
  const response = await chrome.runtime.sendMessage({ type: 'LIST_BACKUPS' });
  if (!response?.ok) {
    await showStatus('Failed to load backups');
    return;
  }
  backups = Array.isArray(response.items) ? response.items : [];
  renderBackups();
}

/** Slovensky: Vyrenderuje tabuľku záloh. */
function renderBackups() {
  tableBody.textContent = '';
  if (!backups.length) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;
  const fragment = document.createDocumentFragment();
  backups.forEach((item) => {
    fragment.appendChild(renderRow(item));
  });
  tableBody.appendChild(fragment);
  syncSelection();
}

/** Slovensky: Vytvorí riadok tabuľky pre zálohu. */
function renderRow(item) {
  const row = document.createElement('tr');

  const selectCell = document.createElement('td');
  selectCell.className = 'col-select';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selectedIds.has(item.id);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) {
      selectedIds.add(item.id);
    } else {
      selectedIds.delete(item.id);
    }
    updateSelectionState();
  });
  selectCell.appendChild(checkbox);

  const timeCell = document.createElement('td');
  timeCell.className = 'col-time';
  timeCell.textContent = formatTimestamp(item.createdAt || item.capturedAt);

  const promptCell = document.createElement('td');
  promptCell.textContent = previewPrompt(item.userPrompt || '');

  const backupCell = document.createElement('td');
  backupCell.textContent = item.answerHTML ? 'Yes' : 'No';

  const actionsCell = document.createElement('td');
  actionsCell.className = 'col-actions';
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'secondary';
  openButton.textContent = 'Open';
  openButton.addEventListener('click', () => {
    void openLinks([item.url || `https://chatgpt.com/c/${item.convoId}`]);
  });
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'secondary';
  exportButton.textContent = 'Export';
  exportButton.style.marginLeft = '6px';
  exportButton.addEventListener('click', () => {
    void exportBackup(item.id);
  });
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'secondary';
  deleteButton.textContent = 'Forget';
  deleteButton.style.marginLeft = '6px';
  deleteButton.addEventListener('click', () => {
    void deleteBackup(item.id);
  });
  actionsCell.append(openButton, exportButton, deleteButton);

  row.append(selectCell, timeCell, promptCell, backupCell, actionsCell);
  return row;
}

/** Slovensky: Formátuje čas pre zobrazenie. */
function formatTimestamp(ms) {
  const date = new Date(ms || Date.now());
  return date.toLocaleString();
}

/** Slovensky: Reže prompt pre prehľadné zobrazenie. */
function previewPrompt(prompt) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 140) {
    return trimmed;
  }
  return `${trimmed.slice(0, 137)}...`;
}

/** Slovensky: Synchronizuje výber so zoznamom záznamov. */
function syncSelection() {
  const validIds = new Set(backups.map((item) => item.id));
  selectedIds.forEach((id) => {
    if (!validIds.has(id)) {
      selectedIds.delete(id);
    }
  });
  updateSelectionState();
}

/** Slovensky: Aktualizuje stav vybraných riadkov. */
function updateSelectionState() {
  selectionCounter.textContent = `${selectedIds.size} selected`;
  openNextButton.disabled = selectedIds.size === 0;
  selectAllInput.checked = backups.length > 0 && selectedIds.size === backups.length;
  selectAllInput.indeterminate = selectedIds.size > 0 && selectedIds.size < backups.length;
}

/** Slovensky: Prepne výber všetkých záznamov. */
function toggleSelectAll(checked) {
  if (checked) {
    backups.forEach((item) => selectedIds.add(item.id));
  } else {
    selectedIds.clear();
  }
  renderBackups();
}

/** Slovensky: Požiada background o otvorenie vybraných konverzácií. */
async function openSelected() {
  const urls = backups
    .filter((item) => selectedIds.has(item.id))
    .map((item) => item.url || `https://chatgpt.com/c/${item.convoId}`);
  const opened = await openLinks(urls);
  if (opened >= 0) {
    await showStatus(`Opened ${opened} tab(s)`);
  }
}

/** Slovensky: Pošle URLs na otvorenie do pozadia. */
async function openLinks(urls) {
  if (!urls.length) {
    return 0;
  }
  const response = await chrome.runtime.sendMessage({ type: 'OPEN_NEXT', urls });
  if (!response?.ok) {
    await showStatus('Unable to open tabs');
    return -1;
  }
  return Number(response.opened) || 0;
}

/** Slovensky: Zavolá export konkrétnej zálohy. */
async function exportBackup(id) {
  const response = await chrome.runtime.sendMessage({ type: 'EXPORT_BACKUP', id });
  if (!response?.ok) {
    await showStatus('Export failed');
    return;
  }
  const blob = new Blob([response.html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = response.filename || 'chat.html';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 0);
}

/** Slovensky: Odstráni miestnu zálohu. */
async function deleteBackup(id) {
  await chrome.runtime.sendMessage({ type: 'DELETE_BACKUP', id });
  selectedIds.delete(id);
  await loadBackups();
  await showStatus('Backup forgotten');
}

/** Slovensky: Vyžiada manuálny scan otvorených tabov. */
async function requestManualScan() {
  const response = await chrome.runtime.sendMessage({ type: 'REQUEST_SCAN' });
  if (response?.ok) {
    await showStatus(`Scan requested (${response.dispatched || 0} tab(s))`);
  } else {
    await showStatus('Unable to trigger scan');
  }
}

/** Slovensky: Zobrazí krátke toast hlásenie. */
async function showStatus(text) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  statusRoot.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  await new Promise((resolve) => setTimeout(resolve, 1800));
  toast.classList.remove('show');
  setTimeout(() => {
    toast.remove();
  }, 200);
}

