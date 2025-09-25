import { logInfo, tailLogs, clearLogs, getLogs } from './utils.js';

const TAIL_LIMIT = 200;
const TAIL_INTERVAL_MS = 1000;
const REPORT_STORAGE_KEY = 'would_delete_report';
const REPORT_CSV_COLUMNS = [
  'url',
  'convoId',
  'title',
  'messageCount',
  'userMessageCount',
  'lastMessageAgeMin',
  'reasons',
  'ts'
];

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
  const reportCard = root.querySelector('[data-role="would-report"]');
  const reportRows = root.querySelector('[data-role="report-rows"]');
  const reportTotalSeenEl = root.querySelector('[data-role="report-total-seen"]');
  const reportTotalQualifiedEl = root.querySelector('[data-role="report-total-qualified"]');
  const reportUpdatedEl = root.querySelector('[data-role="report-updated"]');
  const reportRefreshButton = root.querySelector('[data-action="report-refresh"]');
  const reportExportButton = root.querySelector('[data-action="report-export"]');
  const reportClearButton = root.querySelector('[data-action="report-clear"]');
  const reportScanAllButton = root.querySelector('[data-action="report-scan-all"]');

  let tailTimer = null;
  let currentLevel = levelSelect?.value || 'INFO';
  let latestProbeJson = '';
  let injectStatusTimer = null;
  let latestReport = null;

  async function refreshAll() {
    await Promise.all([refreshLogs(), refreshSummary(), refreshSnapshot(), refreshReport()]);
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

  async function refreshReport() {
    if (!reportCard) {
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: 'REPORT_GET' });
      if (!response?.ok) {
        throw new Error(response?.error || 'report-load-failed');
      }
      latestReport = normalizeReport(response.report);
      renderReport(latestReport);
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Slovensky: Normalizuje report pre jednoduchšie renderovanie.
   */
  function normalizeReport(report) {
    if (!report || typeof report !== 'object') {
      return { ts: 0, items: [], totalSeen: 0, totalQualified: 0 };
    }
    const ts = Number.parseInt(report.ts, 10);
    const totalSeen = Number.parseInt(report.totalSeen, 10);
    const totalQualified = Number.parseInt(report.totalQualified, 10);
    return {
      ts: Number.isFinite(ts) ? ts : 0,
      items: Array.isArray(report.items) ? report.items : [],
      totalSeen: Number.isFinite(totalSeen) ? totalSeen : 0,
      totalQualified: Number.isFinite(totalQualified) ? totalQualified : 0
    };
  }

  function renderReport(report) {
    if (!reportCard) {
      return;
    }
    if (reportTotalSeenEl) {
      reportTotalSeenEl.textContent = String(report.totalSeen || 0);
    }
    if (reportTotalQualifiedEl) {
      reportTotalQualifiedEl.textContent = String(report.totalQualified || 0);
    }
    if (reportUpdatedEl) {
      reportUpdatedEl.textContent = formatReportTimestamp(report.ts);
    }
    renderReportRows(report.items || []);
  }

  function renderReportRows(items) {
    if (!reportRows) {
      return;
    }
    reportRows.innerHTML = '';
    const data = Array.isArray(items) ? items : [];
    if (!data.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = 'No simulated deletions yet.';
      row.appendChild(cell);
      reportRows.appendChild(row);
      return;
    }
    data.forEach((item) => {
      const row = document.createElement('tr');
      row.appendChild(renderCell(item.title?.trim() ? item.title : '(no title)'));
      row.appendChild(renderCell(formatNumber(item.lastMessageAgeMin)));
      row.appendChild(renderCell(formatNumber(item.messageCount)));
      row.appendChild(renderCell(formatNumber(item.userMessageCount)));
      row.appendChild(renderCell(formatReasons(item.reasons)));
      row.appendChild(renderLinkCell(item.url));
      reportRows.appendChild(row);
    });
  }

  function renderCell(value) {
    const cell = document.createElement('td');
    cell.textContent = value ?? '—';
    return cell;
  }

  function renderLinkCell(url) {
    const cell = document.createElement('td');
    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Open';
      cell.appendChild(link);
    } else {
      cell.textContent = '—';
    }
    return cell;
  }

  function formatNumber(value) {
    if (value === null || value === undefined) {
      return '—';
    }
    const num = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(num) ? String(num) : '—';
  }

  function formatReasons(reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) {
      return '—';
    }
    return reasons.join(', ');
  }

  function formatReportTimestamp(ts) {
    if (!ts) {
      return 'never';
    }
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
      return 'never';
    }
    return date.toLocaleString();
  }

  function buildReportCsv(items) {
    const rows = Array.isArray(items) ? items : [];
    const header = REPORT_CSV_COLUMNS.join(',');
    const lines = rows.map((item) =>
      REPORT_CSV_COLUMNS.map((key) => csvEscape(resolveCsvValue(item, key))).join(',')
    );
    return [header, ...lines].join('\n');
  }

  function resolveCsvValue(item, key) {
    if (!item || typeof item !== 'object') {
      return '';
    }
    if (key === 'reasons') {
      return Array.isArray(item.reasons) ? item.reasons.join('|') : '';
    }
    if (key === 'ts') {
      const ts = Number.isFinite(item.ts) ? item.ts : Number.parseInt(item.ts, 10);
      return Number.isFinite(ts) ? new Date(ts).toISOString() : '';
    }
    const value = item[key];
    return value === undefined || value === null ? '' : String(value);
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    if (text === '') {
      return '';
    }
    if (/[",\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
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

  reportRefreshButton?.addEventListener('click', async () => {
    await refreshReport();
  });

  reportExportButton?.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'REPORT_EXPORT' });
      if (!response?.ok) {
        throw new Error(response?.error || 'export-failed');
      }
      const csv = buildReportCsv(response.items || []);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'mychatgpt_would_delete.csv';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
    }
  });

  reportClearButton?.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'REPORT_CLEAR' });
      if (!response?.ok) {
        throw new Error(response?.error || 'clear-failed');
      }
      latestReport = normalizeReport(response.report);
      renderReport(latestReport);
    } catch (error) {
      console.error(error);
    }
  });

  reportScanAllButton?.addEventListener('click', async () => {
    if (reportScanAllButton.disabled) {
      return;
    }
    reportScanAllButton.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'SCAN_ALL_TABS_NOW', bypassCooldown: true });
    } catch (error) {
      console.error(error);
    } finally {
      reportScanAllButton.disabled = false;
    }
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
    if (changes[REPORT_STORAGE_KEY]) {
      refreshReport();
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
