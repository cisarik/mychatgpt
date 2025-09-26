import { initDb, backups } from './db.js';
import {
  createManualOpenStrategy,
  DEFAULT_SETTINGS,
  DeletionStrategyIds,
  ensureRiskyNotExpired,
  getConvoUrl,
  getDeletionStrategy,
  getConversationIdFromUrl,
  getActiveTabId,
  getActiveChatgptTabId,
  getAllChatgptTabIds,
  log,
  LogLevel,
  normalizeChatUrl,
  normalizeSettings,
  now,
  passesHeuristics,
  sanitizeHTML,
  SETTINGS_KEY,
  sleep
} from './utils.js';
import { createUiAutomationDeletionStrategy } from './automation/risky_mode.js';

let settingsCache = { ...DEFAULT_SETTINGS };
const bootstrapReady = bootstrap();
const recentlyOpened = new Map();
const CANCEL_FLAG_KEY = 'cancel_deletion';
let deletionInProgress = false;

const automationStrategy = createUiAutomationDeletionStrategy({
  getSettings: () => settingsCache,
  getDebug: () => Boolean(settingsCache.debugLogs),
  shouldCancel: () => readCancelFlag()
});

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
  const heuristic = applyHeuristics(cleaned);
  if (!heuristic.eligible) {
    await log(LogLevel.INFO, 'capture', 'Candidate rejected', {
      convoId: cleaned.convoId,
      reasons: heuristic.reasons
    });
    return { ok: false, rejected: heuristic.reasons };
  }
  const stored = await persistCandidate(cleaned, heuristic, { storeWhenIneligible: false });
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
  return {
    convoId,
    url: normalizeChatUrl(baseUrl) || `https://chatgpt.com/c/${convoId}`,
    userPrompt,
    answerHTML,
    createdAt,
    capturedAt,
    messageCount: resolveMessageCount(candidate)
  };
}

/** Slovensky: Vráti približný počet správ. */
function resolveMessageCount(candidate) {
  if (Number.isFinite(candidate?.messageCount)) {
    return candidate.messageCount;
  }
  if (Number.isFinite(candidate?.meta?.messageCountsApprox)) {
    return candidate.meta.messageCountsApprox;
  }
  return 0;
}

/** Slovensky: Aplikuje heuristiky na kandidáta. */
function applyHeuristics(candidate) {
  const verdict = passesHeuristics(candidate, settingsCache);
  return {
    eligible: verdict.allowed,
    reason: verdict.allowed ? null : verdict.reason || verdict.reasons?.[0] || 'unknown',
    reasons: Array.isArray(verdict.reasons) ? verdict.reasons : []
  };
}

/**
 * Slovensky: Uloží kandidáta do DB s metadátami heuristík.
 * @param {ReturnType<typeof sanitizeCandidate>} cleaned
 * @param {{eligible:boolean,reason:string|null,reasons:string[]}} heuristics
 * @param {{storeWhenIneligible?:boolean}} options
 */
async function persistCandidate(cleaned, heuristics, { storeWhenIneligible = false } = {}) {
  if (!heuristics.eligible && !storeWhenIneligible) {
    return null;
  }
  const stored = await backups.save({
    ...cleaned,
    eligible: heuristics.eligible ? true : false,
    eligibilityReason: heuristics.eligible ? null : heuristics.reason || 'unknown'
  });
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
  const heuristics = applyHeuristics(cleaned);
  const stored = await persistCandidate(cleaned, heuristics, { storeWhenIneligible });
  if (!stored) {
    return { ok: false, error: 'rejected_by_heuristics', heuristics };
  }
  await log(LogLevel.INFO, 'capture', 'Manual capture stored', {
    convoId: stored.convoId,
    eligible: heuristics.eligible,
    reason: heuristics.reason,
    source
  });
  return { ok: true, stored, heuristics };
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
  const desiredStrategy = getDeletionStrategy(settings);
  let report;
  try {
    if (desiredStrategy === DeletionStrategyIds.UI_AUTOMATION) {
      const available = await automationStrategy.isAvailable();
      if (available) {
        report = await automationStrategy.deleteMany(items.map((item) => item.url));
      } else {
        await log(LogLevel.WARN, 'deletion', 'Automation unavailable – using manual fallback');
        report = await runManualDeletion(items, settings, true);
      }
    } else {
      report = await runManualDeletion(items, settings, false);
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

/** Slovensky: Otvorí manuálne potrebné taby (fallback mód). */
async function runManualDeletion(items, settings, fromFallback) {
  const canonicalItems = items.map((item) => ({ ...item, url: normalizeChatUrl(item.url) || item.url }));
  const available = await filterAvailableTabs(canonicalItems.map((item) => item.url));
  const availableSet = new Set(available);
  const results = [];
  let cancelled = false;
  for (const item of canonicalItems) {
    const convoId = item.convoId;
    if (!convoId) {
      continue;
    }
    if (await readCancelFlag()) {
      cancelled = true;
      break;
    }
    if (!availableSet.has(item.url)) {
      results.push({
        convoId,
        url: item.url,
        ok: false,
        reason: 'already_open',
        strategyId: DeletionStrategyIds.MANUAL_OPEN,
        attempt: 0
      });
      availableSet.delete(item.url);
      continue;
    }
    await openConversationTab(item.url, { active: false });
    results.push({
      convoId,
      url: item.url,
      ok: false,
      reason: fromFallback ? 'manual_fallback' : 'manual_open',
      strategyId: DeletionStrategyIds.MANUAL_OPEN,
      attempt: 1
    });
    availableSet.delete(item.url);
    if (settings.risky_between_tabs_ms) {
      await sleep(settings.risky_between_tabs_ms);
    }
  }
  const opened = results.filter((row) => row.reason === 'manual_open' || row.reason === 'manual_fallback').length;
  return {
    strategyId: DeletionStrategyIds.MANUAL_OPEN,
    attempted: canonicalItems.length,
    opened,
    notes: cancelled ? ['cancelled'] : [],
    results
  };
}

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
        const selectors = globalThis.RiskySelectors;
        if (!selectors?.waitForAppShell) {
          console.warn(`${prefix} Probe missing selectors`);
          return { ok: false, error: 'selectors_missing' };
        }
        const summary = {
          headerFound: false,
          sidebarFound: false,
          menuFound: false,
          confirmFound: false
        };
        const profile = detectUiProfile();

        const logMeta = (message, meta, level = 'log') => {
          if (meta !== undefined) {
            console[level](`${prefix} ${message}`, meta);
          } else {
            console[level](`${prefix} ${message}`);
          }
        };

        const convoIdFromLocation = () => {
          try {
            const url = new URL(window.location.href);
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts[0] === 'c' && parts[1]) {
              return parts[1];
            }
            return null;
          } catch (_error) {
            return null;
          }
        };

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

        try {
          await selectors.waitForAppShell({ timeoutMs });
        } catch (error) {
          logMeta('Probe appShell timeout', {
            code: error?.code || 'waitForAppShell',
            timeoutMs: error?.timeoutMs,
            message: error?.message || String(error)
          }, 'warn');
          return { ok: false, error: error?.code || 'app_shell_timeout' };
        }

        const conversationStatus = await selectors.waitForConversationView({ timeoutMs });
        if (!conversationStatus.ready) {
          logMeta('Probe conversation not ready', {
            attempted: conversationStatus.attempted,
            timeoutMs: conversationStatus.timeoutMs
          }, 'warn');
        }

        let toolbarResult = null;
        let kebabResult = null;
        let path = 'header';

        if (conversationStatus.ready) {
          try {
            toolbarResult = await selectors.waitForHeaderToolbar({ timeoutMs });
            if (toolbarResult?.share) {
              summary.headerFound = true;
            }
            kebabResult = await selectors.findHeaderKebabNearShare(toolbarResult, { timeoutMs });
            summary.headerFound = summary.headerFound || Boolean(kebabResult?.element);
          } catch (error) {
            logMeta('Probe header kebab missing', {
              code: error?.code,
              attempted: error?.attempted,
              timeoutMs: error?.timeoutMs
            }, 'warn');
          }
        }

        const convoId = convoIdFromLocation();
        if (!kebabResult) {
          path = 'sidebar';
          try {
            await selectors.ensureSidebarVisible({ timeoutMs });
            if (convoId) {
              kebabResult = await selectors.findSidebarSelectedItemByConvoId(convoId, { timeoutMs });
              summary.sidebarFound = Boolean(kebabResult?.element);
            } else {
              logMeta('Probe sidebar skipped (missing convoId)');
            }
          } catch (error) {
            logMeta('Probe sidebar kebab missing', {
              code: error?.code,
              attempted: error?.attempted,
              timeoutMs: error?.timeoutMs
            }, 'warn');
          }
        }

        if (kebabResult?.element) {
          await selectors.reveal(kebabResult.element);
          kebabResult.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
          await selectors.sleep(150);
        }

        let menuResult = null;
        if (kebabResult?.element) {
          try {
            menuResult = await selectors.findDeleteInOpenMenu(profile, { timeoutMs });
            if (menuResult?.element) {
              summary.menuFound = true;
            }
          } catch (error) {
            logMeta('Probe delete menu missing', {
              code: error?.code,
              attempted: error?.attempted,
              timeoutMs: error?.timeoutMs
            }, 'warn');
          }
        }

        if (menuResult?.element) {
          await selectors.reveal(menuResult.element);
          menuResult.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
          await selectors.sleep(180);
        }

        let confirmResult = null;
        if (menuResult?.element) {
          try {
            confirmResult = await selectors.findConfirmDelete(profile, { timeoutMs });
            if (confirmResult?.element) {
              summary.confirmFound = true;
            }
          } catch (error) {
            logMeta('Probe confirm missing', {
              code: error?.code,
              attempted: error?.attempted,
              timeoutMs: error?.timeoutMs
            }, 'warn');
          }
        }

        if (confirmResult?.element) {
          await selectors.reveal(confirmResult.element);
          confirmResult.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          confirmResult.element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
        } else if (menuResult?.element) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
        }

        console.log(`${prefix} Probe summary`, summary);
        return { ok: true, summary, path };
      },
      args: [{ timeoutMs: settings.risky_step_timeout_ms, prefix: '[RiskyMode]' }]
    });
    const outcome = response?.result;
    if (!outcome?.ok) {
      return { ok: false, error: outcome?.error || 'probe_failed' };
    }
    const summary = outcome.summary || {};
    return {
      ok: true,
      result: {
        header: Boolean(summary.headerFound),
        sidebar: Boolean(summary.sidebarFound),
        menu: Boolean(summary.menuFound),
        confirm: Boolean(summary.confirmFound)
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
