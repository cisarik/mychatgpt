import { initDb, backups } from './db.js';
import {
  createManualOpenStrategy,
  DEFAULT_SETTINGS,
  DeletionStrategyIds,
  getConvoUrl,
  getDeletionStrategy,
  getConversationIdFromUrl,
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
        return triggerScan();
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
  const heuristic = passesHeuristics(cleaned, settingsCache);
  if (!heuristic.allowed) {
    await log(LogLevel.INFO, 'capture', 'Candidate rejected', {
      convoId: cleaned.convoId,
      reasons: heuristic.reasons
    });
    return { ok: false, rejected: heuristic.reasons };
  }
  const stored = await backups.save(cleaned);
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
  const userPrompt = (candidate?.userPrompt || '').trim();
  const answerHTML = sanitizeHTML(candidate?.firstAnswerHTML || candidate?.answerHTML || '');
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
    messageCount: Number.isFinite(candidate?.messageCount) ? candidate.messageCount : 0
  };
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

/** Slovensky: Pošle obsahovým skriptom požiadavku na manuálny scan. */
async function triggerScan() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  let dispatched = 0;
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) {
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'RUN_CAPTURE_NOW' });
        dispatched += 1;
      } catch (_error) {
        // Content skript nemusí byť injektovaný; ignorujeme.
      }
    })
  );
  await log(LogLevel.INFO, 'scan', 'Manual scan requested', { dispatched });
  return { ok: true, dispatched };
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
  const settings = normalizeSettings(settingsCache);
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

/** Slovensky: Otestuje selektory na aktívnom tabe – loguje len do konzoly. */
async function testSelectorsOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: 'https://chatgpt.com/*' });
  if (!tab?.id) {
    return { ok: false, error: 'no_active_chat' };
  }
  const settings = normalizeSettings(settingsCache);
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      injectImmediately: true,
      func: selectorProbe,
      args: [
        {
          timeoutMs: settings.risky_step_timeout_ms,
          prefix: '[RiskyMode]',
          debug: Boolean(settings.debugLogs)
        }
      ]
    });
    return { ok: true, result: injected?.[0]?.result || null };
  } catch (error) {
    await log(LogLevel.ERROR, 'deletion', 'Selector probe failed', { message: error?.message || String(error) });
    return { ok: false, error: error?.message || 'probe_failed' };
  }
}

/** Slovensky: Kód injektovaný do chatgpt tabu pre overenie selektorov. */
async function selectorProbe(payload) {
  const { timeoutMs, prefix, debug } = payload || {};
  const logProbe = (message, meta) => {
    if (debug) {
      if (meta !== undefined) {
        console.log(`${prefix} ${message}`, meta);
      } else {
        console.log(`${prefix} ${message}`);
      }
    }
  };
  const selectors = await import(chrome.runtime.getURL('automation/selectors.js'));
  const summary = { kebab: false, deleteMenu: false, confirm: false };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  try {
    const kebab = await selectors.findKebabButton(document, timeoutMs);
    summary.kebab = true;
    logProbe('Test: kebab menu located', probeSummary(kebab));
    kebab.click();
    await pause(80);
    try {
      const deleteItem = await selectors.findDeleteMenuItem(document, timeoutMs);
      summary.deleteMenu = true;
      logProbe('Test: delete item located', probeSummary(deleteItem));
      deleteItem.click();
      await pause(80);
      try {
        const confirm = await selectors.findConfirmDeleteButton(document, timeoutMs);
        summary.confirm = true;
        logProbe('Test: confirm button located', probeSummary(confirm));
        dismissModal(confirm);
      } catch (error) {
        summary.confirm = false;
        logProbe('Test: confirm button missing', { code: error?.code || 'not_found', detail: error?.attempted });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    } catch (error) {
      summary.deleteMenu = false;
      logProbe('Test: delete item missing', { code: error?.code || 'not_found', detail: error?.attempted });
    }
  } catch (error) {
    summary.kebab = false;
    logProbe('Test: kebab menu missing', { code: error?.code || 'not_found', detail: error?.attempted });
  }
  return summary;

  function probeSummary(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }
    const tag = node.tagName.toLowerCase();
    const text = (node.textContent || '').trim().slice(0, 40);
    const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
    return { tag, text, label };
  }

  function dismissModal(confirmButton) {
    const dialog = confirmButton?.closest('[role="dialog"],[role="alertdialog"]');
    if (!dialog) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    const cancel = dialog.querySelector('button[aria-label*="cancel" i], button.secondary');
    if (cancel) {
      cancel.click();
    } else {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  }
}
