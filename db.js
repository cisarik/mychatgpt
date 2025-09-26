import { normalizeSettings, SETTINGS_KEY } from './utils.js';

const DB_KEY = 'backups_v2_store';

export async function init() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, DB_KEY]);
  if (!stored?.[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(stored?.[SETTINGS_KEY]) });
  }
  if (!stored?.[DB_KEY]) {
    await chrome.storage.local.set({ [DB_KEY]: {} });
  }
}

export async function getAll() {
  const store = await readStore();
  return Object.values(store).sort((a, b) => {
    const aTime = normalizeTimestamp(a?.createdAt);
    const bTime = normalizeTimestamp(b?.createdAt);
    return (bTime || 0) - (aTime || 0);
  });
}

export async function put(item) {
  if (!item?.convoId) {
    throw new Error('missing_convo_id');
  }
  const store = await readStore();
  const current = store[item.convoId] || {};
  const payload = {
    ...current,
    ...item,
    id: current.id || item.id || item.convoId
  };
  store[item.convoId] = payload;
  await writeStore(store);
  return payload;
}

export async function update(convoId, patch) {
  if (!convoId) {
    return null;
  }
  const store = await readStore();
  const current = store[convoId];
  if (!current) {
    return null;
  }
  const next = { ...current, ...patch };
  store[convoId] = next;
  await writeStore(store);
  return next;
}

async function readStore() {
  const stored = await chrome.storage.local.get([DB_KEY]);
  const map = stored?.[DB_KEY];
  if (map && typeof map === 'object') {
    return { ...map };
  }
  return {};
}

async function writeStore(map) {
  await chrome.storage.local.set({ [DB_KEY]: map });
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}
