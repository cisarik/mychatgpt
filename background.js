import { initDb, backups } from './db.js';
import {
  createManualOpenStrategy,
  DEFAULT_SETTINGS,
  DeletionStrategyIds,
  ensureRiskyNotExpired,
  getConvoUrl,
  getConversationIdFromUrl,
  getActiveTabId,
  getActiveChatgptTabId,
  getAllChatgptTabIds,
  isRiskySessionActive,
  log,
  LogLevel,
  normalizeChatUrl,
  normalizeSettings,
  now,
  computeEligibility,
  reEvaluate,
  sanitizeHTML,
  SETTINGS_KEY,
  sleep,
  randomJitter
} from './utils.js';

let settingsCache = { ...DEFAULT_SETTINGS };
const bootstrapReady = bootstrap();
const recentlyOpened = new Map();
const CANCEL_FLAG_KEY = 'cancel_deletion';
let deletionInProgress = false;

const manualBatchStrategy = createManualOpenStrategy(async (url) => {
  await openConversationTab(url, { active: false });
});

/**
 * Slovensky: Štartuje pozadie – DB, nastavenia a log.
 */
async function bootstrap() {
  await initDb();
  await ensureSettingsLoaded();
  chrome.storage.onChanged.addListener(handleSettingsChange);
  await log(LogLevel.INFO, 'background', 'Search Cleaner ready');
}

/**
 * Slovensky: Načíta nastavenia zo storage.
 */
async function ensureSettingsLoaded() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  if (!stored?.[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
    settingsCache = { ...DEFAULT_SETTINGS };
    return;
  }
  settingsCache = normalizeSettings(stored[SETTINGS_KEY]);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
}

function handleSettingsChange(changes, area) {
  if (area !== 'local' || !changes[SETTINGS_KEY]) {
    return;
  }
  settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettingsLoaded();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }
  (async () => {
    await bootstrapReady;
    switch (message.type) {
      case 'CANDIDATE_CONVERSATION':
        return handleCandidate(message.payload || {}, sender);
      case 'LIST_BACKUPS':
        return listBackups();
      case 'DELETE_BACKUP':
        return deleteBackup(message.id);
      case 'EXPORT_BACKUP':
        return exportBackup(message.id);
      case 'GET_SETTINGS':
        return { ok: true, settings: settingsCache };
      case 'SAVE_SETTINGS':
        return saveSettings(message.update || {});
      case 'OPEN_NEXT':
        return openNext(message.urls || []);
      case 'REQUEST_SCAN':
        return scanAllChatgptTabs();
      case 'captureActiveTabNow':
        return captureActiveTabNow();
      case 'scanAllChatgptTabs':
        return scanAllChatgptTabs();
      case 'RE_EVALUATE_SELECTED':
        return reEvaluateSelected(message.convoIds);
      case 'BACKUPS_UPDATED':
        return { ok: true };
      case 'DELETE_SELECTED':
        return deleteSelected(message.selection || message.urls || []);
      case 'CANCEL_DELETION':
        await setCancelFlag(true);
        return { ok: true };
      case 'TEST_SELECTORS_ON_ACTIVE_TAB':
        return testSelectorsOnActiveTab();
      case 'ACTIVE_TAB_READY':
        await log(LogLevel.INFO, 'content', 'Active tab ready', { tab: sender?.tab?.id });
        return { ok: true };
      default:
        return { ok: false, error: 'unsupported_message' };
    }
  })()
    .then((response) => sendResponse(response || { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || 'unexpected_error' }));
  return true;
});

/**
 * Slovensky: Spracuje zachytený kandidát z content skriptu.
 */
async function handleCandidate(candidate, sender) {
  const cleaned = sanitizeCandidate(candidate, sender);
  if (!cleaned) {
    return { ok: false, rejected: ['invalid_candidate'] };
  }
  const evaluation = computeEligibility(cleaned, settingsCache);
  if (!evaluation.eligible) {
    await log(LogLevel.INFO, 'capture', 'Candidate rejected', {
      convoId: cleaned.convoId,
      reason: evaluation.reason || 'unknown'
    });
    return { ok: false, rejected: [evaluation.reason || 'unknown'] };
  }
  const prepared = reEvaluate(cleaned, settingsCache, evaluation);
  const stored = await persistCandidate(prepared, evaluation, { storeWhenIneligible: false });
  await log(LogLevel.INFO, 'capture', 'Backup stored', {
    convoId: stored.convoId,
    createdAt: stored.createdAt,
    capturedAt: stored.capturedAt
  });
  return { ok: true, stored };
}

/** Slovensky: Vyčistí surové dáta kandidáta. */
function sanitizeCandidate(candidate, sender) {
  const baseUrl = typeof candidate?.url === 'string' ? candidate.url : sender?.tab?.url;
  const convoId = candidate?.convoId || extractConvoId(baseUrl);
  if (!convoId) {
    return null;
  }
  const userPromptRaw = candidate?.userPromptText ?? candidate?.userPrompt ?? '';
  const userPrompt = String(userPromptRaw).trim();
  const answerSource =
    candidate?.assistantHTML || candidate?.answerHTML || candidate?.firstAnswerHTML || '';
  const answerHTML = sanitizeHTML(answerSource);
  if (!userPrompt || !answerHTML) {
    return null;
  }
  const createdAt = Number.isFinite(candidate?.createdAt) ? candidate.createdAt : Date.now();
  const capturedAt = Date.now();
  const counts = normalizeCapturedCounts(candidate?.counts);
  return {
    convoId,
    url: normalizeChatUrl(baseUrl) || `https://chatgpt.com/c/${convoId}`,
    userPrompt,
    answerHTML,
    createdAt,
    capturedAt,
    counts,
    messageCount: (counts.user ?? 0) + (counts.assistant ?? 0)
  };
}

/** Slovensky: Normalizuje počty turnov z content skriptu. */
function normalizeCapturedCounts(rawCounts) {
  const result = {};
  if (!rawCounts || typeof rawCounts !== 'object') {
    return result;
  }
  if (Number.isFinite(rawCounts.user)) {
    result.user = clampTurnCount(rawCounts.user);
  }
  if (Number.isFinite(rawCounts.assistant)) {
    result.assistant = clampTurnCount(rawCounts.assistant);
  }
  return result;
}

function clampTurnCount(value) {
  const floored = Math.floor(Number(value));
  if (!Number.isFinite(floored) || floored <= 0) {
    return 0;
  }
  return floored >= 1 ? 1 : 0;
}

/**
 * Slovensky: Uloží (alebo aktualizuje) kandidáta s aktuálnym verdictom.
 * @param {object} prepared
 * @param {{eligible:boolean,reason:string|null}} evaluation
 * @param {{storeWhenIneligible?:boolean}} options
 */
async function persistCandidate(prepared, evaluation, { storeWhenIneligible = false } = {}) {
  if (!evaluation.eligible && !storeWhenIneligible) {
    return null;
  }
  const stored = await backups.save(prepared);
  await notifyBackupsUpdated();
  return stored;
}

/** Slovensky: Vynúti zachytenie z aktívnej karty. */
async function captureActiveTabNow() {
  const tabId = await getActiveChatgptTabId();
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: 'no_active_chatgpt_tab' };
  }
  const result = await captureFromTab(tabId, { storeWhenIneligible: true, source: 'active' });
  return result;
}

/** Slovensky: Spustí zachytenie na všetkých otvorených kartách. */
async function scanAllChatgptTabs() {
  const tabIds = await getAllChatgptTabIds();
  const outcomes = [];
  let storedCount = 0;
  for (const tabId of tabIds) {
    await sleep(100 + Math.floor(Math.random() * 101));
    const result = await captureFromTab(tabId, { storeWhenIneligible: true, source: 'bulk' });
    if (result.ok && result.stored) {
      storedCount += 1;
    }
    outcomes.push({ tabId, ...result });
  }
  await log(LogLevel.INFO, 'scan', 'Bulk capture finished', {
    scanned: tabIds.length,
    stored: storedCount
  });
  return { ok: true, scanned: tabIds.length, stored: storedCount, results: outcomes };
}

/** Slovensky: Požiada obsahový skript o zachytenie a uloží výsledok. */
async function captureFromTab(tabId, { storeWhenIneligible = false, source = 'manual' } = {}) {
  if (!Number.isInteger(tabId)) {
    return { ok: false, error: 'invalid_tab' };
  }
  let tabInfo = null;
  try {
    tabInfo = await chrome.tabs.get(tabId);
  } catch (_error) {
    // karta mohla zaniknúť
  }
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: 'RUN_CAPTURE_NOW', includePayload: true });
  } catch (error) {
    return { ok: false, error: error?.message || 'send_failed' };
  }
  if (!response?.ok) {
    return { ok: false, error: response?.error || 'capture_failed' };
  }
  const summary = response.summary || response.payload || null;
  if (!summary) {
    return { ok: false, error: 'empty_summary' };
  }
  const cleaned = sanitizeCandidate({ ...summary, url: summary.url || tabInfo?.url }, { tab: tabInfo });
  if (!cleaned) {
    return { ok: false, error: 'invalid_candidate' };
  }
  const evaluation = computeEligibility(cleaned, settingsCache);
  const prepared = reEvaluate(cleaned, settingsCache, evaluation);
  const stored = await persistCandidate(prepared, evaluation, { storeWhenIneligible });
  if (!stored) {
    return { ok: false, error: 'rejected_by_eligibility', evaluation };
  }
  await log(LogLevel.INFO, 'capture', 'Manual capture stored', {
    convoId: stored.convoId,
    eligible: evaluation.eligible,
    reason: evaluation.reason,
    source
  });
  return { ok: true, stored, heuristics: evaluation };
}

/** Slovensky: Prepočíta eligibility na vybraných záznamoch. */
async function reEvaluateSelected(convoIds) {
  const filteredIds = Array.isArray(convoIds)
    ? Array.from(
        new Set(
          convoIds
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter((value) => value.length > 0)
        )
      )
    : [];
  let records = [];
  if (filteredIds.length > 0) {
    for (const convoId of filteredIds) {
      const record = await backups.byConvoId(convoId);
      if (record) {
        records.push(record);
      }
    }
  } else {
    records = await backups.list();
  }
  if (!records.length) {
    return { ok: true, processed: 0, eligible: 0 };
  }
  let processed = 0;
  let eligibleCount = 0;
  for (const record of records) {
    if (!record?.convoId) {
      continue;
    }
    const evaluation = computeEligibility(record, settingsCache);
    if (evaluation.eligible) {
      eligibleCount += 1;
    }
    const prepared = reEvaluate(record, settingsCache, evaluation);
    await backups.save(prepared);
    processed += 1;
  }
  if (processed > 0) {
    await notifyBackupsUpdated();
  }
  return {
    ok: true,
    processed,
    eligible: eligibleCount
  };
}

/** Slovensky: Odošle signál pre popup na obnovenie zoznamu. */
async function notifyBackupsUpdated() {
  try {
    await chrome.runtime.sendMessage({ type: 'BACKUPS_UPDATED' });
  } catch (_error) {
    // Žiadny poslucháč nie je problém – popup sa obnoví manuálne.
  }
}

/** Slovensky: Z URL vytiahne ID konverzácie. */
function extractConvoId(url) {
  try {
    const parsed = new URL(url || '', 'https://chatgpt.com');
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'c' && parts[1]) {
      return parts[1];
    }
    return null;
  } catch (_error) {
    return null;
  }
}

async function listBackups() {
  const items = await backups.list();
  return { ok: true, items };
}

async function deleteBackup(id) {
  if (!id) {
    return { ok: false, error: 'missing_id' };
  }
  await backups.remove(id);
  return { ok: true };
}

async function exportBackup(id) {
  if (!id) {
    return { ok: false, error: 'missing_id' };
  }
  const record = await backups.byId(id);
  if (!record) {
    return { ok: false, error: 'not_found' };
  }
  const html = buildExportHtml(record);
  const safeTitle = sanitizeFilename(record.title || 'chat');
  return {
    ok: true,
    html,
    filename: `${safeTitle}-${record.id}.html`
  };
}

/** Slovensky: Postaví jednoduchý HTML export. */
function buildExportHtml(record) {
  const title = escapeHtml(record.title || 'Search backup');
  const prompt = escapeHtml(record.userPrompt || '');
  const created = new Date(record.createdAt || record.capturedAt || Date.now()).toISOString();
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    `<title>${title}</title></head><body><main>` +
    `<h1>${title}</h1>` +
    `<section><h2>User prompt</h2><pre>${prompt}</pre></section>` +
    `<section><h2>Assistant</h2>${record.answerHTML || ''}</section>` +
    `<footer><p>Captured at: ${created}</p></footer>` +
    '</main></body></html>'
  );
}

/** Slovensky: Escapuje HTML znaky. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Slovensky: Uprace názov súboru pre export. */
function sanitizeFilename(value) {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 64) || 'chat';
}

async function saveSettings(update) {
  const next = normalizeSettings({ ...settingsCache, ...update });
  settingsCache = next;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  await log(LogLevel.INFO, 'settings', 'Settings updated', next);
  return { ok: true, settings: next };
}

/** Slovensky: Otvorí ďalšiu dávku vybraných konverzácií. */
async function openNext(urls) {
  const normalized = Array.isArray(urls)
    ? urls
        .map((url) => normalizeChatUrl(url))
        .filter((url) => Boolean(url))
    : [];
  if (!normalized.length) {
    return { ok: false, error: 'empty_batch' };
  }
  const unique = Array.from(new Set(normalized)).filter((url) => !recentlyOpened.has(url));
  if (!unique.length) {
    return { ok: true, opened: 0 };
  }
  const limit = Math.max(1, settingsCache.batchSize || DEFAULT_SETTINGS.batchSize);
  const slice = unique.slice(0, limit);
  const openable = await filterAvailableTabs(slice);
  if (!openable.length) {
    return { ok: true, opened: 0 };
  }
  const report = await manualBatchStrategy.deleteMany(openable);
  report.notes.forEach((note) => {
    log(LogLevel.WARN, 'batch', 'Open batch note', { note }).catch(() => {});
  });
  return { ok: true, opened: report.opened };
}

/** Slovensky: Odfiltruje už otvorené konverzácie. */
async function filterAvailableTabs(urls) {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const openSet = new Set(tabs.map((tab) => normalizeChatUrl(tab.url)).filter(Boolean));
  return urls.filter((url) => !openSet.has(url));
}

/** Slovensky: Otvorí konverzáciu na pozadí a označí ju. */
async function openConversationTab(url, { active = false } = {}) {
  const normalized = normalizeChatUrl(url);
  if (!normalized) {
    return;
  }
  const delay = 150 + Math.floor(Math.random() * 120);
  await sleep(delay);
  await chrome.tabs.create({ url: normalized, active });
  markOpened(normalized);
}

/** Slovensky: Označí URL ako nedávno otvorenú kvôli anti-duplikátu. */
function markOpened(url) {
  const normalized = normalizeChatUrl(url);
  if (!normalized) {
    return;
  }
  if (recentlyOpened.has(normalized)) {
    clearTimeout(recentlyOpened.get(normalized));
  }
  const timer = setTimeout(() => recentlyOpened.delete(normalized), 60000);
  recentlyOpened.set(normalized, timer);
}

/** Slovensky: Spustí mazanie vybratých konverzácií podľa aktuálnych nastavení. */
async function deleteSelected(selection) {
  if (deletionInProgress) {
    return { ok: false, error: 'deletion_running' };
  }
  const items = normalizeSelection(selection);
  if (!items.length) {
    return { ok: false, error: 'empty_selection' };
  }
  deletionInProgress = true;
  await resetCancelFlag();
  const settings = ensureRiskyNotExpired(settingsCache);
  settingsCache = settings;
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch (error) {
    await log(LogLevel.WARN, 'settings', 'Persist fallback failed', {
      message: error?.message || String(error)
    });
  }
  let report;
  try {
    if (!isRiskySessionActive(settings)) {
      report = {
        strategyId: DeletionStrategyIds.UI_AUTOMATION,
        attempted: items.length,
        opened: 0,
        notes: ['risky_inactive'],
        results: items.map((item) => ({
          convoId: item.convoId,
          url: item.url,
          ok: false,
          reason: 'risky_inactive',
          strategyId: DeletionStrategyIds.UI_AUTOMATION,
          step: 'guard',
          attempt: 0
        }))
      };
      await log(LogLevel.WARN, 'deletion', 'Risky mode inactive – skipping automation');
    } else {
      report = await runRiskyAutomationBatch(items, settings);
    }
    await recordDeletionResults(report.results || [], settings);
    return { ok: true, report };
  } catch (error) {
    await log(LogLevel.ERROR, 'deletion', 'deleteSelected failed', { message: error?.message || String(error) });
    return { ok: false, error: error?.message || 'deletion_failed' };
  } finally {
    deletionInProgress = false;
    await resetCancelFlag();
  }
}

/** Slovensky: Normalizuje výber konverzácií na jedinečné URL. */
function normalizeSelection(selection) {
  const list = Array.isArray(selection) ? selection : [];
  const seen = new Map();
  list.forEach((entry) => {
    let convoId = '';
    let url = '';
    if (typeof entry === 'string') {
      if (entry.startsWith('http')) {
        url = normalizeChatUrl(entry) || entry;
        convoId = getConversationIdFromUrl(url) || '';
      } else {
        convoId = entry;
      }
    } else if (entry && typeof entry === 'object') {
      if (typeof entry.convoId === 'string') {
        convoId = entry.convoId;
      }
      if (entry.url) {
        url = normalizeChatUrl(entry.url) || entry.url;
      }
    }
    if (!url && convoId) {
      url = getConvoUrl(convoId);
    }
    if (url && !convoId) {
      convoId = getConversationIdFromUrl(url) || convoId;
    }
    if (!url || !convoId) {
      return;
    }
    const canonical = normalizeChatUrl(url) || url;
    if (!seen.has(canonical)) {
      seen.set(canonical, { convoId, url: canonical });
    }
  });
  return Array.from(seen.values());
}

/** Slovensky: Spustí riskantnú automatizáciu na dávke položiek. */
async function runRiskyAutomationBatch(items, rawSettings) {
  const entries = Array.isArray(items) ? items : [];
  const normalizedSettings = normalizeSettings(rawSettings || settingsCache);
  const results = [];
  let cancelled = false;
  let deleted = 0;
  let failed = 0;

  broadcastRiskyProgress({ processed: 0, total: entries.length, deleted, failed });

  for (let index = 0; index < entries.length; index += 1) {
    if (await readCancelFlag()) {
      cancelled = true;
      break;
    }
    const entry = entries[index];
    const convoId = entry?.convoId || getConversationIdFromUrl(entry?.url);
    const url = normalizeChatUrl(entry?.url) || (convoId ? getConvoUrl(convoId) : null);
    if (!url) {
      const fallback = {
        convoId: convoId || '',
        url: entry?.url || '',
        ok: false,
        reason: 'invalid_url',
        step: 'init',
        attempt: 0,
        strategyId: DeletionStrategyIds.UI_AUTOMATION
      };
      results.push(fallback);
      failed += 1;
      broadcastRiskyProgress({ processed: results.length, total: entries.length, deleted, failed });
      continue;
    }

    console.log('[RiskyMode][bg] begin item', { url, index: index + 1 });
    const attempt = await attemptRiskyAutomation({ convoId, url, settings: normalizedSettings });
    results.push(attempt);
    if (attempt.ok) {
      deleted += 1;
    } else {
      failed += 1;
    }
    console.log('[RiskyMode][bg] item result', {
      url,
      ok: attempt.ok,
      reason: attempt.reason,
      step: attempt.step,
      attempt: attempt.attempt
    });
    broadcastRiskyProgress({ processed: results.length, total: entries.length, deleted, failed });

    if (index < entries.length - 1) {
      await delayBetweenTabs(normalizedSettings);
    }
  }

  broadcastRiskyProgress({
    processed: results.length,
    total: entries.length,
    deleted,
    failed,
    done: true,
    cancelled
  });

  const opened = results.filter((item) => item.ok).length;
  const notes = [];
  if (cancelled) {
    notes.push('cancelled');
  }
  return {
    strategyId: DeletionStrategyIds.UI_AUTOMATION,
    attempted: entries.length,
    opened,
    notes,
    results
  };
}

/** Slovensky: Pokus o mazanie na konkrétnej URL s retry logikou. */
async function attemptRiskyAutomation({ convoId, url, settings }) {
  const maxRetries = Math.max(0, Number.isFinite(settings?.risky_max_retries) ? settings.risky_max_retries : 0);
  let lastError = { reason: 'automation_failed', step: 'init', attempt: 0 };
  for (let index = 0; index <= maxRetries; index += 1) {
    const attempt = index + 1;
    try {
      const { tab } = await getOrCreateTabForUrl(url);
      if (!tab?.id) {
        lastError = { reason: 'tab_missing', step: 'tab', attempt };
        break;
      }
      await focusTab(tab);
      const jitter = randomJitter(settings?.risky_jitter_ms);
      if (Number.isFinite(jitter) && jitter > 0) {
        console.log('[RiskyMode][bg] jitter', { url, attempt, ms: jitter });
        await sleep(jitter);
      }
      await ensureTabScripts(tab.id);
      const profile = await resolveUiProfile();
      const invoke = await invokeRiskyDelete(tab.id, { url, convoId, profile, settings });
      if (!invoke.ok) {
        console.error(`[RiskyMode][bg] FATAL call failed: ${invoke.err || 'unknown'}`, { url, attempt });
        lastError = { reason: 'tab_exec_error', step: 'tab_exec', attempt, err: invoke.err };
      } else if (invoke.out?.ok) {
        return {
          convoId,
          url,
          ok: true,
          reason: invoke.out.reason || 'deleted',
          step: invoke.out.step || 'verify',
          attempt,
          strategyId: DeletionStrategyIds.UI_AUTOMATION
        };
      } else {
        lastError = {
          reason: invoke.out?.reason || 'automation_failed',
          step: invoke.out?.step || 'unknown',
          attempt,
          err: invoke.out?.details?.message || invoke.out?.details?.code || null
        };
        console.warn('[RiskyMode][bg] retryable failure', { url, attempt, reason: lastError.reason, step: lastError.step });
      }
    } catch (error) {
      const parsed = parseChromeError(error);
      lastError = { reason: parsed, step: 'chrome', attempt };
      console.error('[RiskyMode][bg] chrome error', { url, attempt, error: parsed });
    }

    if (index < maxRetries) {
      await sleep(200);
    }
  }

  return {
    convoId,
    url,
    ok: false,
    reason: lastError.reason || 'automation_failed',
    step: lastError.step || 'unknown',
    attempt: lastError.attempt || maxRetries + 1,
    strategyId: DeletionStrategyIds.UI_AUTOMATION,
    err: lastError.err || null
  };
}

/** Slovensky: Predlet pre injekciu – zaistí načítanie skriptov. */
async function ensureTabScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['automation/selectors.js']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['automation/risky_mode.js']
  });
}

/** Slovensky: Zavolá globálny API v kontexte karty. */
async function invokeRiskyDelete(tabId, args) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: async (payload) => {
      try {
        console.log('[RiskyMode][tab] begin run', payload);
        if (!window.__MYCHAT_SELECTORS__ || !window.__MYCHAT_RISKY__) {
          throw new Error('global API missing');
        }
        const out = await window.__MYCHAT_RISKY__.runHeaderDelete(payload);
        console.log('[RiskyMode][tab] done', out);
        return { ok: true, out };
      } catch (error) {
        const message = error && (error.stack || error.message || String(error));
        console.error('[RiskyMode][tab] FATAL', message);
        return { ok: false, err: String(message || 'tab_error') };
      }
    },
    args: [args]
  });
  return execution?.result || { ok: false, err: 'no_result' };
}

/** Slovensky: Zameria okno a aktivuje kartu pred injekciou. */
async function focusTab(tab) {
  try {
    if (tab?.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (_error) {}
  try {
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { active: true });
    }
  } catch (_error) {}
  await sleep(150);
}

/** Slovensky: Vráti existujúci tab alebo otvorí nový pre danú URL. */
async function getOrCreateTabForUrl(url) {
  const normalized = normalizeChatUrl(url);
  if (!normalized) {
    return { tab: null };
  }
  const candidates = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const existing = candidates.find((tab) => normalizeChatUrl(tab.url) === normalized);
  if (existing?.id) {
    await waitForTabComplete(existing.id, { timeoutMs: 15000 });
    return { tab: existing };
  }
  const created = await chrome.tabs.create({ url: normalized, active: true });
  await waitForTabComplete(created.id, { timeoutMs: 20000 });
  return { tab: created };
}

/** Slovensky: Počká na načítanie karty. */
async function waitForTabComplete(tabId, { timeoutMs = 15000 } = {}) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() <= deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === 'complete') {
        return;
      }
    } catch (_error) {
      return;
    }
    await sleep(150);
  }
}

/** Slovensky: Vypočíta pauzu medzi kartami vrátane jitteru. */
async function delayBetweenTabs(settings) {
  const base = Math.max(0, settings?.risky_between_tabs_ms || 0);
  const jitter = randomJitter(settings?.risky_jitter_ms);
  const total = base + (Number.isFinite(jitter) ? jitter : 0);
  if (total > 0) {
    await sleep(total);
  }
}

/** Slovensky: Vyhodnotí UI profil z jazykov pre tab volanie. */
let cachedUiProfile = null;
async function resolveUiProfile() {
  if (cachedUiProfile) {
    return cachedUiProfile;
  }
  const locales = [];
  try {
    if (typeof chrome.i18n?.getUILanguage === 'function') {
      locales.push(chrome.i18n.getUILanguage());
    }
  } catch (_error) {}
  if (typeof chrome.i18n?.getAcceptLanguages === 'function') {
    try {
      const accepted = await new Promise((resolve) => chrome.i18n.getAcceptLanguages((langs) => resolve(langs || [])));
      locales.push(...accepted);
    } catch (_error) {}
  }
  const normalized = locales
    .map((code) => String(code || '').toLowerCase())
    .filter(Boolean);
  const isSk = normalized.some((code) => /^sk|^cs|^cz/.test(code));
  const base = isSk ? PROFILE_SK : PROFILE_EN;
  cachedUiProfile = compileBackgroundProfile(base);
  return cachedUiProfile;
}

const PROFILE_SK = {
  delete_menu_items: [/^(odstrániť|odstranit)$/i, /^(zmazať|zmazat)$/i],
  confirm_buttons: [/^(odstrániť|odstranit)$/i, /^(zmazať|zmazat)$/i, /^(áno, odstrániť|ano, odstranit)$/i],
  toast_texts: [/odstránen/i, /odstranen/i, /zmazan/i]
};

const PROFILE_EN = {
  delete_menu_items: [/^(delete|delete chat|delete conversation)$/i, /^remove$/i],
  confirm_buttons: [/^(delete|delete conversation)$/i, /^yes, delete$/i],
  toast_texts: [/deleted/i, /removed/i]
};

function compileBackgroundProfile(base) {
  const toastRegex = Array.isArray(base.toast_texts) && base.toast_texts.length
    ? new RegExp(base.toast_texts.map((regex) => regex.source).join('|'), 'i')
    : null;
  return {
    delete_menu_items: base.delete_menu_items,
    confirm_buttons: base.confirm_buttons,
    toast_texts: base.toast_texts,
    toast_regex: toastRegex
  };
}

/** Slovensky: Posiela priebežný update pre popup. */
function broadcastRiskyProgress(payload) {
  try {
    chrome.runtime.sendMessage({ type: 'RISKY_PROGRESS', payload }).catch(() => {});
  } catch (_error) {}
}

/** Slovensky: Normalizuje chybu z chrome.* API na text. */
function parseChromeError(error) {
  if (!error) {
    return 'chrome_error';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error.message) {
    return error.message;
  }
  if (error.code) {
    return error.code;
  }
  return 'chrome_error';
}

/** Slovensky: Otvorí manuálne potrebné taby (fallback mód). */
/** Slovensky: Zapíše výsledok pokusu do IndexedDB. */
async function recordDeletionResults(results, settings) {
  const timestamp = now();
  await Promise.all(
    (results || []).map(async (item) => {
      if (!item?.convoId) {
        return;
      }
      await backups.updateDeletionMeta(item.convoId, {
        lastDeletionAttemptAt: timestamp,
        lastDeletionOutcome: {
          ok: Boolean(item.ok),
          reason: item.reason || null,
          step: item.step || null,
          strategyId: item.strategyId,
          attempt: item.attempt || 0,
          dryRun: item.strategyId === DeletionStrategyIds.UI_AUTOMATION ? Boolean(settings.dry_run) : false
        }
      });
    })
  );
}

/** Slovensky: Nastaví príznak zrušenia mazania. */
async function setCancelFlag(value) {
  await chrome.storage.local.set({ [CANCEL_FLAG_KEY]: Boolean(value) });
}

/** Slovensky: Vráti aktuálny stav cancel príznaku. */
async function readCancelFlag() {
  try {
    const stored = await chrome.storage.local.get([CANCEL_FLAG_KEY]);
    return Boolean(stored?.[CANCEL_FLAG_KEY]);
  } catch (_error) {
    return false;
  }
}

/** Slovensky: Resetuje cancel príznak na false. */
async function resetCancelFlag() {
  await chrome.storage.local.set({ [CANCEL_FLAG_KEY]: false });
}

/** Slovensky: Otestuje selektory na aktívnom tabe – výsledky loguje do konzoly karty. */
async function testSelectorsOnActiveTab() {
  const tabId = await getActiveTabId();
  if (!tabId) {
    return { ok: false, error: 'no_active_chat' };
  }
  const urlOk = await isChatUrl(tabId);
  if (!urlOk) {
    return { ok: false, error: 'no_active_chat' };
  }
  const settings = normalizeSettings(settingsCache);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      files: ['automation/selectors.js']
    });
    const [response] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async ({ timeoutMs, prefix }) => {
        const selectors = globalThis.__MYCHAT_SELECTORS__;
        if (!selectors?.waitForHeaderToolbar) {
          console.warn(`${prefix} Probe missing selectors`);
          return { ok: false, error: 'selectors_missing' };
        }

        const summary = { header: false, menu: false, confirm: false };
        const profile = detectUiProfile();

        const logMeta = (message, meta, level = 'log') => {
          if (meta !== undefined) {
            console[level](`${prefix} ${message}`, meta);
          } else {
            console[level](`${prefix} ${message}`);
          }
        };

        const toMeta = (error) => {
          if (!error) {
            return { code: 'error', message: 'unknown' };
          }
          const meta = {
            code: error.code || error.reason || 'error',
            message: error.message || error.reason || String(error)
          };
          if (Array.isArray(error.attempted) && error.attempted.length) {
            meta.attempted = error.attempted;
          }
          if (Number.isFinite(error.timeoutMs)) {
            meta.timeoutMs = error.timeoutMs;
          }
          return meta;
        };

        try {
          await selectors.waitForAppShell({ timeoutMs });
        } catch (error) {
          logMeta('Probe appShell timeout', toMeta(error), 'warn');
          return { ok: false, error: error?.code || 'app_shell_timeout', summary };
        }

        let toolbarResult = null;
        try {
          toolbarResult = await selectors.waitForHeaderToolbar({ timeoutMs });
          if (toolbarResult?.shareEl instanceof Element) {
            summary.header = true;
          }
          logMeta('Probe share', toolbarResult?.evidence || toolbarResult?.describe);
        } catch (error) {
          logMeta('Probe share missing', toMeta(error), 'warn');
        }

        let kebabEl = null;
        if (toolbarResult?.toolbarEl instanceof Element && toolbarResult?.shareEl instanceof Element) {
          try {
            const match = await selectors.findHeaderKebabNearShare(toolbarResult.toolbarEl, toolbarResult.shareEl, { timeoutMs });
            kebabEl = match?.kebabEl || match?.element;
            if (kebabEl instanceof Element) {
              summary.header = true;
            }
            logMeta('Probe kebab', match?.evidence);
          } catch (error) {
            logMeta('Probe kebab missing', toMeta(error), 'warn');
          }
        }

        let menuResult = null;
        let confirmResult = null;
        let menuOpened = false;

        if (kebabEl instanceof Element) {
          await selectors.reveal(kebabEl);
          await selectors.clickHard(kebabEl);
          await selectors.sleep(160);
          menuOpened = true;
          try {
            menuResult = await selectors.findDeleteInOpenMenu(profile, { timeoutMs });
            if (menuResult?.element instanceof Element) {
              summary.menu = true;
            }
            logMeta('Probe delete', menuResult?.evidence);
          } catch (error) {
            logMeta('Probe delete missing', toMeta(error), 'warn');
          }

          if (menuResult?.element instanceof Element && !menuResult?.evidence?.hidden) {
            await selectors.reveal(menuResult.element);
            await selectors.clickHard(menuResult.element);
            await selectors.sleep(180);
            try {
              confirmResult = await selectors.findConfirmDelete(profile, { timeoutMs });
              if (confirmResult?.element instanceof Element) {
                summary.confirm = true;
              }
              logMeta('Probe confirm', confirmResult?.evidence);
            } catch (error) {
              logMeta('Probe confirm missing', toMeta(error), 'warn');
            }
          }
        }

        if (confirmResult?.element instanceof Element) {
          const doc = confirmResult.element.ownerDocument || document;
          const keyInit = { key: 'Escape', bubbles: true, cancelable: true };
          doc.dispatchEvent(new KeyboardEvent('keydown', keyInit));
          doc.dispatchEvent(new KeyboardEvent('keyup', keyInit));
          await selectors.sleep(120);
        } else if (menuOpened) {
          const keyInit = { key: 'Escape', bubbles: true, cancelable: true };
          document.dispatchEvent(new KeyboardEvent('keydown', keyInit));
          document.dispatchEvent(new KeyboardEvent('keyup', keyInit));
          await selectors.sleep(120);
        }

        console.log(`${prefix} Probe summary`, summary);
        return { ok: true, summary };

        function detectUiProfile() {
          const langs = [];
          if (Array.isArray(navigator?.languages)) {
            langs.push(...navigator.languages);
          }
          if (typeof navigator?.language === 'string') {
            langs.push(navigator.language);
          }
          if (typeof document?.documentElement?.lang === 'string') {
            langs.push(document.documentElement.lang);
          }
          const normalized = langs.map((code) => String(code || '').toLowerCase());
          const isSk = normalized.some((code) => /^sk|^cs|^cz/.test(code));
          if (isSk) {
            return {
              delete_menu_items: [/^(odstrániť|odstranit)$/i, /^(zmazať|zmazat)$/i],
              confirm_buttons: [/^(odstrániť|odstranit)$/i, /^(zmazať|zmazat)$/i, /^(áno, odstrániť|ano, odstranit)$/i]
            };
          }
          return {
            delete_menu_items: [/^(delete|delete chat|delete conversation)$/i, /^remove$/i],
            confirm_buttons: [/^(delete|delete conversation)$/i, /^yes, delete$/i]
          };
        }
      },
      args: [{ timeoutMs: settings.risky_step_timeout_ms, prefix: '[RiskyMode][tab]' }]
    });
    const outcome = response?.result;
    if (!outcome?.ok) {
      return { ok: false, error: outcome?.error || 'probe_failed' };
    }
    const summary = outcome.summary || {};
    return {
      ok: true,
      result: {
        header: Boolean(summary.header),
        menu: Boolean(summary.menu),
        confirm: Boolean(summary.confirm)
      }
    };
  } catch (error) {
    await log(LogLevel.ERROR, 'deletion', 'Selector probe failed', { message: error?.message || String(error) });
    return { ok: false, error: error?.message || 'probe_failed' };
  }
}

/** Slovensky: Overí, či tab smeruje na chatgpt.com. */
async function isChatUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return typeof tab?.url === 'string' && tab.url.startsWith('https://chatgpt.com/');
  } catch (_error) {
    return false;
  }
}
