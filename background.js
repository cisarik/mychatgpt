import { initDb, backups } from './db.js';
import {
  clearLogs,
  createDisabledAutomationStrategy,
  createManualOpenStrategy,
  DEFAULT_SETTINGS,
  DeletionStrategyIds,
  getLogs,
  log,
  LogLevel,
  normalizeChatUrl,
  normalizeSettings,
  passesHeuristics,
  sanitizeHTML,
  SETTINGS_KEY,
  sleep
} from './utils.js';

let settingsCache = { ...DEFAULT_SETTINGS };
const bootstrapReady = bootstrap();
const recentlyOpened = new Map();

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
      case 'GET_LOGS':
        return { ok: true, logs: await getLogs() };
      case 'CLEAR_LOGS':
        await clearLogs();
        return { ok: true };
      case 'OPEN_NEXT':
        return openNext(message.urls || []);
      case 'REQUEST_SCAN':
        return triggerScan();
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
  const strategy = selectStrategy(settingsCache.deletionStrategyId);
  let report;
  try {
    report = await strategy.deleteMany(openable);
  } catch (error) {
    if (strategy.id === DeletionStrategyIds.UI_AUTOMATION) {
      const fallback = selectStrategy(DeletionStrategyIds.MANUAL_OPEN);
      report = await fallback.deleteMany(openable);
      await log(LogLevel.WARN, 'batch', 'Automation strategy unavailable, used manual fallback', { error: error?.message });
    } else {
      throw error;
    }
  }
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

/** Slovensky: Vyberie vhodnú mazaciu strategiu (aktuálne len manuál). */
function selectStrategy(requestedId) {
  const opener = async (url) => {
    const delay = 150 + Math.floor(Math.random() * 100);
    await sleep(delay);
    await chrome.tabs.create({ url, active: false });
    markOpened(url);
  };
  const manual = createManualOpenStrategy(opener);
  if (requestedId === DeletionStrategyIds.UI_AUTOMATION) {
    return createDisabledAutomationStrategy();
  }
  return manual;
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

