import {
  computeEligibility,
  normalizeSettings,
  SETTINGS_KEY,
  focusTab,
  sleep,
  randomBetween,
  logBg
} from './utils.js';
import * as db from './db.js';

let settingsCache = normalizeSettings();

bootstrap();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }
  if (message.type === 'getList') {
    (async () => {
      try {
        const items = await db.getAll();
        sendResponse({ ok: true, items });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'get_list_failed' });
      }
    })();
    return true;
  }
  if (message.type === 'refreshAll') {
    (async () => {
      try {
        const result = await refreshAll();
        sendResponse(result);
      } catch (error) {
        logBg('refresh_error', error?.message || error);
        sendResponse({ ok: false, error: error?.message || 'refresh_failed' });
      }
    })();
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  bootstrap();
});

async function bootstrap() {
  await db.init();
  await ensureSettings();
}

async function ensureSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  if (stored?.[SETTINGS_KEY]) {
    settingsCache = normalizeSettings(stored[SETTINGS_KEY]);
  } else {
    settingsCache = normalizeSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
  }
}

async function refreshAll() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/c/*' });
  const stats = { backedUpOnly: 0, deleted: 0, skipped: 0, failed: 0 };
  for (const tab of tabs) {
    await processTab(tab, stats);
    const pause = settingsCache.risky.enabled
      ? settingsCache.risky.risky_between_tabs_ms
      : randomBetween(80, 120);
    if (pause > 0) {
      await sleep(pause);
    }
  }
  await notifyListUpdated();
  await notifySummary(stats);
  return { ok: true, stats };
}

async function processTab(tab, stats) {
  if (!tab?.id) {
    return;
  }
  try {
    await focusTab(tab.id, tab.windowId);
  } catch (error) {
    logBg('focus_fail', tab.id, error?.message || error);
    stats.failed += 1;
    return;
  }

  let capturePayload;
  try {
    await injectCaptureModule(tab.id);
    const captureResult = await callCapture(tab.id);
    if (!captureResult?.ok) {
      throw new Error(captureResult?.error || 'capture_failed');
    }
    capturePayload = captureResult.payload;
  } catch (error) {
    logBg('capture_fail', tab.id, error?.message || error);
    stats.failed += 1;
    return;
  }

  if (!capturePayload?.convoId) {
    logBg('capture_no_convo', tab.id);
    stats.failed += 1;
    return;
  }

  const evaluation = computeEligibility(capturePayload, settingsCache);
  let stored;
  try {
    stored = await db.put({
      ...capturePayload,
      eligible: evaluation.eligible,
      eligibilityReason: evaluation.reason || null
    });
  } catch (error) {
    logBg('store_fail', capturePayload.convoId, error?.message || error);
    stats.failed += 1;
    return;
  }

  if (!evaluation.eligible) {
    stats.skipped += 1;
    return;
  }

  const hadBackup = stored.backupSaved === true;
  if (!hadBackup) {
    stored = (await db.update(stored.convoId, { backupSaved: true })) || stored;
  }

  if (!settingsCache.risky.enabled) {
    if (!hadBackup) {
      stats.backedUpOnly += 1;
    }
    return;
  }

  if (hadBackup) {
    return;
  }

  const deletion = await runHeaderDelete(tab.id, stored.convoId);
  if (deletion.ok) {
    stats.deleted += 1;
    await db.update(stored.convoId, {
      lastDeletionOutcome: 'ok',
      lastDeletionReason: 'verify_ok',
      deletedAt: Date.now()
    });
    logBg('delete_ok', stored.convoId);
  } else {
    stats.failed += 1;
    await db.update(stored.convoId, {
      lastDeletionOutcome: 'fail',
      lastDeletionReason: deletion.reason || deletion.code || 'delete_failed'
    });
    logBg('delete_fail', stored.convoId, deletion.reason || deletion.code || 'delete_failed');
  }
}

async function injectCaptureModule(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['automation/capture.js']
  });
}

async function callCapture(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => {
      if (!window.__MYCHAT_CAPTURE__) {
        throw new Error('capture_api_missing');
      }
      return window.__MYCHAT_CAPTURE__.captureNow();
    }
  });
  return result;
}

async function runHeaderDelete(tabId, convoId) {
  try {
    await injectHeaderModule(tabId);
  } catch (error) {
    logBg('header_inject_fail', tabId, error?.message || error);
    return { ok: false, reason: 'header_inject_failed' };
  }

  let probe;
  try {
    probe = await callHeader(tabId, 'probe', { settings: settingsCache.risky });
  } catch (error) {
    logBg('probe_fail', tabId, error?.message || error);
    return { ok: false, reason: error?.message || 'probe_failed' };
  }

  if (!probe?.header || !probe?.menu || !probe?.confirm) {
    return { ok: false, reason: probe?.error || 'probe_failed' };
  }

  try {
    const outcome = await callHeader(tabId, 'runDelete', {
      convoId,
      settings: settingsCache.risky
    });
    if (outcome?.ok) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: outcome?.reason || outcome?.code || 'delete_failed',
      code: outcome?.code
    };
  } catch (error) {
    return { ok: false, reason: error?.message || 'delete_failed' };
  }
}

async function injectHeaderModule(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['automation/header.js']
  });
}

async function callHeader(tabId, method, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (name, payload) => {
      const api = window.__MYCHAT_HEADER__;
      if (!api || typeof api[name] !== 'function') {
        throw new Error('missing_method');
      }
      return api[name](payload);
    },
    args: [method, args]
  });
  return result;
}

async function notifyListUpdated() {
  try {
    await chrome.runtime.sendMessage({ type: 'listUpdated' });
  } catch (_error) {
    /* ignoruj tiché chyby */
  }
}

async function notifySummary(stats) {
  try {
    await chrome.runtime.sendMessage({ type: 'refreshSummary', stats });
  } catch (_error) {
    /* ignoruj tiché chyby */
  }
}
