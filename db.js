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
  const messageCountFallback = Number.isFinite(input.messageCount)
    ? input.messageCount
    : Number.isFinite(existing?.messageCount)
    ? existing.messageCount
    : 0;
  const counts = normalizeCountsRecord(input.counts, existing?.counts, {
    userPrompt: input.userPrompt || existing?.userPrompt || '',
    answerHTML: input.answerHTML || existing?.answerHTML || '',
    messageCount: messageCountFallback
  });
  const messageCount = counts.user + counts.assistant;
  return {
    id: recordId,
    convoId: input.convoId || existing?.convoId || '',
    title: buildTitle(titleSource),
    userPrompt: input.userPrompt || existing?.userPrompt || '',
    answerHTML: input.answerHTML || existing?.answerHTML || '',
    createdAt,
    capturedAt,
    messageCount,
    counts,
    url: input.url || existing?.url || '',
    lastDeletionAttemptAt: Number.isFinite(input.lastDeletionAttemptAt)
      ? input.lastDeletionAttemptAt
      : Number.isFinite(existing?.lastDeletionAttemptAt)
      ? existing.lastDeletionAttemptAt
      : null,
    lastDeletionOutcome: normalizeDeletionOutcome(input.lastDeletionOutcome, existing?.lastDeletionOutcome),
    lastDeletionReason: normalizeDeletionText(input.lastDeletionReason, existing?.lastDeletionReason),
    lastDeletionEvidence: normalizeDeletionText(input.lastDeletionEvidence, existing?.lastDeletionEvidence, 120),
    eligible: normalizeEligibility(input.eligible, existing?.eligible),
    eligibilityReason: normalizeEligibilityReason(input.eligibilityReason, existing?.eligibilityReason)
  };
}

/** Slovensky: Normalizuje flag eligibility na tri-stavový boolean. */
function normalizeEligibility(nextValue, existingValue) {
  if (typeof nextValue === 'boolean') {
    return nextValue;
  }
  if (existingValue === true || existingValue === false) {
    return existingValue;
  }
  return null;
}

/** Slovensky: Normalizuje text dôvodu neeligibility. */
function normalizeEligibilityReason(nextValue, existingValue) {
  if (typeof nextValue === 'string' && nextValue.trim()) {
    return nextValue.trim();
  }
  if (typeof existingValue === 'string' && existingValue.trim()) {
    return existingValue.trim();
  }
  return null;
}

/** Slovensky: Zlúči počty turnov z nového aj starého záznamu. */
function normalizeCountsRecord(currentCounts, existingCounts, context) {
  const pick = (role) => {
    const sources = [currentCounts, existingCounts];
    for (const source of sources) {
      if (source && Number.isFinite(source[role])) {
        const floored = Math.floor(source[role]);
        if (floored <= 0) {
          return 0;
        }
        if (floored >= 1) {
          return 1;
        }
      }
    }
    return null;
  };
  let user = pick('user');
  let assistant = pick('assistant');
  const promptText = String(context?.userPrompt || '').trim();
  const answerHtml = String(context?.answerHTML || '').trim();
  const messageCount = Number.isFinite(context?.messageCount) ? Math.max(0, Math.floor(context.messageCount)) : 0;
  if (user === null) {
    if (promptText) {
      user = 1;
    } else if (messageCount >= 1) {
      user = 1;
    } else {
      user = 0;
    }
  }
  if (assistant === null) {
    if (answerHtml) {
      assistant = 1;
    } else if (messageCount >= 2) {
      assistant = 1;
    } else {
      assistant = 0;
    }
  }
  return {
    user,
    assistant
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
   * Slovensky: Aktualizuje meta údaje o poslednom mazacom pokuse.
   * @param {string} convoId
 * @param {{lastDeletionAttemptAt?: number|null,lastDeletionOutcome?: any,lastDeletionReason?: any,lastDeletionEvidence?: any}} meta
 * @returns {Promise<import('./utils.js').BackupItem|null>}
 */
  async updateDeletionMeta(convoId, meta) {
    if (!convoId || !meta) {
      return null;
}

function normalizeDeletionOutcome(nextValue, existingValue) {
  const candidates = [nextValue, existingValue];
  for (const value of candidates) {
    if (value === 'ok' || value === 'fail') {
      return value;
    }
  }
  return null;
}

function normalizeDeletionText(nextValue, existingValue, limit = 160) {
  const normalize = (value) => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
  };
  return normalize(nextValue) ?? normalize(existingValue);
}
    const db = await initDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index(INDEX_CONVO);
    const existing = await requestToPromise(index.get(convoId));
    if (!existing) {
      await txDone(tx);
      return null;
    }
    const record = mapRecord({ ...existing, ...meta }, existing);
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
