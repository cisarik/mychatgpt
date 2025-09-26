/* Slovensky komentar: Inicializacia IndexedDB uloziska pre aplikaciu. */
const DB_NAME = 'mychatgpt-db';
const DB_VERSION = 1;
const STORE_BACKUPS = 'backups';
const STORE_CATEGORIES = 'categories';

/* Slovensky komentar: Predvolene kategorie na prvy beh. */
const DEFAULT_CATEGORIES = [
  { id: 'programovanie', name: 'Programovanie' },
  { id: 'kryptomeny', name: 'Kryptomeny' },
  { id: 'hw', name: 'HW' },
  { id: 'zdravie', name: 'Zdravie' }
];

const dbGlobalTarget = typeof self !== 'undefined' ? self : window;
let dbInstance = null;

/* Slovensky komentar: Otvorenie databazy s vytvorenim obchodov. */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      /* Slovensky komentar: Vytvorenie obchodov pri povyseni verzie. */
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_BACKUPS)) {
        const backupsStore = db.createObjectStore(STORE_BACKUPS, { keyPath: 'id' });
        backupsStore.createIndex('byTimestamp', 'timestamp', { unique: false });
        backupsStore.createIndex('byCategory', 'category', { unique: false });
        backupsStore.createIndex('byConvo', 'convoId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CATEGORIES)) {
        db.createObjectStore(STORE_CATEGORIES, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

/* Slovensky komentar: Prevod IndexedDB requestu na Promise. */
function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* Slovensky komentar: Verejna API pre databazu. */
const Database = {
  initDB: async () => {
    if (dbInstance) {
      return dbInstance;
    }
    try {
      const db = await openDatabase();
      return db;
    } catch (error) {
      await Logger.log('error', 'db', 'IndexedDB initialization failed', { message: error && error.message });
      throw error;
    }
  },
  ensureDbWithSeeds: async () => {
    const start = Date.now();
    const db = await Database.initDB();
    let inserted = 0;
    try {
      const transaction = db.transaction([STORE_CATEGORIES], 'readwrite');
      const store = transaction.objectStore(STORE_CATEGORIES);
      const countRequest = store.count();
      const existingCount = await requestAsPromise(countRequest);
      if (existingCount === 0) {
        await Promise.all(
          DEFAULT_CATEGORIES.map(async (category) => {
            const putRequest = store.put(category);
            await requestAsPromise(putRequest);
            inserted += 1;
          })
        );
      }
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      const durationMs = Date.now() - start;
      await Logger.log('info', 'db', 'Category seeding check completed', {
        inserted,
        existingCount,
        durationMs
      });
      return { inserted, existingCount };
    } catch (error) {
      await Logger.log('error', 'db', 'Category seeding failed', { message: error && error.message });
      throw error;
    }
  },
  constants: {
    name: DB_NAME,
    version: DB_VERSION,
    stores: {
      backups: STORE_BACKUPS,
      categories: STORE_CATEGORIES
    }
  }
};

dbGlobalTarget.Database = Database;
