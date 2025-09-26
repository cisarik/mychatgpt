const LOG_KEY = 'search_cleaner_logs';
const LOG_LIMIT = 150;

export const SETTINGS_KEY = 'search_cleaner_settings';

export const DeletionStrategyIds = Object.freeze({
  MANUAL_OPEN: 'manual-open',
  UI_AUTOMATION: 'ui-automation'
});

export const LogLevel = Object.freeze({
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
});

export const DEFAULT_SETTINGS = Object.freeze({
  debugLogs: false,
  maxMessageCount: 2,
  maxAgeMinutes: 10,
  maxPromptLength: 280,
  maxAnswerLength: 3600,
  batchSize: 5,
  deletionStrategyId: DeletionStrategyIds.MANUAL_OPEN
});

let debugCache = false;
let debugReady = false;
let debugWaiter = null;

/**
 * @typedef {Object} HeuristicsConfig
 * @property {number} maxMessageCount
 * @property {number} maxAgeMinutes
 * @property {number} maxPromptLength
 * @property {number} maxAnswerLength
 */

/**
 * @typedef {Object} BackupItem
 * @property {string} id
 * @property {string} convoId
 * @property {string} title
 * @property {string} userPrompt
 * @property {string} answerHTML
 * @property {number} createdAt
 * @property {number} capturedAt
 * @property {number} messageCount
 * @property {string} url
 */

/**
 * @typedef {Object} DeletionReport
 * @property {string} strategyId
 * @property {number} attempted
 * @property {number} opened
 * @property {string[]} notes
 */

/**
 * @typedef {Object} DeletionStrategy
 * @property {'manual-open'|'ui-automation'} id
 * @property {() => Promise<boolean>} isAvailable
 * @property {(urls: string[]) => Promise<DeletionReport>} deleteMany
 */

/**
 * Slovensky: Zabezpečí načítanie debug flagu z chrome.storage.
 * @returns {Promise<boolean>}
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
      debugCache = Boolean(settings.debugLogs);
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
    debugCache = Boolean(nextValue.debugLogs);
    debugReady = true;
  });
}

/**
 * Slovensky: Normalizuje nastavenia podľa DEFAULT_SETTINGS.
 * @param {Partial<DEFAULT_SETTINGS>} raw
 * @returns {{debugLogs:boolean,maxMessageCount:number,maxAgeMinutes:number,maxPromptLength:number,maxAnswerLength:number,batchSize:number,deletionStrategyId:string}}
 */
export function normalizeSettings(raw) {
  const base = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  const result = { ...base };
  if (typeof raw.debugLogs === 'boolean') {
    result.debugLogs = raw.debugLogs;
  }
  if (Number.isFinite(raw.maxMessageCount)) {
    result.maxMessageCount = clampInt(raw.maxMessageCount, 1, 6);
  }
  if (Number.isFinite(raw.maxAgeMinutes)) {
    result.maxAgeMinutes = clampInt(raw.maxAgeMinutes, 1, 60);
  }
  if (Number.isFinite(raw.maxPromptLength)) {
    result.maxPromptLength = clampInt(raw.maxPromptLength, 40, 2000);
  }
  if (Number.isFinite(raw.maxAnswerLength)) {
    result.maxAnswerLength = clampInt(raw.maxAnswerLength, 200, 12000);
  }
  if (Number.isFinite(raw.batchSize)) {
    result.batchSize = clampInt(raw.batchSize, 1, 10);
  }
  if (typeof raw.deletionStrategyId === 'string' && Object.values(DeletionStrategyIds).includes(raw.deletionStrategyId)) {
    result.deletionStrategyId = raw.deletionStrategyId;
  }
  return result;
}

/**
 * Slovensky: Posúdi kandidáta podľa heuristík.
 * @param {object} summary
 * @param {HeuristicsConfig} settings
 * @returns {{allowed:boolean,reasons:string[],settings:HeuristicsConfig}}
 */
export function passesHeuristics(summary, settings) {
  const normalized = normalizeSettings(settings);
  if (!summary || typeof summary !== 'object') {
    return { allowed: false, reasons: ['invalid_summary'], settings: normalized };
  }
  const reasons = [];
  const messageCount = Number.isFinite(summary.messageCount) ? summary.messageCount : 0;
  if (messageCount > normalized.maxMessageCount) {
    reasons.push('too_many_messages');
  }
  const promptLength = (summary.userPrompt || '').trim().length;
  if (promptLength === 0) {
    reasons.push('empty_prompt');
  }
  if (promptLength > normalized.maxPromptLength) {
    reasons.push('prompt_too_long');
  }
  const answerLength = countAnswerLength(summary.answerHTML || summary.firstAnswerHTML || '');
  if (answerLength === 0) {
    reasons.push('empty_answer');
  }
  if (answerLength > normalized.maxAnswerLength) {
    reasons.push('answer_too_long');
  }
  const createdAt = Number.isFinite(summary.createdAt) ? summary.createdAt : Date.now();
  const capturedAt = Number.isFinite(summary.capturedAt) ? summary.capturedAt : Date.now();
  const ageMinutes = Math.max(0, (capturedAt - createdAt) / 60000);
  if (ageMinutes > normalized.maxAgeMinutes) {
    reasons.push('too_old');
  }
  if (Array.isArray(summary.attachments) && summary.attachments.length) {
    reasons.push('has_attachments');
  }
  return { allowed: reasons.length === 0, reasons, settings: normalized };
}

/**
 * Slovensky: Sanitizuje HTML odpovede.
 * @param {string} input
 * @returns {string}
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
  const allowedTags = new Set(['a', 'article', 'blockquote', 'br', 'code', 'div', 'em', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'li', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
  const globalAttrs = new Set(['class', 'aria-label', 'role', 'data-language']);
  const perTagAttrs = { a: new Set(['href', 'title', 'rel', 'target']), img: new Set(['src', 'alt', 'title']) };
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

/**
 * Slovensky: Normalizuje URL konverzácie.
 * @param {string} url
 * @returns {string|null}
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
 * Slovensky: Z URL vytiahne ID konverzácie.
 * @param {string} url
 * @returns {string|null}
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
 * Slovensky: Zapíše log do kruhového bufferu ak sú debug logy povolené.
 * @param {LogLevel[keyof LogLevel]} level
 * @param {string} scope
 * @param {string} message
 * @param {unknown} meta
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
    console.warn('Search Cleaner log store failed', error);
  }
  return entry;
}

/**
 * Slovensky: Načíta logy z kruhového bufferu.
 * @returns {Promise<Array>}
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
 * Slovensky: Vymaže logy.
 * @returns {Promise<void>}
 */
export async function clearLogs() {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}

/**
 * Slovensky: Krátka pomocná pauza.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

/**
 * Slovensky: Vytvorí stratégiu ručného otvárania kariet.
 * @param {(url: string) => Promise<void>} opener
 * @returns {DeletionStrategy}
 */
export function createManualOpenStrategy(opener) {
  return {
    id: DeletionStrategyIds.MANUAL_OPEN,
    async isAvailable() {
      return true;
    },
    async deleteMany(urls) {
      const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
      let opened = 0;
      for (const url of list) {
        await opener(url);
        opened += 1;
      }
      return {
        strategyId: DeletionStrategyIds.MANUAL_OPEN,
        attempted: list.length,
        opened,
        notes: opened < list.length ? ['some_tabs_blocked'] : []
      };
    }
  };
}

/**
 * Slovensky: Placeholder pre budúci riskantný mód.
 * @returns {DeletionStrategy}
 */
export function createDisabledAutomationStrategy() {
  return {
    id: DeletionStrategyIds.UI_AUTOMATION,
    async isAvailable() {
      return false;
    },
    async deleteMany() {
      // TODO(ui-automation): locate kebab menu → open delete → confirm → wait for removal.
      throw new Error('UI automation strategy not enabled');
    }
  };
}

/**
 * Slovensky: Generuje jednoduché UUID v4.
 * @returns {string}
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

/** Slovensky: Vyholí meta objekt z undefined hodnôt. */
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

/** Slovensky: Orezáva číslo na celé v danom intervale. */
function clampInt(value, min, max) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) {
    return min;
  }
  return Math.min(max, Math.max(min, parsed));
}

/** Slovensky: Rezerva na sanitizáciu keď DOMParser nie je dostupný. */
function fallbackSanitize(value) {
  return String(value)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '');
}

/** Slovensky: Overí, či je link povolený. */
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

/** Slovensky: Overí, či je img zdroj bezpečný. */
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

/** Slovensky: Spočíta dĺžku odpovede bez HTML. */
function countAnswerLength(html) {
  const stripped = stripHtml(String(html));
  return stripped.length;
}

/** Slovensky: Odstráni HTML tagy pre heuristiky. */
function stripHtml(value) {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

