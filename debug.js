import { logInfo, tailLogs, clearLogs, getLogs } from './utils.js';

const TAIL_LIMIT = 200;
const TAIL_INTERVAL_MS = 1000;
const REPORT_STORAGE_KEY = 'would_delete_report';
const SOFT_PLAN_STORAGE_KEY = 'soft_delete_plan';
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
  const planCard = root.querySelector('[data-role="soft-plan"]');
  const planRows = root.querySelector('[data-role="plan-rows"]');
  const planTotalEl = root.querySelector('[data-role="plan-total"]');
  const planUpdatedEl = root.querySelector('[data-role="plan-updated"]');
  const planRegenerateButton = root.querySelector('[data-action="plan-regenerate"]');
  const planExportButton = root.querySelector('[data-action="plan-export"]');
  const planClearButton = root.querySelector('[data-action="plan-clear"]');
  const planConfirmButton = root.querySelector('[data-action="plan-confirm"]');
  const planModal = root.querySelector('[data-role="soft-plan-modal"]');
  const planModalTitle = root.querySelector('[data-role="plan-modal-title"]');
  const planModalContent = root.querySelector('[data-role="plan-modal-content"]');
  const liveCard = root.querySelector('[data-role="live-mode-card"]');
  const liveStatusBadge = liveCard?.querySelector('[data-role="live-arm-status"]');
  const liveTestButton = liveCard?.querySelector('[data-action="live-test"]');
  const liveTestResult = liveCard?.querySelector('[data-role="live-test-result"]');
  const liveLoadButton = liveCard?.querySelector('[data-action="live-load-plan"]');
  const liveOpenConfirmButton = liveCard?.querySelector('[data-action="live-open-confirm"]');
  const liveSelectionContainer = liveCard?.querySelector('[data-role="live-selection-container"]');
  const liveSelectionRows = liveCard?.querySelector('[data-role="live-selection-rows"]');
  const liveSelectionHint = liveCard?.querySelector('[data-role="live-selection-hint"]');
  const liveBatchNote = liveCard?.querySelector('[data-role="live-batch-note"]');
  const liveResultsCard = liveCard?.querySelector('[data-role="live-results-card"]');
  const liveResultsList = liveCard?.querySelector('[data-role="live-results-list"]');
  const liveCopyButton = liveCard?.querySelector('[data-action="live-copy-results"]');
  const liveCopyButtonDefaultLabel = liveCopyButton?.textContent || 'Copy JSON';
  const liveConfirmDialog = liveCard?.querySelector('[data-role="live-confirm-dialog"]');
  const liveConfirmSummary = liveCard?.querySelector('[data-role="live-confirm-summary"]');
  const liveConfirmList = liveCard?.querySelector('[data-role="live-confirm-list"]');
  const liveConfirmLimits = liveCard?.querySelector('[data-role="live-confirm-limits"]');
  const liveConfirmWarning = liveCard?.querySelector('[data-role="live-confirm-warning"]');
  const liveConfirmAck = liveCard?.querySelector('[data-role="live-confirm-ack"]');
  const liveConfirmSubmit = liveCard?.querySelector('[data-action="live-confirm-submit"]');

  let tailTimer = null;
  let currentLevel = levelSelect?.value || 'INFO';
  let latestProbeJson = '';
  let injectStatusTimer = null;
  let latestReport = null;
  let latestPlan = null;
  let liveSettings = null;
  let liveCandidates = [];
  let liveSelection = new Set();
  let liveResults = null;
  let liveResultsMeta = null;

  async function refreshAll() {
    await Promise.all([
      refreshLogs(),
      refreshSummary(),
      refreshSnapshot(),
      refreshReport(),
      refreshPlan(),
      refreshLive()
    ]);
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

  async function refreshPlan() {
    if (!planCard) {
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PLAN_GET' });
      if (!response?.ok) {
        throw new Error(response?.error || 'plan-load-failed');
      }
      latestPlan = normalizePlan(response.plan);
      renderPlan(latestPlan);
    } catch (error) {
      console.error(error);
    }
  }

  async function refreshLive() {
    if (!liveCard) {
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ensureSettings' });
      if (response?.settings) {
        liveSettings = response.settings;
      }
    } catch (error) {
      console.error(error);
    }
    updateLiveArmStatus();
    updateLiveNotes();
    renderLiveSelection();
    updateSelectionHint();
    renderLiveResults();
    updateLiveControls();
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

  /**
   * Slovensky: Normalizuje DRY-RUN plán pre UI.
   */
  function normalizePlan(plan) {
    if (!plan || typeof plan !== 'object') {
      return { ts: 0, items: [], totals: { planned: 0 } };
    }
    const ts = Number.parseInt(plan.ts, 10);
    const items = Array.isArray(plan.items) ? plan.items : [];
    const planned = Number.isFinite(plan?.totals?.planned) ? plan.totals.planned : items.length;
    return {
      ts: Number.isFinite(ts) ? ts : 0,
      items,
      totals: { planned }
    };
  }

  function isLiveModeArmedLocal() {
    if (!liveSettings) {
      return false;
    }
    return !liveSettings.LIST_ONLY && !liveSettings.DRY_RUN && Boolean(liveSettings.LIVE_MODE_ENABLED);
  }

  function getLiveLimits() {
    const batchLimit = Number.isFinite(liveSettings?.LIVE_PATCH_BATCH_LIMIT)
      ? liveSettings.LIVE_PATCH_BATCH_LIMIT
      : 0;
    const deleteLimit = Number.isFinite(liveSettings?.DELETE_LIMIT) ? liveSettings.DELETE_LIMIT : batchLimit;
    const effective = batchLimit && deleteLimit ? Math.min(batchLimit, deleteLimit) : batchLimit || deleteLimit;
    const rateLimit = Number.isFinite(liveSettings?.LIVE_PATCH_RATE_LIMIT_PER_MIN)
      ? liveSettings.LIVE_PATCH_RATE_LIMIT_PER_MIN
      : 0;
    const whitelist = Array.isArray(liveSettings?.LIVE_WHITELIST_HOSTS)
      ? liveSettings.LIVE_WHITELIST_HOSTS
      : [];
    return {
      batchLimit: batchLimit || 0,
      deleteLimit: deleteLimit || 0,
      effective: effective || Math.max(batchLimit || 0, deleteLimit || 0),
      rateLimit,
      whitelist
    };
  }

  /**
   * Slovensky: Aktualizuje badge s ozbrojeným stavom Live režimu.
   */
  function updateLiveArmStatus() {
    if (!liveStatusBadge) {
      return;
    }
    const armed = isLiveModeArmedLocal();
    liveStatusBadge.textContent = armed ? 'ARMED (live)' : 'SAFE (dry-run)';
  }

  /**
   * Slovensky: Zobrazí limity a whitelist pre Live režim.
   */
  function updateLiveNotes() {
    if (!liveBatchNote) {
      return;
    }
    if (!liveSettings) {
      liveBatchNote.hidden = false;
      liveBatchNote.textContent = 'Loading Live Mode settings…';
      return;
    }
    const limits = getLiveLimits();
    const hosts = limits.whitelist.length ? limits.whitelist.join(', ') : '—';
    const rateText = limits.rateLimit > 0 ? limits.rateLimit : 'unlimited';
    const batchText = limits.batchLimit > 0 ? limits.batchLimit : 'unlimited';
    const deleteText = limits.deleteLimit > 0 ? limits.deleteLimit : 'unlimited';
    const effectiveText = limits.effective > 0 ? limits.effective : Math.max(limits.batchLimit, limits.deleteLimit, 0) || 'unlimited';
    liveBatchNote.hidden = false;
    liveBatchNote.textContent = `Batch limit ≤ ${batchText} (DELETE limit ≤ ${deleteText}, effective ≤ ${effectiveText}). Rate limit/min: ${rateText}. Whitelist: ${hosts}.`;
  }

  function updateLiveControls() {
    if (liveOpenConfirmButton) {
      const enabled = isLiveModeArmedLocal() && liveSelection.size > 0;
      liveOpenConfirmButton.disabled = !enabled;
    }
    if (liveCopyButton) {
      liveCopyButton.disabled = !liveResults || !Array.isArray(liveResults) || liveResults.length === 0;
    }
  }

  function updateSelectionHint() {
    if (!liveSelectionHint) {
      return;
    }
    if (!liveSettings) {
      liveSelectionHint.hidden = false;
      liveSelectionHint.textContent = 'Loading live mode settings…';
      return;
    }
    if (!isLiveModeArmedLocal()) {
      liveSelectionHint.hidden = false;
      liveSelectionHint.textContent = 'Guard rails active: disable LIST_ONLY & DRY_RUN and enable LIVE_MODE in Settings to arm Live Mode.';
      return;
    }
    if (!liveCandidates.length) {
      liveSelectionHint.hidden = false;
      liveSelectionHint.textContent = 'No LIVE batch candidates loaded yet.';
      return;
    }
    const limits = getLiveLimits();
    const effectiveLimit = limits.effective || limits.batchLimit || limits.deleteLimit || liveCandidates.length || 'unbounded';
    liveSelectionHint.hidden = false;
    liveSelectionHint.textContent = `Selected ${liveSelection.size} of ${liveCandidates.length} candidates (effective limit ≤ ${effectiveLimit}).`;
  }

  function renderLiveSelection() {
    if (!liveSelectionRows || !liveSelectionContainer) {
      return;
    }
    liveSelectionRows.innerHTML = '';
    if (!liveCandidates.length) {
      liveSelectionContainer.hidden = true;
      return;
    }
    liveSelectionContainer.hidden = false;
    liveCandidates.forEach((candidate) => {
      const row = document.createElement('tr');
      const selectCell = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = liveSelection.has(candidate.key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          liveSelection.add(candidate.key);
        } else {
          liveSelection.delete(candidate.key);
        }
        updateSelectionHint();
        updateLiveControls();
      });
      selectCell.appendChild(checkbox);

      const titleCell = document.createElement('td');
      titleCell.textContent = candidate.title || '—';

      const convoCell = document.createElement('td');
      convoCell.textContent = candidate.convoId || '—';

      const urlCell = document.createElement('td');
      if (candidate.url) {
        const link = document.createElement('a');
        link.href = candidate.url;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        link.textContent = candidate.url;
        urlCell.appendChild(link);
      } else {
        urlCell.textContent = '—';
      }

      row.appendChild(selectCell);
      row.appendChild(titleCell);
      row.appendChild(convoCell);
      row.appendChild(urlCell);
      liveSelectionRows.appendChild(row);
    });
  }

  function getSelectedItems() {
    if (!liveCandidates.length) {
      return [];
    }
    return liveCandidates
      .filter((candidate) => liveSelection.has(candidate.key))
      .map((candidate) => ({
        convoId: candidate.convoId,
        url: candidate.url,
        title: candidate.title
      }));
  }

  async function loadLiveCandidatesFromPlan() {
    if (!liveCard) {
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PLAN_GET' });
      if (!response?.ok) {
        throw new Error(response?.error || 'plan-load-failed');
      }
      const plan = normalizePlan(response.plan);
      latestPlan = plan;
      const dedup = new Map();
      for (const item of plan.items) {
        if (item?.qualifies === false) {
          continue;
        }
        const key = (item?.convoId || '').trim() || (item?.url || '').trim();
        if (!key || dedup.has(key)) {
          continue;
        }
        dedup.set(key, {
          key,
          convoId: item?.convoId || '',
          url: item?.url || '',
          title: item?.title || ''
        });
      }
      liveCandidates = Array.from(dedup.values());
      liveSelection = new Set(liveCandidates.map((candidate) => candidate.key));
      renderLiveSelection();
      updateSelectionHint();
      updateLiveControls();
    } catch (error) {
      if (liveSelectionHint) {
        liveSelectionHint.hidden = false;
        liveSelectionHint.textContent = `Failed to load plan: ${error?.message || 'unknown error'}`;
      }
    }
  }

  async function handleLiveTest() {
    if (!liveTestResult) {
      return;
    }
    liveTestResult.textContent = 'Testing…';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'LIVE_TEST_CONNECTIVITY' });
      if (response?.ok) {
        const ms = Number.isFinite(response.elapsedMs) ? Math.round(response.elapsedMs) : null;
        liveTestResult.textContent = ms !== null ? `OK (${ms} ms)` : 'OK';
      } else {
        const reason = response?.reason ? ` (${response.reason})` : '';
        liveTestResult.textContent = `Error: ${response?.error || 'bridge-failed'}${reason}`;
      }
    } catch (error) {
      liveTestResult.textContent = `Error: ${error?.message || 'bridge-failed'}`;
    }
  }

  function iconForLiveResult(item) {
    if (item?.ok) {
      return '✅';
    }
    if (item?.reasonCode && item.reasonCode.startsWith('patch_blocked')) {
      return '⚠️';
    }
    return '❌';
  }

  function renderLiveResults() {
    if (!liveResultsCard || !liveResultsList) {
      return;
    }
    if (!liveResults || !Array.isArray(liveResults) || liveResults.length === 0) {
      liveResultsCard.hidden = true;
      if (liveCopyButton) {
        liveCopyButton.disabled = true;
      }
      return;
    }
    liveResultsCard.hidden = false;
    liveResultsList.innerHTML = '';
    liveResults.forEach((item) => {
      const li = document.createElement('li');
      const icon = iconForLiveResult(item);
      const title = item.title || '(untitled)';
      const reason = item.reasonCode || (item.ok ? 'patch_ok' : 'unknown');
      const statusPart = item.status ? ` • status ${item.status}` : '';
      li.textContent = `${icon} ${title} — ${item.convoId || 'no-id'} (${reason}${statusPart})`;
      liveResultsList.appendChild(li);
    });
    if (liveCopyButton) {
      liveCopyButton.disabled = false;
    }
  }

  function getLiveResultsJson() {
    if (!liveResults || !Array.isArray(liveResults) || liveResults.length === 0) {
      return '';
    }
    const payload = {
      ts: Date.now(),
      results: liveResults,
      meta: liveResultsMeta
    };
    return JSON.stringify(payload, null, 2);
  }

  function openLiveConfirmDialog() {
    if (!liveConfirmDialog) {
      return;
    }
    const items = getSelectedItems();
    const limits = getLiveLimits();
    if (liveConfirmSummary) {
      liveConfirmSummary.textContent = items.length
        ? `Ready to PATCH ${items.length} conversation(s).`
        : 'No candidates selected.';
    }
    if (liveConfirmList) {
      liveConfirmList.innerHTML = '';
      const preview = items.slice(0, 10);
      preview.forEach((item) => {
        const li = document.createElement('li');
        const convo = item.convoId || 'no-id';
        const title = item.title || '(untitled)';
        li.textContent = `${title} — ${convo}`;
        liveConfirmList.appendChild(li);
      });
      if (items.length > preview.length) {
        const li = document.createElement('li');
        li.textContent = `…and ${items.length - preview.length} more.`;
        liveConfirmList.appendChild(li);
      }
    }
    if (liveConfirmLimits) {
      liveConfirmLimits.textContent = `Effective limit ≤ ${limits.effective} (batch ≤ ${limits.batchLimit}, delete ≤ ${limits.deleteLimit}). Rate/min ${limits.rateLimit}.`;
    }
    if (liveConfirmWarning) {
      liveConfirmWarning.hidden = true;
      liveConfirmWarning.textContent = '';
    }
    if (liveConfirmAck) {
      liveConfirmAck.checked = false;
    }
    if (liveConfirmSubmit) {
      liveConfirmSubmit.disabled = false;
    }
    try {
      liveConfirmDialog.showModal();
    } catch (_error) {
      liveConfirmDialog.setAttribute('open', 'open');
    }
  }

  async function copyLiveResultsToClipboard() {
    if (!liveCopyButton) {
      return;
    }
    const json = getLiveResultsJson();
    if (!json) {
      return;
    }
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = json;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      liveCopyButton.textContent = 'Copied!';
      setTimeout(() => {
        liveCopyButton.textContent = liveCopyButtonDefaultLabel;
      }, 1200);
    } catch (error) {
      console.error(error);
      liveCopyButton.textContent = 'Copy failed';
      setTimeout(() => {
        liveCopyButton.textContent = liveCopyButtonDefaultLabel;
      }, 1500);
    }
  }

  async function executeLiveBatch() {
    if (!liveConfirmDialog) {
      return;
    }
    if (!isLiveModeArmedLocal()) {
      if (liveConfirmWarning) {
        liveConfirmWarning.hidden = false;
        liveConfirmWarning.textContent = 'Live Mode is not armed. Enable it in Settings and reload.';
      }
      return;
    }
    const items = getSelectedItems();
    if (!items.length) {
      if (liveConfirmWarning) {
        liveConfirmWarning.hidden = false;
        liveConfirmWarning.textContent = 'Select at least one candidate to proceed.';
      }
      return;
    }
    if (!liveConfirmAck?.checked) {
      if (liveConfirmWarning) {
        liveConfirmWarning.hidden = false;
        liveConfirmWarning.textContent = 'Please acknowledge the confirmation checkbox.';
      }
      liveConfirmAck?.focus();
      return;
    }
    if (liveConfirmWarning) {
      liveConfirmWarning.hidden = true;
      liveConfirmWarning.textContent = '';
    }
    if (liveConfirmSubmit) {
      liveConfirmSubmit.disabled = true;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'LIVE_EXECUTE_BATCH',
        items,
        confirmed: true
      });
      if (!response?.ok) {
        if (liveConfirmWarning) {
          const reason = response?.reason ? ` (${response.reason})` : '';
          liveConfirmWarning.hidden = false;
          liveConfirmWarning.textContent = `Batch blocked${reason}.`;
        }
        return;
      }
      liveResults = Array.isArray(response.results) ? response.results : [];
      liveResultsMeta = response.meta || null;
      renderLiveResults();
      updateLiveControls();
      liveConfirmDialog.close('confirm');
    } catch (error) {
      if (liveConfirmWarning) {
        liveConfirmWarning.hidden = false;
        liveConfirmWarning.textContent = `Batch failed: ${error?.message || 'unknown error'}`;
      }
    } finally {
      if (liveConfirmSubmit) {
        liveConfirmSubmit.disabled = false;
      }
    }
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

  function renderPlan(plan) {
    if (!planCard) {
      return;
    }
    if (planTotalEl) {
      planTotalEl.textContent = String(plan.totals.planned || 0);
    }
    if (planUpdatedEl) {
      planUpdatedEl.textContent = formatReportTimestamp(plan.ts);
    }
    renderPlanRows(plan.items || []);
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

  function renderPlanRows(items) {
    if (!planRows) {
      return;
    }
    planRows.innerHTML = '';
    const data = Array.isArray(items) ? items : [];
    if (!data.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = 'No DRY-RUN plan entries yet.';
      row.appendChild(cell);
      planRows.appendChild(row);
      return;
    }
    data.forEach((item, index) => {
      const row = document.createElement('tr');
      row.dataset.index = String(index);
      row.dataset.convoId = item.convoId || '';
      row.dataset.url = item.url || '';
      row.appendChild(renderCell(item.title?.trim() ? item.title : '(no title)'));
      row.appendChild(renderCell(formatConvoId(item.convoId)));
      row.appendChild(renderCell(formatNumber(item.lastMessageAgeMin)));
      row.appendChild(renderCell(formatNumber(item.messageCount)));
      row.appendChild(renderCell(formatReasons(item.reasons)));
      row.appendChild(renderPlanActions());
      planRows.appendChild(row);
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

  function formatConvoId(value) {
    if (!value) {
      return '—';
    }
    const text = String(value);
    if (text.length <= 10) {
      return text;
    }
    return `${text.slice(0, 10)}…`;
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

  function renderPlanActions() {
    const cell = document.createElement('td');
    cell.className = 'inline-group';
    const diff = document.createElement('button');
    diff.type = 'button';
    diff.className = 'secondary';
    diff.dataset.action = 'plan-view-diff';
    diff.textContent = 'View diff';
    const justification = document.createElement('button');
    justification.type = 'button';
    justification.className = 'secondary';
    justification.dataset.action = 'plan-view-justification';
    justification.textContent = 'View justification';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.action = 'plan-remove';
    remove.textContent = 'Remove from plan';
    cell.appendChild(diff);
    cell.appendChild(justification);
    cell.appendChild(remove);
    return cell;
  }

  function openPlanModal(title, payload) {
    if (!planModal) {
      return;
    }
    if (planModalTitle) {
      planModalTitle.textContent = title || 'Detail';
    }
    if (planModalContent) {
      planModalContent.textContent = payload || '';
    }
    if (typeof planModal.showModal === 'function') {
      planModal.showModal();
    }
  }

  function closePlanModal() {
    if (planModal && typeof planModal.close === 'function' && planModal.open) {
      planModal.close();
    }
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

  planRegenerateButton?.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PLAN_REGENERATE' });
      if (!response?.ok) {
        throw new Error(response?.error || 'plan-regenerate-failed');
      }
      latestPlan = normalizePlan(response.plan);
      renderPlan(latestPlan);
    } catch (error) {
      console.error(error);
    }
  });

  planExportButton?.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PLAN_EXPORT' });
      if (!response?.ok) {
        throw new Error(response?.error || 'plan-export-failed');
      }
      const blob = new Blob([JSON.stringify(response.items || [], null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'mychatgpt_soft_delete_plan.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
    }
  });

  planClearButton?.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PLAN_CLEAR' });
      if (!response?.ok) {
        throw new Error(response?.error || 'plan-clear-failed');
      }
      latestPlan = normalizePlan(response.plan);
      renderPlan(latestPlan);
    } catch (error) {
      console.error(error);
    }
  });

  planConfirmButton?.addEventListener('click', async () => {
    if (planConfirmButton.disabled) {
      return;
    }
    planConfirmButton.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PLAN_CONFIRM_DRY_RUN' });
      if (!response?.ok) {
        throw new Error(response?.error || 'plan-confirm-failed');
      }
    } catch (error) {
      console.error(error);
    } finally {
      planConfirmButton.disabled = false;
    }
  });

  planCard?.addEventListener('click', async (event) => {
    const diffBtn = event.target.closest('button[data-action="plan-view-diff"]');
    const justificationBtn = event.target.closest('button[data-action="plan-view-justification"]');
    const removeBtn = event.target.closest('button[data-action="plan-remove"]');
    if (!diffBtn && !justificationBtn && !removeBtn) {
      return;
    }
    const row = event.target.closest('tr');
    if (!row) {
      return;
    }
    const index = Number.parseInt(row.dataset.index || '', 10);
    if (!Number.isFinite(index) || !latestPlan?.items?.[index]) {
      return;
    }
    const item = latestPlan.items[index];
    if (diffBtn) {
      openPlanModal('Diff preview', JSON.stringify(item.diffPreview, null, 2));
      return;
    }
    if (justificationBtn) {
      const payload = {
        summary: item.justification?.summary || '',
        details: item.justification?.details || []
      };
      openPlanModal('Justification', JSON.stringify(payload, null, 2));
      return;
    }
    if (removeBtn) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'PLAN_REMOVE_ITEM',
          convoId: item.convoId,
          url: item.url
        });
        if (!response?.ok) {
          throw new Error(response?.error || 'plan-remove-failed');
        }
        latestPlan = normalizePlan(response.plan);
        renderPlan(latestPlan);
      } catch (error) {
        console.error(error);
      }
    }
  });

  planModal?.addEventListener('close', () => {
    if (planModalContent) {
      planModalContent.textContent = '';
    }
  });

  planModal?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closePlanModal();
  });

  liveTestButton?.addEventListener('click', () => {
    handleLiveTest();
  });

  liveLoadButton?.addEventListener('click', async () => {
    await loadLiveCandidatesFromPlan();
  });

  liveOpenConfirmButton?.addEventListener('click', () => {
    openLiveConfirmDialog();
  });

  liveConfirmSubmit?.addEventListener('click', (event) => {
    event.preventDefault();
    executeLiveBatch();
  });

  liveConfirmDialog?.addEventListener('close', () => {
    if (liveConfirmAck) {
      liveConfirmAck.checked = false;
    }
    if (liveConfirmWarning) {
      liveConfirmWarning.hidden = true;
      liveConfirmWarning.textContent = '';
    }
    if (!(typeof liveConfirmDialog.showModal === 'function')) {
      liveConfirmDialog.removeAttribute('open');
    }
  });

  liveCopyButton?.addEventListener('click', async () => {
    await copyLiveResultsToClipboard();
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
    if (changes.settings) {
      refreshLive();
    }
    if (changes[REPORT_STORAGE_KEY]) {
      refreshReport();
    }
    if (changes[SOFT_PLAN_STORAGE_KEY]) {
      refreshPlan();
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
    },
    focusSoftDeletePlan: () => {
      if (planCard) {
        planCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  };
}
