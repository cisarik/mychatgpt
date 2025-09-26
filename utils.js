const LOG_KEY = 'cleaner_logs';
const LOG_LIMIT = 120;

export const SETTINGS_KEY = 'cleaner_settings';

export const DEFAULT_SETTINGS = Object.freeze({
  debugEnabled: false,
  maxMessageCount: 2,
  maxAgeMinutes: 10,
  maxPromptLength: 280,
  batchSize: 5
});

export const LogLevel = Object.freeze({
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
});

let debugCache = false;
let debugReady = false;
let debugWaiter = null;

/**
 * Slovensky: Zabezpečí načítanie flagu debugEnabled zo storage.
 */
async function ensureDebugState() {
  if (debugReady) {
    return debugCache;
  }
  if (debugWaiter) {
    await debugWaiter;
    return debugCache;
  }
  debugWaiter = (async () => {
    try {
      const stored = await chrome.storage.local.get([SETTINGS_KEY]);
      const settings = normalizeSettings(stored?.[SETTINGS_KEY]);
      debugCache = Boolean(settings.debugEnabled);
    } catch (_error) {
      debugCache = false;
    } finally {
      debugReady = true;
      debugWaiter = null;
    }
  })();
  await debugWaiter;
  return debugCache;
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) {
      return;
    }
    const nextValue = normalizeSettings(changes[SETTINGS_KEY]?.newValue);
    debugCache = Boolean(nextValue.debugEnabled);
    debugReady = true;
  });
}

/**
 * Slovensky: Ukladá log iba ak je zapnutý debug režim.
 */
export async function log(level, scope, message, meta = undefined) {
  const allowed = await ensureDebugState();
  if (!allowed) {
    return null;
  }
  const entry = {
    id: uuidv4(),
    timestamp: Date.now(),
    level: level || LogLevel.INFO,
    scope: scope || 'general',
    message: message || '',
    meta: sanitizeMeta(meta)
  };
  try {
    const stored = await chrome.storage.local.get([LOG_KEY]);
    const existing = Array.isArray(stored?.[LOG_KEY]) ? stored[LOG_KEY] : [];
    const next = [...existing, entry].slice(-LOG_LIMIT);
    await chrome.storage.local.set({ [LOG_KEY]: next });
  } catch (error) {
    console.warn('Cleaner log store failed', error);
  }
  return entry;
}

/**
 * Slovensky: Vráti uložené logy podľa debug nastavení.
 */
export async function getLogs() {
  try {
    const stored = await chrome.storage.local.get([LOG_KEY]);
    return Array.isArray(stored?.[LOG_KEY]) ? stored[LOG_KEY] : [];
  } catch (_error) {
    return [];
  }
}

/**
 * Slovensky: Vyčistí uložené logy.
 */
export async function clearLogs() {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}

function sanitizeMeta(meta) {
  if (meta === undefined || meta === null) {
    return null;
  }
  if (typeof meta !== 'object') {
    return meta;
  }
  if (Array.isArray(meta)) {
    return meta.length ? meta : null;
  }
  const keys = Object.keys(meta);
  if (!keys.length) {
    return null;
  }
  return keys.reduce((acc, key) => {
    const value = meta[key];
    if (value === undefined) {
      return acc;
    }
    acc[key] = value;
    return acc;
  }, {});
}

/**
 * Slovensky: Zjednotí nastavenia s predvolenými hodnotami.
 */
export function normalizeSettings(raw) {
  const base = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const result = { ...base };
  if (typeof raw.debugEnabled === 'boolean') {
    result.debugEnabled = raw.debugEnabled;
  }
  if (Number.isFinite(raw.maxMessageCount)) {
    result.maxMessageCount = clampInt(raw.maxMessageCount, 1, 6);
  }
  if (Number.isFinite(raw.maxAgeMinutes)) {
    result.maxAgeMinutes = clampInt(raw.maxAgeMinutes, 1, 60);
  }
  if (Number.isFinite(raw.maxPromptLength)) {
    result.maxPromptLength = clampInt(raw.maxPromptLength, 40, 1000);
  }
  if (Number.isFinite(raw.batchSize)) {
    result.batchSize = clampInt(raw.batchSize, 1, 10);
  }
  return result;
}

function clampInt(value, min, max) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) {
    return min;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Slovensky: Rozhodne, či zhrnutie spĺňa heuristiky.
 */
export function passesHeuristics(summary, settings) {
  const normalized = normalizeSettings(settings);
  if (!summary || typeof summary !== 'object') {
    return { allowed: false, reasons: ['invalid_summary'] };
  }
  const reasons = [];
  const messageCount = Number.isFinite(summary.messageCount) ? summary.messageCount : 0;
  if (messageCount > normalized.maxMessageCount) {
    reasons.push('too_many_messages');
  }
  const promptLength = summary.userPrompt ? summary.userPrompt.trim().length : 0;
  if (promptLength > normalized.maxPromptLength) {
    reasons.push('prompt_too_long');
  }
  const createdAt = Number.isFinite(summary.createdAt) ? summary.createdAt : Date.now();
  const capturedAt = Number.isFinite(summary.capturedAt) ? summary.capturedAt : Date.now();
  const ageMinutes = Math.max(0, (capturedAt - createdAt) / 60000);
  if (ageMinutes > normalized.maxAgeMinutes) {
    reasons.push('too_old');
  }
  return { allowed: reasons.length === 0, reasons, settings: normalized };
}

/**
 * Slovensky: Získa ID konverzácie z URL.
 */
export function getConversationIdFromUrl(url) {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url, 'https://chatgpt.com');
    const pieces = parsed.pathname.split('/').filter(Boolean);
    if (pieces[0] === 'c' && pieces[1]) {
      return pieces[1];
    }
    return null;
  } catch (_error) {
    return null;
  }
}

/**
 * Slovensky: Sanitizuje HTML odpovede.
 */
export function sanitizeHTML(input) {
  if (!input) {
    return '';
  }
  if (typeof DOMParser === 'undefined') {
    return fallbackSanitize(input);
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${input}</div>`, 'text/html');
  doc.querySelectorAll('script, style, link, meta, title').forEach((node) => node.remove());
  const allowedTags = new Set([
    'a',
    'article',
    'blockquote',
    'br',
    'code',
    'div',
    'em',
    'figure',
    'figcaption',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img',
    'li',
    'ol',
    'p',
    'pre',
    'section',
    'span',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul'
  ]);
  const globalAttrs = new Set(['class', 'aria-label', 'role', 'data-language']);
  const perTagAttrs = {
    a: new Set(['href', 'title', 'rel', 'target']),
    img: new Set(['src', 'alt', 'title'])
  };
  doc.body.querySelectorAll('*').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      const fragment = doc.createDocumentFragment();
      while (el.firstChild) {
        fragment.appendChild(el.firstChild);
      }
      el.replaceWith(fragment);
      return;
    }
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
        el.removeAttribute(attr.name);
        return;
      }
      const allowedForTag = perTagAttrs[tag] || new Set();
      if (!allowedForTag.has(name) && !globalAttrs.has(name)) {
        el.removeAttribute(attr.name);
        return;
      }
      if (name === 'href' && !isSafeLink(attr.value)) {
        el.removeAttribute(attr.name);
      }
      if (name === 'src' && tag === 'img' && !isSafeImage(attr.value)) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

function fallbackSanitize(value) {
  return String(value)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '');
}

function isSafeLink(value) {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('?')) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, 'https://chatgpt.com');
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:';
  } catch (_error) {
    return false;
  }
}

function isSafeImage(value) {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('data:image/')) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, 'https://chatgpt.com');
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (_error) {
    return false;
  }
}

/**
 * Slovensky: Normalizuje URL pre porovnania.
 */
export function normalizeChatUrl(url) {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url, 'https://chatgpt.com');
    parsed.hash = '';
    parsed.search = '';
    if (!parsed.pathname.endsWith('/')) {
      parsed.pathname += '/';
    }
    return parsed.toString();
  } catch (_error) {
    return null;
  }
}

/**
 * Slovensky: Jednoduché UUID v4.
 */
export function uuidv4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return template.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

