import { logInfo, tailLogs, clearLogs, getLogs } from './utils.js';

const TAIL_LIMIT = 200;
const TAIL_INTERVAL_MS = 1000;

export async function init({ root }) {
  const tailEl = root.querySelector('[data-role="log-tail"]');
  const levelSelect = root.querySelector('[data-role="log-level-filter"]');
  const lastScanLabel = root.querySelector('[data-role="last-scan"]');
  const scanButton = root.querySelector('[data-action="scan-now"]');
  const injectButton = root.querySelector('[data-action="force-inject"]');
  const exportButton = root.querySelector('[data-action="export-logs"]');
  const clearButton = root.querySelector('[data-action="clear-logs"]');
  const probeButton = root.querySelector('[data-action="run-probe"]');
  const copyProbeButton = root.querySelector('[data-action="copy-probe"]');
  const probeOutput = root.querySelector('[data-role="probe-output"]');
  const snapshotContainer = root.querySelector('[data-role="snapshot-container"]');
  const snapshotOutput = root.querySelector('[data-role="snapshot-output"]');
  const injectStatus = root.querySelector('[data-role="inject-status"]');

  let tailTimer = null;
  let currentLevel = levelSelect?.value || 'INFO';
  let latestProbeJson = '';
  let injectStatusTimer = null;

  async function refreshAll() {
    await Promise.all([refreshLogs(), refreshSummary(), refreshSnapshot()]);
  }

  async function refreshLogs() {
    const logs = await tailLogs({ limit: TAIL_LIMIT, minLevel: currentLevel });
    renderLogs(logs);
  }

  function renderLogs(logs) {
    if (!tailEl) {
      return;
    }
    tailEl.innerHTML = '';
    logs
      .slice()
      .reverse()
      .forEach((entry) => {
        const div = document.createElement('div');
        div.className = 'log-entry';
        div.textContent = formatEntry(entry);
        tailEl.appendChild(div);
      });
  }

  function formatEntry(entry) {
    const level = (entry.level || 'info').toUpperCase();
    const scope = entry.scope || 'general';
    const time = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '—';
    const reason = entry.meta?.reasonCode ? ` (${entry.meta.reasonCode})` : '';
    let line = `[${time}] [${level}] [${scope}] ${entry.msg}${reason}`;
    if (entry.meta) {
      const extra = { ...entry.meta };
      delete extra.reasonCode;
      if (Object.keys(extra).length) {
        line += ` ${JSON.stringify(extra)}`;
      }
    }
    if (entry.err) {
      line += ` :: ${entry.err.name || 'Error'}: ${entry.err.message}`;
    }
    return line;
  }

  async function refreshSummary() {
    const { last_scan_summary: summary = null, last_scan_at: at = null } = await chrome.storage.local.get([
      'last_scan_summary',
      'last_scan_at'
    ]);
    if (!lastScanLabel) {
      return;
    }
    if (!summary) {
      lastScanLabel.textContent = 'No scans yet.';
      return;
    }
    const timestamp = at ? new Date(at).toLocaleString() : 'unknown time';
    lastScanLabel.textContent = `${timestamp}: ${summary}`;
  }

  async function refreshSnapshot() {
    if (!snapshotContainer || !snapshotOutput) {
      return;
    }
    const { debug_last_extractor_dump: snapshot = null } = await chrome.storage.local.get([
      'debug_last_extractor_dump'
    ]);
    if (!snapshot) {
      snapshotContainer.hidden = true;
      snapshotOutput.textContent = '';
      return;
    }
    snapshotContainer.hidden = false;
    snapshotOutput.textContent = JSON.stringify(snapshot, null, 2);
  }

  function startTailPolling() {
    stopTailPolling();
    tailTimer = setInterval(() => {
      if (!root.isConnected) {
        stopTailPolling();
        return;
      }
      const isHidden = Boolean(root.closest('[hidden]'));
      if (!isHidden) {
        refreshLogs();
      }
    }, TAIL_INTERVAL_MS);
  }

  function stopTailPolling() {
    if (tailTimer) {
      clearInterval(tailTimer);
      tailTimer = null;
    }
  }

  function updateInjectStatus(message, { error = false } = {}) {
    if (!injectStatus) {
      return;
    }
    injectStatus.textContent = message || '';
    if (!message) {
      injectStatus.removeAttribute('data-state');
    } else {
      injectStatus.setAttribute('data-state', error ? 'error' : 'success');
    }
    if (injectStatusTimer) {
      clearTimeout(injectStatusTimer);
      injectStatusTimer = null;
    }
    if (message) {
      injectStatusTimer = setTimeout(() => {
        if (injectStatus) {
          injectStatus.textContent = '';
          injectStatus.removeAttribute('data-state');
        }
        injectStatusTimer = null;
      }, 3000);
    }
  }

  levelSelect?.addEventListener('change', async () => {
    currentLevel = levelSelect.value || 'INFO';
    await refreshLogs();
  });

  scanButton?.addEventListener('click', async () => {
    scanButton.disabled = true;
    try {
      await logInfo('ui', 'Manual scan requested');
      const response = await chrome.runtime.sendMessage({ type: 'scanNow' });
      if (response?.summary) {
        const timestamp = new Date().toLocaleString();
        if (lastScanLabel) {
          lastScanLabel.textContent = `${timestamp}: ${response.summary}`;
        }
      }
    } catch (error) {
      console.error(error);
    } finally {
      scanButton.disabled = false;
    }
  });

  injectButton?.addEventListener('click', async () => {
    injectButton.disabled = true;
    updateInjectStatus('Injecting content script...');
    try {
      await logInfo('ui', 'Force inject requested');
      const response = await chrome.runtime.sendMessage({ type: 'FORCE_INJECT' });
      if (response?.ok) {
        updateInjectStatus('Content script injected.');
      } else if (response?.error === 'no-active-chat-tab') {
        updateInjectStatus('Open a chatgpt.com tab and try again.', { error: true });
      } else {
        const detail = response?.error ? `: ${response.error}` : '';
        updateInjectStatus(`Injection failed${detail}.`, { error: true });
      }
    } catch (error) {
      updateInjectStatus(`Injection failed: ${error?.message || error}`, { error: true });
    } finally {
      injectButton.disabled = false;
    }
  });

  exportButton?.addEventListener('click', async () => {
    const logs = await getLogs();
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mychatgpt-debug-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  clearButton?.addEventListener('click', async () => {
    await clearLogs();
    await refreshLogs();
  });

  probeButton?.addEventListener('click', async () => {
    probeButton.disabled = true;
    copyProbeButton.disabled = true;
    latestProbeJson = '';
    if (probeOutput) {
      probeOutput.textContent = 'Running extractor probe...';
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: 'RUN_DEBUG_PROBE' });
      if (!response?.ok) {
        throw new Error(response?.error || 'Probe failed');
      }
      const formatted = JSON.stringify(response.probe, null, 2);
      latestProbeJson = formatted;
      if (probeOutput) {
        probeOutput.textContent = formatted;
      }
      copyProbeButton.disabled = false;
    } catch (error) {
      if (probeOutput) {
        probeOutput.textContent = `Probe failed: ${error?.message || error}`;
      }
    } finally {
      probeButton.disabled = false;
    }
  });

  copyProbeButton?.addEventListener('click', async () => {
    if (!latestProbeJson) {
      return;
    }
    try {
      await navigator.clipboard.writeText(latestProbeJson);
      copyProbeButton.textContent = 'Copied';
      setTimeout(() => {
        copyProbeButton.textContent = 'Copy JSON';
      }, 1500);
    } catch (error) {
      console.error(error);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
      return;
    }
    if (changes.debug_logs) {
      refreshLogs();
    }
    if (changes.last_scan_summary || changes.last_scan_at) {
      refreshSummary();
    }
    if (changes.debug_last_extractor_dump) {
      refreshSnapshot();
    }
  });

  await refreshAll();
  startTailPolling();

  return {
    onShow: () => {
      refreshAll();
      startTailPolling();
    },
    onHide: () => {
      stopTailPolling();
    }
  };
}
