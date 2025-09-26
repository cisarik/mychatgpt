/* Slovensky komentar: Inicializacia IndexedDB uloziska pre aplikaciu. */
const DB_NAME = 'mychatgpt-db';
const DB_VERSION = 1;
const STORE_BACKUPS = 'backups';
const STORE_CATEGORIES = 'categories';

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
      await Logger.log('error', 'database', 'IndexedDB initialization failed', { message: error && error.message });
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
