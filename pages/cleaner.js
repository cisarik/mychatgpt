import { DEFAULT_SETTINGS, getConvoUrl, isRiskySessionActive, normalizeSettings } from '../utils.js';

const tableBody = document.getElementById('backup-body');
const selectAllInput = document.getElementById('select-all');
const selectionCounter = document.getElementById('selection-counter');
const openNextButton = document.getElementById('open-next-button');
const deleteSelectedButton = document.getElementById('delete-selected-button');
const cancelDeletionButton = document.getElementById('cancel-deletion-button');
const testSelectorsButton = document.getElementById('test-selectors-button');
const refreshButton = document.getElementById('refresh-button');
const scanButton = document.getElementById('scan-button');
const emptyState = document.getElementById('empty-state');
const settingsForm = document.getElementById('settings-form');
const riskyModeCheckbox = document.getElementById('risky_mode_enabled');
const riskySessionStatus = document.getElementById('risky-session-status');
const riskyEnableSessionButton = document.getElementById('risky-enable-session');
const dryRunInput = document.getElementById('dry_run');
const riskyStepTimeoutInput = document.getElementById('risky_step_timeout_ms');
const riskyBetweenTabsInput = document.getElementById('risky_between_tabs_ms');
const riskyMaxRetriesInput = document.getElementById('risky_max_retries');
const jitterMinInput = document.getElementById('risky_jitter_min');
const jitterMaxInput = document.getElementById('risky_jitter_max');
const debugToggle = document.getElementById('debugLogs');
const statusRoot = document.getElementById('status-root');

let backups = [];
let selectedIds = new Set();
let settings = { ...DEFAULT_SETTINGS };
let busy = false;

cancelDeletionButton.disabled = true;

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
  deleteSelectedButton.addEventListener('click', () => {
    void runDeletion();
  });
  cancelDeletionButton.addEventListener('click', () => {
    void cancelDeletion();
  });
  testSelectorsButton.addEventListener('click', () => {
    void testSelectors();
  });
  selectAllInput.addEventListener('change', () => {
    toggleSelectAll(selectAllInput.checked);
  });
  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSettings();
  });
  riskyEnableSessionButton.addEventListener('click', () => {
    void enableRiskySession();
  });
  riskyModeCheckbox.addEventListener('change', () => {
    settings.risky_mode_enabled = riskyModeCheckbox.checked;
    if (!settings.risky_mode_enabled) {
      settings.risky_session_until = null;
    }
    updateRiskySessionStatus();
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
  updateRiskySessionStatus();
}

/** Slovensky: Aplikuje nastavenia do formulára. */
function applySettingsToForm() {
  settingsForm.maxMessageCount.value = settings.maxMessageCount;
  settingsForm.maxAgeMinutes.value = settings.maxAgeMinutes;
  settingsForm.maxPromptLength.value = settings.maxPromptLength;
  settingsForm.maxAnswerLength.value = settings.maxAnswerLength;
  settingsForm.batchSize.value = settings.batchSize;
  debugToggle.checked = Boolean(settings.debugLogs);
  riskyModeCheckbox.checked = Boolean(settings.risky_mode_enabled);
  dryRunInput.checked = Boolean(settings.dry_run);
  riskyStepTimeoutInput.value = settings.risky_step_timeout_ms;
  riskyBetweenTabsInput.value = settings.risky_between_tabs_ms;
  riskyMaxRetriesInput.value = settings.risky_max_retries;
  jitterMinInput.value = settings.risky_jitter_ms?.[0] ?? DEFAULT_SETTINGS.risky_jitter_ms[0];
  jitterMaxInput.value = settings.risky_jitter_ms?.[1] ?? DEFAULT_SETTINGS.risky_jitter_ms[1];
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
    debugLogs: debugToggle.checked,
    risky_mode_enabled: riskyModeCheckbox.checked,
    dry_run: dryRunInput.checked,
    risky_step_timeout_ms: Number.parseInt(riskyStepTimeoutInput.value, 10),
    risky_between_tabs_ms: Number.parseInt(riskyBetweenTabsInput.value, 10),
    risky_max_retries: Number.parseInt(riskyMaxRetriesInput.value, 10),
    risky_jitter_ms: [Number.parseInt(jitterMinInput.value, 10), Number.parseInt(jitterMaxInput.value, 10)]
  };
  const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', update });
  if (response?.ok) {
    settings = normalizeSettings(response.settings || {});
    applySettingsToForm();
    updateRiskySessionStatus();
    await showStatus('Settings saved');
  } else {
    await showStatus('Failed to save settings');
  }
}

/** Slovensky: Aktualizuje text tlačidla pre otváranie dávky. */
function updateBatchLabel() {
  openNextButton.textContent = `Open next ${settings.batchSize} (manual)`;
}

/** Slovensky: Aktualizuje informáciu o trvaní riskantnej relácie. */
function updateRiskySessionStatus() {
  if (!settings.risky_mode_enabled) {
    riskySessionStatus.textContent = 'Risky mode disabled';
    return;
  }
  if (isRiskySessionActive(settings)) {
    const remainingMs = Math.max(0, (settings.risky_session_until || 0) - Date.now());
    const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
    riskySessionStatus.textContent = `Session active (${minutes} min left)`;
  } else {
    riskySessionStatus.textContent = 'Session inactive – extend to run automation';
  }
}

/** Slovensky: Prepína busy stav pri rizikovom mazaní. */
function setBusy(state) {
  busy = state;
  cancelDeletionButton.disabled = !state;
  updateSelectionState();
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

  const statusCell = document.createElement('td');
  statusCell.className = 'col-status';
  const statusInfo = formatDeletionStatus(item);
  statusCell.textContent = statusInfo.text;
  if (statusInfo.title) {
    statusCell.title = statusInfo.title;
  }

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

  row.append(selectCell, timeCell, promptCell, backupCell, statusCell, actionsCell);
  return row;
}

/** Slovensky: Formátuje čas pre zobrazenie. */
function formatTimestamp(ms) {
  const date = new Date(ms || Date.now());
  return date.toLocaleString();
}

/** Slovensky: Formátuje výsledok posledného mazania. */
function formatDeletionStatus(item) {
  const outcome = item.lastDeletionOutcome;
  if (!outcome) {
    return { text: '—', title: '' };
  }
  const strategy = outcome.strategyId === 'ui-automation' ? 'automation' : 'manual';
  const reasonLabel = formatOutcomeReason(outcome);
  const since = item.lastDeletionAttemptAt ? formatRelativeTime(item.lastDeletionAttemptAt) : '';
  const text = since ? `${reasonLabel} (${since})` : reasonLabel;
  const detailParts = [reasonLabel, `via ${strategy}`];
  if (outcome.dryRun) {
    detailParts.push('dry-run');
  }
  if (outcome.step) {
    detailParts.push(`step: ${outcome.step}`);
  }
  return { text, title: detailParts.join(' · ') };
}

function formatOutcomeReason(outcome) {
  const mapping = {
    deleted: 'Deleted',
    dry_run: 'Dry run',
    manual_open: 'Opened manually',
    manual_fallback: 'Manual fallback',
    already_open: 'Already open',
    verify_timeout: 'Verify timeout',
    not_logged_in: 'Not logged in',
    automation_failed: 'Automation failed'
  };
  if (outcome.ok) {
    return 'Deleted';
  }
  if (outcome.reason && mapping[outcome.reason]) {
    return mapping[outcome.reason];
  }
  return outcome.reason ? outcome.reason.replace(/_/g, ' ') : 'Unknown';
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 0) {
    return 'now';
  }
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) {
    return 'moments ago';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} d ago`;
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
  const hasSelection = selectedIds.size > 0;
  openNextButton.disabled = !hasSelection || busy;
  deleteSelectedButton.disabled = !hasSelection || busy;
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
  if (busy) {
    return;
  }
  const urls = backups
    .filter((item) => selectedIds.has(item.id))
    .map((item) => item.url || getConvoUrl(item.convoId));
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

/** Slovensky: Spustí mazanie cez pozadie. */
async function runDeletion() {
  if (!selectedIds.size || busy) {
    return;
  }
  setBusy(true);
  try {
    const payload = backups
      .filter((item) => selectedIds.has(item.id))
      .map((item) => ({ convoId: item.convoId, url: item.url || getConvoUrl(item.convoId) }));
    const response = await chrome.runtime.sendMessage({ type: 'DELETE_SELECTED', selection: payload });
    if (response?.ok) {
      const report = response.report || {};
      const okCount = Array.isArray(report.results) ? report.results.filter((entry) => entry.ok).length : 0;
      const manualOpen = Array.isArray(report.results)
        ? report.results.filter((entry) => entry.reason === 'manual_open' || entry.reason === 'manual_fallback').length
        : 0;
      if (okCount > 0) {
        await showStatus(`Deleted ${okCount} chat(s)`);
      } else if (manualOpen > 0) {
        await showStatus(`Opened ${manualOpen} tab(s) for manual cleanup`);
      } else {
        await showStatus('Deletion flow completed');
      }
      selectedIds.clear();
      await loadBackups();
      updateSelectionState();
    } else {
      await showStatus('Deletion failed');
    }
  } catch (_error) {
    await showStatus('Deletion failed');
  } finally {
    setBusy(false);
  }
}

/** Slovensky: Požiada o zrušenie mazacej dávky. */
async function cancelDeletion() {
  await chrome.runtime.sendMessage({ type: 'CANCEL_DELETION' });
  await showStatus('Cancel requested');
}

/** Slovensky: Spustí test selektorov na aktívnej karte. */
async function testSelectors() {
  testSelectorsButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'TEST_SELECTORS_ON_ACTIVE_TAB' });
    if (response?.ok) {
      const result = response.result || {};
      const summary = ['kebab', 'deleteMenu', 'confirm']
        .map((key) => `${key}:${result[key] ? '✓' : '×'}`)
        .join(' ');
      await showStatus(`Selector probe: ${summary}`);
    } else {
      await showStatus('Selector probe failed');
    }
  } catch (_error) {
    await showStatus('Selector probe failed');
  } finally {
    testSelectorsButton.disabled = false;
  }
}

/** Slovensky: Zapne risk mód na 10 minút. */
async function enableRiskySession() {
  const update = {
    risky_mode_enabled: true,
    risky_session_until: Date.now() + 10 * 60 * 1000
  };
  const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', update });
  if (response?.ok) {
    settings = normalizeSettings(response.settings || {});
    applySettingsToForm();
    updateRiskySessionStatus();
    await showStatus('Risky mode enabled for 10 min');
  } else {
    await showStatus('Unable to extend session');
  }
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
