/* Slovensky komentar: Pomocne funkcie pre logovanie a praca s FIFO ulozenim. */
const LOG_STORAGE_KEY = 'debug_logs';
const MAX_LOG_RECORDS = 500;
const SETTINGS_STORAGE_KEY = 'settings_v1';

/* Slovensky komentar: Predvolene nastavenia pre funkcionalitu extension. */
const DEFAULT_SETTINGS = Object.freeze({
  LIST_ONLY: true,
  DRY_RUN: true,
  CONFIRM_BEFORE_DELETE: true,
  AUTO_SCAN: false,
  MAX_MESSAGES: 2,
  USER_MESSAGES_MAX: 2,
  SAFE_URL_PATTERNS: ['/workspaces', '/projects', '/new-project']
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
    ...DEFAULT_SETTINGS,
    SAFE_URL_PATTERNS: [...DEFAULT_SETTINGS.SAFE_URL_PATTERNS]
  };
}

/* Slovensky komentar: Sanitizuje ulozene nastavenia a vrati zoznam opravenych poli. */
function sanitizeSettings(rawSettings) {
  const defaults = cloneDefaultSettings();
  const healedFields = new Set();
  const result = cloneDefaultSettings();

  if (!rawSettings || typeof rawSettings !== 'object') {
    Object.keys(defaults).forEach((key) => healedFields.add(key));
    return { settings: result, healedFields: Array.from(healedFields) };
  }

  const boolFields = ['LIST_ONLY', 'DRY_RUN', 'CONFIRM_BEFORE_DELETE', 'AUTO_SCAN'];
  boolFields.forEach((key) => {
    if (typeof rawSettings[key] === 'boolean') {
      result[key] = rawSettings[key];
    } else {
      healedFields.add(key);
    }
  });

  const intFields = [
    { key: 'MAX_MESSAGES', min: 1 },
    { key: 'USER_MESSAGES_MAX', min: 1 }
  ];
  intFields.forEach(({ key, min }) => {
    const value = rawSettings[key];
    if (Number.isFinite(value) && Number.isInteger(value) && value >= min) {
      result[key] = value;
    } else {
      healedFields.add(key);
    }
  });

  if (Array.isArray(rawSettings.SAFE_URL_PATTERNS) && rawSettings.SAFE_URL_PATTERNS.every((item) => typeof item === 'string')) {
    result.SAFE_URL_PATTERNS = rawSettings.SAFE_URL_PATTERNS.map((item) => item.trim()).filter((item) => item);
    if (!result.SAFE_URL_PATTERNS.length) {
      result.SAFE_URL_PATTERNS = [...defaults.SAFE_URL_PATTERNS];
      healedFields.add('SAFE_URL_PATTERNS');
    }
  } else {
    healedFields.add('SAFE_URL_PATTERNS');
  }

  const healedList = Array.from(healedFields);
  return { settings: result, healedFields: healedList };
}

/* Slovensky komentar: Nacita nastavenia a vykona automaticke opravy. */
async function loadSettings() {
  const stored = await chrome.storage.local.get({ [SETTINGS_STORAGE_KEY]: null });
  const raw = stored[SETTINGS_STORAGE_KEY];
  const { settings, healedFields } = sanitizeSettings(raw);
  if (!raw || healedFields.length) {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  }
  return { settings, healedFields };
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
    return patterns.some((patternRaw) => {
      const pattern = typeof patternRaw === 'string' ? patternRaw.trim() : '';
      if (!pattern) {
        return false;
      }
      if (pattern.includes('://')) {
        return url.startsWith(pattern);
      }
      return pathname.startsWith(pattern);
    });
  } catch (_error) {
    return false;
  }
}

globalTarget.Logger = Logger;
globalTarget.SettingsStore = SettingsStore;
globalTarget.urlMatchesAnyPattern = urlMatchesAnyPattern;
