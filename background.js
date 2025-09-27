/* Slovensky komentar: Servisny worker inicializuje databazu, nastavenia a obsluhuje stub skenovania. */
importScripts('utils.js', 'db.js');

/* Slovensky komentar: Nazov storage kluca pre cooldown je zdieľaný cez utils. */
const COOLDOWN_KEY = typeof COOLDOWN_STORAGE_KEY !== 'undefined' ? COOLDOWN_STORAGE_KEY : 'cooldown_v1';
/* Slovensky komentar: Limit na velkost HTML odpovede pre zalohu. */
const MAX_ANSWER_BYTES = 250 * 1024;

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
    ['LIST_ONLY', 'DRY_RUN', 'CONFIRM_BEFORE_DELETE', 'AUTO_SCAN', 'SHOW_CANDIDATE_BADGE', 'CAPTURE_ONLY_CANDIDATES'].forEach((key) => {
      if (typeof raw[key] === 'boolean') {
        merged[key] = raw[key];
      } else {
        merged[key] = defaults[key];
      }
    });
    ['MAX_MESSAGES', 'USER_MESSAGES_MAX', 'SCAN_COOLDOWN_MIN', 'MIN_AGE_MINUTES', 'DELETE_LIMIT'].forEach((key) => {
      const value = Number(raw[key]);
      merged[key] = Number.isFinite(value) && value >= 1 ? Math.floor(value) : defaults[key];
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
        const activeTab = await getActiveTab();
        if (!activeTab || !activeTab.url || !activeTab.url.startsWith('https://chatgpt.com/')) {
          reasonCode = 'backup_no_match';
          responsePayload = {
            ok: false,
            reasonCode,
            message: 'Active tab is not chatgpt.com.',
            record: null
          };
          return;
        }

        if (urlMatchesAnyPattern(activeTab.url, settings.SAFE_URL_PATTERNS)) {
          reasonCode = 'backup_safe_url';
          responsePayload = {
            ok: false,
            reasonCode,
            message: 'SAFE_URL pattern prevents capture.',
            record: null
          };
          return;
        }

        let convoId = null;
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
              record: null
            };
            return;
          }
          const evaluation = evaluateCandidateFromProbe(probeResponse, settings);
          convoId = evaluation.convoId || null;
          if (!evaluation.ok) {
            reasonCode = 'backup_not_candidate';
            responsePayload = {
              ok: false,
              reasonCode,
              message: 'Not a short chat (over limits).',
              record: null
            };
            logMeta = {
              ...logMeta,
              convoId,
              counts: evaluation.counts
            };
            return;
          }
        }

        let capturePayload = null;
        try {
          capturePayload = await sendCaptureRequest(activeTab.id, traceId);
        } catch (captureError) {
          reasonCode = 'backup_capture_error';
          responsePayload = {
            ok: false,
            reasonCode,
            message: (captureError && captureError.message) || 'Capture failed.',
            record: null
          };
          return;
        }

        if (!capturePayload || !capturePayload.ok) {
          reasonCode = 'backup_capture_error';
          const captureMessage = capturePayload && capturePayload.error ? capturePayload.error : 'Capture unavailable.';
          responsePayload = {
            ok: false,
            reasonCode,
            message: captureMessage,
            record: null
          };
          return;
        }

        const now = Date.now();
        const questionText = capturePayload.questionText && typeof capturePayload.questionText === 'string'
          ? capturePayload.questionText.trim()
          : null;
        const answerHtmlRaw = capturePayload.answerHTML && typeof capturePayload.answerHTML === 'string'
          ? capturePayload.answerHTML
          : null;
        const titleCandidate = capturePayload.title && typeof capturePayload.title === 'string'
          ? capturePayload.title.trim()
          : '';
        const safeTitle = titleCandidate || (questionText ? questionText.slice(0, 80) : '');
        const truncateResult = truncateAnswerHtml(answerHtmlRaw || '');
        const questionLength = questionText ? questionText.length : 0;
        const answerLength = truncateResult.value ? truncateResult.value.length : 0;
        const backupRecord = {
          id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `backup-${now}`,
          title: safeTitle ? safeTitle : null,
          questionText: questionText || null,
          answerHTML: truncateResult.value || null,
          timestamp: now,
          category: null,
          convoId: capturePayload.convoId || convoId || null,
          answerTruncated: truncateResult.truncated
        };
        logMeta = {
          convoId: backupRecord.convoId,
          qLen: questionLength,
          aLen: answerLength,
          truncated: truncateResult.truncated,
          id: backupRecord.id
        };

        if (settings.DRY_RUN) {
          reasonCode = 'backup_dry_run';
          responsePayload = {
            ok: true,
            reasonCode,
            message: 'Dry run: not persisted.',
            record: backupRecord,
            dryRun: true
          };
          return;
        }

        try {
          await Database.saveBackup(backupRecord);
          reasonCode = 'backup_ok';
          responsePayload = {
            ok: true,
            reasonCode,
            message: 'Backup stored successfully.',
            record: backupRecord,
            dryRun: false
          };
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
                  // Slovensky komentar: Ignorujeme chybu pri broadcastovani.
                }
              }
            );
          } catch (_broadcastError) {
            // Slovensky komentar: Broadcast chyba je tichá.
          }
        } catch (writeError) {
          reasonCode = 'backup_write_error';
          responsePayload = {
            ok: false,
            reasonCode,
            message: 'Failed to persist backup.',
            record: null
          };
          logMeta = {
            ...logMeta,
            error: writeError && writeError.message ? writeError.message : String(writeError)
          };
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        reasonCode = reasonCode === 'backup_capture_error' ? reasonCode : 'backup_capture_error';
        responsePayload = {
          ok: false,
          reasonCode,
          message,
          record: null
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
  return undefined;
});

