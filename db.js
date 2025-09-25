import { uuidv4 } from './utils.js';

const DB_NAME = 'mychatgpt-db';
const DB_VERSION = 1;
const CATEGORY_SEEDS = ['Programovanie', 'Kryptomeny', 'HW', 'Zdravie'];

let dbPromise;
let seeded = false;

export function initDb() {
  if (!dbPromise) {
    dbPromise = openDb();
  }
  return dbPromise;
}

async function openDb() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('backups')) {
        const backups = database.createObjectStore('backups', { keyPath: 'id' });
        backups.createIndex('by_timestamp', 'timestamp', { unique: false });
        backups.createIndex('by_title', 'title', { unique: false });
        backups.createIndex('by_question', 'questionText', { unique: false });
        backups.createIndex('by_category', 'category', { unique: false });
      }
      if (!database.objectStoreNames.contains('categories')) {
        const categories = database.createObjectStore('categories', { keyPath: 'id' });
        categories.createIndex('by_name', 'name', { unique: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!seeded) {
    await seedCategories(db);
    seeded = true;
  }

  return db;
}

async function seedCategories(db) {
  const existing = await getAll(db, 'categories');
  const names = new Set(existing.map((item) => item.name));
  const missing = CATEGORY_SEEDS.filter((name) => !names.has(name));
  if (missing.length === 0) {
    return;
  }
  await runWrite(db, 'categories', (store) => {
    missing.forEach((name) => {
      store.put({ id: uuidv4(), name });
    });
  });
}

function runWrite(db, storeName, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    fn(store, tx);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function getByKey(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function deleteByKey(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  });
}

export const backups = {
  async add(entry) {
    const db = await initDb();
    const record = {
      id: entry.id || uuidv4(),
      title: entry.title || 'Untitled backup',
      questionText: entry.questionText || '',
      answerHTML: entry.answerHTML || '',
      timestamp: entry.timestamp || Date.now(),
      category: entry.category || CATEGORY_SEEDS[0],
      convoId: entry.convoId || ''
    };
    await runWrite(db, 'backups', (store) => {
      store.put(record);
    });
    return record.id;
  },

  async get() {
    const db = await initDb();
    const all = await getAll(db, 'backups');
    return all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  },

  async byId(id) {
    const db = await initDb();
    return getByKey(db, 'backups', id);
  },

  async delete(id) {
    const db = await initDb();
    return deleteByKey(db, 'backups', id);
  }
};

export const categories = {
  async list() {
    const db = await initDb();
    const all = await getAll(db, 'categories');
    return all.sort((a, b) => a.name.localeCompare(b.name));
  },

  async add(name) {
    const db = await initDb();
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Name required');
    }
    const record = { id: uuidv4(), name: trimmed };
    await runWrite(db, 'categories', (store) => {
      store.add(record);
    });
    return record;
  },

  async rename(id, nextName) {
    const db = await initDb();
    const trimmed = nextName.trim();
    if (!trimmed) {
      throw new Error('Name required');
    }
    const existing = await getByKey(db, 'categories', id);
    if (!existing) {
      throw new Error('Category not found');
    }
    await runWrite(db, 'categories', (store) => {
      store.put({ ...existing, name: trimmed });
    });
    return true;
  },

  async delete(id) {
    const db = await initDb();
    return deleteByKey(db, 'categories', id);
  }
};
