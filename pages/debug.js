/* Slovensky komentar: Debug stranka ponuka manualne akcie bez ziveho streamu logov. */
(async function () {
  const testLogButton = document.getElementById('test-log-btn');
  const autoscanButton = document.getElementById('autoscan-feed-btn');
  const scanResultContainer = document.getElementById('scan-result');
  const connectivityButton = document.getElementById('connectivity-btn');
  const checkCsButton = document.getElementById('check-cs-btn');
  const connectivityContainer = document.getElementById('connectivity-results');
  const probeButton = document.getElementById('probe-btn');
  const metadataContainer = document.getElementById('metadata-results');
  const heuristicsButton = document.getElementById('heuristics-btn');
  const heuristicsContainer = document.getElementById('heuristics-results');
  const captureButton = document.getElementById('capture-btn');
  const captureContainer = document.getElementById('capture-results');
  const backupButton = document.getElementById('backup-btn');
  const backupModeLabel = document.getElementById('backup-mode-label');
  const backupToastContainer = document.getElementById('backup-toast');
  const backupHistoryContainer = document.getElementById('backup-history');
  const debugToastContainer = document.getElementById('debug-toast');
  const bulkOpenTabsButton = document.getElementById('bulk-open-tabs-btn');
  const bulkOpenTabsHistory = document.getElementById('bulk-open-tabs-history');

  /* Slovensky komentar: Zobrazi kratku toast spravu v debug nadpise. */
  function showDebugToast(message) {
    if (!debugToastContainer || !message) {
      return;
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    debugToastContainer.prepend(toast);
    while (debugToastContainer.childElementCount > 2) {
      debugToastContainer.removeChild(debugToastContainer.lastElementChild);
    }
    setTimeout(() => {
      if (toast.parentElement === debugToastContainer) {
        debugToastContainer.removeChild(toast);
      }
    }, 2600);
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
    if (!scanResultContainer) {
      return;
    }
    const block = document.createElement('div');
    block.className = 'log-entry';
    block.textContent = message;
    scanResultContainer.prepend(block);
    while (scanResultContainer.childElementCount > 5) {
      scanResultContainer.removeChild(scanResultContainer.lastElementChild);
    }
  }

  /* Slovensky komentar: Odosle stub pozadovku na autoscan. */
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

  /* Slovensky komentar: Prida JSON riadok do historie bulk backupu. */
  function appendBulkOpenTabsHistory(summary) {
    if (!bulkOpenTabsHistory) {
      return;
    }
    const block = document.createElement('div');
    block.className = 'log-entry';
    const dryRun = summary && Array.isArray(summary.wouldWrite);
    const payload = summary && typeof summary === 'object'
      ? {
          timestamp: summary.timestamp || null,
          scannedTabs: Number.isFinite(summary.scannedTabs) ? summary.scannedTabs : 0,
          candidates: summary.stats && Number.isFinite(summary.stats.candidates)
            ? summary.stats.candidates
            : 0,
          written: Array.isArray(summary.written) ? summary.written.length : 0,
          wouldWrite: dryRun ? (summary.wouldWrite ? summary.wouldWrite.length : 0) : 0,
          skipped: Array.isArray(summary.skipped) ? summary.skipped.length : 0,
          dryRun
        }
      : { note: 'no summary' };
    block.textContent = JSON.stringify(payload);
    bulkOpenTabsHistory.prepend(block);
    while (bulkOpenTabsHistory.childElementCount > 10) {
      bulkOpenTabsHistory.removeChild(bulkOpenTabsHistory.lastElementChild);
    }
  }

  /* Slovensky komentar: Naformatuje sumar bulk backupu pre toast. */
  function summarizeBulkToast(summary) {
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

  if (autoscanButton) {
    autoscanButton.addEventListener('click', async () => {
      const originalLabel = autoscanButton.textContent;
      autoscanButton.disabled = true;
      autoscanButton.textContent = 'Prebieha…';
      try {
        const response = await requestAutoscanStub();
        if (response && response.ok) {
          appendScanToast(`Auto-scan stub: ${JSON.stringify(response.result)}`);
          await Logger.log('info', 'scan', 'Auto-scan feed stub executed', {
            result: response.result
          });
        } else {
          const errorMessage = extractErrorMessage(response && (response.error || response.message));
          appendScanToast(`Auto-scan chyba: ${errorMessage}`);
          await Logger.log('error', 'scan', 'Auto-scan feed stub failed', {
            message: errorMessage
          });
        }
      } catch (error) {
        const message = extractErrorMessage(error);
        appendScanToast(`Auto-scan chyba: ${message}`);
        await Logger.log('error', 'scan', 'Auto-scan feed stub threw error', {
          message
        });
      } finally {
        autoscanButton.disabled = false;
        autoscanButton.textContent = originalLabel;
      }
    });
  }

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

  if (testLogButton) {
    testLogButton.addEventListener('click', async () => {
      const originalText = testLogButton.textContent;
      const note = `debug_page:${Date.now()}`;
      testLogButton.disabled = true;
      testLogButton.textContent = 'Odosielam…';
      try {
        const response = await requestTestLog(note);
        if (!response || response.ok !== true) {
          const errorMessage = response && response.error ? response.error : 'Žiadna odozva';
          throw new Error(errorMessage);
        }
        showDebugToast('Test log odoslaný (pozri DevTools)');
        testLogButton.textContent = 'Odoslané';
        await Logger.log('info', 'debug', 'Test log request forwarded', {
          forwarded: Boolean(response.forwarded),
          forwardError: response.forwardError || null,
          requestedAt: response.requestedAt,
          note
        });
      } catch (error) {
        testLogButton.textContent = 'Chyba';
        const message = extractErrorMessage(error);
        showDebugToast(`Test log zlyhal: ${message}`);
        await Logger.log('error', 'debug', 'Test log request failed', {
          message,
          note
        });
      } finally {
        setTimeout(() => {
          testLogButton.textContent = originalText;
          testLogButton.disabled = false;
        }, 1400);
      }
    });
  }

  /* Slovensky komentar: Prida zaznam z konektivity do histórie. */
  function appendConnectivityRecord(text) {
    if (!connectivityContainer) {
      return;
    }
    const block = document.createElement('div');
    block.className = 'log-entry';
    block.textContent = text;
    connectivityContainer.prepend(block);
    while (connectivityContainer.childElementCount > 5) {
      connectivityContainer.removeChild(connectivityContainer.lastElementChild);
    }
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

  connectivityButton.addEventListener('click', async () => {
    const originalLabel = connectivityButton.textContent;
    connectivityButton.disabled = true;
    connectivityButton.textContent = 'Overujem…';
    try {
      const response = await requestConnectivityTest();
      if (response && response.ok && response.payload) {
        appendConnectivityRecord(`OK: ${JSON.stringify(response.payload)}`);
        await Logger.log('info', 'debug', 'Connectivity test succeeded', {
          reasonCode: response.reasonCode,
          traceId: response.payload.traceId
        });
      } else {
        const errorMessage = extractErrorMessage(response && (response.error || response.message));
        appendConnectivityRecord(`Chyba: ${errorMessage}`);
        await Logger.log('warn', 'debug', 'Connectivity test returned warning', {
          reasonCode: response && response.reasonCode ? response.reasonCode : 'unknown',
          message: errorMessage
        });
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      appendConnectivityRecord(`Chyba: ${message}`);
      await Logger.log('error', 'debug', 'Connectivity test request threw error', {
        message
      });
    } finally {
      connectivityButton.disabled = false;
      connectivityButton.textContent = originalLabel;
    }
  });

  if (checkCsButton) {
    checkCsButton.addEventListener('click', async () => {
      const originalText = checkCsButton.textContent;
      checkCsButton.disabled = true;
      checkCsButton.textContent = 'Overujem…';
      try {
        const response = await requestConnectivityTest();
        if (response && response.ok) {
          checkCsButton.textContent = 'Content script aktívny';
          appendConnectivityRecord(`Check CS OK: ${JSON.stringify(response.payload || {})}`);
          await Logger.log('info', 'debug', 'Content script check succeeded', {
            reasonCode: response.reasonCode || 'ping_ok'
          });
        } else {
          const errorMessage = extractErrorMessage(response && (response.error || response.message));
          checkCsButton.textContent = 'Content script chýba';
          appendConnectivityRecord(`Check CS chyba: ${errorMessage}`);
          await Logger.log('warn', 'debug', 'Content script check warning', {
            reasonCode: response && response.reasonCode ? response.reasonCode : 'no_response',
            message: errorMessage
          });
        }
      } catch (error) {
        checkCsButton.textContent = 'Content script chýba';
        const message = extractErrorMessage(error);
        appendConnectivityRecord(`Check CS chyba: ${message}`);
        await Logger.log('error', 'debug', 'Content script check threw error', {
          message
        });
      } finally {
        setTimeout(() => {
          checkCsButton.textContent = originalText;
          checkCsButton.disabled = false;
        }, 1400);
      }
    });
  }

  /* Slovensky komentar: Vytvori zaznam o metadata probe v historii. */
  function appendProbeRecord(text) {
    if (!metadataContainer) {
      return;
    }
    const block = document.createElement('div');
    block.className = 'log-entry';
    block.textContent = text;
    metadataContainer.prepend(block);
    while (metadataContainer.childElementCount > 5) {
      metadataContainer.removeChild(metadataContainer.lastElementChild);
    }
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

  if (probeButton) {
    probeButton.addEventListener('click', async () => {
      const originalLabel = probeButton.textContent;
      probeButton.disabled = true;
      probeButton.textContent = 'Prebieha…';
      try {
        const response = await requestMetadataProbe();
        if (response && response.ok && response.payload) {
          const payload = response.payload;
          if (payload.skipped && payload.reason === 'probe_safe_url') {
            appendProbeRecord('Preskocené: Aktívna stránka je chránená vzorom SAFE_URL.');
          } else {
            appendProbeRecord(`OK: ${JSON.stringify(payload)}`);
          }
          await Logger.log('info', 'debug', 'Metadata probe completed', {
            reasonCode: response.reasonCode,
            traceId: payload.traceId,
            skipped: Boolean(payload.skipped)
          });
        } else {
          const errorMessage = extractErrorMessage(response && (response.error || response.message));
          appendProbeRecord(`Chyba: ${errorMessage}`);
          await Logger.log('warn', 'debug', 'Metadata probe returned warning', {
            reasonCode: response && response.reasonCode ? response.reasonCode : 'unknown',
            message: errorMessage
          });
        }
      } catch (error) {
        const message = extractErrorMessage(error);
        appendProbeRecord(`Chyba: ${message}`);
        await Logger.log('error', 'debug', 'Metadata probe request threw error', {
          message
        });
      } finally {
        probeButton.disabled = false;
        probeButton.textContent = originalLabel;
      }
    });
  }

  /* Slovensky komentar: Prida zaznam o heuristike do historie. */
  function appendHeuristicsRecord(text) {
    if (!heuristicsContainer) {
      return;
    }
    const block = document.createElement('div');
    block.className = 'log-entry';
    block.textContent = text;
    heuristicsContainer.prepend(block);
    while (heuristicsContainer.childElementCount > 5) {
      heuristicsContainer.removeChild(heuristicsContainer.lastElementChild);
    }
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

  if (heuristicsButton) {
    heuristicsButton.addEventListener('click', async () => {
      const originalLabel = heuristicsButton.textContent;
      heuristicsButton.disabled = true;
      heuristicsButton.textContent = 'Evaluating…';
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
          await Logger.log('info', 'debug', 'Heuristics evaluation invoked manually', {
            reasonCode: response.reasonCode,
            candidate: decision.isCandidate,
            decided: decision.decided,
            reasonCodes: decision.reasonCodes,
            cooldown
          });
        } else {
          const reason = response && response.reasonCode ? response.reasonCode : 'unknown';
          const errorDetail = extractErrorMessage(response && (response.error || response.message), '').trim();
          const reasonLine = errorDetail ? `${reason} (${errorDetail})` : reason;
          appendHeuristicsRecord(`[${timestamp}] Heuristics failed: ${reasonLine}`);
          await Logger.log('warn', 'debug', 'Heuristics evaluation returned warning', {
            reasonCode: reason,
            message: errorDetail || null
          });
        }
      } catch (error) {
        const message = extractErrorMessage(error);
        appendHeuristicsRecord(`Heuristics error: ${message}`);
        await Logger.log('error', 'debug', 'Heuristics evaluation request threw error', {
          message
        });
      } finally {
        heuristicsButton.disabled = false;
        heuristicsButton.textContent = originalLabel;
      }
    });
  }

  /* Slovensky komentar: Prida zaznam o capture preview do historie. */
  function appendCaptureRecord(text) {
    if (!captureContainer) {
      return;
    }
    const block = document.createElement('div');
    block.className = 'log-entry';
    block.textContent = text;
    captureContainer.prepend(block);
    while (captureContainer.childElementCount > 5) {
      captureContainer.removeChild(captureContainer.lastElementChild);
    }
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

  if (captureButton) {
    captureButton.addEventListener('click', async () => {
      const originalLabel = captureButton.textContent;
      captureButton.disabled = true;
      captureButton.textContent = 'Capturing…';
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
          await Logger.log('info', 'debug', 'Capture preview invoked', {
            reasonCode: response.reasonCode,
            skipped: Boolean(payload.skipped)
          });
        } else {
          const message = extractErrorMessage(response && (response.error || response.message));
          appendCaptureRecord(`Chyba: ${message}`);
          await Logger.log('warn', 'debug', 'Capture preview returned warning', {
            reasonCode: response && response.reasonCode ? response.reasonCode : 'capture_error',
            message
          });
        }
      } catch (error) {
        const message = extractErrorMessage(error);
        appendCaptureRecord(`Chyba: ${message}`);
        await Logger.log('error', 'debug', 'Capture preview request threw error', {
          message
        });
      } finally {
        captureButton.disabled = false;
        captureButton.textContent = originalLabel;
      }
    });
  }

  if (bulkOpenTabsButton) {
    bulkOpenTabsButton.addEventListener('click', async () => {
      const originalText = bulkOpenTabsButton.textContent;
      bulkOpenTabsButton.disabled = true;
      bulkOpenTabsButton.textContent = 'Working…';
      try {
        const response = await requestBulkBackupOpenTabs();
        if (response && response.ok) {
          showDebugToast(summarizeBulkToast(response.summary));
          const summary = response.summary || {};
          const dryRun = summary && Array.isArray(summary.wouldWrite);
          const meta = {
            reasonCode: dryRun ? 'bulk_backup_dry_run' : 'bulk_backup_ok',
            scannedTabs: Number.isFinite(summary.scannedTabs) ? summary.scannedTabs : 0,
            candidates: summary.stats && Number.isFinite(summary.stats.candidates)
              ? summary.stats.candidates
              : 0,
            written: Array.isArray(summary.written) ? summary.written.length : 0,
            wouldWrite: dryRun ? (summary.wouldWrite ? summary.wouldWrite.length : 0) : 0,
            skipped: Array.isArray(summary.skipped) ? summary.skipped.length : 0
          };
          await Logger.log('info', 'debug', 'Bulk backup over open tabs finished', meta);
        } else {
          const message = extractErrorMessage(response && (response.error || response.message), 'Bulk backup failed.');
          showDebugToast(message);
          await Logger.log('warn', 'debug', 'Bulk backup over open tabs blocked', {
            message,
            reasonCode: 'bulk_backup_error'
          });
        }
      } catch (error) {
        const message = extractErrorMessage(error, 'Bulk backup error.');
        showDebugToast(message);
        await Logger.log('error', 'debug', 'Bulk backup over open tabs threw error', {
          message
        });
      } finally {
        bulkOpenTabsButton.disabled = false;
        bulkOpenTabsButton.textContent = originalText;
      }
    });
  }

  /* Slovensky komentar: Vykresli toast pre manualne zalozenie. */
  function appendBackupToast(text) {
    if (!backupToastContainer) {
      return;
    }
    const block = document.createElement('div');
    block.className = 'log-entry';
    block.textContent = text;
    backupToastContainer.prepend(block);
    while (backupToastContainer.childElementCount > 4) {
      backupToastContainer.removeChild(backupToastContainer.lastElementChild);
    }
  }

  /* Slovensky komentar: Prida kartu s vysledkom manualnej zalohy. */
  function appendBackupHistoryCard(record) {
    if (!backupHistoryContainer || !record) {
      return;
    }
    const card = document.createElement('div');
    card.className = 'log-entry';
    const qLen = record.questionText ? record.questionText.length : 0;
    const aLen = record.answerHTML ? record.answerHTML.length : 0;
    const titlePreview = record.title ? record.title : '(bez názvu)';
    const convoPreview = record.convoId ? record.convoId : '∅';
    const truncatedText = record.answerTruncated ? 'truncated=yes' : 'truncated=no';
    card.textContent = `id=${record.id} | title=${titlePreview} | qLen=${qLen} | aLen=${aLen} | convo=${convoPreview} | ${truncatedText}`;
    backupHistoryContainer.prepend(card);
    while (backupHistoryContainer.childElementCount > 5) {
      backupHistoryContainer.removeChild(backupHistoryContainer.lastElementChild);
    }
  }

  /* Slovensky komentar: Aktualizuje popis rezimu zalohy. */
  async function refreshBackupModeLabel() {
    if (!backupModeLabel) {
      return;
    }
    try {
      const { settings } = await SettingsStore.load();
      backupModeLabel.textContent = settings.CAPTURE_ONLY_CANDIDATES ? 'Candidates only' : 'All chats allowed';
    } catch (error) {
      backupModeLabel.textContent = 'Mode unknown';
      await Logger.log('warn', 'debug', 'Failed to read settings for backup label', {
        message: error && error.message
      });
    }
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

  if (backupButton) {
    backupButton.addEventListener('click', async () => {
      const labelSpan = backupButton.querySelector('span');
      const originalLabel = labelSpan ? labelSpan.textContent : backupButton.textContent;
      backupButton.disabled = true;
      if (labelSpan) {
        labelSpan.textContent = 'Working…';
      } else {
        backupButton.textContent = 'Working…';
      }
      try {
        const response = await requestManualBackup();
        if (response && response.ok) {
          appendBackupToast(response.message || 'Backup completed.');
          appendBackupHistoryCard(response.record);
          await Logger.log('info', 'debug', 'Manual backup executed', {
            reasonCode: response.reasonCode,
            dryRun: Boolean(response.dryRun),
            id: response.record ? response.record.id : null
          });
        } else {
          const reason = response && response.reasonCode ? response.reasonCode : 'unknown';
          const message = extractErrorMessage(response && (response.message || response.error));
          appendBackupToast(message || 'Manual backup failed.');
          await Logger.log('warn', 'debug', 'Manual backup blocked', {
            reasonCode: reason,
            message: message || null
          });
        }
      } catch (error) {
        const message = extractErrorMessage(error);
        appendBackupToast(message || 'Manual backup error.');
        await Logger.log('error', 'debug', 'Manual backup threw error', {
          message
        });
      } finally {
        backupButton.disabled = false;
        if (labelSpan) {
          labelSpan.textContent = originalLabel;
        } else {
          backupButton.textContent = originalLabel;
        }
        await refreshBackupModeLabel();
      }
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'bulk_backup_summary') {
      appendBulkOpenTabsHistory(message.summary);
    }
  });

  try {
    const storedBulk = await chrome.storage.local.get({ last_bulk_backup: null });
    if (storedBulk.last_bulk_backup) {
      appendBulkOpenTabsHistory(storedBulk.last_bulk_backup);
    }
  } catch (error) {
    await Logger.log('warn', 'debug', 'Failed to load bulk backup summary history', {
      message: error && error.message
    });
  }

  await refreshBackupModeLabel();
  await Logger.log('info', 'db', 'Debug page opened');
})();
