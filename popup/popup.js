/* Slovensky komentar: Obsluha jednotneho povrchu s kartami a internymi odkazmi. */
(function () {
  const defaultTab = 'searches';
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const panels = new Map();
  let suppressHashChange = false;
  let activeTabName = null;
  const globalTarget = typeof window !== 'undefined' ? window : self;

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
  function showSearchToast(message) {
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
          showSearchToast(summarizeBulkResult(response.summary));
        } else {
          const message = response && response.error ? response.error : 'Bulk backup failed.';
          showSearchToast(message);
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        showSearchToast(`Bulk backup error: ${message}`);
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
    if (backupInfo && backupInfo.ok === false && backupInfo.reasonCode) {
      showSearchToast(`Backup failed: ${backupInfo.reasonCode}`);
      return;
    }
    if (reasonCode === 'capture_failed' || reasonCode === 'db_insert_failed') {
      showSearchToast(`Backup failed: ${reasonCode}`);
      return;
    }
    if (!backupInfo || backupInfo.ok !== true) {
      return;
    }
    if (reasonCode === 'dry_run') {
      showSearchToast('Dry run: konverzácia zostala zachovaná.');
      return;
    }
    if (reasonCode === 'list_only') {
      showSearchToast('Delete preskočený (List only mód).');
      return;
    }
    if (reasonCode === 'confirm_required') {
      showSearchToast('Mazanie vyžaduje potvrdenie v nastaveniach.');
      return;
    }
    if (payload.didDelete) {
      showSearchToast('Delete OK');
      return;
    }
    const uiReason = payload.ui && payload.ui.reason ? payload.ui.reason : reasonCode;
    if (uiReason) {
      showSearchToast(`Delete failed: ${uiReason}`);
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
      showSearchToast('Backup saved');
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
    if (message && message.type === 'runner_update') {
      handleRunnerUpdate(message.payload || message);
    }
  });
})();
