import { uuidv4 } from './utils.js';

const DB_NAME = 'mychatgpt-db';
const DB_VERSION = 2;
const STORE_NAME = 'backups';
const INDEX_CONVO = 'by_convo';
const INDEX_TIMESTAMP = 'by_timestamp';

let dbPromise;

/**
 * Slovensky: Lazne otvorí IndexedDB s migráciami.
 */
export function initDb() {
  if (!dbPromise) {
    dbPromise = openDb();
  }
  return dbPromise;
}

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
      if (!store.indexNames.contains(INDEX_TIMESTAMP)) {
        store.createIndex(INDEX_TIMESTAMP, 'timestamp', { unique: false });
      }
      if (!store.indexNames.contains(INDEX_CONVO)) {
        store.createIndex(INDEX_CONVO, 'convoId', { unique: false });
      }
      if (oldVersion > 0 && db.objectStoreNames.contains('categories')) {
        db.deleteObjectStore('categories');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runReadWrite(db, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    try {
      fn(store, tx);
    } catch (error) {
      tx.abort();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('tx error'));
    tx.onabort = () => reject(tx.error || new Error('tx abort'));
  });
}

function runReadonly(db, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    let result;
    try {
      result = fn(store, tx);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('tx error'));
    tx.onabort = () => reject(tx.error || new Error('tx abort'));
  });
}

function getAll(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function getByKey(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function deleteByKey(store, key) {
  return new Promise((resolve, reject) => {
    const request = store.delete(key);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

function getByIndex(store, indexName, key) {
  if (!store.indexNames.contains(indexName)) {
    return Promise.resolve(null);
  }
  const index = store.index(indexName);
  return new Promise((resolve, reject) => {
    const request = index.get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function mapRecord(input) {
  const createdAt = Number.isFinite(input?.createdAt) ? input.createdAt : Date.now();
  const capturedAt = Number.isFinite(input?.capturedAt) ? input.capturedAt : Date.now();
  const recordId = input?.id || input?.convoId || uuidv4();
  return {
    id: recordId,
    convoId: input?.convoId || '',
    title: input?.title || buildTitle(input?.userPrompt || input?.questionText),
    questionText: input?.userPrompt || input?.questionText || '',
    answerHTML: input?.answerHTML || '',
    timestamp: capturedAt,
    createdAt,
    capturedAt,
    messageCount: Number.isFinite(input?.messageCount) ? input.messageCount : 0,
    url: input?.url || ''
  };
}

function buildTitle(prompt) {
  const text = (prompt || '').trim();
  if (!text) {
    return 'Search backup';
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export const backups = {
  /**
   * Slovensky: Uloží alebo aktualizuje záznam.
   */
  async save(entry) {
    const db = await initDb();
    const record = mapRecord(entry || {});
    await runReadWrite(db, (store) => {
      store.put(record);
    });
    return record;
  },

  /**
   * Slovensky: Vráti všetky záznamy zoradené podľa času.
   */
  async list() {
    const db = await initDb();
    const rows = await runReadonly(db, async (store) => {
      const all = await getAll(store);
      return all;
    });
    return rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  },

  /**
   * Slovensky: Vyhľadá podľa ID.
   */
  async byId(id) {
    if (!id) {
      return null;
    }
    const db = await initDb();
    return runReadonly(db, (store) => getByKey(store, id));
  },

  /**
   * Slovensky: Vyhľadá podľa convoId.
   */
  async byConvoId(convoId) {
    if (!convoId) {
      return null;
    }
    const db = await initDb();
    return runReadonly(db, (store) => getByIndex(store, INDEX_CONVO, convoId));
  },

  /**
   * Slovensky: Odstráni záznam.
   */
  async remove(id) {
    if (!id) {
      return false;
    }
    const db = await initDb();
    await runReadWrite(db, (store) => {
      deleteByKey(store, id);
    });
    return true;
  }
};

