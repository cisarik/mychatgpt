import { initDb, backups } from './db.js';
import {
  clearLogs,
  DEFAULT_SETTINGS,
  getLogs,
  log,
  LogLevel,
  normalizeChatUrl,
  normalizeSettings,
  passesHeuristics,
  sanitizeHTML,
  SETTINGS_KEY
} from './utils.js';

let settingsCache = { ...DEFAULT_SETTINGS };
const ready = bootstrap();

async function bootstrap() {
  await initDb();
  await ensureSettingsLoaded();
  chrome.storage.onChanged.addListener(handleSettingsChange);
  await log(LogLevel.INFO, 'background', 'Cleaner booted');
}

/**
 * Slovensky: Načíta nastavenia, ak ešte nie sú pripravené.
 */
async function ensureSettingsLoaded() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  if (!stored?.[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
    settingsCache = { ...DEFAULT_SETTINGS };
    return;
  }
  const normalized = normalizeSettings(stored[SETTINGS_KEY]);
  settingsCache = normalized;
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
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
    await ready;
    switch (message.type) {
      case 'CANDIDATE_CONVERSATION':
        return handleCandidate(message.payload || {}, sender);
      case 'LIST_BACKUPS':
        return { ok: true, items: await backups.list() };
      case 'DELETE_BACKUP':
        await backups.remove(message.id);
        return { ok: true };
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
      case 'OPEN_BATCH':
        return openBatch(message.urls || []);
      default:
        return { ok: false, error: 'unsupported_message' };
    }
  })()
    .then((response) => {
      sendResponse(response || { ok: true });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error?.message || 'unexpected_error' });
    });
  return true;
});

async function handleCandidate(candidate, sender) {
  const cleaned = sanitizeCandidate(candidate, sender);
  if (!cleaned) {
    return { ok: false, rejected: 'invalid_candidate' };
  }
  const heuristic = passesHeuristics(cleaned, settingsCache);
  if (!heuristic.allowed) {
    await log(LogLevel.INFO, 'capture', 'Rejected by heuristics', {
      convoId: cleaned.convoId,
      reasons: heuristic.reasons
    });
    return { ok: false, rejected: heuristic.reasons };
  }
  const existing = await backups.byConvoId(cleaned.convoId);
  const record = await backups.save({
    id: existing?.id || cleaned.convoId,
    convoId: cleaned.convoId,
    title: cleaned.title,
    userPrompt: cleaned.userPrompt,
    answerHTML: sanitizeHTML(cleaned.firstAnswerHTML),
    createdAt: cleaned.createdAt,
    capturedAt: cleaned.capturedAt,
    messageCount: cleaned.messageCount,
    url: cleaned.url
  });
  await log(LogLevel.INFO, 'capture', 'Backup stored', {
    convoId: record.convoId,
    updated: Boolean(existing)
  });
  return { ok: true, stored: record, updated: Boolean(existing) };
}

function sanitizeCandidate(candidate, sender) {
  const url = typeof candidate?.url === 'string' ? candidate.url : sender?.tab?.url;
  const convoId = candidate?.convoId || (url ? extractConvoId(url) : null);
  if (!convoId) {
    return null;
  }
  const userPrompt = (candidate?.userPrompt || '').trim();
  const firstAnswerHTML = candidate?.firstAnswerHTML || '';
  if (!userPrompt || !firstAnswerHTML) {
    return null;
  }
  const createdAt = Number.isFinite(candidate?.createdAt) ? candidate.createdAt : Date.now();
  const capturedAt = Number.isFinite(candidate?.capturedAt) ? candidate.capturedAt : Date.now();
  return {
    convoId,
    url: normalizeChatUrl(url) || `https://chatgpt.com/c/${convoId}`,
    userPrompt,
    firstAnswerHTML,
    createdAt,
    capturedAt,
    messageCount: Number.isFinite(candidate?.messageCount) ? candidate.messageCount : 0,
    title: buildTitleFromPrompt(userPrompt)
  };
}

function extractConvoId(url) {
  try {
    const parsed = new URL(url, 'https://chatgpt.com');
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'c' && parts[1]) {
      return parts[1];
    }
    return null;
  } catch (_error) {
    return null;
  }
}

function buildTitleFromPrompt(prompt) {
  if (!prompt) {
    return 'Search backup';
  }
  const trimmed = prompt.trim();
  if (trimmed.length <= 80) {
    return trimmed;
  }
  return `${trimmed.slice(0, 77)}...`;
}

async function saveSettings(update) {
  const next = normalizeSettings({ ...settingsCache, ...update });
  settingsCache = next;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  await log(LogLevel.INFO, 'settings', 'Settings updated', next);
  return { ok: true, settings: next };
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
  return {
    ok: true,
    html,
    filename: `${record.title || 'chat'}-${record.id}.html`
  };
}

function buildExportHtml(record) {
  const title = escapeHtml(record.title || 'Search backup');
  const prompt = escapeHtml(record.questionText || '');
  const created = new Date(record.createdAt || record.timestamp || Date.now()).toISOString();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
    `<title>${title}</title></head><body><main>` +
    `<h1>${title}</h1>` +
    `<section><h2>User prompt</h2><pre>${prompt}</pre></section>` +
    `<section><h2>Assistant</h2>${record.answerHTML || ''}</section>` +
    `<footer><p>Captured at: ${created}</p></footer>` +
    `</main></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function openBatch(urls) {
  if (!Array.isArray(urls) || !urls.length) {
    return { ok: false, error: 'empty_batch' };
  }
  const normalizedUrls = urls
    .map((url) => normalizeChatUrl(url))
    .filter((url) => Boolean(url));
  if (!normalizedUrls.length) {
    return { ok: false, error: 'invalid_urls' };
  }
  const unique = Array.from(new Set(normalizedUrls));
  const limit = Math.max(1, settingsCache.batchSize || DEFAULT_SETTINGS.batchSize);
  const slice = unique.slice(0, limit);
  const openable = await filterExistingTabs(slice);
  await Promise.all(openable.map((url) => chrome.tabs.create({ url, active: false })));
  await log(LogLevel.INFO, 'batch', 'Tabs opened', { count: openable.length });
  return { ok: true, opened: openable.length };
}

async function filterExistingTabs(urls) {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  const openSet = new Set(tabs.map((tab) => normalizeChatUrl(tab.url)).filter(Boolean));
  return urls.filter((url) => !openSet.has(url));
}

