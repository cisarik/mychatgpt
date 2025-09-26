import { uuidv4 } from './utils.js';

const DB_NAME = 'search-cleaner-db';
const DB_VERSION = 2;
const STORE_NAME = 'backups';
const INDEX_CONVO = 'by_convo';
const INDEX_CAPTURED = 'by_captured';

let dbPromise = null;

/**
 * Slovensky: Inicializuje IndexedDB a vráti reťazec pripravený na ďalšie volania.
 * @returns {Promise<IDBDatabase>}
 */
export function initDb() {
  if (!dbPromise) {
    dbPromise = openDb();
  }
  return dbPromise;
}

/** Slovensky: Otvorí IndexedDB s potrebnými upgrade krokmi. */
async function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion || 0;
      let store;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      } else {
        store = request.transaction.objectStore(STORE_NAME);
      }
      ensureIndex(store, INDEX_CONVO, 'convoId');
      ensureIndex(store, INDEX_CAPTURED, 'capturedAt');
      if (oldVersion < 2) {
        migrateV1ToV2(store);
      }
      if (db.objectStoreNames.contains('categories')) {
        db.deleteObjectStore('categories');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Slovensky: Zabezpečí existenciu indexu. */
function ensureIndex(store, indexName, keyPath) {
  if (!store.indexNames.contains(indexName)) {
    store.createIndex(indexName, keyPath, { unique: false });
  }
}

/** Slovensky: Minimálne migruje staré záznamy v1 na v2. */
function migrateV1ToV2(store) {
  try {
    const rows = store.getAll();
    rows.onsuccess = () => {
      const all = Array.isArray(rows.result) ? rows.result : [];
      all.forEach((record) => {
        if (!record) {
          return;
        }
        if (!record.capturedAt && record.timestamp) {
          record.capturedAt = record.timestamp;
        }
        if (!record.title && record.userPrompt) {
          record.title = buildTitle(record.userPrompt);
        }
        store.put(record);
      });
    };
  } catch (_error) {
    // Migrácia je best-effort; ak zlyhá, pokračujeme s novými záznamami.
  }
}

/** Slovensky: Vráti promis pre dokončenie transakcie. */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
  });
}

/** Slovensky: Zabalí IDB request do Promise. */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Slovensky: Normalizuje dáta záznamu zálohy. */
function mapRecord(input = {}, existing = null) {
  const createdAt = Number.isFinite(input.createdAt) ? input.createdAt : Number.isFinite(existing?.createdAt) ? existing.createdAt : Date.now();
  const capturedAt = Number.isFinite(input.capturedAt) ? input.capturedAt : Number.isFinite(existing?.capturedAt) ? existing.capturedAt : Date.now();
  const recordId = existing?.id || input.id || input.convoId || uuidv4();
  const titleSource = input.title || existing?.title || input.userPrompt || existing?.userPrompt || '';
  return {
    id: recordId,
    convoId: input.convoId || existing?.convoId || '',
    title: buildTitle(titleSource),
    userPrompt: input.userPrompt || existing?.userPrompt || '',
    answerHTML: input.answerHTML || existing?.answerHTML || '',
    createdAt,
    capturedAt,
    messageCount: Number.isFinite(input.messageCount) ? input.messageCount : Number.isFinite(existing?.messageCount) ? existing.messageCount : 0,
    url: input.url || existing?.url || ''
  };
}

/** Slovensky: Vyrobí krátky titulok zo zadania. */
function buildTitle(prompt) {
  const text = (prompt || '').trim();
  if (!text) {
    return 'Search backup';
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export const backups = {
  /**
   * Slovensky: Uloží alebo aktualizuje záznam podľa convoId.
   * @param {import('./utils.js').BackupItem|object} entry
   * @returns {Promise<import('./utils.js').BackupItem>}
   */
  async save(entry) {
    if (!entry || !entry.convoId) {
      throw new Error('missing_convoId');
    }
    const db = await initDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index(INDEX_CONVO);
    const existing = await requestToPromise(index.get(entry.convoId));
    const record = mapRecord(entry, existing);
    store.put({ ...record, timestamp: record.capturedAt });
    await txDone(tx);
    return record;
  },

  /**
   * Slovensky: Vráti všetky zálohy zoradené podľa času zachytenia.
   * @returns {Promise<import('./utils.js').BackupItem[]>}
   */
  async list() {
    const db = await initDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    const rows = await requestToPromise(request);
    await txDone(tx);
    return (rows || []).map((item) => mapRecord(item, item)).sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
  },

  /**
   * Slovensky: Nájde zálohu podľa ID.
   * @param {string} id
   * @returns {Promise<import('./utils.js').BackupItem|null>}
   */
  async byId(id) {
    if (!id) {
      return null;
    }
    const db = await initDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const record = await requestToPromise(store.get(id));
    await txDone(tx);
    return record ? mapRecord(record, record) : null;
  },

  /**
   * Slovensky: Nájde zálohu podľa convoId.
   * @param {string} convoId
   * @returns {Promise<import('./utils.js').BackupItem|null>}
   */
  async byConvoId(convoId) {
    if (!convoId) {
      return null;
    }
    const db = await initDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index(INDEX_CONVO);
    const record = await requestToPromise(index.get(convoId));
    await txDone(tx);
    return record ? mapRecord(record, record) : null;
  },

  /**
   * Slovensky: Odstráni zálohu podľa ID.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    if (!id) {
      return false;
    }
    const db = await initDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    await txDone(tx);
    return true;
  }
};

