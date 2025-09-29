/* Slovensky komentar: Obsluha jednotneho povrchu s kartami a internymi odkazmi. */
(function () {
  const defaultTab = 'searches';
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const panels = new Map();
  let suppressHashChange = false;
  let activeTabName = null;
  const globalTarget = typeof window !== 'undefined' ? window : self;
  const toastHost = document.getElementById('popup-toast-stack');
  const queueCountElement = document.getElementById('queue-count');
  const deleteQueuedButton = document.getElementById('delete-queued-btn');
  const deleteBadge = document.getElementById('delete-queued-badge');
  let settingsSnapshot = null;
  let autoOfferShown = false;
  let currentQueueCount = 0;
  let batchInFlight = false;

  /* Slovensky komentar: Mini toast API pre jednotny vizualny feedback. */
  function spawnMiniToast(type, message, options = {}) {
    if (!toastHost || !message) {
      return null;
    }
    const toast = document.createElement('div');
    toast.className = `mini-toast mini-toast--${type}`;
    toast.textContent = message;
    toastHost.prepend(toast);
    while (toastHost.childElementCount > 4) {
      toastHost.removeChild(toastHost.lastElementChild);
    }

    let settled = false;
    const removeToast = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId && typeof globalTarget.clearTimeout === 'function') {
        globalTarget.clearTimeout(timeoutId);
      }
      toast.removeEventListener('click', onClick);
      if (toast.parentElement === toastHost) {
        toastHost.removeChild(toast);
      }
    };

    const duration = typeof options.durationMs === 'number' && Number.isFinite(options.durationMs)
      ? Math.max(600, options.durationMs)
      : 2800;
    const timeoutId = globalTarget && typeof globalTarget.setTimeout === 'function'
      ? globalTarget.setTimeout(removeToast, duration)
      : null;

    const onClick = () => {
      removeToast();
    };
    toast.addEventListener('click', onClick);

    return { close: removeToast };
  }

  const MiniToast = {
    show(type, message, options) {
      const intent = typeof type === 'string' && type ? type : 'info';
      return spawnMiniToast(intent, message, options);
    },
    success(message, options) {
      return spawnMiniToast('success', message, options);
    },
    info(message, options) {
      return spawnMiniToast('info', message, options);
    },
    error(message, options) {
      return spawnMiniToast('error', message, options);
    }
  };

  if (globalTarget && typeof globalTarget === 'object') {
    globalTarget.MiniToast = MiniToast;
  }

  /* Slovensky komentar: Promise wrapper pre runtime spravy. */
  function sendRuntimeMessage(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const lastError = chrome.runtime && chrome.runtime.lastError ? chrome.runtime.lastError : null;
          if (lastError) {
            reject(new Error(lastError.message || 'sendMessage failed'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function ensureSettingsSnapshot() {
    try {
      const loaded = await SettingsStore.load();
      settingsSnapshot = loaded && loaded.settings ? loaded.settings : null;
    } catch (error) {
      console.warn('Failed to load settings snapshot', error);
      settingsSnapshot = null;
    }
  }

  function updateDeleteUi(count) {
    if (typeof count === 'number' && count >= 0) {
      currentQueueCount = count;
      if (queueCountElement) {
        queueCountElement.textContent = `Queued: ${count}`;
      }
      if (deleteBadge) {
        deleteBadge.textContent = String(count);
        deleteBadge.hidden = false;
      }
      if (!batchInFlight && deleteQueuedButton) {
        deleteQueuedButton.disabled = count === 0;
      }
      if (count === 0) {
        autoOfferShown = false;
      }
      const allowOffer = !settingsSnapshot || settingsSnapshot.autoOffer !== false;
      if (count > 0 && allowOffer && !autoOfferShown) {
        showRunOfferToast(count);
        autoOfferShown = true;
      }
    } else {
      if (queueCountElement) {
        queueCountElement.textContent = 'Queued: –';
      }
      if (deleteBadge) {
        deleteBadge.textContent = '–';
        deleteBadge.hidden = true;
      }
      if (!batchInFlight && deleteQueuedButton) {
        deleteQueuedButton.disabled = true;
      }
    }
  }

  function setBatchInFlight(nextState) {
    batchInFlight = Boolean(nextState);
    if (!deleteQueuedButton) {
      return;
    }
    const label = deleteQueuedButton.querySelector('.button-label');
    if (batchInFlight) {
      deleteQueuedButton.disabled = true;
      if (label) {
        label.textContent = 'Running batch…';
      }
    } else {
      deleteQueuedButton.disabled = currentQueueCount === 0;
      if (label) {
        label.textContent = 'Delete queued (UI automation)';
      }
    }
  }

  function showRunOfferToast(count) {
    if (!toastHost) {
      return;
    }
    const existing = toastHost.querySelector('.mini-toast--offer');
    if (existing && existing.parentElement === toastHost) {
      toastHost.removeChild(existing);
    }
    const toast = document.createElement('div');
    toast.className = 'mini-toast mini-toast--info mini-toast--offer';
    const text = document.createElement('span');
    text.textContent = `${count} queued — Run delete now?`;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'mini-toast__action';
    action.textContent = 'Run';
    const removeToast = () => {
      if (toast.parentElement === toastHost) {
        toastHost.removeChild(toast);
      }
    };
    action.addEventListener('click', () => {
      removeToast();
      triggerDeletionBatch();
    });
    toast.addEventListener('click', (event) => {
      if (event.target === action) {
        return;
      }
      removeToast();
    });
    toast.append(text, action);
    toastHost.prepend(toast);
    if (typeof globalTarget.setTimeout === 'function') {
      globalTarget.setTimeout(removeToast, 7000);
    }
  }

  async function refreshQueueCount() {
    try {
      const response = await sendRuntimeMessage({ type: 'deletion_queue_count' });
      if (response && response.ok && typeof response.count === 'number') {
        updateDeleteUi(response.count);
        return;
      }
    } catch (error) {
      console.warn('Failed to fetch deletion queue count', error);
    }
    updateDeleteUi(null);
  }

  async function triggerDeletionBatch() {
    if (batchInFlight || !deleteQueuedButton) {
      return;
    }
    setBatchInFlight(true);
    try {
      const response = await sendRuntimeMessage({ type: 'run_ui_deletion_batch', trigger: 'popup_button' });
      if (response && response.ok) {
        const summary = response.summary || {};
        const successes = Number.isFinite(summary.successes) ? summary.successes : 0;
        const failures = Number.isFinite(summary.failures) ? summary.failures : 0;
        const total = Number.isFinite(summary.total) ? summary.total : successes + failures;
        const mode = summary.mode ? summary.mode.replace('_', ' ') : 'active tab';
        const message = `${successes}/${total} deleted · ${failures} failed (${mode})`;
        MiniToast.success(`Batch completed: ${message}`);
      } else {
        const message = response && response.error ? response.error : 'Batch failed.';
        MiniToast.error(message);
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      MiniToast.error(`Batch error: ${message}`);
    } finally {
      setBatchInFlight(false);
      refreshQueueCount();
    }
  }

  if (deleteQueuedButton) {
    deleteQueuedButton.addEventListener('click', () => {
      triggerDeletionBatch();
    });
  }

  function getDebugAPI() {
    return globalTarget && globalTarget.DebugPanel ? globalTarget.DebugPanel : null;
  }

  function scheduleDebugMount() {
    const api = getDebugAPI();
    if (!api || typeof api.mountDebug !== 'function') {
      return;
    }
    if (typeof globalTarget.setTimeout !== 'function') {
      if (activeTabName === 'debug') {
        api.mountDebug();
      }
      return;
    }
    globalTarget.setTimeout(() => {
      if (activeTabName === 'debug') {
        api.mountDebug();
      }
    }, 0);
  }

  function unmountDebugPanel() {
    const api = getDebugAPI();
    if (api && typeof api.unmountDebug === 'function') {
      api.unmountDebug();
    }
  }

  tabButtons.forEach((button) => {
    const tabName = button.dataset.tab;
    const panel = document.getElementById(`page-${tabName}`);
    if (panel) {
      panels.set(tabName, panel);
    }
  });

  panels.forEach((panel) => {
    const isActive = panel.classList.contains('active');
    panel.hidden = !isActive;
    panel.setAttribute('aria-hidden', String(!isActive));
  });

  /* Slovensky komentar: Aktivuje pozadovanu kartu, aktualizuje hash a fokus. */
  function activateTab(tabName, options = {}) {
    const { focus = true, updateHash = true } = options;
    const button = tabButtons.find((item) => item.dataset.tab === tabName);
    const panel = panels.get(tabName);
    if (!button || !panel) {
      return;
    }

    const previousTab = activeTabName;
    if (previousTab === tabName) {
      if (focus) {
        button.focus();
      }
      if (updateHash) {
        const nextHash = `#${tabName}`;
        if (window.location.hash !== nextHash) {
          suppressHashChange = true;
          window.location.hash = nextHash;
        }
      }
      return;
    }

    if (previousTab === 'debug' && tabName !== 'debug') {
      unmountDebugPanel();
    }

    tabButtons.forEach((item) => {
      const isActive = item === button;
      item.classList.toggle('active', isActive);
      item.setAttribute('aria-selected', String(isActive));
      item.tabIndex = isActive ? 0 : -1;
    });

    panels.forEach((candidate, key) => {
      const isActive = key === tabName;
      candidate.classList.toggle('active', isActive);
      candidate.setAttribute('aria-hidden', String(!isActive));
      candidate.hidden = !isActive;
    });

    if (focus) {
      button.focus();
    }

    if (updateHash) {
      const nextHash = `#${tabName}`;
      if (window.location.hash !== nextHash) {
        suppressHashChange = true;
        window.location.hash = nextHash;
      }
    }

    activeTabName = tabName;
    if (tabName === 'debug') {
      scheduleDebugMount();
    }
  }

  /* Slovensky komentar: Obsluha zmeny hash pre podporu deep linkov. */
  function syncFromHash({ focus = true, ensureHash = false } = {}) {
    const hashValue = window.location.hash.replace('#', '');
    if (panels.has(hashValue)) {
      activateTab(hashValue, { focus, updateHash: false });
      return;
    }
    activateTab(defaultTab, { focus, updateHash: ensureHash });
  }

  tabButtons.forEach((button, index) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      activateTab(button.dataset.tab);
    });

    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
        return;
      }
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = (index + delta + tabButtons.length) % tabButtons.length;
      const nextButton = tabButtons[nextIndex];
      if (nextButton) {
        activateTab(nextButton.dataset.tab);
      }
    });
  });

  window.addEventListener('hashchange', () => {
    if (suppressHashChange) {
      suppressHashChange = false;
      return;
    }
    syncFromHash({ focus: true, ensureHash: true });
  });

  if (tabButtons.length) {
    syncFromHash({ focus: false, ensureHash: true });
  }

  (async () => {
    await ensureSettingsSnapshot();
    await refreshQueueCount();
  })().catch((error) => {
    console.warn('Queue bootstrap failed', error);
    updateDeleteUi(null);
  });

  document.addEventListener('mychatgpt:debug-panel-ready', () => {
    if (activeTabName === 'debug') {
      scheduleDebugMount();
    }
  });

  const testButton = document.getElementById('test-log-btn');
  if (testButton) {
    testButton.addEventListener('click', async () => {
      /* Slovensky komentar: Zapise testovaci zaznam na overenie logovania. */
      await Logger.log('info', 'popup', 'Manual test log triggered');
      testButton.textContent = 'Logged!';
      setTimeout(() => {
        testButton.textContent = 'Test log';
      }, 1500);
    });
  }

  const bulkBackupButton = document.getElementById('bulk-backup-open-tabs-btn');
  const searchesToast = document.getElementById('searches-toast');

  /* Slovensky komentar: Zobrazi kratku toast spravu v sekcii Searches. */
  function showSearchToast(message, intent = 'info') {
    if (!searchesToast || !message) {
      return;
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    searchesToast.prepend(toast);
    while (searchesToast.childElementCount > 3) {
      searchesToast.removeChild(searchesToast.lastElementChild);
    }
    setTimeout(() => {
      if (toast.parentElement === searchesToast) {
        searchesToast.removeChild(toast);
      }
    }, 3200);
    const intentValue = typeof intent === 'string' ? intent : 'info';
    if (intentValue === 'success') {
      MiniToast.success(message);
      return;
    }
    if (intentValue === 'error') {
      MiniToast.error(message);
      return;
    }
    MiniToast.info(message);
  }

  /* Slovensky komentar: Naformatuje sumar do toast spravy. */
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

  /* Slovensky komentar: Vyziada bulk backup spracovanie od backgroundu. */
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

  if (bulkBackupButton) {
    bulkBackupButton.addEventListener('click', async () => {
      const originalText = bulkBackupButton.textContent;
      bulkBackupButton.disabled = true;
      bulkBackupButton.textContent = 'Working…';
      try {
        const response = await requestBulkBackupOpenTabs();
        if (response && response.ok) {
          showSearchToast(summarizeBulkResult(response.summary), 'success');
        } else {
          const message = response && response.error ? response.error : 'Bulk backup failed.';
          showSearchToast(message, 'error');
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        showSearchToast(`Bulk backup error: ${message}`, 'error');
      } finally {
        bulkBackupButton.disabled = false;
        bulkBackupButton.textContent = originalText;
      }
    });
  }

  function getSearchesApi() {
    if (globalTarget && typeof globalTarget === 'object' && globalTarget.SearchesPage) {
      return globalTarget.SearchesPage;
    }
    return null;
  }

  function showDeleteToast(payload) {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const reasonCode = payload.reasonCode;
    const backupInfo = payload.backup && typeof payload.backup === 'object' ? payload.backup : null;
    const matchSource = payload.ui && typeof payload.ui.matchSource === 'string'
      ? payload.ui.matchSource
      : null;
    const matchHint = matchSource ? ` (match: ${matchSource})` : '';
    if (backupInfo && backupInfo.ok === false && backupInfo.reasonCode) {
      const message = `Backup failed: ${backupInfo.reasonCode}`;
      showSearchToast(message, 'error');
      return;
    }
    if (reasonCode === 'capture_failed' || reasonCode === 'db_insert_failed') {
      const message = `Backup failed: ${reasonCode}`;
      showSearchToast(message, 'error');
      return;
    }
    if (!backupInfo || backupInfo.ok !== true) {
      if (reasonCode) {
        MiniToast.info(`Runner update: ${reasonCode}`);
      }
      return;
    }
    if (reasonCode === 'dry_run') {
      const message = 'Dry run: konverzácia zostala zachovaná.';
      showSearchToast(message, 'info');
      return;
    }
    if (reasonCode === 'list_only') {
      const message = 'Delete preskočený (List only mód).';
      showSearchToast(message, 'info');
      return;
    }
    if (reasonCode === 'confirm_required') {
      const message = 'Mazanie vyžaduje potvrdenie v nastaveniach.';
      showSearchToast(message, 'info');
      return;
    }
    if (payload.didDelete) {
      const message = `Delete OK${matchHint}`;
      showSearchToast(message, 'success');
      return;
    }
    const uiReason = payload.ui && payload.ui.reason ? payload.ui.reason : reasonCode;
    if (uiReason) {
      const message = `Delete failed: ${uiReason}${matchHint}`;
      showSearchToast(message, 'error');
    }
  }

  function handleRunnerUpdate(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : message;
    if (!payload || typeof payload !== 'object') {
      return;
    }
    if (payload.backup && payload.backup.ok) {
      showSearchToast('Backup saved', 'success');
    }
    const searchesApi = getSearchesApi();
    if (searchesApi && typeof searchesApi.loadAndRenderRecent === 'function') {
      try {
        const maybePromise = searchesApi.loadAndRenderRecent();
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch((error) => {
            console.warn('Failed to refresh searches after runner update', error);
          });
        }
      } catch (error) {
        console.warn('Failed to refresh searches after runner update', error);
      }
    }
    showDeleteToast(payload);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'runner_update') {
      handleRunnerUpdate(message.payload || message);
      return;
    }
    if (message.type === 'deletion_queue_updated') {
      if (typeof message.count === 'number') {
        updateDeleteUi(message.count);
      } else {
        refreshQueueCount();
      }
      return;
    }
  });
})();
