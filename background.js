/* Slovensky komentar: Servisny worker inicializuje databazu, nastavenia a obsluhuje stub skenovania. */
importScripts('utils.js', 'db.js');

/* Slovensky komentar: Nazov storage kluca pre cooldown je zdieľaný cez utils. */
const COOLDOWN_KEY = typeof COOLDOWN_STORAGE_KEY !== 'undefined' ? COOLDOWN_STORAGE_KEY : 'cooldown_v1';

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

/* Slovensky komentar: Odošle ping na obsahový skript a vrati odpoved. */
function sendPingRequest(tabId, traceId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: 'ping',
        traceId,
        want: { url: true, title: true, markers: true }
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || 'sendMessage failed'));
          return;
        }
        resolve(response || null);
      }
    );
  });
}

/* Slovensky komentar: Odošle poziadavku na citanie metadata bez zasahu do DOM. */
function sendProbeRequest(tabId, traceId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: 'probe_metadata',
        traceId,
        want: { url: true, title: true, ids: true, counts: true }
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || 'sendMessage failed'));
          return;
        }
        resolve(response || null);
      }
    );
  });
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
      let cooldownReport = { lastScanAt: null, minutes: null, wouldWait: false, remainingMs: 0 };
      let payload = null;
      let errorMessage = null;

      try {
        const { settings } = await SettingsStore.load();
        const { lastScanAt } = await readCooldownSnapshot();
        const cooldownMinutes = settings.SCAN_COOLDOWN_MIN;
        const cooldownState = shouldCooldown(lastScanAt, cooldownMinutes);
        cooldownReport = {
          lastScanAt,
          minutes: cooldownMinutes,
          wouldWait: cooldownState.cooldown,
          remainingMs: cooldownState.remainingMs
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
          decision.reasonCodes.push('safe_url');
          decision.snapshot.url = activeTab.url;
          decision.snapshot.title = activeTab.title || null;
          logReasonCode = 'safe_url';
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
        const timestamp = Date.now();
        await writeCooldownTimestamp(timestamp);
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
        const { settings } = await SettingsStore.load();
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
        const { settings } = await SettingsStore.load();
        if (urlMatchesAnyPattern(activeTab.url, settings.SAFE_URL_PATTERNS)) {
          reasonCode = 'safe_url';
          const payload = {
            ok: true,
            traceId,
            url: activeTab.url,
            title: activeTab.title || null,
            convoId: null,
            counts: { total: null, user: null, assistant: null },
            markers: { hasAppRoot: false, hasComposer: false, guessChatView: false },
            skipped: true,
            reason: 'safe_url_pattern'
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
  return undefined;
});

