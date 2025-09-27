/* Slovensky komentar: Pomocne funkcie pre logovanie a praca s FIFO ulozenim. */
const LOG_STORAGE_KEY = 'debug_logs';
const MAX_LOG_RECORDS = 500;
const SETTINGS_STORAGE_KEY = 'settings_v1';
const COOLDOWN_STORAGE_KEY = 'cooldown_v1';

/* Slovensky komentar: Predvolene nastavenia pre funkcionalitu extension. */
const REQUIRED_SAFE_URL_PATTERN = 'https://chatgpt.com/c/*';

const DEFAULT_SETTINGS = Object.freeze({
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
  SAFE_URL_PATTERNS: ['/workspaces', '/projects', '/new-project', REQUIRED_SAFE_URL_PATTERN]
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
function normalizeSafeUrlPatterns(strOrArray) {
  /* Slovensky komentar: Normalizuje SAFE_URL vzory (napr. '/workspaces', '/c/*', 'https://chatgpt.com/c/*'). */
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
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
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
  if (rawPatterns !== undefined) {
    const lines = Array.isArray(rawPatterns)
      ? rawPatterns
      : typeof rawPatterns === 'string'
      ? rawPatterns.split(/\r?\n/)
      : [];
    const trimmed = [];
    let flagged = !Array.isArray(rawPatterns);
    lines.forEach((line) => {
      if (typeof line !== 'string') {
        flagged = true;
        return;
      }
      const clean = line.trim();
      if (!clean) {
        if (line) {
          flagged = true;
        }
        return;
      }
      if (clean.startsWith('#')) {
        flagged = true;
        return;
      }
      if (clean !== line) {
        flagged = true;
      }
      trimmed.push(clean);
    });
    const normalized = normalizeSafeUrlPatterns(trimmed);
    if (normalized.length) {
      if (normalized.length !== trimmed.length) {
        flagged = true;
      } else {
        for (let index = 0; index < normalized.length; index += 1) {
          if (normalized[index] !== trimmed[index]) {
            flagged = true;
            break;
          }
        }
      }
      result.SAFE_URL_PATTERNS = normalized;
      if (flagged) {
        healedFields.add('SAFE_URL_PATTERNS');
      }
    } else {
      healedFields.add('SAFE_URL_PATTERNS');
    }
  } else {
    healedFields.add('SAFE_URL_PATTERNS');
  }

  if (!result.SAFE_URL_PATTERNS.length) {
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
  let nextSettings = settings;
  const normalized = normalizeSafeUrlPatterns(nextSettings.SAFE_URL_PATTERNS);
  let mutated = false;
  let addedRequiredPattern = false;
  if (!normalized.includes(REQUIRED_SAFE_URL_PATTERN)) {
    mutated = true;
    addedRequiredPattern = true;
    nextSettings = {
      ...nextSettings,
      SAFE_URL_PATTERNS: [...normalized, REQUIRED_SAFE_URL_PATTERN]
    };
  } else if (normalized.length !== nextSettings.SAFE_URL_PATTERNS.length) {
    mutated = true;
    nextSettings = {
      ...nextSettings,
      SAFE_URL_PATTERNS: normalized
    };
  }
  if (!raw || healedFields.length || mutated) {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: nextSettings });
  }
  if (mutated && !healedFields.includes('SAFE_URL_PATTERNS')) {
    healedFields.push('SAFE_URL_PATTERNS');
  }
  if (mutated) {
    try {
      await Logger.log('info', 'settings', 'SAFE_URL patterns migrated', {
        scope: 'settings',
        before: settings.SAFE_URL_PATTERNS,
        after: nextSettings.SAFE_URL_PATTERNS
      });
    } catch (_logError) {
      /* Slovensky komentar: Ignoruje neuspesne logovanie migracie. */
    }
  }
  return { settings: nextSettings, healedFields, meta: { addedRequiredPattern } };
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
