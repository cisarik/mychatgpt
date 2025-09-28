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
  /* Slovensky komentar: Ulozi zaznam o zalohe do IndexedDB. */
  saveBackup: async (record) => {
    try {
      const sanitizedRecord = { ...record };
      const questionTextValid = typeof sanitizedRecord.questionText === 'string'
        ? sanitizedRecord.questionText.trim()
        : '';
      sanitizedRecord.questionText = questionTextValid ? questionTextValid : '(untitled)';
      const categoryValue = typeof sanitizedRecord.category === 'string'
        ? sanitizedRecord.category.trim()
        : '';
      sanitizedRecord.category = categoryValue ? categoryValue : null;
      const db = await Database.initDB();
      const transaction = db.transaction([STORE_BACKUPS], 'readwrite');
      const store = transaction.objectStore(STORE_BACKUPS);
      store.put(sanitizedRecord);
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      await Logger.log('info', 'db', 'Backup persisted', {
        id: sanitizedRecord && sanitizedRecord.id ? sanitizedRecord.id : null,
        timestamp: sanitizedRecord && sanitizedRecord.timestamp ? sanitizedRecord.timestamp : null
      });
      return sanitizedRecord && sanitizedRecord.id ? sanitizedRecord.id : null;
    } catch (error) {
      await Logger.log('error', 'db', 'Backup persist failed', { message: error && error.message });
      throw error;
    }
  },
  /* Slovensky komentar: Vyhlada kategoriu podla ID. */
  getCategoryById: async (id) => {
    if (!id) {
      return null;
    }
    try {
      const db = await Database.initDB();
      return await new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction([STORE_CATEGORIES], 'readonly');
          const store = transaction.objectStore(STORE_CATEGORIES);
          const request = store.get(id);

          request.onsuccess = () => {
            resolve(request.result || null);
          };
          request.onerror = () => {
            reject(request.error);
          };

          transaction.onerror = () => {
            reject(transaction.error);
          };
          transaction.onabort = () => {
            reject(transaction.error);
          };
        } catch (innerError) {
          reject(innerError);
        }
      });
    } catch (error) {
      await Logger.log('error', 'db', 'Lookup category by id failed', { message: error && error.message, id });
      throw error;
    }
  },
  /* Slovensky komentar: Vrati zoznam vsetkych kategorii. */
  getAllCategories: async () => {
    try {
      const db = await Database.initDB();
      return await new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction([STORE_CATEGORIES], 'readonly');
          const store = transaction.objectStore(STORE_CATEGORIES);
          const request = store.getAll();

          request.onsuccess = () => {
            const rows = Array.isArray(request.result) ? request.result : [];
            resolve(rows);
          };
          request.onerror = () => {
            reject(request.error);
          };

          transaction.onerror = () => {
            reject(transaction.error);
          };
          transaction.onabort = () => {
            reject(transaction.error);
          };
        } catch (innerError) {
          reject(innerError);
        }
      });
    } catch (error) {
      await Logger.log('error', 'db', 'Load categories failed', { message: error && error.message });
      throw error;
    }
  },
  /* Slovensky komentar: Najde existujucu zalohu podla convoId. */
  getBackupByConvoId: async (convoId) => {
    if (!convoId) {
      return null;
    }
    try {
      const db = await Database.initDB();
      return await new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction([STORE_BACKUPS], 'readonly');
          const store = transaction.objectStore(STORE_BACKUPS);
          const index = store.index('byConvo');
          const request = index.get(convoId);

          request.onsuccess = () => {
            resolve(request.result || null);
          };
          request.onerror = () => {
            reject(request.error);
          };

          transaction.onerror = () => {
            reject(transaction.error);
          };
          transaction.onabort = () => {
            reject(transaction.error);
          };
        } catch (innerError) {
          reject(innerError);
        }
      });
    } catch (error) {
      await Logger.log('error', 'db', 'Lookup by convoId failed', { message: error && error.message });
      throw error;
    }
  },
  /* Slovensky komentar: Načíta zálohu podľa identifikátora. */
  getBackupById: async (id) => {
    if (!id) {
      return null;
    }
    try {
      const db = await Database.initDB();
      return await new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction([STORE_BACKUPS], 'readonly');
          const store = transaction.objectStore(STORE_BACKUPS);
          const request = store.get(id);

          request.onsuccess = () => {
            resolve(request.result || null);
          };
          request.onerror = () => {
            reject(request.error);
          };

          transaction.onerror = () => {
            reject(transaction.error);
          };
          transaction.onabort = () => {
            reject(transaction.error);
          };
        } catch (innerError) {
          reject(innerError);
        }
      });
    } catch (error) {
      await Logger.log('error', 'db', 'Lookup by id failed', { message: error && error.message });
      throw error;
    }
  },
  /* Slovensky komentar: Ziska najnovsie zalohy obmedzene limitom. */
  getRecentBackups: async (limit = 10) => {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 10;
    try {
      const db = await Database.initDB();
      return await new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction([STORE_BACKUPS], 'readonly');
          const store = transaction.objectStore(STORE_BACKUPS);
          const index = store.index('byTimestamp');
          const request = index.openCursor(null, 'prev');
          const collected = [];

          request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor && collected.length < safeLimit) {
              collected.push(cursor.value);
              cursor.continue();
              return;
            }
            resolve(collected);
          };

          request.onerror = () => {
            reject(request.error);
          };

          transaction.onerror = () => {
            reject(transaction.error);
          };
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      await Logger.log('error', 'db', 'Load recent backups failed', { message: error && error.message });
      throw error;
    }
  },
  /* Slovensky komentar: Vymaze zalohu z uloziska. */
  deleteBackup: async (id) => {
    if (!id) {
      return false;
    }
    try {
      const db = await Database.initDB();
      const transaction = db.transaction([STORE_BACKUPS], 'readwrite');
      const store = transaction.objectStore(STORE_BACKUPS);
      store.delete(id);
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      return true;
    } catch (error) {
      await Logger.log('error', 'db', 'Backup delete failed', { message: error && error.message, id });
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

/* Slovensky komentar: Minimalne API pre jednoduche pouzitie v pohladoch. */
const db = {
  async getBackupById(id) {
    return await Database.getBackupById(id);
  }
};

dbGlobalTarget.Database = Database;
dbGlobalTarget.db = db;
