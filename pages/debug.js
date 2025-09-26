/* Slovensky komentar: Logika pre nacitanie, filtrovanie a export logov. */
(async function () {
  const filterInput = document.getElementById('filter-input');
  const logsContainer = document.getElementById('logs');
  const refreshButton = document.getElementById('refresh-btn');
  const exportButton = document.getElementById('export-btn');
  const clearButton = document.getElementById('clear-btn');
  const scanButton = document.getElementById('scan-btn');
  const scanResultContainer = document.getElementById('scan-result');
  const connectivityButton = document.getElementById('connectivity-btn');
  const connectivityContainer = document.getElementById('connectivity-results');
  const probeButton = document.getElementById('probe-btn');
  const metadataContainer = document.getElementById('metadata-results');
  const heuristicsButton = document.getElementById('heuristics-btn');
  const heuristicsContainer = document.getElementById('heuristics-results');

  async function loadAndRenderLogs() {
    const filterValue = filterInput.value.trim().toLowerCase();
    const logs = await Logger.getLogs();
    logsContainer.innerHTML = '';
    logs
      .filter((entry) => {
        if (!filterValue) {
          return true;
        }
        const text = JSON.stringify(entry).toLowerCase();
        return text.includes(filterValue);
      })
      .forEach((entry) => {
        const block = document.createElement('div');
        block.className = 'log-entry';
        block.textContent = JSON.stringify(entry, null, 2);
        logsContainer.appendChild(block);
      });
    if (!logsContainer.children.length) {
      const empty = document.createElement('div');
      empty.className = 'log-entry';
      empty.textContent = 'No logs to display.';
      logsContainer.appendChild(empty);
    }
  }

  filterInput.addEventListener('input', () => {
    loadAndRenderLogs();
  });

  refreshButton.addEventListener('click', () => {
    loadAndRenderLogs();
  });

  exportButton.addEventListener('click', async () => {
    const logs = await Logger.getLogs();
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mychatgpt-debug-logs.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });

  clearButton.addEventListener('click', async () => {
    await Logger.clear();
    await Logger.log('info', 'db', 'Logs cleared from debug page');
    await loadAndRenderLogs();
  });

  /* Slovensky komentar: Vytvori toast so stavom skenu. */
  function appendScanToast(message) {
    const block = document.createElement('div');
    block.className = 'log-entry';
    block.textContent = message;
    scanResultContainer.prepend(block);
    while (scanResultContainer.childElementCount > 4) {
      scanResultContainer.removeChild(scanResultContainer.lastElementChild);
    }
  }

  /* Slovensky komentar: Odosle spravu pre stub skenovanie. */
  function requestScanStub() {
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

  scanButton.addEventListener('click', async () => {
    const originalLabel = scanButton.textContent;
    scanButton.disabled = true;
    scanButton.textContent = 'Prebieha stub…';
    try {
      const response = await requestScanStub();
      if (response && response.ok) {
        appendScanToast(`Scan stub executed: ${JSON.stringify(response.result)}`);
        await Logger.log('info', 'scan', 'Scan stub completed on debug page', {
          result: response.result
        });
      } else {
        const errorMessage = (response && response.error) || 'Neznáma chyba';
        appendScanToast(`Scan stub failed: ${errorMessage}`);
        await Logger.log('error', 'scan', 'Scan stub returned error', {
          message: errorMessage
        });
      }
    } catch (error) {
      appendScanToast(`Scan stub failed: ${error && error.message}`);
      await Logger.log('error', 'scan', 'Scan stub request threw error', {
        message: error && error.message
      });
    } finally {
      scanButton.disabled = false;
      scanButton.textContent = originalLabel;
    }
  });

  /* Slovensky komentar: Prida zaznam z konektivity do histórie. */
  function appendConnectivityRecord(text) {
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
          if (payload.skipped && payload.reason === 'safe_url_pattern') {
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

  await Logger.log('info', 'db', 'Debug page opened');
  await loadAndRenderLogs();
})();
