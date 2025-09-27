/* Slovensky komentar: Pomocne funkcie pre logovanie a praca s FIFO ulozenim. */
const LOG_STORAGE_KEY = 'debug_logs';
const MAX_LOG_RECORDS = 500;
const SETTINGS_STORAGE_KEY = 'settings_v1';
const COOLDOWN_STORAGE_KEY = 'cooldown_v1';

/* Slovensky komentar: Predvolene nastavenia pre funkcionalitu extension. */
const SAFE_URL_DEFAULTS = Object.freeze([
  '/workspaces',
  '/projects',
  '/new-project',
  'https://chatgpt.com/c/*'
]);

const SETTINGS_DEFAULTS = Object.freeze({
  LIST_ONLY: true,
  DRY_RUN: true,
  CONFIRM_BEFORE_DELETE: true,
  AUTO_SCAN: false,
  SHOW_CANDIDATE_BADGE: true,
  MAX_MESSAGES: 2,
  USER_MESSAGES_MAX: 2,
  SCAN_COOLDOWN_MIN: 5,
  MIN_AGE_MINUTES: 2,
  DELETE_LIMIT: 10,
  CAPTURE_ONLY_CANDIDATES: true,
  SAFE_URL_PATTERNS: SAFE_URL_DEFAULTS
});

/* Slovensky komentar: Ziska referenciu na globalny objekt pre rozne prostredia. */
const globalTarget = typeof self !== 'undefined' ? self : window;

/* Slovensky komentar: Bezpecne nacita logy zo storage. */
async function readLogs() {
  try {
    const result = await chrome.storage.local.get({ [LOG_STORAGE_KEY]: [] });
    const logs = Array.isArray(result[LOG_STORAGE_KEY]) ? result[LOG_STORAGE_KEY] : [];
    return logs.slice(-MAX_LOG_RECORDS);
  } catch (error) {
    console.error('Failed to read logs', error);
    return [];
  }
}

/* Slovensky komentar: Zapise log so zachovanim FIFO. */
async function appendLog(level, scope, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    meta: meta === undefined ? null : meta
  };

  const logs = await readLogs();
  logs.push(entry);
  const trimmed = logs.slice(-MAX_LOG_RECORDS);
  await chrome.storage.local.set({ [LOG_STORAGE_KEY]: trimmed });
  return entry;
}

/* Slovensky komentar: Vymaze vsetky logy. */
async function clearLogs() {
  await chrome.storage.local.set({ [LOG_STORAGE_KEY]: [] });
}

/* Slovensky komentar: Vytvori hlboku kopiu predvolenych nastaveni. */
function cloneDefaultSettings() {
  return {
    ...SETTINGS_DEFAULTS,
    SAFE_URL_PATTERNS: [...SAFE_URL_DEFAULTS]
  };
}

/* Slovensky komentar: Porovna dve polia na identitu hodnot. */
function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

/* Slovensky komentar: Sanitizuje ulozene nastavenia a vrati zoznam opravenych poli. */
function normalizeSafeUrlPatterns(strOrArray) {
  /* Slovensky komentar: Normalizuje SAFE_URL vzory a vrati pole bez duplicit. */
  const maxLength = 200;
  const rawItems = Array.isArray(strOrArray)
    ? strOrArray
    : typeof strOrArray === 'string'
    ? strOrArray.split(/\r?\n/)
    : [];
  const seen = new Set();
  const normalized = [];

  rawItems.forEach((rawLine) => {
    if (typeof rawLine !== 'string') {
      return;
    }
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.length > maxLength) {
      return;
    }
    if (seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  });

  return normalized;
}

function sanitizeSettings(rawSettings) {
  const defaults = cloneDefaultSettings();
  const healedFields = new Set();
  const result = cloneDefaultSettings();

  if (!rawSettings || typeof rawSettings !== 'object') {
    Object.keys(defaults).forEach((key) => healedFields.add(key));
    return { settings: result, healedFields: Array.from(healedFields) };
  }

  const boolFields = [
    'LIST_ONLY',
    'DRY_RUN',
    'CONFIRM_BEFORE_DELETE',
    'AUTO_SCAN',
    'CAPTURE_ONLY_CANDIDATES',
    'SHOW_CANDIDATE_BADGE'
  ];
  boolFields.forEach((key) => {
    if (typeof rawSettings[key] === 'boolean') {
      result[key] = rawSettings[key];
    } else {
      healedFields.add(key);
    }
  });

  const intFields = [
    { key: 'MAX_MESSAGES', min: 1 },
    { key: 'USER_MESSAGES_MAX', min: 1 },
    { key: 'SCAN_COOLDOWN_MIN', min: 1 },
    { key: 'MIN_AGE_MINUTES', min: 0 },
    { key: 'DELETE_LIMIT', min: 1 }
  ];
  intFields.forEach(({ key, min }) => {
    const value = rawSettings[key];
    if (Number.isFinite(value) && Number.isInteger(value) && value >= min) {
      result[key] = value;
    } else {
      healedFields.add(key);
    }
  });

  const rawPatterns = rawSettings.SAFE_URL_PATTERNS;
  const normalizedPatterns = normalizeSafeUrlPatterns(rawPatterns);
  if (normalizedPatterns.length > 0) {
    result.SAFE_URL_PATTERNS = normalizedPatterns;
    const sameArray = Array.isArray(rawPatterns)
      && rawPatterns.length === normalizedPatterns.length
      && rawPatterns.every((value, index) => value === normalizedPatterns[index]);
    if (!sameArray) {
      healedFields.add('SAFE_URL_PATTERNS');
    }
  } else {
    result.SAFE_URL_PATTERNS = [...defaults.SAFE_URL_PATTERNS];
    healedFields.add('SAFE_URL_PATTERNS');
  }

  const healedList = Array.from(healedFields);
  return { settings: result, healedFields: healedList };
}

/* Slovensky komentar: Vypocita, ci este plati cooldown interval. */
function shouldCooldown(lastMs, minutes) {
  if (!Number.isFinite(lastMs) || !Number.isFinite(minutes) || minutes <= 0) {
    return { cooldown: false, remainingMs: 0 };
  }
  const now = Date.now();
  const intervalMs = minutes * 60 * 1000;
  const elapsed = now - lastMs;
  if (elapsed >= intervalMs) {
    return { cooldown: false, remainingMs: 0 };
  }
  const remainingMs = Math.max(0, intervalMs - elapsed);
  return { cooldown: true, remainingMs };
}

/* Slovensky komentar: Nacita nastavenia a vykona automaticke opravy. */
async function loadSettings() {
  const stored = await chrome.storage.local.get({ [SETTINGS_STORAGE_KEY]: null });
  const raw = stored[SETTINGS_STORAGE_KEY];
  const { settings, healedFields } = sanitizeSettings(raw);
  const normalizedPatterns = normalizeSafeUrlPatterns(settings.SAFE_URL_PATTERNS);
  const normalizedChanged = !arraysEqual(normalizedPatterns, settings.SAFE_URL_PATTERNS);
  const nextSettings = {
    ...settings,
    SAFE_URL_PATTERNS: normalizedChanged ? normalizedPatterns : settings.SAFE_URL_PATTERNS
  };
  const shouldPersist = !raw || healedFields.length > 0 || normalizedChanged;
  if (normalizedChanged && !healedFields.includes('SAFE_URL_PATTERNS')) {
    healedFields.push('SAFE_URL_PATTERNS');
  }
  if (shouldPersist) {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: nextSettings });
  }
  return { settings: nextSettings, healedFields, meta: { normalizedSafePatterns: normalizedChanged } };
}

/* Slovensky komentar: Ulozi nastavenia po sanitizacii a vrati pripadne opravy. */
async function persistSettings(nextSettings) {
  const { settings, healedFields } = sanitizeSettings(nextSettings);
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  return { settings, healedFields };
}

/* Slovensky komentar: Exporty pre ostatne casti aplikacie. */
const Logger = {
  log: appendLog,
  getLogs: readLogs,
  clear: clearLogs,
  constants: {
    storageKey: LOG_STORAGE_KEY,
    maxRecords: MAX_LOG_RECORDS
  }
};

/* Slovensky komentar: Pomocna vrstva pre pracu s nastaveniami. */
const SettingsStore = {
  key: SETTINGS_STORAGE_KEY,
  defaults: () => cloneDefaultSettings(),
  sanitize: sanitizeSettings,
  load: loadSettings,
  save: persistSettings
};

/* Slovensky komentar: Overi, ci URL zodpoveda niektoremu z povolenych patternov. */
function urlMatchesAnyPattern(url, patterns) {
  if (!url || !Array.isArray(patterns) || !patterns.length) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || '/';
    const normalized = normalizeSafeUrlPatterns(patterns);
    if (!normalized.length) {
      return false;
    }
    return normalized.some((pattern) => {
      if (pattern.startsWith('http://') || pattern.startsWith('https://')) {
        /* Slovensky komentar: Povoluje iba suffix glob, napr. https://chatgpt.com/c/*. */
        if (!pattern.includes('*')) {
          return url === pattern;
        }
        if (!pattern.endsWith('*') || pattern.indexOf('*') !== pattern.length - 1) {
          return false;
        }
        const prefix = pattern.slice(0, -1);
        return prefix ? url.startsWith(prefix) : false;
      }
      if (pattern.startsWith('/')) {
        /* Slovensky komentar: Porovná substring na pathname, napr. /workspaces. */
        return pathname.includes(pattern);
      }
      /* Slovensky komentar: Zanechá podporu zdedených hodnot ako substring na pathname. */
      return pathname.includes(pattern);
    });
  } catch (_error) {
    return false;
  }
}

globalTarget.Logger = Logger;
globalTarget.SettingsStore = SettingsStore;
globalTarget.urlMatchesAnyPattern = urlMatchesAnyPattern;
globalTarget.normalizeSafeUrlPatterns = normalizeSafeUrlPatterns;
globalTarget.shouldCooldown = shouldCooldown;
globalTarget.COOLDOWN_STORAGE_KEY = COOLDOWN_STORAGE_KEY;
globalTarget.SAFE_URL_DEFAULTS = SAFE_URL_DEFAULTS;
globalTarget.SETTINGS_DEFAULTS = SETTINGS_DEFAULTS;
