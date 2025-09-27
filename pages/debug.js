/* Slovensky komentar: Debug stranka ponuka manualne akcie bez ziveho streamu logov. */
(async function () {
  const testLogButton = document.getElementById('test-log-btn');
  const autoscanButton = document.getElementById('autoscan-feed-btn');
  const scanResultContainer = document.getElementById('scan-result');
  const connectivityButton = document.getElementById('connectivity-btn');
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
          const errorMessage = (response && response.error) || 'Neznáma chyba';
          appendScanToast(`Auto-scan chyba: ${errorMessage}`);
          await Logger.log('error', 'scan', 'Auto-scan feed stub failed', {
            message: errorMessage
          });
        }
      } catch (error) {
        appendScanToast(`Auto-scan chyba: ${error && error.message}`);
        await Logger.log('error', 'scan', 'Auto-scan feed stub threw error', {
          message: error && error.message
        });
      } finally {
        autoscanButton.disabled = false;
        autoscanButton.textContent = originalLabel;
      }
    });
  }

  if (testLogButton) {
    testLogButton.addEventListener('click', async () => {
      /* Slovensky komentar: Zapise testovaci zaznam pre rychle overenie. */
      const originalText = testLogButton.textContent;
      testLogButton.disabled = true;
      try {
        await Logger.log('info', 'debug', 'Manual test log triggered on debug page');
        testLogButton.textContent = 'Logged!';
      } catch (error) {
        testLogButton.textContent = 'Error';
        await Logger.log('error', 'debug', 'Test log failed on debug page', {
          message: error && error.message
        });
      } finally {
        setTimeout(() => {
          testLogButton.textContent = originalText;
          testLogButton.disabled = false;
        }, 1200);
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
        const errorMessage = (response && response.error) || 'Neznáma chyba';
        appendConnectivityRecord(`Chyba: ${errorMessage}`);
        await Logger.log('warn', 'debug', 'Connectivity test returned warning', {
          reasonCode: response && response.reasonCode ? response.reasonCode : 'unknown',
          message: errorMessage
        });
      }
    } catch (error) {
      appendConnectivityRecord(`Chyba: ${error && error.message}`);
      await Logger.log('error', 'debug', 'Connectivity test request threw error', {
        message: error && error.message
      });
    } finally {
      connectivityButton.disabled = false;
      connectivityButton.textContent = originalLabel;
    }
  });

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
          const errorMessage = (response && response.error) || 'Neznáma chyba';
          appendProbeRecord(`Chyba: ${errorMessage}`);
          await Logger.log('warn', 'debug', 'Metadata probe returned warning', {
            reasonCode: response && response.reasonCode ? response.reasonCode : 'unknown',
            message: errorMessage
          });
        }
      } catch (error) {
        appendProbeRecord(`Chyba: ${error && error.message}`);
        await Logger.log('error', 'debug', 'Metadata probe request threw error', {
          message: error && error.message
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
          const cooldown = response.cooldown || { wouldWait: false, remainingMs: 0 };
          const cooldownText = `autoCooldown=${cooldown.wouldWait ? `wait ${cooldown.remainingMs}ms` : 'ready'}`;
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
          appendHeuristicsRecord(`[${timestamp}] Heuristics failed: ${reason}`);
          await Logger.log('warn', 'debug', 'Heuristics evaluation returned warning', {
            reasonCode: reason
          });
        }
      } catch (error) {
        appendHeuristicsRecord(`Heuristics error: ${error && error.message}`);
        await Logger.log('error', 'debug', 'Heuristics evaluation request threw error', {
          message: error && error.message
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
          const message = (response && response.error) || 'Neznáma chyba';
          appendCaptureRecord(`Chyba: ${message}`);
          await Logger.log('warn', 'debug', 'Capture preview returned warning', {
            reasonCode: response && response.reasonCode ? response.reasonCode : 'capture_error',
            message
          });
        }
      } catch (error) {
        appendCaptureRecord(`Chyba: ${error && error.message}`);
        await Logger.log('error', 'debug', 'Capture preview request threw error', {
          message: error && error.message
        });
      } finally {
        captureButton.disabled = false;
        captureButton.textContent = originalLabel;
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
          appendBackupToast(response && response.message ? response.message : 'Manual backup failed.');
          await Logger.log('warn', 'debug', 'Manual backup blocked', {
            reasonCode: reason,
            message: response && response.message ? response.message : null
          });
        }
      } catch (error) {
        appendBackupToast(error && error.message ? error.message : 'Manual backup error.');
        await Logger.log('error', 'debug', 'Manual backup threw error', {
          message: error && error.message
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

  await refreshBackupModeLabel();
  await Logger.log('info', 'db', 'Debug page opened');
})();
