/* Slovensky komentar: Pomocne funkcie pre logovanie a praca s FIFO ulozenim. */
const LOG_STORAGE_KEY = 'debug_logs';
const MAX_LOG_RECORDS = 500;

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

globalTarget.Logger = Logger;
