/* Slovensky komentar: Logika pre nacitanie, filtrovanie a export logov. */
(async function () {
  const filterInput = document.getElementById('filter-input');
  const logsContainer = document.getElementById('logs');
  const refreshButton = document.getElementById('refresh-btn');
  const exportButton = document.getElementById('export-btn');
  const clearButton = document.getElementById('clear-btn');
  const scanButton = document.getElementById('scan-btn');
  const scanResultContainer = document.getElementById('scan-result');

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

  await Logger.log('info', 'db', 'Debug page opened');
  await loadAndRenderLogs();
})();
