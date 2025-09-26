import { normalizeSettings, SETTINGS_KEY, log } from './utils.js';

const DB_KEY = 'backups_v2_store';

export async function init() {
  const existing = await chrome.storage.local.get([SETTINGS_KEY]);
  if (!existing?.[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings() });
  }
}

export async function getAll() {
  const store = await readStore();
  return Object.values(store).sort((a, b) => {
    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

export async function getMany(ids) {
  const wanted = new Set(ids || []);
  if (!wanted.size) {
    return [];
  }
  const store = await readStore();
  return Object.values(store).filter((item) => wanted.has(item.convoId));
}

export async function put(item) {
  if (!item?.convoId) {
    throw new Error('missing_convo_id');
  }
  const store = await readStore();
  const payload = { ...item, id: item.id || item.convoId };
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
  log('DB updated', Object.keys(map).length);
}
