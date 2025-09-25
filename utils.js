const LOG_KEY = 'debug_logs';
const LOG_LIMIT = 500;

export const LogLevel = Object.freeze({
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
});

const LEVEL_PRIORITY = {
  [LogLevel.TRACE]: 0,
  [LogLevel.DEBUG]: 1,
  [LogLevel.INFO]: 2,
  [LogLevel.WARN]: 3,
  [LogLevel.ERROR]: 4
};

let cachedLevel = LogLevel.INFO;
let cacheInitialized = false;
let cachePromise = null;

function normalizeLevel(value) {
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered in LEVEL_PRIORITY) {
      return lowered;
    }
  }
  if (typeof value === 'number') {
    const matched = Object.entries(LEVEL_PRIORITY).find(([, priority]) => priority === value);
    if (matched) {
      return matched[0];
    }
  }
  return LogLevel.INFO;
}

async function ensureLevelCache() {
  if (cacheInitialized) {
    return cachedLevel;
  }
  if (cachePromise) {
    await cachePromise;
    return cachedLevel;
  }
  cachePromise = (async () => {
    try {
      const { settings } = await chrome.storage.local.get(['settings']);
      if (settings && settings.DEBUG_LEVEL) {
        cachedLevel = normalizeLevel(settings.DEBUG_LEVEL);
      }
    } catch (error) {
      console.warn('MyChatGPT log level read failed', error);
    } finally {
      cacheInitialized = true;
      cachePromise = null;
    }
  })();
  await cachePromise;
  return cachedLevel;
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) {
      return;
    }
    const nextLevel = normalizeLevel(changes.settings.newValue?.DEBUG_LEVEL);
    cachedLevel = nextLevel;
    cacheInitialized = true;
  });
}

async function shouldLog(level) {
  await ensureLevelCache();
  const activePriority = LEVEL_PRIORITY[cachedLevel] ?? LEVEL_PRIORITY[LogLevel.INFO];
  const requestedPriority = LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY[LogLevel.INFO];
  return requestedPriority >= activePriority;
}

function serializeError(err) {
  if (!err) {
    return null;
  }
  if (typeof err === 'string') {
    return { name: 'Error', message: err, stack: null };
  }
  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack || null
  };
}

function appendToConsole(level, scope, msg, entry) {
  const method = level === LogLevel.ERROR ? 'error' : level === LogLevel.WARN ? 'warn' : 'log';
  const fn = console[method] || console.log;
  try {
    fn.call(console, `[${scope}] ${msg}`, entry.meta || '', entry.err || '');
  } catch (_error) {
    // ignore console failures
  }
}

async function persistLogEntry(entry) {
  const stored = await chrome.storage.local.get([LOG_KEY]);
  const current = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  const updated = [...current, entry].slice(-LOG_LIMIT);
  await chrome.storage.local.set({ [LOG_KEY]: updated });
}

/**
 * Slovensky: Štruktúrované logovanie s FIFO limitom.
 */
export async function log(level, scope, msg, meta = {}, err) {
  const normalizedLevel = normalizeLevel(level);
  if (!(await shouldLog(normalizedLevel))) {
    return null;
  }
  const entry = {
    ts: Date.now(),
    level: normalizedLevel,
    scope: scope || 'general',
    msg: msg || '',
    meta: sanitizeMeta(meta)
  };
  const serializedError = serializeError(err);
  if (serializedError) {
    entry.err = serializedError;
  }
  try {
    await persistLogEntry(entry);
  } catch (error) {
    console.error('MyChatGPT log failure', error);
  }
  appendToConsole(normalizedLevel, entry.scope, entry.msg, entry);
  return entry;
}

export function logTrace(scope, msg, meta = {}) {
  return log(LogLevel.TRACE, scope, msg, meta);
}

export function logDebug(scope, msg, meta = {}) {
  return log(LogLevel.DEBUG, scope, msg, meta);
}

export function logInfo(scope, msg, meta = {}) {
  return log(LogLevel.INFO, scope, msg, meta);
}

export function logWarn(scope, msg, meta = {}) {
  return log(LogLevel.WARN, scope, msg, meta);
}

export function logError(scope, msg, err, meta = {}) {
  return log(LogLevel.ERROR, scope, msg, meta, err);
}

export async function getLogs() {
  try {
    const stored = await chrome.storage.local.get([LOG_KEY]);
    const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
    return logs;
  } catch (error) {
    console.error('MyChatGPT getLogs failure', error);
    return [];
  }
}

export async function clearLogs() {
  try {
    await chrome.storage.local.set({ [LOG_KEY]: [] });
  } catch (error) {
    console.error('MyChatGPT clearLogs failure', error);
  }
}

export async function tailLogs({ limit = 50, minLevel = LogLevel.TRACE } = {}) {
  const logs = await getLogs();
  const normalizedLevel = normalizeLevel(minLevel);
  const threshold = LEVEL_PRIORITY[normalizedLevel] ?? LEVEL_PRIORITY[LogLevel.TRACE];
  return logs
    .filter((entry) => (LEVEL_PRIORITY[normalizeLevel(entry.level)] ?? LEVEL_PRIORITY[LogLevel.INFO]) >= threshold)
    .slice(-limit);
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
  return Object.keys(meta).length ? meta : null;
}

export function csvToArray(csv) {
  if (!csv) {
    return [];
  }
  return csv
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function arrayToCsv(values) {
  if (!Array.isArray(values)) {
    return '';
  }
  return values.map((value) => String(value).trim()).filter(Boolean).join(',');
}

export function minutesSince(input) {
  if (!input) {
    return Number.POSITIVE_INFINITY;
  }
  const timestamp = typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(timestamp)) {
    return Number.POSITIVE_INFINITY;
  }
  return (Date.now() - timestamp) / 60000;
}

export function uuidv4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback pre staršie prehliadače.
  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return template.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const ALLOWED_TAGS = new Set([
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
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
]);

const GLOBAL_ATTRS = new Set(['class', 'aria-label', 'aria-live', 'role', 'data-language']);
const TAG_ATTRS = {
  a: new Set(['href', 'title', 'rel', 'target']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  code: new Set(['class']),
  pre: new Set(['class']),
  div: new Set(['data-codeblock-language', 'data-language']),
  span: new Set(['data-codeblock-language', 'data-language'])
};

const EMPTY_SET = new Set();

const PATCH_ENDPOINT_PREFIX = '/backend-api/conversation/';
const LEGACY_PATCH_ENDPOINT_PREFIX = '/conversation/';

export function sanitizeHTML(html) {
  if (!html) {
    return '';
  }
  if (typeof DOMParser === 'undefined') {
    return fallbackSanitize(html);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  doc.querySelectorAll('script, style, link, meta, title').forEach((el) => el.remove());

  doc.body.querySelectorAll('*').forEach((element) => {
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      const fragment = doc.createDocumentFragment();
      while (element.firstChild) {
        fragment.appendChild(element.firstChild);
      }
      element.replaceWith(fragment);
      return;
    }

    [...element.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
        element.removeAttribute(attr.name);
        return;
      }
      const allowedForTag = TAG_ATTRS[tag] || EMPTY_SET;
      if (!allowedForTag.has(name) && !GLOBAL_ATTRS.has(name)) {
        element.removeAttribute(attr.name);
        return;
      }
      if (name === 'href' && !isSafeLink(attr.value)) {
        element.removeAttribute(attr.name);
        return;
      }
      if (name === 'src') {
        if (tag === 'img' && !isSafeImageSrc(attr.value)) {
          const alt = element.getAttribute('alt') || '';
          const replacement = doc.createElement('span');
          replacement.textContent = alt;
          element.replaceWith(replacement);
        }
      }
    });
  });

  return doc.body.innerHTML;
}

function isSafeLink(value) {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('?') || trimmed.startsWith('./')) {
    return true;
  }
  try {
    const url = new URL(trimmed, 'https://example.com');
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' || url.protocol === 'tel:') {
      return true;
    }
  } catch (_error) {
    return false;
  }
  return false;
}

function isSafeImageSrc(value) {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('data:image/')) {
    return true;
  }
  try {
    const url = new URL(trimmed, 'https://example.com');
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (_error) {
    return false;
  }
}

function fallbackSanitize(input) {
  return String(input)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+=\"[^\"]*\"/gi, '');
}

export const ReasonCodes = Object.freeze({
  PATCH_OK: 'patch_ok',
  PATCH_BLOCKED_BY_SAFETY: 'patch_blocked_by_safety',
  PATCH_BLOCKED_BY_WHITELIST: 'patch_blocked_by_whitelist',
  PATCH_BLOCKED_BY_RATE_LIMIT: 'patch_blocked_by_rate_limit',
  PATCH_BLOCKED_BY_BATCH_LIMIT: 'patch_blocked_by_batch_limit',
  PATCH_BLOCKED_BY_DUPLICATE: 'patch_blocked_by_duplicate',
  PATCH_BLOCKED_BY_DELETE_LIMIT: 'patch_blocked_by_delete_limit',
  PATCH_BRIDGE_TIMEOUT: 'patch_bridge_timeout',
  PATCH_BRIDGE_ERROR: 'patch_bridge_error',
  PATCH_HTTP_ERROR_PREFIX: 'patch_http_error_',
  UNDO_OK: 'undo_ok',
  UNDO_BLOCKED_BY_SAFETY: 'undo_blocked_by_safety',
  UNDO_BLOCKED_BY_WHITELIST: 'undo_blocked_by_whitelist',
  UNDO_BLOCKED_BY_RATE_LIMIT: 'undo_blocked_by_rate_limit',
  UNDO_BLOCKED_BY_BATCH_LIMIT: 'undo_blocked_by_batch_limit',
  UNDO_BLOCKED_BY_DUPLICATE: 'undo_blocked_by_duplicate',
  UNDO_BLOCKED_BY_DELETE_LIMIT: 'undo_blocked_by_delete_limit',
  UNDO_BRIDGE_TIMEOUT: 'undo_bridge_timeout',
  UNDO_BRIDGE_ERROR: 'undo_bridge_error',
  UNDO_HTTP_ERROR_PREFIX: 'undo_http_error_',
  UNDO_BATCH_COMPLETED: 'undo_batch_completed',
  BRIDGE_CONNECTIVITY_OK: 'bridge_connectivity_ok',
  BRIDGE_CONNECTIVITY_FAILED: 'bridge_connectivity_failed',
  LIVE_BATCH_COMPLETED: 'live_batch_completed'
});

/**
 * Slovensky: Zostaví reason kód pre HTTP odpoveď PATCH požiadavky.
 */
export function buildPatchHttpReason(status) {
  const code = Number.parseInt(status, 10);
  if (!Number.isFinite(code)) {
    return `${ReasonCodes.PATCH_HTTP_ERROR_PREFIX}unknown`;
  }
  return `${ReasonCodes.PATCH_HTTP_ERROR_PREFIX}${code}`;
}

/**
 * Slovensky: Zostaví reason kód pre HTTP odpoveď UNDO PATCH požiadavky.
 */
export function buildUndoHttpReason(status) {
  const code = Number.parseInt(status, 10);
  if (!Number.isFinite(code)) {
    return `${ReasonCodes.UNDO_HTTP_ERROR_PREFIX}unknown`;
  }
  return `${ReasonCodes.UNDO_HTTP_ERROR_PREFIX}${code}`;
}

/**
 * Slovensky: Vráti preferovanú PATCH cestu pre konverzáciu.
 */
export function getPatchEndpoint(convoId) {
  const raw = typeof convoId === 'string' ? convoId.trim() : '';
  if (!raw) {
    return null;
  }
  const encoded = encodeURIComponent(raw);
  return `${PATCH_ENDPOINT_PREFIX}${encoded}`;
}

/**
 * Slovensky: Poskytne zoznam náhradných PATCH ciest (primárna + legacy).
 */
export function getPatchEndpointCandidates(convoId) {
  const preferred = getPatchEndpoint(convoId);
  if (!preferred) {
    return [];
  }
  const legacy = `${LEGACY_PATCH_ENDPOINT_PREFIX}${encodeURIComponent(convoId.trim())}`;
  if (legacy === preferred) {
    return [preferred];
  }
  return [preferred, legacy];
}

/**
 * Slovensky: Jednoduché stopky pre meranie latencie v milisekundách.
 */
export function createStopwatch() {
  const baseNow = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();
  const startedAt = baseNow();
  return {
    startedAt,
    elapsedMs() {
      return baseNow() - startedAt;
    }
  };
}
