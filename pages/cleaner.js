import { DEFAULT_SETTINGS, DeletionStrategyIds, getConvoUrl, isRiskySessionActive, normalizeSettings } from '../utils.js';

const tableBody = document.getElementById('backup-body');
const selectAllInput = document.getElementById('select-all');
const selectionCounter = document.getElementById('selection-counter');
const openNextButton = document.getElementById('open-next-button');
const deleteSelectedButton = document.getElementById('delete-selected-button');
const cancelDeletionButton = document.getElementById('cancel-deletion-button');
const testSelectorsButton = document.getElementById('test-selectors-button');
const refreshButton = document.getElementById('refresh-button');
const forceCaptureButton = document.getElementById('force-capture-button');
const scanAllButton = document.getElementById('scan-all-button');
const reEvaluateButton = document.getElementById('re-evaluate-button');
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
const showAllToggle = document.getElementById('show-all-toggle');

let backups = [];
let selectedIds = new Set();
let settings = { ...DEFAULT_SETTINGS };
let busy = false;
let showAll = false;

cancelDeletionButton.disabled = true;

void bootstrap();

/** Slovensky: Inicializuje rozhranie čističa. */
async function bootstrap() {
  bindEvents();
  showAllToggle.checked = showAll;
  await loadSettings();
  await loadBackups();
  updateSelectionState();
}

/** Slovensky: Naviaže udalosti na prvky UI. */
function bindEvents() {
  refreshButton.addEventListener('click', () => {
    void loadBackups();
  });
  reEvaluateButton.addEventListener('click', () => {
    void reEvaluateEligibility();
  });
  forceCaptureButton.addEventListener('click', () => {
    void forceCaptureActiveTab();
  });
  scanAllButton.addEventListener('click', () => {
    void scanAllTabs();
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
  showAllToggle.addEventListener('change', () => {
    showAll = showAllToggle.checked;
    renderBackups();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'BACKUPS_UPDATED') {
      void loadBackups();
    }
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
  testSelectorsButton.disabled = state;
  refreshButton.disabled = state;
  forceCaptureButton.disabled = state;
  scanAllButton.disabled = state;
  reEvaluateButton.disabled = state;
  showAllToggle.disabled = state;
  riskyEnableSessionButton.disabled = state;
  settingsForm.querySelectorAll('input, button').forEach((node) => {
    if (node === cancelDeletionButton || node === riskyEnableSessionButton) {
      return;
    }
    node.disabled = state;
  });
  tableBody.querySelectorAll('input[type="checkbox"]').forEach((node) => {
    node.disabled = state;
  });
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
  const visible = getVisibleBackups();
  if (!visible.length) {
    emptyState.hidden = false;
    updateSelectionState();
    return;
  }
  emptyState.hidden = true;
  const fragment = document.createDocumentFragment();
  visible.forEach((item) => {
    fragment.appendChild(renderRow(item));
  });
  tableBody.appendChild(fragment);
  syncSelection(visible);
}

/** Slovensky: Určí zoznam viditeľných záznamov podľa filtra. */
function getVisibleBackups() {
  if (!Array.isArray(backups)) {
    return [];
  }
  if (showAll) {
    return [...backups];
  }
  return backups.filter((item) => item && item.eligible === true);
}

/** Slovensky: Vytvorí riadok tabuľky pre zálohu. */
function renderRow(item) {
  const row = document.createElement('tr');

  const selectCell = document.createElement('td');
  selectCell.className = 'col-select';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.disabled = busy;
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

  const turnsCell = document.createElement('td');
  turnsCell.textContent = formatTurns(item);

  const backupCell = document.createElement('td');
  backupCell.textContent = item.answerHTML ? 'Yes' : 'No';

  const eligibleCell = document.createElement('td');
  const eligibleFlag = item.eligible === false ? '×' : '✓';
  eligibleCell.textContent = eligibleFlag;

  const reasonCell = document.createElement('td');
  if (item.eligible === false) {
    const reasonText = formatEligibilityReason(item.eligibilityReason);
    reasonCell.textContent = reasonText;
    reasonCell.title = item.eligibilityReason || reasonText;
  } else {
    reasonCell.textContent = '—';
  }

  const statusCell = document.createElement('td');
  statusCell.className = 'col-status';
  const statusInfo = formatDeletionStatus(item);
  statusCell.textContent = '';
  if (statusInfo.pillText) {
    const pill = document.createElement('span');
    pill.className = statusInfo.pillClass;
    pill.textContent = statusInfo.pillText;
    statusCell.appendChild(pill);
  }
  if (statusInfo.since) {
    const sinceSpan = document.createElement('span');
    sinceSpan.className = 'status-muted';
    sinceSpan.style.marginLeft = '6px';
    sinceSpan.textContent = statusInfo.since;
    statusCell.appendChild(sinceSpan);
  }
  if (statusInfo.title) {
    statusCell.title = statusInfo.title;
  } else {
    statusCell.removeAttribute('title');
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

  row.append(selectCell, timeCell, promptCell, turnsCell, backupCell, eligibleCell, reasonCell, statusCell, actionsCell);
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
    return { pillText: '—', pillClass: 'status-pill', title: 'No attempts yet', since: '' };
  }
  const strategy = outcome.strategyId === DeletionStrategyIds.UI_AUTOMATION ? 'automation' : 'manual';
  const reasonLabel = formatOutcomeReason(outcome);
  const since = item.lastDeletionAttemptAt ? formatRelativeTime(item.lastDeletionAttemptAt) : '';
  const detailParts = [reasonLabel, `via ${strategy}`];
  if (outcome.dryRun) {
    detailParts.push('dry-run');
  }
  if (outcome.step) {
    detailParts.push(`step: ${outcome.step}`);
  }
  const title = detailParts.join(' · ');
  if (outcome.ok && outcome.reason === 'dry_run') {
    return { pillText: 'DRY', pillClass: 'status-pill status-pill--warn', title, since };
  }
  if (outcome.ok) {
    return { pillText: 'OK', pillClass: 'status-pill status-pill--ok', title, since };
  }
  return { pillText: 'FAIL', pillClass: 'status-pill status-pill--fail', title, since };
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
    automation_failed: 'Automation failed',
    risky_inactive: 'Risky mode inactive'
  };
  if (outcome.ok) {
    return 'Deleted';
  }
  if (outcome.reason && mapping[outcome.reason]) {
    return mapping[outcome.reason];
  }
  return outcome.reason ? outcome.reason.replace(/_/g, ' ') : 'Unknown';
}

/** Slovensky: Zobrazí počet turnov ako "u+a". */
function formatTurns(item) {
  if (!item || typeof item !== 'object') {
    return '0+0';
  }
  const messageCount = Number.isFinite(item.messageCount) ? Math.max(0, Math.floor(item.messageCount)) : 0;
  const userHasText = Boolean(String(item.userPrompt || '').trim());
  const assistantHasHtml = Boolean(String(item.answerHTML || '').trim());
  const user = coerceTurnDisplay(item.counts?.user, messageCount, 1, userHasText);
  const assistant = coerceTurnDisplay(item.counts?.assistant, messageCount, 2, assistantHasHtml);
  return `${user}+${assistant}`;
}

function coerceTurnDisplay(value, messageCount, threshold, hasText) {
  if (Number.isFinite(value)) {
    const floored = Math.floor(value);
    if (floored >= 1) {
      return 1;
    }
    return 0;
  }
  if (hasText) {
    return 1;
  }
  if (Number.isFinite(messageCount) && messageCount >= threshold) {
    return 1;
  }
  return 0;
}

/** Slovensky: Formátuje dôvod neeligibility. */
function formatEligibilityReason(code) {
  const mapping = {
    too_many_messages: 'Too many messages',
    too_old: 'Too old',
    too_long_prompt: 'Prompt too long',
    too_long_answer: 'Answer too long',
    empty_prompt: 'Empty prompt',
    empty_answer: 'Empty answer',
    no_turns: 'No turns',
    internal_count_error: 'Internal count error',
    has_attachments: 'Has attachments',
    invalid_summary: 'Invalid capture',
    unknown: 'Unknown'
  };
  if (!code) {
    return 'Unknown';
  }
  const key = String(code).toLowerCase();
  if (mapping[key]) {
    return mapping[key];
  }
  return key.replace(/_/g, ' ');
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
function syncSelection(visibleList = getVisibleBackups()) {
  const validIds = new Set(visibleList.map((item) => item.id));
  selectedIds.forEach((id) => {
    if (!validIds.has(id)) {
      selectedIds.delete(id);
    }
  });
  updateSelectionState(visibleList);
}

/** Slovensky: Aktualizuje stav vybraných riadkov. */
function updateSelectionState(visibleList = getVisibleBackups()) {
  selectionCounter.textContent = `${selectedIds.size} selected`;
  const hasSelection = selectedIds.size > 0;
  openNextButton.disabled = !hasSelection || busy;
  deleteSelectedButton.disabled = !hasSelection || busy;
  const totalVisible = visibleList.length;
  selectAllInput.disabled = busy || totalVisible === 0;
  selectAllInput.checked = totalVisible > 0 && selectedIds.size === totalVisible;
  selectAllInput.indeterminate = selectedIds.size > 0 && selectedIds.size < totalVisible;
}

/** Slovensky: Prepne výber všetkých záznamov. */
function toggleSelectAll(checked) {
  if (checked) {
    getVisibleBackups().forEach((item) => selectedIds.add(item.id));
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
  void showStatus('Running… see tab console');
  try {
    const payload = backups
      .filter((item) => selectedIds.has(item.id))
      .map((item) => ({ convoId: item.convoId, url: item.url || getConvoUrl(item.convoId) }));
    const response = await chrome.runtime.sendMessage({ type: 'DELETE_SELECTED', selection: payload });
    const report = response?.report || {};
    const results = Array.isArray(report.results) ? report.results : [];
    const deletedCount = results.filter((entry) => entry.ok).length;
    const failedCount = results.filter((entry) => !entry.ok).length;

    if (response?.ok || results.length) {
      await showStatus(`Deleted ${deletedCount} • Failed ${failedCount}`);
    } else {
      await showStatus('Deletion failed');
    }

    if (response?.ok) {
      selectedIds.clear();
    }

    if (response?.ok || results.length) {
      await loadBackups();
      updateSelectionState();
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
      const summary = [
        result.header ? 'header ✓' : 'header ×',
        result.menu ? 'menu ✓' : 'menu ×',
        result.confirm ? 'confirm ✓' : 'confirm ×'
      ].join(', ');
      await showStatus(`Probe done – check page console (${summary})`);
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

/** Slovensky: Vynúti zachytenie z aktuálnej karty. */
async function forceCaptureActiveTab() {
  if (busy) {
    return;
  }
  forceCaptureButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'captureActiveTabNow' });
    if (response?.ok) {
      const eligible = response?.heuristics?.eligible !== false;
      await showStatus(eligible ? 'Captured active tab' : 'Captured (not eligible)');
      await loadBackups();
    } else {
      if (response?.error === 'no_active_chatgpt_tab') {
        await showStatus('No active chatgpt.com tab');
      } else {
        await showStatus('Capture failed');
      }
    }
  } catch (_error) {
    await showStatus('Capture failed');
  } finally {
    forceCaptureButton.disabled = busy;
  }
}

/** Slovensky: Spustí zachytenie na všetkých kartách. */
async function scanAllTabs() {
  if (busy) {
    return;
  }
  scanAllButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'scanAllChatgptTabs' });
    if (response?.ok) {
      const scanned = Number.isFinite(response.scanned) ? response.scanned : 0;
      const stored = Number.isFinite(response.stored) ? response.stored : 0;
      await showStatus(`Scan complete: ${stored}/${scanned} stored`);
      await loadBackups();
    } else {
      await showStatus('Scan failed');
    }
  } catch (_error) {
    await showStatus('Scan failed');
  } finally {
    scanAllButton.disabled = busy;
  }
}

/** Slovensky: Prepočíta eligibility pre vybrané alebo viditeľné riadky. */
async function reEvaluateEligibility() {
  if (busy) {
    return;
  }
  reEvaluateButton.disabled = true;
  try {
    const selectedConvoIds = backups
      .filter((item) => selectedIds.has(item.id))
      .map((item) => item.convoId)
      .filter((convoId) => typeof convoId === 'string' && convoId.trim().length > 0);
    let targetConvoIds = selectedConvoIds;
    if (!targetConvoIds.length) {
      targetConvoIds = getVisibleBackups()
        .map((item) => item.convoId)
        .filter((convoId) => typeof convoId === 'string' && convoId.trim().length > 0);
    }
    const unique = Array.from(new Set(targetConvoIds));
    if (!unique.length) {
      await showStatus('Nothing to re-evaluate');
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: 'RE_EVALUATE_SELECTED', convoIds: unique });
    if (response?.ok) {
      const processed = Number.isFinite(response.processed) ? response.processed : unique.length;
      const eligible = Number.isFinite(response.eligible) ? response.eligible : 0;
      const suffix = processed === eligible ? '' : ` (${eligible} eligible)`;
      await showStatus(`Re-evaluated ${processed} item(s)${suffix}`);
      await loadBackups();
    } else {
      await showStatus('Re-evaluation failed');
    }
  } catch (_error) {
    await showStatus('Re-evaluation failed');
  } finally {
    reEvaluateButton.disabled = busy;
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
