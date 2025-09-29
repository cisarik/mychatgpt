/* Slovensky komentar: Servisny worker inicializuje databazu, nastavenia a obsluhuje stub skenovania. */
importScripts('utils.js', 'db.js');

/* Slovensky komentar: Nazov storage kluca pre cooldown je zdieľaný cez utils. */
const COOLDOWN_KEY = typeof COOLDOWN_STORAGE_KEY !== 'undefined' ? COOLDOWN_STORAGE_KEY : 'cooldown_v1';
/* Slovensky komentar: Limit na velkost HTML odpovede pre zalohu. */
const MAX_ANSWER_BYTES = 250 * 1024;
/* Slovensky komentar: Predvolene timeouty pre UI mazanie. */
const UI_DELETE_TIMEOUTS = Object.freeze({
  sidebar: 1500,
  menu: 1200,
  confirm: 1500,
  verify: 1500
});
/* Slovensky komentar: Pocet opakovani pre jednotlive kroky. */
const UI_DELETE_RETRIES = 2;

/* Slovensky komentar: Vrati hlboku kopiu predvolenych nastaveni. */
function createDefaultSettingsSnapshot() {
  const base = typeof SETTINGS_DEFAULTS === 'object' && SETTINGS_DEFAULTS
    ? SETTINGS_DEFAULTS
    : {
        LIST_ONLY: true,
        DRY_RUN: true,
        CONFIRM_BEFORE_DELETE: true,
        AUTO_SCAN: false,
        SHOW_CANDIDATE_BADGE: true,
        MAX_MESSAGES: 2,
        USER_MESSAGES_MAX: 2,
        SCAN_COOLDOWN_MIN: 5,
        MIN_AGE_MINUTES: 2,
        DELETE_LIMIT: 10,
        CAPTURE_ONLY_CANDIDATES: true,
        verboseConsole: true,
        miniWindow: false,
        autoOffer: true,
        deleteBatchLimit: 5,
        searchHintDelayMs: 2500,
        SAFE_URL_PATTERNS: [
          '/workspaces',
          '/projects',
          '/new-project',
          'https://chatgpt.com/c/*'
        ]
      };
  const safePatterns = Array.isArray(base.SAFE_URL_PATTERNS) ? base.SAFE_URL_PATTERNS : [];
  return {
    ...base,
    SAFE_URL_PATTERNS: [...safePatterns]
  };
}

/* Slovensky komentar: Ziska platnu aktivnu kategoriu zo storage ak existuje. */
async function resolveActiveCategoryId() {
  try {
    const resolved = await Database.getActiveCategoryId();
    return resolved || null;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    await Logger.log('warn', 'settings', 'Active category resolve failed', { message });
    return null;
  }
}

/* Slovensky komentar: Ziska cerstve nastavenia zo storage bez cache. */
async function getSettingsFresh() {
  const defaults = createDefaultSettingsSnapshot();
  try {
    const stored = await chrome.storage.local.get('settings_v1');
    const raw = stored && typeof stored.settings_v1 === 'object' ? stored.settings_v1 : null;
    if (!raw) {
      return defaults;
    }
    if (typeof SettingsStore === 'object' && typeof SettingsStore.sanitize === 'function') {
      const { settings } = SettingsStore.sanitize(raw);
      const sanitized = {
        ...defaults,
        ...settings
      };
      const normalizedPatterns = typeof normalizeSafeUrlPatterns === 'function'
        ? normalizeSafeUrlPatterns(settings.SAFE_URL_PATTERNS)
        : sanitized.SAFE_URL_PATTERNS;
      sanitized.SAFE_URL_PATTERNS = Array.isArray(normalizedPatterns) && normalizedPatterns.length
        ? normalizedPatterns
        : [...defaults.SAFE_URL_PATTERNS];
      return sanitized;
    }
    const merged = {
      ...defaults,
      ...raw
    };
    [
      'LIST_ONLY',
      'DRY_RUN',
      'CONFIRM_BEFORE_DELETE',
      'AUTO_SCAN',
      'SHOW_CANDIDATE_BADGE',
      'CAPTURE_ONLY_CANDIDATES',
      'verboseConsole',
      'miniWindow',
      'autoOffer'
    ].forEach((key) => {
      if (typeof raw[key] === 'boolean') {
        merged[key] = raw[key];
      } else {
        merged[key] = defaults[key];
      }
    });
    [
      { key: 'MAX_MESSAGES', min: 1 },
      { key: 'USER_MESSAGES_MAX', min: 1 },
      { key: 'SCAN_COOLDOWN_MIN', min: 1 },
      { key: 'MIN_AGE_MINUTES', min: 0 },
      { key: 'DELETE_LIMIT', min: 1 },
      { key: 'deleteBatchLimit', min: 1 },
      { key: 'searchHintDelayMs', min: 0 }
    ].forEach(({ key, min }) => {
      const value = Number(raw[key]);
      merged[key] = Number.isFinite(value) && value >= min ? Math.floor(value) : defaults[key];
    });
    const normalizedPatterns = typeof normalizeSafeUrlPatterns === 'function'
      ? normalizeSafeUrlPatterns(raw.SAFE_URL_PATTERNS ?? merged.SAFE_URL_PATTERNS)
      : merged.SAFE_URL_PATTERNS;
    merged.SAFE_URL_PATTERNS = Array.isArray(normalizedPatterns) && normalizedPatterns.length
      ? normalizedPatterns
      : [...defaults.SAFE_URL_PATTERNS];
    return merged;
  } catch (error) {
    console.error('getSettingsFresh failed', error);
    return defaults;
  }
}

/* Slovensky komentar: Spusti zasadenie kategorii a zaznamena trvanie. */
async function runCategorySeeding(trigger) {
  const startedAt = Date.now();
  try {
    const result = await Database.ensureDbWithSeeds();
    const durationMs = Date.now() - startedAt;
    await Logger.log('info', 'db', 'Category seeding invoked', {
      trigger,
      durationMs,
      inserted: result.inserted,
      existingCount: result.existingCount
    });
  } catch (error) {
    await Logger.log('error', 'db', 'Category seeding wrapper failed', {
      trigger,
      message: error && error.message
    });
  }
}

/* Slovensky komentar: Uisti sa, ze nastavenia su v storage a pripadne opravy zaznamena. */
async function ensureSettingsBaseline(trigger) {
  try {
    const { healedFields } = await SettingsStore.load();
    if (healedFields.length) {
      await Logger.log('info', 'settings', 'Settings auto-healed to defaults', {
        trigger,
        healedFields
      });
    }
  } catch (error) {
    await Logger.log('error', 'settings', 'Settings baseline failed', {
      trigger,
      message: error && error.message
    });
  }
}

/* Slovensky komentar: Inicializacia pri spusteni workeru. */
async function bootstrapStartup() {
  await ensureSettingsBaseline('startup');
  await runCategorySeeding('startup');
}

bootstrapStartup().catch(() => {
  /* Slovensky komentar: Zamedzi neodchytenemu odmietnutiu pri starte. */
});

/* Slovensky komentar: Ziska aktivnu kartu v aktuálnom okne. */
function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'tabs.query failed'));
        return;
      }
      if (tabs && tabs.length) {
        resolve(tabs[0]);
      } else {
        resolve(null);
      }
    });
  });
}

/* Slovensky komentar: Posle spravu s manualnym timeoutom a pri chybe reinjektuje obsahovy skript. */
async function sendWithEnsureCS(tabId, payload, { timeoutMs = 1500 } = {}) {
  try {
    const firstAttempt = chrome.tabs.sendMessage(tabId, payload);
    return await withManualTimeout(firstAttempt, timeoutMs);
  } catch (firstError) {
    const runtimeMessage =
      (chrome.runtime && chrome.runtime.lastError && chrome.runtime.lastError.message)
        || (firstError && firstError.message)
        || '';
    if (!isNoReceiverError(runtimeMessage)) {
      throw firstError;
    }
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    console.info('[MyChatGPT] cs_injected_retry', { tabId });
    try {
      await Logger.log('info', 'content', 'Content script auto-injected for retry', {
        reasonCode: 'cs_injected_retry',
        tabId
      });
    } catch (logError) {
      console.warn('cs_injected_retry log failed', logError);
    }
  } catch (injectError) {
    throw injectError;
  }

  const retryAttempt = chrome.tabs.sendMessage(tabId, payload);
  return withManualTimeout(retryAttempt, timeoutMs);
}

/* Slovensky komentar: Posle debug log na aktivnu kartu, ak ide o chatgpt.com. */
async function forwardDebugLogToActiveTab(payload) {
  const activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id || !activeTab.url || !activeTab.url.startsWith('https://chatgpt.com/')) {
    return { forwarded: false, reason: 'no_active_chatgpt' };
  }
  try {
    await sendWithEnsureCS(activeTab.id, { type: 'debug_console_log', payload });
    return { forwarded: true, reason: null };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { forwarded: false, reason: message };
  }
}

/* Slovensky komentar: Odošle ping na obsahový skript a vrati odpoved. */
async function sendPingRequest(tabId, traceId) {
  const response = await sendWithEnsureCS(tabId, {
    type: 'ping',
    traceId,
    want: { url: true, title: true, markers: true }
  });
  return response || null;
}

/* Slovensky komentar: Odošle poziadavku na citanie metadata bez zasahu do DOM. */
async function sendProbeRequest(tabId, traceId) {
  const response = await sendWithEnsureCS(tabId, {
    type: 'probe_metadata',
    traceId,
    want: { url: true, title: true, ids: true, counts: true }
  });
  return response || null;
}

/* Slovensky komentar: Odošle poziadavku na zachytenie obsahu bez modifikacie. */
async function sendCaptureRequest(tabId, traceId) {
  const response = await sendWithEnsureCS(tabId, {
    type: 'capture_preview',
    traceId
  });
  return response || null;
}

/* Slovensky komentar: Notifikacia popupu o pocte poloziek vo fronte. */
async function broadcastQueueCount() {
  let count = null;
  try {
    count = await Database.countQueued();
  } catch (_error) {
    count = null;
  }
  try {
    chrome.runtime.sendMessage({
      type: 'deletion_queue_updated',
      count
    });
  } catch (_notifyError) {
    /* Slovensky komentar: Ignoruje pripadnu chybu pri odoslani. */
  }
  return count;
}

/* Slovensky komentar: Spusti spracovanie fronty mazania cez UI automatizaciu. */
async function runDeletionBatch(trigger = 'manual') {
  let settings = null;
  try {
    settings = await getSettingsFresh();
  } catch (_error) {
    settings = createDefaultSettingsSnapshot();
  }
  const limitValue = Number.isFinite(settings.deleteBatchLimit) && settings.deleteBatchLimit > 0
    ? settings.deleteBatchLimit
    : 5;
  const useMiniWindow = Boolean(settings.miniWindow);
  let queuedItems = [];
  try {
    queuedItems = await Database.listQueued(limitValue);
  } catch (error) {
    console.error('[batch] listQueued_failed', { message: error && error.message });
    queuedItems = [];
  }
  const mode = useMiniWindow ? 'mini_window' : 'active_tab';
  console.info(`[batch] start total=${queuedItems.length} mode=${mode}`);
  await broadcastQueueCount();
  if (!queuedItems.length) {
    try {
      await Logger.log('info', 'batch', 'UI delete batch skipped (empty)', { trigger, total: 0, mode });
    } catch (_logError) {
      /* Slovensky komentar: Pokracuje aj bez zapisu logu. */
    }
    console.info('[batch] done successes=0 failures=0');
    return { ok: true, total: 0, successes: 0, failures: 0, mode };
  }

  let context = null;
  let successes = 0;
  let failures = 0;
  try {
    context = await ensureUiAutomationContext(useMiniWindow);
    const tabId = context && typeof context.tabId === 'number' ? context.tabId : null;
    if (typeof tabId !== 'number') {
      throw new Error('tab_unavailable');
    }
    try {
      await Logger.log('info', 'batch', 'UI delete batch start', {
        trigger,
        total: queuedItems.length,
        mode,
        limit: limitValue
      });
    } catch (_logError) {
      /* Slovensky komentar: Tichy pokracujuci rezim pri chybe logu. */
    }

    for (let index = 0; index < queuedItems.length; index += 1) {
      const item = queuedItems[index];
      const titleText = item && typeof item.title === 'string' && item.title ? item.title : '(untitled)';
      let response = null;
      try {
        response = await sendWithEnsureCS(
          tabId,
          {
            type: 'phase2_delete_by_title',
            payload: {
              id: item && item.id ? item.id : null,
              title: item ? item.title : null,
              retries: UI_DELETE_RETRIES,
              timeouts: UI_DELETE_TIMEOUTS
            }
          },
          { timeoutMs: 25000 }
        );
      } catch (error) {
        const reasonCode = error && error.message === 'timeout' ? 'timeout' : 'send_failed';
        response = {
          ok: false,
          reasonCode,
          error: error && error.message ? error.message : String(error)
        };
        console.warn('[batch] send_step_failed', { id: item && item.id ? item.id : null, reasonCode, message: response.error });
      }

      let statusLabel = '';
      if (response && response.ok) {
        successes += 1;
        try {
          const markOk = await Database.markDeleted(item && item.id ? item.id : null);
          if (!markOk) {
            console.warn('[batch] mark_deleted_noop', { id: item && item.id ? item.id : null });
          }
        } catch (markError) {
          console.warn('[batch] mark_deleted_failed', {
            id: item && item.id ? item.id : null,
            message: markError && markError.message
          });
        }
        statusLabel = 'deleted';
      } else {
        failures += 1;
        const reasonCode = response && typeof response.reasonCode === 'string' ? response.reasonCode : 'error';
        try {
          const marked = await Database.markFailed(item && item.id ? item.id : null, reasonCode);
          if (!marked) {
            console.warn('[batch] mark_failed_noop', { id: item && item.id ? item.id : null, reasonCode });
          }
        } catch (markError) {
          console.warn('[batch] mark_failed_error', {
            id: item && item.id ? item.id : null,
            reasonCode,
            message: markError && markError.message
          });
        }
        statusLabel = `failed:${reasonCode}`;
      }

      console.info(`[batch] item ${index + 1}/${queuedItems.length} title="${titleText}" result=${statusLabel}`);
      await broadcastQueueCount();
    }

    console.info(`[batch] done successes=${successes} failures=${failures}`);
    try {
      await Logger.log('info', 'batch', 'UI delete batch done', {
        trigger,
        total: queuedItems.length,
        mode,
        successes,
        failures
      });
    } catch (_logError) {
      /* Slovensky komentar: Ignoruje chybu pri zapise summary. */
    }
    return { ok: true, total: queuedItems.length, successes, failures, mode };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('[batch] orchestration_error', { message });
    try {
      await Logger.log('error', 'batch', 'UI delete batch failed', { trigger, mode, message });
    } catch (_logError) {
      /* Slovensky komentar: Chybu pri logu ignoruje. */
    }
    return { ok: false, error: message, total: queuedItems.length, successes, failures, mode };
  } finally {
    if (useMiniWindow && context && typeof context.windowId === 'number') {
      try {
        await removeWindow(context.windowId);
      } catch (closeError) {
        console.warn('[batch] mini_window_close_failed', {
          windowId: context.windowId,
          message: closeError && closeError.message
        });
      }
    }
    await broadcastQueueCount();
  }
}

/* Slovensky komentar: Ziska zoznam chatgpt.com tabov v deterministickom poradi. */
function queryChatgptTabs() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: 'https://chatgpt.com/*' }, (tabs) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'tabs.query failed'));
        return;
      }
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

/* Slovensky komentar: Pocka na dokoncene nacitanie tabu. */
function waitForTabComplete(tabId, timeoutMs = 12000) {
  if (typeof tabId !== 'number') {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch (_error) {
        /* Slovensky komentar: Ignoruje chybu pri odhlaseni. */
      }
      clearTimeout(timerId);
    };
    const timerId = setTimeout(() => {
      cleanup();
      reject(new Error('tab_load_timeout'));
    }, Math.max(1000, timeoutMs));
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo && changeInfo.status === 'complete') {
        cleanup();
        resolve(tab || null);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        cleanup();
        reject(new Error(runtimeError.message || 'tabs.get failed'));
        return;
      }
      if (!tab) {
        cleanup();
        resolve(null);
        return;
      }
      if (tab.status === 'complete') {
        cleanup();
        resolve(tab);
      }
    });
  });
}

/* Slovensky komentar: Aktivuje tab s danou konfiguraciou. */
function updateTab(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'tabs.update failed'));
        return;
      }
      resolve(tab || null);
    });
  });
}

/* Slovensky komentar: Zameria okno pre lepsi UX. */
function focusWindow(windowId) {
  if (typeof windowId !== 'number') {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    chrome.windows.update(windowId, { focused: true }, (win) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'windows.update failed'));
        return;
      }
      resolve(win || null);
    });
  });
}

/* Slovensky komentar: Vytvori novy tab so strankou chatgpt.com. */
function createChatgptTab(windowId = null) {
  return new Promise((resolve, reject) => {
    const createOptions = windowId && typeof windowId === 'number'
      ? { url: 'https://chatgpt.com/', windowId }
      : { url: 'https://chatgpt.com/' };
    chrome.tabs.create(createOptions, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'tabs.create failed'));
        return;
      }
      resolve(tab || null);
    });
  });
}

/* Slovensky komentar: Otvori mini popup okno s chatgpt.com. */
function createMiniWindow() {
  return new Promise((resolve, reject) => {
    chrome.windows.create(
      {
        url: 'https://chatgpt.com/',
        type: 'popup',
        focused: true,
        width: 480,
        height: 720
      },
      (win) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || 'windows.create failed'));
          return;
        }
        resolve(win || null);
      }
    );
  });
}

/* Slovensky komentar: Zatvori okno ak existuje. */
function removeWindow(windowId) {
  if (typeof windowId !== 'number') {
    return Promise.resolve(false);
  }
  return new Promise((resolve, reject) => {
    chrome.windows.remove(windowId, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'windows.remove failed'));
        return;
      }
      resolve(true);
    });
  });
}

/* Slovensky komentar: Najde alebo otvori tab na chatgpt.com pre aktivny rezim. */
async function ensureActiveChatgptTab() {
  let activeTab = null;
  try {
    activeTab = await getActiveTab();
  } catch (_error) {
    activeTab = null;
  }
  if (activeTab && activeTab.id && activeTab.url && activeTab.url.startsWith('https://chatgpt.com/')) {
    try {
      if (typeof activeTab.windowId === 'number') {
        await focusWindow(activeTab.windowId);
      }
      await updateTab(activeTab.id, { active: true });
    } catch (_focusError) {
      /* Slovensky komentar: Ignoruje chybu pri fokusovani. */
    }
    try {
      await waitForTabComplete(activeTab.id, 12000);
    } catch (waitError) {
      console.warn('[batch] active_tab_wait_failed', { message: waitError && waitError.message });
    }
    return { tabId: activeTab.id, windowId: activeTab.windowId || null, created: false };
  }

  let candidateTab = null;
  try {
    const tabs = await queryChatgptTabs();
    candidateTab = tabs.find((tab) => tab && typeof tab.id === 'number') || null;
  } catch (_queryError) {
    candidateTab = null;
  }
  if (candidateTab && candidateTab.id) {
    try {
      if (typeof candidateTab.windowId === 'number') {
        await focusWindow(candidateTab.windowId);
      }
      await updateTab(candidateTab.id, { active: true });
    } catch (_activateError) {
      /* Slovensky komentar: Pokracuje aj pri neuspechu. */
    }
    try {
      await waitForTabComplete(candidateTab.id, 12000);
    } catch (waitError) {
      console.warn('[batch] existing_tab_wait_failed', { message: waitError && waitError.message });
    }
    return { tabId: candidateTab.id, windowId: candidateTab.windowId || null, created: false };
  }

  const createdTab = await createChatgptTab();
  const tabId = createdTab && typeof createdTab.id === 'number' ? createdTab.id : null;
  const windowId = createdTab && typeof createdTab.windowId === 'number' ? createdTab.windowId : null;
  if (tabId) {
    try {
      await waitForTabComplete(tabId, 15000);
    } catch (waitError) {
      console.warn('[batch] new_tab_wait_failed', { message: waitError && waitError.message });
    }
  }
  return { tabId, windowId, created: true };
}

/* Slovensky komentar: Podla rezimu pripravi tab pre UI mazanie. */
async function ensureUiAutomationContext(useMiniWindow) {
  if (useMiniWindow) {
    const createdWindow = await createMiniWindow();
    const windowId = createdWindow && typeof createdWindow.id === 'number' ? createdWindow.id : null;
    let tabId = null;
    if (createdWindow && Array.isArray(createdWindow.tabs)) {
      const firstTab = createdWindow.tabs.find((tab) => tab && typeof tab.id === 'number');
      tabId = firstTab ? firstTab.id : null;
    }
    if (typeof tabId !== 'number') {
      const fallbackTab = await createChatgptTab(windowId);
      tabId = fallbackTab && typeof fallbackTab.id === 'number' ? fallbackTab.id : null;
    }
    if (typeof tabId === 'number') {
      try {
        await waitForTabComplete(tabId, 15000);
      } catch (waitError) {
        console.warn('[batch] mini_window_wait_failed', { message: waitError && waitError.message });
      }
    }
    return { tabId, windowId, createdWindow: true };
  }
  const context = await ensureActiveChatgptTab();
  return { tabId: context.tabId, windowId: context.windowId || null, createdWindow: false };
}

/* Slovensky komentar: Vyhodnoti kandidat status z metadata probe. */
function evaluateCandidateFromProbe(probePayload, settings) {
  const result = {
    ok: false,
    reasonCode: 'counts_unknown',
    counts: { total: null, user: null, assistant: null },
    convoId: null
  };
  if (!probePayload || !probePayload.ok) {
    result.reasonCode = 'no_probe';
    return result;
  }
  const counts = probePayload.counts && typeof probePayload.counts === 'object' ? probePayload.counts : {};
  const total = Number.isFinite(counts.total) ? counts.total : null;
  const user = Number.isFinite(counts.user) ? counts.user : null;
  const assistant = Number.isFinite(counts.assistant) ? counts.assistant : null;
  result.counts = { total, user, assistant };
  result.convoId = probePayload.convoId || null;

  if (total === null) {
    result.reasonCode = 'counts_unknown';
    return result;
  }
  if (total > settings.MAX_MESSAGES) {
    result.reasonCode = 'over_max';
    return result;
  }
  if (user !== null && user > settings.USER_MESSAGES_MAX) {
    result.reasonCode = 'user_over_limit';
    return result;
  }

  result.ok = true;
  result.reasonCode = 'candidate_ok';
  return result;
}

/* Slovensky komentar: Orezanie HTML odpovede na stanovenu velkost. */
function truncateAnswerHtml(htmlValue) {
  if (typeof htmlValue !== 'string') {
    return { value: null, truncated: false, bytes: 0 };
  }
  const encoder = new TextEncoder();
  const encoded = encoder.encode(htmlValue);
  if (encoded.length <= MAX_ANSWER_BYTES) {
    return { value: htmlValue, truncated: false, bytes: encoded.length };
  }
  let low = 0;
  let high = htmlValue.length;
  let bestSlice = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const slice = htmlValue.slice(0, mid);
    const sliceBytes = encoder.encode(slice).length;
    if (sliceBytes <= MAX_ANSWER_BYTES) {
      bestSlice = slice;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const finalBytes = encoder.encode(bestSlice).length;
  return { value: bestSlice, truncated: true, bytes: finalBytes };
}

/* Slovensky komentar: Ulozi pripraveny snapshot do IndexedDB s deduplikaciou. */
async function persistSnapshotRecord(snapshot, settings, traceId, {
  tabTitle = '',
  fallbackConvoId = null,
  runWithTimer = null,
  timings = null
} = {}) {
  const dryRun = Boolean(settings && settings.DRY_RUN);
  const timer = typeof runWithTimer === 'function'
    ? runWithTimer
    : async (_label, fn) => {
        const started = Date.now();
        if (typeof fn !== 'function') {
          return { ok: false, value: null, elapsedMs: 0, error: new Error('Timer callback missing') };
        }
        try {
          const value = await fn();
          return { ok: true, value, elapsedMs: Date.now() - started };
        } catch (error) {
          return { ok: false, value: null, elapsedMs: Date.now() - started, error };
        }
      };
  const timingBucket = timings || { captureMs: 0, dbMs: 0 };
  const titleCandidate = snapshot && typeof snapshot.title === 'string' ? snapshot.title.trim() : '';
  const questionText = snapshot && typeof snapshot.questionText === 'string'
    ? snapshot.questionText.trim()
    : '';
  const answerHtmlRaw = snapshot && typeof snapshot.answerHTML === 'string' ? snapshot.answerHTML : '';
  const resolvedConvoId = (snapshot && snapshot.convoId) || fallbackConvoId || null;
  const now = Date.now();
  const truncateResult = truncateAnswerHtml(answerHtmlRaw || '');
  const backupRecord = {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `backup-${now}`,
    title: titleCandidate || (questionText ? questionText.slice(0, 80) : tabTitle || null) || null,
    questionText: questionText || null,
    answerHTML: truncateResult.value || null,
    timestamp: now,
    category: null,
    convoId: resolvedConvoId,
    answerTruncated: truncateResult.truncated
  };

  try {
    const activeCategoryId = await resolveActiveCategoryId();
    if (activeCategoryId) {
      backupRecord.category = activeCategoryId;
    }
  } catch (_categoryError) {
    backupRecord.category = backupRecord.category || null;
  }

  const logMeta = {
    convoId: backupRecord.convoId,
    qLen: questionText ? questionText.length : 0,
    aLen: truncateResult.value ? truncateResult.value.length : 0,
    truncated: truncateResult.truncated,
    id: backupRecord.id,
    bytes: truncateResult.bytes,
    category: backupRecord.category || null
  };

  if (!dryRun && backupRecord.convoId) {
    const lookupAttempt = await timer(
      `db:getBackupByConvoId:${traceId}`,
      () => Database.getBackupByConvoId(backupRecord.convoId)
    );
    if (Number.isFinite(lookupAttempt.elapsedMs)) {
      timingBucket.dbMs = (timingBucket.dbMs || 0) + lookupAttempt.elapsedMs;
    }
    if (!lookupAttempt.ok) {
      const lookupError = lookupAttempt.error;
      const message = lookupError && lookupError.message ? lookupError.message : String(lookupError);
      return {
        ok: false,
        reasonCode: 'backup_lookup_error',
        message: 'Failed to verify existing backup.',
        record: null,
        dryRun,
        logMeta: { ...logMeta, error: message },
        timings: { captureMs: timingBucket.captureMs || 0, dbMs: timingBucket.dbMs || 0 }
      };
    }
    const existingRecord = lookupAttempt.value;
    if (existingRecord) {
      return {
        ok: false,
        reasonCode: 'backup_duplicate',
        message: 'Conversation already backed up.',
        record: existingRecord,
        dryRun,
        logMeta: { ...logMeta, duplicateId: existingRecord.id || null },
        timings: { captureMs: timingBucket.captureMs || 0, dbMs: timingBucket.dbMs || 0 }
      };
    }
  }

  if (dryRun) {
    return {
      ok: true,
      reasonCode: 'backup_dry_run',
      message: 'Dry run: not persisted.',
      record: backupRecord,
      dryRun,
      logMeta,
      timings: { captureMs: timingBucket.captureMs || 0, dbMs: timingBucket.dbMs || 0 }
    };
  }

  const insertAttempt = await timer('db:insertBackup', () => Database.insertBackup(backupRecord));
  if (Number.isFinite(insertAttempt.elapsedMs)) {
    timingBucket.dbMs = (timingBucket.dbMs || 0) + insertAttempt.elapsedMs;
  }
  if (!insertAttempt.ok) {
    const insertError = insertAttempt.error;
    const message = insertError && insertError.message ? insertError.message : String(insertError);
    return {
      ok: false,
      reasonCode: 'backup_write_error',
      message: 'Failed to persist backup.',
      record: null,
      dryRun,
      logMeta: { ...logMeta, error: message },
      timings: { captureMs: timingBucket.captureMs || 0, dbMs: timingBucket.dbMs || 0 }
    };
  }

  return {
    ok: true,
    reasonCode: 'backup_ok',
    message: 'Backup stored.',
    record: backupRecord,
    dryRun,
    logMeta,
    timings: { captureMs: timingBucket.captureMs || 0, dbMs: timingBucket.dbMs || 0 }
  };
}

/* Slovensky komentar: Zachyti obsah aktivnej karty a pripadne ulozi zaznam. */
async function captureAndPersistBackup(activeTab, settings, traceId, { fallbackConvoId = null } = {}) {
  const dryRun = Boolean(settings && settings.DRY_RUN);
  const tabId = activeTab && typeof activeTab.id === 'number' ? activeTab.id : null;
  const tabTitle = activeTab && typeof activeTab.title === 'string' ? activeTab.title.trim() : '';
  const resultBase = {
    ok: false,
    reasonCode: 'backup_capture_error',
    message: 'Capture unavailable.',
    record: null,
    dryRun,
    logMeta: {
      convoId: fallbackConvoId || null,
      qLen: 0,
      aLen: 0,
      truncated: false,
      id: null
    }
  };
  const timings = { captureMs: 0, dbMs: 0 };
  const runWithTimer = typeof Logger === 'object' && typeof Logger.withTimer === 'function'
    ? Logger.withTimer
    : async (_label, fn) => {
        const started = Date.now();
        if (typeof fn !== 'function') {
          return { ok: false, value: null, elapsedMs: 0, error: new Error('Timer callback missing') };
        }
        try {
          const value = await fn();
          return { ok: true, value, elapsedMs: Date.now() - started };
        } catch (error) {
          return { ok: false, value: null, elapsedMs: Date.now() - started, error };
        }
      };
  const snapshotTimings = () => ({
    captureMs: Number.isFinite(timings.captureMs) ? timings.captureMs : 0,
    dbMs: Number.isFinite(timings.dbMs) ? timings.dbMs : 0
  });

  if (!tabId) {
    return {
      ...resultBase,
      reasonCode: 'backup_no_tab',
      message: 'Active tab missing identifier.',
      logMeta: {
        ...resultBase.logMeta,
        error: 'no_tab_id'
      },
      timings: snapshotTimings()
    };
  }

  const captureAttempt = await runWithTimer(`capture:${traceId}`, () => sendCaptureRequest(tabId, traceId));
  if (Number.isFinite(captureAttempt.elapsedMs)) {
    timings.captureMs += captureAttempt.elapsedMs;
  }
  if (!captureAttempt.ok) {
    const captureError = captureAttempt.error;
    const message = captureError && captureError.message ? captureError.message : String(captureError);
    return {
      ...resultBase,
      message,
      logMeta: {
        ...resultBase.logMeta,
        error: message
      },
      timings: snapshotTimings()
    };
  }
  const capturePayload = captureAttempt.value;

  if (!capturePayload || !capturePayload.ok) {
    const message = capturePayload && capturePayload.error ? capturePayload.error : 'Capture unavailable.';
    return {
      ...resultBase,
      message,
      timings: snapshotTimings()
    };
  }

  const snapshotResult = await persistSnapshotRecord(
    {
      title: capturePayload.title,
      questionText: capturePayload.questionText,
      answerHTML: capturePayload.answerHTML,
      convoId: capturePayload.convoId
    },
    settings,
    traceId,
    { tabTitle, fallbackConvoId, runWithTimer, timings }
  );

  return snapshotResult;
  return {
        ok: false,
        reasonCode: 'backup_lookup_error',
        message: 'Failed to verify existing backup.',
        record: null,
        dryRun,
        logMeta: {
          ...logMeta,
          error: message
        },
        timings: snapshotTimings()
      };
    }
    const existingRecord = lookupAttempt.value;
    if (existingRecord) {
      return {
        ok: false,
        reasonCode: 'backup_duplicate',
        message: 'Conversation already backed up.',
        record: existingRecord,
        dryRun,
        logMeta: {
          ...logMeta,
          duplicateId: existingRecord.id || null
        },
        timings: snapshotTimings()
      };
    }
  }

  if (dryRun) {
    return {
      ok: true,
      reasonCode: 'backup_dry_run',
      message: 'Dry run: not persisted.',
      record: backupRecord,
      dryRun,
      logMeta,
      timings: snapshotTimings()
    };
  }

  const insertAttempt = await runWithTimer('db:insertBackup', () => Database.insertBackup(backupRecord));
  if (Number.isFinite(insertAttempt.elapsedMs)) {
    timings.dbMs += insertAttempt.elapsedMs;
  }
  if (!insertAttempt.ok) {
    const writeError = insertAttempt.error;
    const message = writeError && writeError.message ? writeError.message : String(writeError);
    return {
      ok: false,
      reasonCode: 'backup_write_error',
      message: 'Failed to persist backup.',
      record: null,
      dryRun,
      logMeta: {
        ...logMeta,
        error: message
      },
      timings: snapshotTimings()
    };
  }

  try {
    chrome.runtime.sendMessage(
      {
        type: 'backups_updated',
        reason: 'manual_backup',
        id: backupRecord.id,
        timestamp: backupRecord.timestamp
      },
      () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          // Slovensky komentar: Broadcast chyba sa ignoruje.
        }
      }
    );
  } catch (_broadcastError) {
    // Slovensky komentar: Broadcast zlyhanie neblokuje vysledok.
  }

  return {
    ok: true,
    reasonCode: 'backup_ok',
    message: 'Backup stored successfully.',
    record: backupRecord,
    dryRun: false,
    logMeta,
    timings: snapshotTimings()
  };
}

/* Slovensky komentar: Bezpecne precita cas poslednej heuristiky z local storage. */
async function readCooldownSnapshot() {
  const stored = await chrome.storage.local.get({ [COOLDOWN_KEY]: { lastScanAt: null } });
  const entry = stored[COOLDOWN_KEY];
  if (entry && Number.isFinite(entry.lastScanAt)) {
    return { lastScanAt: entry.lastScanAt };
  }
  return { lastScanAt: null };
}

/* Slovensky komentar: Ulozi novy cas posledneho heuristickeho behu. */
async function writeCooldownTimestamp(timestamp) {
  await chrome.storage.local.set({ [COOLDOWN_KEY]: { lastScanAt: timestamp } });
}

self.addEventListener('install', () => {
  /* Slovensky komentar: Okamzite aktivuje novu verziu. */
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  /* Slovensky komentar: Po aktivacii si worker narokuje klientov a pripravi storage. */
  event.waitUntil(
    (async () => {
      await ensureSettingsBaseline('activate');
      try {
        await Database.initDB();
      } catch (error) {
        await Logger.log('error', 'db', 'Database init during activate failed', {
          message: error && error.message
        });
      }
      self.clients.claim();
    })()
  );
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureSettingsBaseline(`onInstalled:${details.reason}`);
  await runCategorySeeding(`onInstalled:${details.reason}`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'debug_test_log') {
    (async () => {
      const note = typeof message.note === 'string' ? message.note.trim() : '';
      const requestedAt = new Date().toISOString();
      const meta = { requestedAt };
      if (note) {
        meta.note = note;
      }
      let logError = null;
      try {
        await Logger.log('info', 'debug', 'Test log from popup', meta);
      } catch (error) {
        logError = error;
      }
      console.info(`[MyChatGPT] Test log (SW) ${requestedAt}`);
      let forwardReport = { forwarded: false, reason: null };
      try {
        forwardReport = await forwardDebugLogToActiveTab({
          msg: 'Test log from background',
          requestedAt,
          note: note || null
        });
      } catch (forwardError) {
        forwardReport = {
          forwarded: false,
          reason: forwardError && forwardError.message ? forwardError.message : String(forwardError)
        };
      }
      const responsePayload = {
        ok: !logError,
        requestedAt,
        forwarded: Boolean(forwardReport.forwarded)
      };
      if (note) {
        responsePayload.note = note;
      }
      if (logError) {
        responsePayload.error = logError && logError.message ? logError.message : String(logError);
      }
      if (forwardReport.reason && !logError) {
        responsePayload.forwardError = forwardReport.reason;
      }
      sendResponse(responsePayload);
    })();
    return true;
  }
  if (message && message.type === 'run_ui_deletion_batch') {
    (async () => {
      try {
        const summary = await runDeletionBatch(message.trigger || 'popup_button');
        const ok = summary && summary.ok !== false;
        sendResponse({ ok, summary });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }
  if (message && message.type === 'heuristics_eval') {
    (async () => {
      const decision = {
        decided: false,
        isCandidate: null,
        reasonCodes: [],
        snapshot: {
          url: null,
          title: null,
          convoId: null,
          counts: { total: null, user: null, assistant: null }
        }
      };
      let logReasonCode = 'no_probe';
      let cooldownReport = { used: false, remainingMs: 0, minutes: null, lastScanAt: null, wouldWait: false };
      let payload = null;
      let errorMessage = null;

      try {
        const settings = await getSettingsFresh();
        cooldownReport = {
          used: false,
          remainingMs: 0,
          minutes: Number.isFinite(settings.SCAN_COOLDOWN_MIN)
            ? settings.SCAN_COOLDOWN_MIN
            : null,
          lastScanAt: null,
          wouldWait: false
        };

        const activeTab = await getActiveTab();
        if (!activeTab || !activeTab.url || !activeTab.url.startsWith('https://chatgpt.com/')) {
          decision.reasonCodes.push('no_match');
          decision.snapshot.url = activeTab && activeTab.url ? activeTab.url : null;
          decision.snapshot.title = activeTab && activeTab.title ? activeTab.title : null;
          payload = { ok: false, reasonCode: 'no_match', decision, cooldown: cooldownReport };
        } else if (urlMatchesAnyPattern(activeTab.url, settings.SAFE_URL_PATTERNS)) {
          decision.decided = true;
          decision.isCandidate = false;
          decision.reasonCodes.push('heuristics_safe_url');
          decision.snapshot.url = activeTab.url;
          decision.snapshot.title = activeTab.title || null;
          logReasonCode = 'heuristics_safe_url';
          payload = { ok: true, reasonCode: logReasonCode, decision, cooldown: cooldownReport };
        } else {
          decision.snapshot.url = activeTab.url;
          decision.snapshot.title = activeTab.title || null;
          let probeResponse = null;
          try {
            probeResponse = await sendProbeRequest(activeTab.id, `heuristics:${Date.now()}`);
          } catch (probeError) {
            errorMessage = probeError && probeError.message ? probeError.message : String(probeError);
          }
          if (!probeResponse || !probeResponse.ok) {
            decision.reasonCodes.push('no_probe');
            logReasonCode = 'no_probe';
            payload = {
              ok: false,
              reasonCode: logReasonCode,
              decision,
              cooldown: cooldownReport,
              error: errorMessage || 'Metadata probe unavailable'
            };
          } else {
            decision.snapshot.convoId = probeResponse.convoId || null;
            if (probeResponse.counts && typeof probeResponse.counts === 'object') {
              const counts = probeResponse.counts;
              decision.snapshot.counts = {
                total:
                  counts.total === null || Number.isFinite(counts.total)
                    ? counts.total
                    : null,
                user:
                  counts.user === null || Number.isFinite(counts.user)
                    ? counts.user
                    : null,
                assistant:
                  counts.assistant === null || Number.isFinite(counts.assistant)
                    ? counts.assistant
                    : null
              };
            }

            const counts = decision.snapshot.counts;
            const totalCount = Number.isFinite(counts.total) ? counts.total : null;
            if (totalCount === null) {
              decision.reasonCodes.push('counts_unknown');
              logReasonCode = 'counts_unknown';
              payload = { ok: true, reasonCode: logReasonCode, decision, cooldown: cooldownReport };
            } else if (totalCount > settings.MAX_MESSAGES) {
              decision.decided = true;
              decision.isCandidate = false;
              decision.reasonCodes.push('over_max');
              logReasonCode = 'over_max';
              payload = { ok: true, reasonCode: logReasonCode, decision, cooldown: cooldownReport };
            } else {
              const userCount = Number.isFinite(counts.user) ? counts.user : null;
              const userWithinLimit = userCount === null || userCount <= settings.USER_MESSAGES_MAX;
              if (userWithinLimit) {
                decision.decided = true;
                decision.isCandidate = true;
                decision.reasonCodes.push('candidate_ok');
                logReasonCode = 'candidate_ok';
                payload = { ok: true, reasonCode: logReasonCode, decision, cooldown: cooldownReport };
              } else {
                decision.decided = true;
                decision.isCandidate = false;
                decision.reasonCodes.push('user_over_limit');
                logReasonCode = 'over_max';
                payload = { ok: true, reasonCode: logReasonCode, decision, cooldown: cooldownReport };
              }
            }
          }
        }
      } catch (error) {
        const fallbackMessage = error && error.message ? error.message : String(error);
        errorMessage = fallbackMessage;
        decision.reasonCodes.push('error');
        payload = payload || {
          ok: false,
          reasonCode: 'no_probe',
          decision,
          cooldown: cooldownReport,
          error: fallbackMessage
        };
      } finally {
        if (!payload) {
          payload = { ok: false, reasonCode: 'no_probe', decision, cooldown: cooldownReport };
        } else if (!payload.cooldown) {
          payload.cooldown = cooldownReport;
        }
        await Logger.log('info', 'scan', 'Heuristics evaluation summary', {
          reasonCode: logReasonCode,
          convoId: decision.snapshot.convoId,
          counts: decision.snapshot.counts,
          url: decision.snapshot.url,
          title: decision.snapshot.title,
          reasonCodes: decision.reasonCodes,
          cooldown: payload.cooldown,
          error: errorMessage || null
        });
        sendResponse(payload);
      }
    })();
    return true;
  }
  if (message && message.type === 'scan_now') {
    (async () => {
      try {
        const settings = await getSettingsFresh();
        const result = {
          scanned: 0,
          matched: 0,
          dryRun: settings.DRY_RUN,
          reasonCode: 'stub_only'
        };
        await Logger.log('info', 'scan', 'Scan stub executed', {
          trigger: 'runtime_message',
          result
        });
        sendResponse({ ok: true, result });
      } catch (error) {
        await Logger.log('error', 'scan', 'Scan stub failed', {
          message: error && error.message
        });
        sendResponse({ ok: false, error: error && error.message });
      }
    })();
    return true;
  }
  if (message && message.type === 'connectivity_test') {
    (async () => {
      const traceId = `ping:${Date.now()}`;
      let activeTab = null;
      let reasonCode = 'no_response';
      try {
        activeTab = await getActiveTab();
      } catch (error) {
        await Logger.log('info', 'scan', 'Connectivity ping result', {
          reasonCode,
          url: null,
          title: null,
          markers: null,
          error: error && error.message
        });
        sendResponse({ ok: false, reasonCode, error: error && error.message });
        return;
      }

      if (!activeTab || !activeTab.url || !activeTab.url.startsWith('https://chatgpt.com/')) {
        reasonCode = 'no_match';
        await Logger.log('info', 'scan', 'Connectivity ping result', {
          reasonCode,
          url: activeTab && activeTab.url ? activeTab.url : null,
          title: activeTab && activeTab.title ? activeTab.title : null,
          markers: null
        });
        sendResponse({ ok: false, reasonCode, error: 'Active tab is not chatgpt.com' });
        return;
      }

      try {
        const response = await sendPingRequest(activeTab.id, traceId);
        if (response && response.ok) {
          reasonCode = 'ping_ok';
          await Logger.log('info', 'scan', 'Connectivity ping result', {
            reasonCode,
            url: response.url,
            title: response.title,
            markers: response.markers
          });
          sendResponse({ ok: true, reasonCode, payload: response });
          return;
        }
        reasonCode = 'no_response';
        await Logger.log('info', 'scan', 'Connectivity ping result', {
          reasonCode,
          url: activeTab.url,
          title: activeTab.title || null,
          markers: null
        });
        sendResponse({ ok: false, reasonCode, error: 'Content script did not respond' });
      } catch (error) {
        reasonCode = 'no_response';
        await Logger.log('info', 'scan', 'Connectivity ping result', {
          reasonCode,
          url: activeTab.url,
          title: activeTab.title || null,
          markers: null,
          error: error && error.message
        });
        sendResponse({ ok: false, reasonCode, error: error && error.message });
      }
    })();
    return true;
  }
  if (message && message.type === 'probe_request') {
    (async () => {
      const traceId = `probe:${Date.now()}`;
      let activeTab = null;
      let reasonCode = 'no_match';
      try {
        activeTab = await getActiveTab();
      } catch (error) {
        await Logger.log('info', 'scan', 'Metadata probe summary', {
          reasonCode: 'error',
          url: null,
          title: null,
          error: error && error.message
        });
        sendResponse({ ok: false, reasonCode: 'error', error: error && error.message });
        return;
      }

      if (!activeTab || !activeTab.url || !activeTab.url.startsWith('https://chatgpt.com/')) {
        reasonCode = 'no_match';
        await Logger.log('info', 'scan', 'Metadata probe summary', {
          reasonCode,
          url: activeTab && activeTab.url ? activeTab.url : null,
          title: activeTab && activeTab.title ? activeTab.title : null
        });
        sendResponse({ ok: false, reasonCode, error: 'Active tab is not chatgpt.com' });
        return;
      }

      try {
        const settings = await getSettingsFresh();
        if (urlMatchesAnyPattern(activeTab.url, settings.SAFE_URL_PATTERNS)) {
          reasonCode = 'probe_safe_url';
          const payload = {
            ok: true,
            traceId,
            url: activeTab.url,
            title: activeTab.title || null,
            convoId: null,
            counts: { total: null, user: null, assistant: null },
            markers: { hasAppRoot: false, hasComposer: false, guessChatView: false },
            skipped: true,
            reason: 'probe_safe_url'
          };
          await Logger.log('info', 'scan', 'Metadata probe summary', {
            reasonCode,
            url: activeTab.url,
            title: activeTab.title || null,
            convoId: null,
            counts: payload.counts,
            skipped: true
          });
          sendResponse({ ok: true, reasonCode, payload });
          return;
        }

        const response = await sendProbeRequest(activeTab.id, traceId);
        if (response && response.ok) {
          reasonCode = 'probe_ok';
          await Logger.log('info', 'scan', 'Metadata probe summary', {
            reasonCode,
            url: response.url,
            title: response.title,
            convoId: response.convoId || null,
            counts: response.counts,
            skipped: Boolean(response.skipped)
          });
          sendResponse({ ok: true, reasonCode, payload: response });
          return;
        }
        reasonCode = 'error';
        await Logger.log('info', 'scan', 'Metadata probe summary', {
          reasonCode,
          url: activeTab.url,
          title: activeTab.title || null,
          convoId: null,
          counts: null
        });
        sendResponse({ ok: false, reasonCode, error: 'Content script did not respond' });
      } catch (error) {
        reasonCode = 'error';
        await Logger.log('info', 'scan', 'Metadata probe summary', {
          reasonCode,
          url: activeTab.url,
          title: activeTab.title || null,
          convoId: null,
          counts: null,
          error: error && error.message
        });
        sendResponse({ ok: false, reasonCode, error: error && error.message });
      }
    })();
    return true;
  }
  if (message && message.type === 'capture_preview_debug') {
    (async () => {
      let reasonCode = 'capture_error';
      try {
        const settings = await getSettingsFresh();
        const activeTab = await getActiveTab();
        if (!activeTab || !activeTab.url || !activeTab.url.startsWith('https://chatgpt.com/')) {
          reasonCode = 'capture_no_match';
          await Logger.log('info', 'scan', 'Capture preview debug summary', {
            reasonCode,
            url: activeTab && activeTab.url ? activeTab.url : null,
            title: activeTab && activeTab.title ? activeTab.title : null
          });
          sendResponse({ ok: false, reasonCode, error: 'Active tab is not chatgpt.com' });
          return;
        }

        if (urlMatchesAnyPattern(activeTab.url, settings.SAFE_URL_PATTERNS)) {
          reasonCode = 'capture_safe_url';
          const payload = {
            ok: true,
            skipped: true,
            reason: 'capture_safe_url',
            url: activeTab.url,
            title: activeTab.title || null,
            questionText: null,
            answerHTML: null
          };
          await Logger.log('info', 'scan', 'Capture preview debug summary', {
            reasonCode,
            url: activeTab.url,
            title: activeTab.title || null,
            skipped: true
          });
          sendResponse({ ok: true, reasonCode, payload });
          return;
        }

        const capturePayload = await sendCaptureRequest(activeTab.id, `debug:${Date.now()}`);
        if (capturePayload && capturePayload.ok) {
          reasonCode = 'capture_ok';
          await Logger.log('info', 'scan', 'Capture preview debug summary', {
            reasonCode,
            url: capturePayload.url || activeTab.url,
            title: capturePayload.title || activeTab.title || null,
            qLen:
              capturePayload.questionText && typeof capturePayload.questionText === 'string'
                ? capturePayload.questionText.length
                : 0,
            aLen:
              capturePayload.answerHTML && typeof capturePayload.answerHTML === 'string'
                ? capturePayload.answerHTML.length
                : 0
          });
          sendResponse({ ok: true, reasonCode, payload: capturePayload });
          return;
        }

        reasonCode = 'capture_error';
        const messageText = capturePayload && capturePayload.error ? capturePayload.error : 'Capture unavailable.';
        await Logger.log('warn', 'scan', 'Capture preview debug summary', {
          reasonCode,
          url: activeTab.url,
          title: activeTab.title || null,
          message: messageText
        });
        sendResponse({ ok: false, reasonCode, error: messageText });
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
        reasonCode = reasonCode === 'capture_safe_url' ? reasonCode : 'capture_error';
        await Logger.log('error', 'scan', 'Capture preview debug summary', {
          reasonCode,
          url: null,
          title: null,
          message: messageText
        });
        sendResponse({ ok: false, reasonCode, error: messageText });
      }
    })();
    return true;
  }
  if (message && message.type === 'backup_now') {
    (async () => {
      const traceId = `backup:${Date.now()}`;
      let reasonCode = 'backup_capture_error';
      let responsePayload = {
        ok: false,
        reasonCode,
        message: 'Unexpected error',
        record: null
      };
      let logMeta = { convoId: null, qLen: 0, aLen: 0, truncated: false, id: null };
      let settings = null;

      try {
        settings = await getSettingsFresh();
        const dryRunFlag = Boolean(settings && settings.DRY_RUN);
        const activeTab = await getActiveTab();
        if (!activeTab || !activeTab.url || !activeTab.url.startsWith('https://chatgpt.com/')) {
          reasonCode = 'backup_no_match';
          responsePayload = {
            ok: false,
            reasonCode,
            message: 'Active tab is not chatgpt.com.',
            record: null,
            dryRun: dryRunFlag
          };
          return;
        }

        if (urlMatchesAnyPattern(activeTab.url, settings.SAFE_URL_PATTERNS)) {
          reasonCode = 'backup_safe_url';
          responsePayload = {
            ok: false,
            reasonCode,
            message: 'SAFE_URL pattern prevents capture.',
            record: null,
            dryRun: dryRunFlag
          };
          return;
        }

        let convoId = null;
        let evaluation = null;
        if (settings.CAPTURE_ONLY_CANDIDATES) {
          let probeResponse = null;
          try {
            probeResponse = await sendProbeRequest(activeTab.id, `manual:${Date.now()}`);
          } catch (probeError) {
            reasonCode = 'backup_capture_error';
            responsePayload = {
              ok: false,
              reasonCode,
              message: (probeError && probeError.message) || 'Metadata probe failed.',
              record: null,
              dryRun: dryRunFlag
            };
            return;
          }
          evaluation = evaluateCandidateFromProbe(probeResponse, settings);
          convoId = evaluation.convoId || null;
          if (!evaluation.ok) {
            reasonCode = 'backup_not_candidate';
            responsePayload = {
              ok: false,
              reasonCode,
              message: 'Not a short chat (over limits).',
              record: null,
              dryRun: dryRunFlag
            };
            logMeta = {
              ...logMeta,
              convoId,
              counts: evaluation.counts
            };
            return;
          }
        }

        const captureResult = await captureAndPersistBackup(activeTab, settings, traceId, { fallbackConvoId: convoId });
        reasonCode = captureResult.reasonCode;
        responsePayload = {
          ok: captureResult.ok,
          reasonCode,
          message: captureResult.message,
          record: captureResult.record,
          dryRun: captureResult.dryRun
        };
        const captureMeta = captureResult.logMeta || {};
        logMeta = {
          ...logMeta,
          ...captureMeta
        };
        if (evaluation) {
          logMeta.counts = evaluation.counts;
        }
        if (!captureResult.ok) {
          return;
        }
        return;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        reasonCode = reasonCode === 'backup_capture_error' ? reasonCode : 'backup_capture_error';
        responsePayload = {
          ok: false,
          reasonCode,
          message,
          record: null,
          dryRun: Boolean(settings && settings.DRY_RUN)
        };
        logMeta = {
          ...logMeta,
          error: message
        };
      } finally {
        await Logger.log('info', 'scan', 'Manual backup attempt', {
          reasonCode,
          ...logMeta,
          dryRun: Boolean(settings && settings.DRY_RUN)
        });
        sendResponse(responsePayload);
      }
    })();
    return true;
  }
  if (message && message.type === 'eval_and_backup') {
    (async () => {
      const traceId = `eval-backup:${Date.now()}`;
      const reasonCodes = [];
      let settings = null;
      let activeTab = null;
      let evaluation = null;
      let captureResult = null;
      let responsePayload = {
        ok: false,
        didBackup: false,
        dryRun: false,
        reasonCodes,
        id: undefined
      };
      let logMeta = {
        url: null,
        title: null,
        convoId: null,
        counts: null,
        candidate: false,
        dryRun: null,
        id: null,
        reasonCodes
      };

      try {
        settings = await getSettingsFresh();
        responsePayload.dryRun = Boolean(settings && settings.DRY_RUN);
        logMeta.dryRun = responsePayload.dryRun;
        activeTab = await getActiveTab();
        if (!activeTab || !activeTab.url || !activeTab.url.startsWith('https://chatgpt.com/')) {
          reasonCodes.push('no_match');
          responsePayload.reasonCodes = [...reasonCodes];
          responsePayload.ok = false;
          responsePayload.message = 'Active tab is not chatgpt.com.';
          return;
        }

        logMeta.url = activeTab.url;
        logMeta.title = activeTab.title || null;

        if (urlMatchesAnyPattern(activeTab.url, settings.SAFE_URL_PATTERNS)) {
          reasonCodes.push('heuristics_safe_url');
          responsePayload.reasonCodes = [...reasonCodes];
          responsePayload.ok = true;
          responsePayload.message = 'SAFE_URL pattern prevents evaluation.';
          return;
        }

        let probeResponse = null;
        try {
          probeResponse = await sendProbeRequest(activeTab.id, traceId);
        } catch (probeError) {
          const messageText = (probeError && probeError.message) || 'Metadata probe failed.';
          reasonCodes.push('no_probe');
          responsePayload.reasonCodes = [...reasonCodes];
          responsePayload.ok = false;
          responsePayload.message = messageText;
          return;
        }

        evaluation = evaluateCandidateFromProbe(probeResponse, settings);
        reasonCodes.push(evaluation.reasonCode);
        responsePayload.reasonCodes = [...reasonCodes];
        logMeta.convoId = evaluation.convoId || null;
        logMeta.counts = evaluation.counts;

        if (!evaluation.ok) {
          responsePayload.ok = true;
          responsePayload.message = 'Conversation not eligible for backup.';
          return;
        }

        logMeta.candidate = true;
        captureResult = await captureAndPersistBackup(activeTab, settings, traceId, {
          fallbackConvoId: evaluation.convoId || null
        });
        reasonCodes.push(captureResult.reasonCode);
        responsePayload.reasonCodes = [...reasonCodes];
        responsePayload.ok = captureResult.ok;
        responsePayload.dryRun = captureResult.dryRun;
        responsePayload.didBackup = captureResult.ok && !captureResult.dryRun;
        if (captureResult.record && captureResult.record.id) {
          responsePayload.id = captureResult.record.id;
          logMeta.id = captureResult.record.id;
        }
        if (!captureResult.ok) {
          responsePayload.message = captureResult.message;
        }

        if (captureResult.logMeta) {
          logMeta = {
            ...logMeta,
            ...captureResult.logMeta
          };
        }
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
        reasonCodes.push('error');
        responsePayload.reasonCodes = [...reasonCodes];
        responsePayload.ok = false;
        responsePayload.message = messageText;
        logMeta = {
          ...logMeta,
          error: messageText
        };
      } finally {
        responsePayload.reasonCodes = [...reasonCodes];
        await Logger.log('info', 'scan', 'Eval-and-backup summary', {
          ...logMeta,
          reasonCodes: [...reasonCodes],
          didBackup: responsePayload.didBackup,
          dryRun: responsePayload.dryRun
        });
        sendResponse(responsePayload);
      }
    })();
    return true;
  }
  if (message && message.type === 'backup_and_delete_active') {
    sendResponse({ ok: false, reasonCode: 'deprecated' });
    return false;
  }

  if (message && message.type === 'delete_backup') {
    sendResponse({ ok: false, reason: 'deprecated' });
    return false;
  }

  if (message && message.type === 'phase1_enqueue_delete') {
    (async () => {
      const traceId = typeof message.traceId === 'string' && message.traceId
        ? message.traceId
        : `hints-search:${Date.now()}`;
      const snapshot = message.snapshot && typeof message.snapshot === 'object'
        ? message.snapshot
        : {};
      const tabTitle = typeof snapshot.tabTitle === 'string' ? snapshot.tabTitle : '';
      let settings = null;
      try {
        settings = await getSettingsFresh();
      } catch (settingsError) {
        await Logger.log('warn', 'settings', 'Phase1 enqueue settings load failed', {
          traceId,
          message: settingsError && settingsError.message ? settingsError.message : String(settingsError)
        });
      }

      try {
        const backupResult = await persistSnapshotRecord(
          {
            title: snapshot.title,
            questionText: snapshot.questionText,
            answerHTML: snapshot.answerHTML,
            convoId: snapshot.convoId
          },
          settings,
          traceId,
          { tabTitle, fallbackConvoId: snapshot.convoId || null }
        );

        const effectiveTitle = (backupResult.record && backupResult.record.title)
          || (typeof snapshot.title === 'string' ? snapshot.title.trim() : '')
          || null;
        const queueResult = await Database.enqueueForDelete({
          title: effectiveTitle,
          convoId: snapshot.convoId || null
        });

        const bytesValue = backupResult && backupResult.logMeta ? backupResult.logMeta.bytes : null;
        if (backupResult && backupResult.record && backupResult.reasonCode === 'backup_ok') {
          console.info(
            `[backup] saved: title="${backupResult.record.title || '(untitled)'}" convoId=${backupResult.record.convoId || 'null'} bytes=${bytesValue || 0}`
          );
        } else {
          console.info(
            `[backup] result: reason=${backupResult.reasonCode || 'unknown'} convoId=${snapshot.convoId || 'null'} bytes=${bytesValue || 0}`
          );
        }

        if (queueResult.enqueued) {
          console.info(
            `[queue] enqueued_for_delete: id=${queueResult.record && queueResult.record.id} title="${queueResult.record && queueResult.record.title ? queueResult.record.title : '(untitled)'}" convoId=${queueResult.record && queueResult.record.convoId ? queueResult.record.convoId : 'null'}`
          );
        } else if (queueResult.record) {
          console.info(
            `[queue] duplicate_skipped: id=${queueResult.record.id} title="${queueResult.record.title || '(untitled)'}" convoId=${queueResult.record.convoId || 'null'}`
          );
        }

        let queueCount = null;
        try {
          queueCount = await Database.countQueued();
        } catch (_countError) {
          queueCount = null;
        }
        try {
          chrome.runtime.sendMessage({
            type: 'deletion_queue_updated',
            count: queueCount
          });
        } catch (_notifyError) {
          /* Slovensky komentar: Ignoruje chybu pri notifikacii popupu. */
        }

        sendResponse({
          ok: true,
          traceId,
          backup: {
            ok: Boolean(backupResult && backupResult.ok),
            reasonCode: backupResult ? backupResult.reasonCode : null,
            recordId: backupResult && backupResult.record && backupResult.record.id ? backupResult.record.id : null
          },
          queue: {
            enqueued: Boolean(queueResult && queueResult.enqueued),
            id: queueResult && queueResult.record && queueResult.record.id ? queueResult.record.id : null,
            duplicate: queueResult && !queueResult.enqueued ? queueResult.record || null : null,
            count: queueCount
          }
        });
      } catch (error) {
        console.error('phase1_enqueue_delete failed', error);
        sendResponse({
          ok: false,
          traceId,
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }

  if (message && message.type === 'deletion_queue_count') {
    (async () => {
      try {
        const count = await Database.countQueued();
        sendResponse({ ok: true, count });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        });
      }
    })();
    return true;
  }

  if (message && message.type === 'bulk_backup_open_tabs') {
    (async () => {
      const summary = {
        timestamp: Date.now(),
        scannedTabs: 0,
        written: [],
        skipped: [],
        stats: {
          candidates: 0,
          safeUrl: 0,
          overMax: 0,
          countsUnknown: 0,
          alreadyBacked: 0,
          noConvoId: 0
        }
      };
      const wouldWrite = [];
      let settings = null;
      let tabs = [];
      let reasonCode = 'bulk_backup_error';

      try {
        settings = await getSettingsFresh();
        tabs = await queryChatgptTabs();
        summary.scannedTabs = tabs.length;
        const dryRun = Boolean(settings && settings.DRY_RUN);
        summary.dryRun = dryRun;

        for (const tab of tabs) {
          const tabId = tab && typeof tab.id === 'number' ? tab.id : null;
          const tabUrl = tab && typeof tab.url === 'string' ? tab.url : '';
          if (!tabId) {
            summary.skipped.push({ tabId: null, url: tabUrl || null, reason: 'tab_missing' });
            continue;
          }
          const matchesSafe = tabUrl ? urlMatchesAnyPattern(tabUrl, settings.SAFE_URL_PATTERNS) : false;
          if (!tabUrl || matchesSafe) {
            if (matchesSafe) {
              summary.stats.safeUrl += 1;
              summary.skipped.push({ tabId, url: tabUrl, reason: 'safe_url' });
            } else {
              summary.skipped.push({ tabId, url: tabUrl || null, reason: 'url_missing' });
            }
            continue;
          }

          let evaluation = {
            ok: false,
            reasonCode: 'counts_unknown',
            counts: { total: null, user: null, assistant: null },
            convoId: null
          };
          try {
            const probeResponse = await sendProbeRequest(tabId, `bulk:${Date.now()}`);
            evaluation = evaluateCandidateFromProbe(probeResponse, settings);
          } catch (probeError) {
            evaluation.reasonCode = 'counts_unknown';
            await Logger.log('warn', 'scan', 'Bulk backup probe failed', {
              tabId,
              url: tabUrl,
              message: probeError && probeError.message
            });
          }

          if (!evaluation.ok) {
            if (evaluation.reasonCode === 'over_max' || evaluation.reasonCode === 'user_over_limit') {
              summary.stats.overMax += 1;
              summary.skipped.push({ tabId, url: tabUrl, reason: 'over_max' });
            } else {
              summary.stats.countsUnknown += 1;
              summary.skipped.push({ tabId, url: tabUrl, reason: 'counts_unknown' });
            }
            continue;
          }

          const convoId = evaluation.convoId || null;
          if (!convoId) {
            summary.stats.noConvoId += 1;
            summary.skipped.push({ tabId, url: tabUrl, reason: 'no_convoid' });
            continue;
          }

          summary.stats.candidates += 1;

          let existingRecord = null;
          try {
            existingRecord = await Database.getBackupByConvoId(convoId);
          } catch (lookupError) {
            await Logger.log('warn', 'db', 'Bulk backup lookup failed', {
              convoId,
              message: lookupError && lookupError.message
            });
            summary.skipped.push({ tabId, url: tabUrl, reason: 'lookup_error' });
            continue;
          }

          if (existingRecord) {
            summary.stats.alreadyBacked += 1;
            summary.skipped.push({ tabId, url: tabUrl, reason: 'already_backed_up' });
            continue;
          }

          let capturePayload = null;
          try {
            capturePayload = await sendCaptureRequest(tabId, `bulk:${Date.now()}`);
          } catch (captureError) {
            await Logger.log('warn', 'scan', 'Bulk backup capture failed', {
              convoId,
              tabId,
              message: captureError && captureError.message
            });
            summary.skipped.push({ tabId, url: tabUrl, reason: 'capture_error' });
            continue;
          }

          if (!capturePayload || !capturePayload.ok) {
            summary.skipped.push({ tabId, url: tabUrl, reason: 'capture_error' });
            continue;
          }

          const now = Date.now();
          const questionText = capturePayload.questionText && typeof capturePayload.questionText === 'string'
            ? capturePayload.questionText.trim()
            : null;
          const answerRaw = capturePayload.answerHTML && typeof capturePayload.answerHTML === 'string'
            ? capturePayload.answerHTML
            : '';
          const truncateResult = truncateAnswerHtml(answerRaw);
          const questionLength = questionText ? questionText.length : 0;
          const summaryEntry = {
            tabId,
            url: tabUrl,
            convoId: capturePayload.convoId || convoId,
            qLen: questionLength,
            aLen: truncateResult.bytes,
            truncated: truncateResult.truncated,
            id: null
          };

          if (dryRun) {
            wouldWrite.push(summaryEntry);
            continue;
          }

          const record = {
            id:
              typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `bulk-${now}-${tabId}`,
            title:
              capturePayload.title && typeof capturePayload.title === 'string' && capturePayload.title.trim()
                ? capturePayload.title.trim()
                : questionText
                ? questionText.slice(0, 80)
                : null,
            questionText: questionText || null,
            answerHTML: truncateResult.value || null,
            timestamp: now,
            category: null,
            convoId: capturePayload.convoId || convoId,
            answerTruncated: truncateResult.truncated
          };

          try {
            const savedId = await Database.saveBackup(record);
            summaryEntry.id = savedId || record.id;
            summary.written.push(summaryEntry);
          } catch (writeError) {
            await Logger.log('error', 'db', 'Bulk backup persist failed', {
              convoId: record.convoId,
              message: writeError && writeError.message
            });
            summary.skipped.push({ tabId, url: tabUrl, reason: 'write_error' });
          }
        }

        summary.timestamp = Date.now();

        if (dryRun) {
          summary.written = [];
          summary.wouldWrite = wouldWrite;
        }

        const responseReason = dryRun ? 'bulk_backup_dry_run' : 'bulk_backup_ok';
        summary.reasonCode = responseReason;

        const payloadForStorage = { ...summary };
        if (!dryRun) {
          delete payloadForStorage.wouldWrite;
        }

        try {
          await chrome.storage.local.set({ last_bulk_backup: payloadForStorage });
        } catch (storageError) {
          await Logger.log('warn', 'db', 'Bulk backup summary store failed', {
            message: storageError && storageError.message
          });
        }

        reasonCode = responseReason;
        await Logger.log('info', 'db', 'Bulk backup run finished', {
          reasonCode,
          scannedTabs: summary.scannedTabs,
          written: summary.written.length,
          wouldWrite: dryRun ? wouldWrite.length : 0,
          skipped: summary.skipped.length,
          stats: summary.stats,
          dryRun
        });

        sendResponse({ ok: true, summary, dryRun, reasonCode: responseReason });

        try {
          chrome.runtime.sendMessage({ type: 'bulk_backup_summary', summary });
        } catch (_broadcastError) {
          // Slovensky komentar: Broadcast chyba sa ignoruje.
        }

        if (!dryRun && summary.written.length) {
          try {
            chrome.runtime.sendMessage(
              {
                type: 'backups_updated',
                reason: 'bulk_backup',
                timestamp: Date.now(),
                count: summary.written.length
              },
              () => {
                const runtimeError = chrome.runtime.lastError;
                if (runtimeError) {
                  // Slovensky komentar: Ignoruje sa, ak nikto nepocuva.
                }
              }
            );
          } catch (_notifyError) {
            // Slovensky komentar: Broadcast zlyhanie je tiché.
          }
        }
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
        summary.error = messageText;
        await Logger.log('error', 'db', 'Bulk backup run failed', {
          reasonCode,
          message: messageText
        });
        sendResponse({ ok: false, error: messageText, summary });
      }
    })();
    return true;
  }
  return undefined;
});

