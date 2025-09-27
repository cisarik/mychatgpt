/* Slovensky komentar: Debug stranka ponuka manualne akcie bez ziveho streamu logov. */
(function (globalTarget) {
  const state = {
    mounted: false,
    panel: null,
    document: null,
    elements: {},
    cleanup: [],
    runtimeListener: null
  };

  function getPanelRoot() {
    const doc = globalTarget.document || document;
    return doc.getElementById('panel-debug') || doc.getElementById('page-debug') || null;
  }

  function resolveElement(panel, id) {
    if (!panel) {
      return null;
    }
    return panel.querySelector(`#${id}`) || null;
  }

  function resolveDocumentElement(doc, id) {
    if (!doc) {
      return null;
    }
    return doc.getElementById(id);
  }

  function rememberCleanup(fn) {
    if (typeof fn === 'function') {
      state.cleanup.push(fn);
    }
  }

  function createNode(tagName) {
    const doc = state.document || globalTarget.document || document;
    return doc.createElement(tagName);
  }

  function getElement(name) {
    return state.elements[name] || null;
  }

  function addListener(element, type, handler, options) {
    if (!element || typeof element.addEventListener !== 'function') {
      return;
    }
    element.addEventListener(type, handler, options);
    rememberCleanup(() => {
      element.removeEventListener(type, handler, options);
    });
  }

  function isMounted() {
    return state.mounted && Boolean(state.panel);
  }

  /* Slovensky komentar: Zobrazi kratku toast spravu v debug nadpise. */
  function showDebugToast(message, options = {}) {
    if (!isMounted() || !message) {
      return;
    }
    const container = getElement('debugToastContainer');
    if (!container) {
      return;
    }
    const toast = createNode('div');
    toast.className = 'toast';

    const textSpan = createNode('span');
    textSpan.textContent = message;
    toast.appendChild(textSpan);

    const actionLabel = options && typeof options.actionLabel === 'string' ? options.actionLabel : null;
    const onAction = options && typeof options.onAction === 'function' ? options.onAction : null;
    if (actionLabel && onAction) {
      const actionButton = createNode('button');
      actionButton.type = 'button';
      actionButton.className = 'toast-action';
      actionButton.textContent = actionLabel;
      actionButton.addEventListener('click', async () => {
        try {
          onAction();
        } catch (error) {
          if (typeof Logger === 'object' && typeof Logger.log === 'function') {
            await Logger.log('warn', 'debug', 'Toast action handler failed', {
              message: error && error.message
            });
          }
        }
      });
      toast.appendChild(actionButton);
    }

    container.prepend(toast);
    while (container.childElementCount > 2) {
      container.removeChild(container.lastElementChild);
    }
    const timeoutId = globalTarget.setTimeout(() => {
      if (toast.parentElement === container) {
        container.removeChild(toast);
      }
    }, 2600);
    rememberCleanup(() => {
      globalTarget.clearTimeout(timeoutId);
      if (toast.parentElement === container) {
        container.removeChild(toast);
      }
    });
  }

  /* Slovensky komentar: Zostavi textovy zaznam pre backup-delete akciu. */
  function formatBackupDeleteHistory(entry) {
    const timestampValue = Number.isFinite(entry?.timestamp)
      ? new Date(entry.timestamp)
      : new Date();
    const timestamp = Number.isFinite(timestampValue.getTime())
      ? timestampValue.toLocaleTimeString([], { hour12: false })
      : '';
    const steps = {
      menu: Boolean(entry?.ui?.steps?.menu),
      item: Boolean(entry?.ui?.steps?.item),
      confirm: Boolean(entry?.ui?.steps?.confirm)
    };
    const recordId = entry?.backup && (entry.backup.recordId || entry.backup.id)
      ? entry.backup.recordId || entry.backup.id
      : null;
    const payload = {
      ok: entry?.ok === true,
      didDelete: entry?.didDelete === true,
      reasonCode: typeof entry?.reasonCode === 'string' && entry.reasonCode ? entry.reasonCode : 'unknown',
      candidate: typeof entry?.candidate === 'boolean' ? entry.candidate : null,
      dryRun: entry?.dryRun === true ? true : entry?.dryRun === false ? false : null,
      backup: { recordId },
      ui: { steps }
    };
    const formatted = JSON.stringify(payload);
    return timestamp ? `[${timestamp}] ${formatted}` : formatted;
  }

  /* Slovensky komentar: Prida zaznam o backup-delete akcii. */
  function appendBackupDeleteHistoryEntry(entry) {
    if (!isMounted()) {
      return;
    }
    const historyHost = getElement('backupDeleteHistory');
    if (!historyHost) {
      return;
    }
    const block = createNode('div');
    block.className = 'history-entry';
    block.textContent = formatBackupDeleteHistory(entry || {});
    historyHost.prepend(block);
    while (historyHost.childElementCount > 10) {
      historyHost.removeChild(historyHost.lastElementChild);
    }
  }

  /* Slovensky komentar: Vrati toast spravu podla vysledku backup-delete. */
  function getBackupDeleteToastMessage(summary) {
    if (!summary) {
      return 'Failed: unknown';
    }
    const recordId = summary?.backup && summary.backup.recordId ? summary.backup.recordId : null;
    const recordHint = recordId ? ` (id=${recordId})` : '';
    if (summary.ok && summary.didDelete) {
      return `Backup & delete: done${recordHint}.`;
    }
    if (summary.ok && summary.reasonCode === 'dry_run') {
      return `Dry run—backup only${recordHint}.`;
    }
    if (summary.reasonCode === 'blocked_by_list_only') {
      return `Read-only: nothing deleted${recordHint}.`;
    }
    const code = typeof summary.reasonCode === 'string' && summary.reasonCode ? summary.reasonCode : 'unknown';
    return `Failed: ${code}${recordHint}`;
  }

  /* Slovensky komentar: Normalizuje odozvu pre historicku stopu. */
  function normalizeBackupDeleteSummary(raw) {
    const candidate = typeof raw?.candidate === 'boolean' ? raw.candidate : null;
    const dryRun = raw?.dryRun === true ? true : raw?.dryRun === false ? false : null;
    const steps = {
      menu: Boolean(raw?.ui?.steps?.menu),
      item: Boolean(raw?.ui?.steps?.item),
      confirm: Boolean(raw?.ui?.steps?.confirm)
    };
    const recordId = raw?.backup && typeof raw.backup === 'object'
      ? raw.backup.recordId || raw.backup.id || (raw.backup.record && raw.backup.record.id) || null
      : null;
    const backup = raw?.backup && typeof raw.backup === 'object'
      ? { ...raw.backup, recordId, reasonCode: raw.backup.reasonCode || null }
      : { recordId, reasonCode: null };
    const backupDryRun = typeof backup?.dryRun === 'boolean' ? backup.dryRun : null;
    const effectiveDryRun = dryRun !== null ? dryRun : backupDryRun;
    return {
      ok: raw?.ok === true,
      didDelete: raw?.didDelete === true,
      reasonCode: typeof raw?.reasonCode === 'string' && raw.reasonCode ? raw.reasonCode : 'unknown',
      candidate,
      dryRun: effectiveDryRun,
      backup,
      ui: {
        ok: raw?.ui?.ok === true,
        reason: typeof raw?.ui?.reason === 'string' ? raw.ui.reason : undefined,
        steps
      },
      timestamp: Number.isFinite(raw?.timestamp) ? raw.timestamp : Date.now()
    };
  }

  /* Slovensky komentar: Extrahuje surovu chybovu spravu pre toast. */
  function extractErrorMessage(error, fallback = 'Žiadna odozva') {
    if (!error) {
      return fallback;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (typeof error.message === 'string' && error.message) {
      return error.message;
    }
    if (typeof error.reason === 'string' && error.reason) {
      return error.reason;
    }
    return String(error);
  }

  /* Slovensky komentar: Prida toast do autoscan feedu. */
  function appendScanToast(message) {
    if (!isMounted() || !message) {
      return;
    }
    const container = getElement('scanResultContainer');
    if (!container) {
      return;
    }
    const block = createNode('div');
    block.className = 'log-entry';
    block.textContent = message;
    container.prepend(block);
    while (container.childElementCount > 5) {
      container.removeChild(container.lastElementChild);
    }
  }

  /* Slovensky komentar: Prida JSON riadok do historie bulk backupu. */
  function appendBulkOpenTabsHistory(summary) {
    if (!isMounted()) {
      return;
    }
    const history = getElement('bulkOpenTabsHistory');
    if (!history) {
      return;
    }
    const block = createNode('div');
    block.className = 'log-entry';
    const dryRun = summary && typeof summary === 'object'
      ? Boolean(summary.dryRun || Array.isArray(summary.wouldWrite))
      : false;
    const payload = summary && typeof summary === 'object'
      ? {
          timestamp: summary.timestamp || null,
          scannedTabs: Number.isFinite(summary.scannedTabs) ? summary.scannedTabs : 0,
          candidates: summary.stats && Number.isFinite(summary.stats.candidates)
            ? summary.stats.candidates
            : 0,
          written: Array.isArray(summary.written) ? summary.written.length : 0,
          wouldWrite: dryRun ? (summary && Array.isArray(summary.wouldWrite) ? summary.wouldWrite.length : 0) : 0,
          skipped: Array.isArray(summary.skipped) ? summary.skipped.length : 0,
          dryRun
        }
      : { note: 'no summary' };
    block.textContent = JSON.stringify(payload);
    history.prepend(block);
    while (history.childElementCount > 10) {
      history.removeChild(history.lastElementChild);
    }
  }

  /* Slovensky komentar: Pridá krátky záznam o Evaluate & Backup akcii. */
  function appendEvalBackupHistory(entry) {
    if (!isMounted()) {
      return;
    }
    const history = getElement('evalBackupHistory');
    if (!history) {
      return;
    }
    const toast = createNode('div');
    toast.className = 'toast';
    const now = new Date();
    const timestamp = Number.isFinite(now.getTime()) ? now.toLocaleTimeString() : '';
    const reasons = Array.isArray(entry && entry.reasonCodes) && entry.reasonCodes.length
      ? entry.reasonCodes.join(',')
      : '∅';
    const status = entry && entry.didBackup
      ? entry.dryRun
        ? 'dry-run'
        : 'stored'
      : 'no-op';
    const parts = [];
    if (timestamp) {
      parts.push(timestamp);
    }
    parts.push(status);
    parts.push(`reasons=${reasons}`);
    if (entry && entry.id) {
      parts.push(`id=${entry.id}`);
    }
    if (entry && entry.message) {
      parts.push(entry.message);
    }
    toast.textContent = parts.join(' · ');
    history.prepend(toast);
    while (history.childElementCount > 6) {
      history.removeChild(history.lastElementChild);
    }
  }

  /* Slovensky komentar: Naformatuje sumar bulk backupu pre toast. */
  function summarizeBulkToast(summary) {
    if (!summary || typeof summary !== 'object') {
      return {
        message: 'Bulk backup completed.',
        dryRun: false,
        writtenCount: 0
      };
    }
    const scanned = Number.isFinite(summary.scannedTabs) ? summary.scannedTabs : 0;
    const candidates = summary.stats && Number.isFinite(summary.stats.candidates)
      ? summary.stats.candidates
      : 0;
    const writtenCount = Array.isArray(summary.written) ? summary.written.length : 0;
    const wouldWriteCount = Array.isArray(summary.wouldWrite) ? summary.wouldWrite.length : 0;
    const skippedCount = Array.isArray(summary.skipped) ? summary.skipped.length : 0;
    const dryRun = Boolean(summary.dryRun || Array.isArray(summary.wouldWrite));
    const prefix = dryRun ? 'Dry run—nothing persisted. ' : '';
    const writtenPart = dryRun
      ? '0 written'
      : `${writtenCount} written`;
    const wouldWritePart = dryRun ? ` · ${wouldWriteCount} wouldWrite` : '';
    const message = `${prefix}${scanned} scanned · ${candidates} candidates · ${writtenPart}${wouldWritePart} · ${skippedCount} skipped`;
    return {
      message,
      dryRun,
      writtenCount,
      wouldWriteCount,
      skippedCount,
      scanned,
      candidates
    };
  }

  /* Slovensky komentar: Prida zaznam z konektivity do histórie. */
  function appendConnectivityRecord(text) {
    if (!isMounted()) {
      return;
    }
    const history = getElement('connectivityContainer');
    if (!history) {
      return;
    }
    const block = createNode('div');
    block.className = 'log-entry';
    block.textContent = text;
    history.prepend(block);
    while (history.childElementCount > 5) {
      history.removeChild(history.lastElementChild);
    }
  }

  /* Slovensky komentar: Vytvori zaznam o metadata probe v historii. */
  function appendProbeRecord(text) {
    if (!isMounted()) {
      return;
    }
    const history = getElement('metadataContainer');
    if (!history) {
      return;
    }
    const block = createNode('div');
    block.className = 'log-entry';
    block.textContent = text;
    history.prepend(block);
    while (history.childElementCount > 5) {
      history.removeChild(history.lastElementChild);
    }
  }

  /* Slovensky komentar: Prida zaznam o heuristike do historie. */
  function appendHeuristicsRecord(text) {
    if (!isMounted()) {
      return;
    }
    const history = getElement('heuristicsContainer');
    if (!history) {
      return;
    }
    const block = createNode('div');
    block.className = 'log-entry';
    block.textContent = text;
    history.prepend(block);
    while (history.childElementCount > 5) {
      history.removeChild(history.lastElementChild);
    }
  }

  /* Slovensky komentar: Prida zaznam o capture preview do historie. */
  function appendCaptureRecord(text) {
    if (!isMounted()) {
      return;
    }
    const history = getElement('captureContainer');
    if (!history) {
      return;
    }
    const block = createNode('div');
    block.className = 'log-entry';
    block.textContent = text;
    history.prepend(block);
    while (history.childElementCount > 5) {
      history.removeChild(history.lastElementChild);
    }
  }

  /* Slovensky komentar: Vykresli toast pre manualne zalozenie. */
  function appendBackupToast(text) {
    if (!isMounted()) {
      return;
    }
    const container = getElement('backupToastContainer');
    if (!container) {
      return;
    }
    const block = createNode('div');
    block.className = 'log-entry';
    block.textContent = text;
    container.prepend(block);
    while (container.childElementCount > 4) {
      container.removeChild(container.lastElementChild);
    }
  }

  /* Slovensky komentar: Prida kartu s vysledkom manualnej zalohy. */
  function appendBackupHistoryCard(record) {
    if (!isMounted() || !record) {
      return;
    }
    const container = getElement('backupHistoryContainer');
    if (!container) {
      return;
    }
    const card = createNode('div');
    card.className = 'log-entry';
    const qLen = record.questionText ? record.questionText.length : 0;
    const aLen = record.answerHTML ? record.answerHTML.length : 0;
    const titlePreview = record.title ? record.title : '(bez názvu)';
    const convoPreview = record.convoId ? record.convoId : '∅';
    const truncatedText = record.answerTruncated ? 'truncated=yes' : 'truncated=no';
    card.textContent = `id=${record.id} | title=${titlePreview} | qLen=${qLen} | aLen=${aLen} | convo=${convoPreview} | ${truncatedText}`;
    container.prepend(card);
    while (container.childElementCount > 5) {
      container.removeChild(container.lastElementChild);
    }
  }

  /* Slovensky komentar: Prida toast do searches sekcie cez hash. */
  function showSearchesToast(message) {
    if (!message) {
      return;
    }
    const doc = state.document || globalTarget.document || document;
    const toastHost = doc.getElementById('searches-toast');
    if (!toastHost) {
      return;
    }
    const toast = createNode('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastHost.prepend(toast);
    while (toastHost.childElementCount > 3) {
      toastHost.removeChild(toastHost.lastElementChild);
    }
    const timeoutId = globalTarget.setTimeout(() => {
      if (toast.parentElement === toastHost) {
        toastHost.removeChild(toast);
      }
    }, 3200);
    rememberCleanup(() => {
      globalTarget.clearTimeout(timeoutId);
      if (toast.parentElement === toastHost) {
        toastHost.removeChild(toast);
      }
    });
  }

  /* Slovensky komentar: Naformatuje sumar do toast spravy v searches. */
  function summarizeBulkResult(summary) {
    if (!summary || typeof summary !== 'object') {
      return 'Bulk backup completed.';
    }
    const scanned = Number.isFinite(summary.scannedTabs) ? summary.scannedTabs : 0;
    const candidates = summary.stats && Number.isFinite(summary.stats.candidates)
      ? summary.stats.candidates
      : 0;
    const writtenCount = Array.isArray(summary.written) ? summary.written.length : 0;
    const wouldWriteCount = Array.isArray(summary.wouldWrite) ? summary.wouldWrite.length : 0;
    const skippedCount = Array.isArray(summary.skipped) ? summary.skipped.length : 0;
    const dryRun = Array.isArray(summary.wouldWrite);
    const writtenPart = dryRun
      ? `${writtenCount} written / ${wouldWriteCount} wouldWrite`
      : `${writtenCount} written`;
    return `${scanned} scanned · ${candidates} candidates · ${writtenPart} · ${skippedCount} skipped`;
  }

  /* Slovensky komentar: Ulozi cleanup funkciu pre timeout. */
  function rememberTimeout(timeoutId) {
    rememberCleanup(() => {
      globalTarget.clearTimeout(timeoutId);
    });
  }

  /* Slovensky komentar: Pre mapovanie surovych chyb na reason kody. */
  function mapBackupDeleteErrorReason(message) {
    if (!message) {
      return 'unexpected_response';
    }
    const normalized = String(message).toLowerCase();
    if (normalized.includes('timeout')) {
      return 'timeout';
    }
    if (normalized.includes('receiving end does not exist') || normalized.includes('no receiving end')) {
      return 'no_active_tab';
    }
    if (normalized.includes('no active tab')
      || normalized.includes('tab not found')
      || normalized.includes('no tab with id')
      || normalized.includes('no window with id')) {
      return 'no_active_tab';
    }
    if (normalized.includes('service worker') || normalized.includes('connection')) {
      return 'no_service_worker';
    }
    if (normalized.includes('not_chatgpt')) {
      return 'not_chatgpt';
    }
    if (normalized.includes('message port closed before a response was received')
      || normalized.includes('message channel closed before a response was received')) {
      return 'no_response';
    }
    return 'unexpected_response';
  }

  /* Slovensky komentar: Vyziada stub pozadovku na autoscan. */
  function requestAutoscanStub() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'scan_now' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Vyziada bulk backup na pozadi. */
  function requestBulkBackupOpenTabs() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bulk_backup_open_tabs' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Vyziada test log z backgroundu. */
  function requestTestLog(note) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'debug_test_log', note }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Poziada background o test konektivity. */
  function requestConnectivityTest() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'connectivity_test' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Vyziada z backgroundu prehliadanie metadata. */
  function requestMetadataProbe() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'probe_request' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Poziada background o vyhodnotenie heuristiky. */
  function requestHeuristicsEvaluation() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'heuristics_eval' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Vyziada read-only capture z backgroundu. */
  function requestCapturePreview() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'capture_preview_debug' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Vyziada manualne zalozenie. */
  function requestManualBackup() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'backup_now' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Vyžiada Evaluate & Backup správu. */
  function requestEvalAndBackup() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'eval_and_backup' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(runtimeError);
          return;
        }
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Vyziada backup-delete spravu z backgroundu. */
  function requestBackupDeleteActive({ confirmed = false, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = { type: 'backup_and_delete_active' };
      if (typeof confirmed === 'boolean') {
        payload.confirm = confirmed;
      }
      let settled = false;
      const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 5000;
      const timeoutId = globalTarget.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error('timeout'));
      }, safeTimeout);
      rememberTimeout(timeoutId);
      chrome.runtime.sendMessage(payload, (response) => {
        if (settled) {
          return;
        }
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          settled = true;
          globalTarget.clearTimeout(timeoutId);
          reject(runtimeError);
          return;
        }
        settled = true;
        globalTarget.clearTimeout(timeoutId);
        resolve(response);
      });
    });
  }

  /* Slovensky komentar: Aktualizuje popis rezimu zalohy. */
  async function refreshBackupModeLabel() {
    if (!isMounted()) {
      return;
    }
    const label = getElement('backupModeLabel');
    if (!label) {
      return;
    }
    try {
      const { settings } = await SettingsStore.load();
      if (!isMounted()) {
        return;
      }
      label.textContent = settings.CAPTURE_ONLY_CANDIDATES ? 'Candidates only' : 'All chats allowed';
    } catch (error) {
      label.textContent = 'Mode unknown';
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('warn', 'debug', 'Failed to read settings for backup label', {
          message: error && error.message
        });
      }
    }
  }

  function resetInteractiveElements() {
    const candidates = [
      'autoscanButton',
      'testLogButton',
      'connectivityButton',
      'checkCsButton',
      'probeButton',
      'heuristicsButton',
      'captureButton',
      'bulkOpenTabsButton',
      'backupButton',
      'evalBackupButton',
      'backupDeleteButton'
    ];
    candidates.forEach((key) => {
      const element = getElement(key);
      if (element && element.disabled) {
        element.disabled = false;
        element.removeAttribute('aria-busy');
      }
    });
  }

  async function handleAutoscanClick(button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Prebieha…';
    try {
      const response = await requestAutoscanStub();
      if (response && response.ok) {
        appendScanToast(`Auto-scan stub: ${JSON.stringify(response.result)}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('info', 'scan', 'Auto-scan feed stub executed', {
            result: response.result
          });
        }
      } else {
        const errorMessage = extractErrorMessage(response && (response.error || response.message));
        appendScanToast(`Auto-scan chyba: ${errorMessage}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('error', 'scan', 'Auto-scan feed stub failed', {
            message: errorMessage
          });
        }
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      appendScanToast(`Auto-scan chyba: ${message}`);
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'scan', 'Auto-scan feed stub threw error', {
          message
        });
      }
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async function handleTestLogClick(button) {
    const originalText = button.textContent;
    const note = `debug_page:${Date.now()}`;
    button.disabled = true;
    button.textContent = 'Odosielam…';
    try {
      const response = await requestTestLog(note);
      if (!response || response.ok !== true) {
        const errorMessage = response && response.error ? response.error : 'Žiadna odozva';
        throw new Error(errorMessage);
      }
      showDebugToast('Test log odoslaný (pozri DevTools)');
      button.textContent = 'Odoslané';
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('info', 'debug', 'Test log request forwarded', {
          forwarded: Boolean(response.forwarded),
          forwardError: response.forwardError || null,
          requestedAt: response.requestedAt,
          note
        });
      }
    } catch (error) {
      button.textContent = 'Chyba';
      const message = extractErrorMessage(error);
      showDebugToast(`Test log zlyhal: ${message}`);
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Test log request failed', {
          message,
          note
        });
      }
    } finally {
      const timeoutId = globalTarget.setTimeout(() => {
        if (button) {
          button.textContent = originalText;
          button.disabled = false;
        }
      }, 1400);
      rememberTimeout(timeoutId);
    }
  }

  async function handleConnectivityClick(button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Overujem…';
    try {
      const response = await requestConnectivityTest();
      if (response && response.ok && response.payload) {
        appendConnectivityRecord(`OK: ${JSON.stringify(response.payload)}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('info', 'debug', 'Connectivity test succeeded', {
            reasonCode: response.reasonCode,
            traceId: response.payload.traceId
          });
        }
      } else {
        const errorMessage = extractErrorMessage(response && (response.error || response.message));
        appendConnectivityRecord(`Chyba: ${errorMessage}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('warn', 'debug', 'Connectivity test returned warning', {
            reasonCode: response && response.reasonCode ? response.reasonCode : 'unknown',
            message: errorMessage
          });
        }
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      appendConnectivityRecord(`Chyba: ${message}`);
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Connectivity test request threw error', {
          message
        });
      }
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async function handleCheckCsClick(button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Overujem…';
    try {
      const response = await requestConnectivityTest();
      if (response && response.ok) {
        button.textContent = 'Content script aktívny';
        appendConnectivityRecord(`Check CS OK: ${JSON.stringify(response.payload || {})}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('info', 'debug', 'Content script check succeeded', {
            reasonCode: response.reasonCode || 'ping_ok'
          });
        }
      } else {
        const errorMessage = extractErrorMessage(response && (response.error || response.message));
        button.textContent = 'Content script chýba';
        appendConnectivityRecord(`Check CS chyba: ${errorMessage}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('warn', 'debug', 'Content script check warning', {
            reasonCode: response && response.reasonCode ? response.reasonCode : 'no_response',
            message: errorMessage
          });
        }
      }
    } catch (error) {
      button.textContent = 'Content script chýba';
      const message = extractErrorMessage(error);
      appendConnectivityRecord(`Check CS chyba: ${message}`);
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Content script check threw error', {
          message
        });
      }
    } finally {
      const timeoutId = globalTarget.setTimeout(() => {
        if (button) {
          button.textContent = originalText;
          button.disabled = false;
        }
      }, 1400);
      rememberTimeout(timeoutId);
    }
  }

  async function handleProbeClick(button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Prebieha…';
    try {
      const response = await requestMetadataProbe();
      if (response && response.ok && response.payload) {
        const payload = response.payload;
        if (payload.skipped && payload.reason === 'probe_safe_url') {
          appendProbeRecord('Preskocené: Aktívna stránka je chránená vzorom SAFE_URL.');
        } else {
          appendProbeRecord(`OK: ${JSON.stringify(payload)}`);
        }
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('info', 'debug', 'Metadata probe completed', {
            reasonCode: response.reasonCode,
            traceId: payload.traceId,
            skipped: Boolean(payload.skipped)
          });
        }
      } else {
        const errorMessage = extractErrorMessage(response && (response.error || response.message));
        appendProbeRecord(`Chyba: ${errorMessage}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('warn', 'debug', 'Metadata probe returned warning', {
            reasonCode: response && response.reasonCode ? response.reasonCode : 'unknown',
            message: errorMessage
          });
        }
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      appendProbeRecord(`Chyba: ${message}`);
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Metadata probe request threw error', {
          message
        });
      }
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async function handleHeuristicsClick(button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Evaluating…';
    try {
      const response = await requestHeuristicsEvaluation();
      const timestamp = new Date().toLocaleTimeString();
      if (response && response.decision) {
        const decision = response.decision;
        const reasons = decision.reasonCodes && decision.reasonCodes.length ? decision.reasonCodes.join(', ') : 'none';
        const countsText = JSON.stringify(decision.snapshot && decision.snapshot.counts ? decision.snapshot.counts : {});
        const candidateText = decision.decided ? `candidate=${decision.isCandidate}` : 'candidate=undecided';
        const cooldown = response.cooldown || { used: false, remainingMs: 0 };
        const cooldownText = cooldown.used
          ? `cooldown=active (${cooldown.remainingMs}ms)`
          : 'cooldown=inactive';
        appendHeuristicsRecord(`[${timestamp}] ${candidateText}; reasons=[${reasons}]; counts=${countsText}; ${cooldownText}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('info', 'debug', 'Heuristics evaluation invoked manually', {
            reasonCode: response.reasonCode,
            candidate: decision.isCandidate,
            decided: decision.decided,
            reasonCodes: decision.reasonCodes,
            cooldown
          });
        }
      } else {
        const reason = response && response.reasonCode ? response.reasonCode : 'unknown';
        const errorDetail = extractErrorMessage(response && (response.error || response.message), '').trim();
        const reasonLine = errorDetail ? `${reason} (${errorDetail})` : reason;
        appendHeuristicsRecord(`[${timestamp}] Heuristics failed: ${reasonLine}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('warn', 'debug', 'Heuristics evaluation returned warning', {
            reasonCode: reason,
            message: errorDetail || null
          });
        }
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      appendHeuristicsRecord(`Heuristics error: ${message}`);
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Heuristics evaluation request threw error', {
          message
        });
      }
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async function handleCaptureClick(button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Capturing…';
    try {
      const response = await requestCapturePreview();
      if (response && response.ok && response.payload) {
        const payload = response.payload;
        if (payload.skipped) {
          appendCaptureRecord('Preskočené: SAFE_URL vzor blokuje capture.');
        } else {
          const title = payload.title || '(bez názvu)';
          const qLen = payload.questionText ? payload.questionText.length : 0;
          const aLen = payload.answerHTML ? payload.answerHTML.length : 0;
          appendCaptureRecord(`OK: title=${title} | qLen=${qLen} | aLen=${aLen}`);
        }
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('info', 'debug', 'Capture preview invoked', {
            reasonCode: response.reasonCode,
            skipped: Boolean(payload.skipped)
          });
        }
      } else {
        const message = extractErrorMessage(response && (response.error || response.message));
        appendCaptureRecord(`Chyba: ${message}`);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('warn', 'debug', 'Capture preview returned warning', {
            reasonCode: response && response.reasonCode ? response.reasonCode : 'capture_error',
            message
          });
        }
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      appendCaptureRecord(`Chyba: ${message}`);
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Capture preview request threw error', {
          message
        });
      }
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async function handleBulkOpenTabsClick(button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';
    try {
      const response = await requestBulkBackupOpenTabs();
      if (response && response.ok) {
        const summary = response.summary || {};
        const toastMeta = summarizeBulkToast(summary);
        const toastOptions = !toastMeta.dryRun && toastMeta.writtenCount > 0
          ? {
              actionLabel: 'Open list',
              onAction: () => {
                if (typeof globalTarget !== 'undefined' && globalTarget.location) {
                  globalTarget.location.hash = '#searches';
                }
                showSearchesToast(summarizeBulkResult(summary));
              }
            }
          : undefined;
        showDebugToast(toastMeta.message, toastOptions);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          const meta = {
            reasonCode: toastMeta.dryRun ? 'bulk_backup_dry_run' : 'bulk_backup_ok',
            scannedTabs: toastMeta.scanned,
            candidates: toastMeta.candidates,
            written: toastMeta.writtenCount,
            wouldWrite: toastMeta.dryRun ? toastMeta.wouldWriteCount : 0,
            skipped: toastMeta.skippedCount
          };
          await Logger.log('info', 'debug', 'Bulk backup over open tabs finished', meta);
        }
      } else {
        const message = extractErrorMessage(response && (response.error || response.message), 'Bulk backup failed.');
        showDebugToast(message);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('warn', 'debug', 'Bulk backup over open tabs blocked', {
            message,
            reasonCode: 'bulk_backup_error'
          });
        }
      }
    } catch (error) {
      const message = extractErrorMessage(error, 'Bulk backup error.');
      showDebugToast(message);
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Bulk backup over open tabs threw error', {
          message
        });
      }
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function handleManualBackupClick(button) {
    const labelSpan = button.querySelector('span');
    const originalLabel = labelSpan ? labelSpan.textContent : button.textContent;
    button.disabled = true;
    if (labelSpan) {
      labelSpan.textContent = 'Working…';
    } else {
      button.textContent = 'Working…';
    }
    try {
      const response = await requestManualBackup();
      if (response && response.ok) {
        appendBackupToast(response.message || 'Backup completed.');
        appendBackupHistoryCard(response.record);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('info', 'debug', 'Manual backup executed', {
            reasonCode: response.reasonCode,
            dryRun: Boolean(response.dryRun),
            id: response.record ? response.record.id : null
          });
        }
      } else {
        const reason = response && response.reasonCode ? response.reasonCode : 'unknown';
        const message = extractErrorMessage(response && (response.message || response.error));
        appendBackupToast(message || 'Manual backup failed.');
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('warn', 'debug', 'Manual backup blocked', {
            reasonCode: reason,
            message: message || null
          });
        }
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      appendBackupToast(message || 'Manual backup error.');
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Manual backup threw error', {
          message
        });
      }
    } finally {
      button.disabled = false;
      if (labelSpan) {
        labelSpan.textContent = originalLabel;
      } else {
        button.textContent = originalLabel;
      }
      await refreshBackupModeLabel();
    }
  }

  async function handleEvalBackupClick(button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Evaluating…';
    try {
      const response = await requestEvalAndBackup();
      const reasons = Array.isArray(response && response.reasonCodes)
        ? response.reasonCodes
        : response && typeof response.reasonCode === 'string'
          ? [response.reasonCode]
          : [];
      if (response && response.ok) {
        const toastMessage = response.message || 'Evaluate & backup: completed.';
        showDebugToast(toastMessage);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('info', 'debug', 'Evaluate & backup completed', {
            ok: true,
            reasonCodes: reasons,
            id: response.id || null,
            dryRun: Boolean(response.dryRun)
          });
        }
      } else {
        const toastMessage = response && response.message ? response.message : 'Evaluate & backup blocked.';
        showDebugToast(toastMessage);
        if (typeof Logger === 'object' && typeof Logger.log === 'function') {
          await Logger.log('warn', 'debug', 'Evaluate & backup blocked', {
            ok: false,
            reasonCodes: reasons,
            message: toastMessage
          });
        }
      }
      appendEvalBackupHistory({
        didBackup: Boolean(response && response.didBackup),
        dryRun: Boolean(response && response.dryRun),
        id: response && response.id ? response.id : null,
        reasonCodes: reasons,
        message: response && response.message ? response.message : undefined
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      showDebugToast(message);
      appendEvalBackupHistory({
        didBackup: false,
        dryRun: false,
        reasonCodes: ['error'],
        message
      });
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Evaluate & backup threw error', {
          message
        });
      }
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  async function handleBackupDeleteClick(button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';
    button.setAttribute('aria-busy', 'true');

    let confirmRequired = true;
    try {
      const { settings } = await SettingsStore.load();
      confirmRequired = Boolean(settings.CONFIRM_BEFORE_DELETE);
    } catch (error) {
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('warn', 'debug', 'Backup-delete confirm guard unavailable', {
          message: error && error.message
        });
      }
    }

    let confirmed = true;
    if (confirmRequired) {
      const confirmFn = typeof globalTarget.confirm === 'function'
        ? globalTarget.confirm.bind(globalTarget)
        : typeof confirm === 'function'
          ? confirm
          : null;
      if (confirmFn) {
        const confirmMessage = 'Naozaj zálohovať a zmazať aktívny chat?';
        const accepted = confirmFn(confirmMessage);
        if (!accepted) {
          showDebugToast('Cancelled');
          button.disabled = false;
          button.textContent = originalLabel;
          button.removeAttribute('aria-busy');
          return;
        }
      } else if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        try {
          await Logger.log('warn', 'debug', 'Confirm dialog unavailable for backup-delete', {
            reason: 'confirm_missing'
          });
        } catch (_logError) {
          // Slovensky komentar: Ignoruje sa neuspesne zalogovanie upozornenia.
        }
      }
    }

    try {
      const response = await requestBackupDeleteActive({ confirmed, timeoutMs: 6000 });
      const safeSource = response && typeof response === 'object'
        ? { ...response }
        : { ok: false, reasonCode: response === undefined ? 'no_response' : 'unexpected_response', ui: { steps: {} } };
      if (safeSource && typeof safeSource === 'object' && !safeSource.reasonCode && typeof safeSource.reason === 'string') {
        safeSource.reasonCode = safeSource.reason;
      }
      if (!safeSource.ui || typeof safeSource.ui !== 'object') {
        safeSource.ui = { steps: {} };
      }
      const summary = normalizeBackupDeleteSummary(safeSource);
      appendBackupDeleteHistoryEntry(summary);
      const toastMessage = getBackupDeleteToastMessage(summary);
      if (toastMessage) {
        showDebugToast(toastMessage);
      }
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log(summary.ok ? 'info' : 'warn', 'debug', 'Backup-delete summary (debug panel)', {
          reasonCode: summary.reasonCode,
          didDelete: summary.didDelete,
          dryRun: summary.dryRun,
          candidate: summary.candidate,
          recordId: summary.backup && summary.backup.recordId ? summary.backup.recordId : null
        });
      }
    } catch (error) {
      const message = extractErrorMessage(error, 'Runtime error');
      const failureReason = mapBackupDeleteErrorReason(message);
      const failure = normalizeBackupDeleteSummary({
        ok: false,
        didDelete: false,
        reasonCode: failureReason,
        dryRun: null,
        candidate: null,
        timestamp: Date.now(),
        ui: { steps: { menu: false, item: false, confirm: false }, reason: failureReason },
        backup: { recordId: null }
      });
      appendBackupDeleteHistoryEntry(failure);
      showDebugToast(`Failed: ${failureReason}`);
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('error', 'debug', 'Backup-delete threw error (debug panel)', {
          message,
          reasonCode: failureReason
        });
      }
    } finally {
      button.disabled = false;
      button.textContent = originalLabel;
      button.removeAttribute('aria-busy');
    }
  }

  async function loadInitialBulkHistory() {
    try {
      const storedBulk = await chrome.storage.local.get({ last_bulk_backup: null });
      if (!isMounted()) {
        return;
      }
      if (storedBulk.last_bulk_backup) {
        appendBulkOpenTabsHistory(storedBulk.last_bulk_backup);
      }
    } catch (error) {
      if (typeof Logger === 'object' && typeof Logger.log === 'function') {
        await Logger.log('warn', 'debug', 'Failed to load bulk backup summary history', {
          message: error && error.message
        });
      }
    }
  }

  function attachHandlers() {
    const {
      autoscanButton,
      testLogButton,
      connectivityButton,
      checkCsButton,
      probeButton,
      heuristicsButton,
      captureButton,
      bulkOpenTabsButton,
      backupButton,
      evalBackupButton,
      backupDeleteButton
    } = state.elements;

    if (autoscanButton) {
      addListener(autoscanButton, 'click', () => handleAutoscanClick(autoscanButton));
    }
    if (testLogButton) {
      addListener(testLogButton, 'click', () => handleTestLogClick(testLogButton));
    }
    if (connectivityButton) {
      addListener(connectivityButton, 'click', () => handleConnectivityClick(connectivityButton));
    }
    if (checkCsButton) {
      addListener(checkCsButton, 'click', () => handleCheckCsClick(checkCsButton));
    }
    if (probeButton) {
      addListener(probeButton, 'click', () => handleProbeClick(probeButton));
    }
    if (heuristicsButton) {
      addListener(heuristicsButton, 'click', () => handleHeuristicsClick(heuristicsButton));
    }
    if (captureButton) {
      addListener(captureButton, 'click', () => handleCaptureClick(captureButton));
    }
    if (bulkOpenTabsButton) {
      addListener(bulkOpenTabsButton, 'click', () => handleBulkOpenTabsClick(bulkOpenTabsButton));
    }
    if (backupButton) {
      addListener(backupButton, 'click', () => handleManualBackupClick(backupButton));
    }
    if (evalBackupButton) {
      addListener(evalBackupButton, 'click', () => handleEvalBackupClick(evalBackupButton));
    }
    if (backupDeleteButton) {
      addListener(backupDeleteButton, 'click', () => handleBackupDeleteClick(backupDeleteButton));
    }
  }

  function attachRuntimeListener() {
    if (state.runtimeListener) {
      return;
    }
    const listener = (message) => {
      if (!isMounted()) {
        return;
      }
      if (message && message.type === 'bulk_backup_summary') {
        appendBulkOpenTabsHistory(message.summary);
      }
      if (message && message.type === 'backups_updated' && message.reason === 'bulk_backup') {
        showDebugToast('Stored backups refreshed.');
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    state.runtimeListener = listener;
    rememberCleanup(() => {
      if (state.runtimeListener === listener) {
        chrome.runtime.onMessage.removeListener(listener);
        state.runtimeListener = null;
      }
    });
  }

  async function mountDebug() {
    if (state.mounted) {
      return;
    }
    const panel = getPanelRoot();
    if (!panel) {
      return;
    }
    const doc = panel.ownerDocument || globalTarget.document || document;
    const backupDeleteButton = resolveElement(panel, 'backup-delete-active-btn');
    const backupDeleteHistory = resolveElement(panel, 'backup-delete-history');
    if (!backupDeleteButton || !backupDeleteHistory) {
      return;
    }

    state.panel = panel;
    state.document = doc;
    state.cleanup = [];
    state.elements = {
      backupDeleteButton,
      backupDeleteHistory,
      testLogButton: resolveElement(panel, 'test-log-btn'),
      autoscanButton: resolveElement(panel, 'autoscan-feed-btn'),
      scanResultContainer: resolveElement(panel, 'scan-result'),
      connectivityButton: resolveElement(panel, 'connectivity-btn'),
      checkCsButton: resolveElement(panel, 'check-cs-btn'),
      connectivityContainer: resolveElement(panel, 'connectivity-results'),
      probeButton: resolveElement(panel, 'probe-btn'),
      metadataContainer: resolveElement(panel, 'metadata-results'),
      heuristicsButton: resolveElement(panel, 'heuristics-btn'),
      heuristicsContainer: resolveElement(panel, 'heuristics-results'),
      captureButton: resolveElement(panel, 'capture-btn'),
      captureContainer: resolveElement(panel, 'capture-results'),
      backupButton: resolveElement(panel, 'backup-btn'),
      backupModeLabel: resolveElement(panel, 'backup-mode-label') || resolveDocumentElement(doc, 'backup-mode-label'),
      backupToastContainer: resolveElement(panel, 'backup-toast') || resolveDocumentElement(doc, 'backup-toast'),
      backupHistoryContainer: resolveElement(panel, 'backup-history') || resolveDocumentElement(doc, 'backup-history'),
      debugToastContainer: resolveElement(panel, 'debug-toast') || resolveDocumentElement(doc, 'debug-toast'),
      bulkOpenTabsButton: resolveElement(panel, 'bulk-open-tabs-btn'),
      bulkOpenTabsHistory: resolveElement(panel, 'bulk-open-tabs-history') || resolveDocumentElement(doc, 'bulk-open-tabs-history'),
      evalBackupButton: resolveElement(panel, 'eval-backup-btn'),
      evalBackupHistory: resolveElement(panel, 'eval-backup-history') || resolveDocumentElement(doc, 'eval-backup-history')
    };

    state.mounted = true;
    attachHandlers();
    attachRuntimeListener();
    await refreshBackupModeLabel();
    await loadInitialBulkHistory();
    if (typeof Logger === 'object' && typeof Logger.log === 'function') {
      await Logger.log('info', 'db', 'Debug panel mounted');
    }
  }

  function unmountDebug() {
    if (!state.mounted) {
      return;
    }
    while (state.cleanup.length) {
      const cleanupFn = state.cleanup.pop();
      try {
        cleanupFn();
      } catch (error) {
        // swallow cleanup errors
      }
    }
    if (state.runtimeListener) {
      chrome.runtime.onMessage.removeListener(state.runtimeListener);
      state.runtimeListener = null;
    }
    resetInteractiveElements();
    state.mounted = false;
    state.panel = null;
    state.document = null;
    state.elements = {};
  }

  if (!globalTarget.DebugPanel) {
    globalTarget.DebugPanel = {};
  }
  globalTarget.DebugPanel.mountDebug = mountDebug;
  globalTarget.DebugPanel.unmountDebug = unmountDebug;

  const doc = globalTarget.document || document;

  function maybeMountStandalone() {
    if (!doc) {
      return;
    }
    if (doc.getElementById('panel-debug')) {
      mountDebug();
    }
  }

  function signalReady() {
    if (doc) {
      doc.dispatchEvent(new CustomEvent('mychatgpt:debug-panel-ready'));
    }
  }

  if (doc && doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', () => {
      maybeMountStandalone();
      signalReady();
    }, { once: true });
  } else {
    maybeMountStandalone();
    signalReady();
  }
})(typeof window !== 'undefined' ? window : self);
