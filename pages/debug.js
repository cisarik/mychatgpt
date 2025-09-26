/* Slovensky komentar: Logika pre nacitanie, filtrovanie a export logov. */
(async function () {
  const filterInput = document.getElementById('filter-input');
  const logsContainer = document.getElementById('logs');
  const refreshButton = document.getElementById('refresh-btn');
  const exportButton = document.getElementById('export-btn');
  const clearButton = document.getElementById('clear-btn');

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
    await Logger.log('info', 'pages/debug', 'Logs cleared from debug page');
    await loadAndRenderLogs();
  });

  await Logger.log('info', 'pages/debug', 'Debug page opened');
  await loadAndRenderLogs();
})();
