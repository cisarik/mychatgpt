import {
  computeEligibility,
  DEFAULT_SETTINGS,
  delay,
  focusTab,
  getActiveChatgptTab,
  getConvoIdFromUrl,
  getConvoUrl,
  normalizeSettings,
  randomBetween,
  SETTINGS_KEY
} from './utils.js';
import * as db from './db.js';

let settingsCache = { ...DEFAULT_SETTINGS };
let deletionRun = null;

bootstrap();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }
  (async () => {
    switch (message.type) {
      case 'captureActiveTabNow':
        return captureActiveTabNow();
      case 'scanAllChatgptTabs':
        return scanAllChatgptTabs();
      case 'getList':
        return getList(Boolean(message.showAll));
      case 'deleteSelected':
        return deleteSelected(message.convoIds || [], message.cancel);
      case 'deleteCurrentTab':
        return deleteCurrentTab();
      case 'probeActiveTab':
        return probeActiveTab();
      case 'reEvaluateSelected':
        return reEvaluateSelected(message.convoIds);
      default:
        return { ok: false, error: 'unsupported_message' };
    }
  })()
    .then((response) => sendResponse(response || { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || 'unexpected_error' }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => bootstrap());

async function bootstrap() {
  await db.init();
  await ensureSettings();
}

async function ensureSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  if (stored?.[SETTINGS_KEY]) {
    settingsCache = normalizeSettings(stored[SETTINGS_KEY]);
  } else {
    settingsCache = { ...DEFAULT_SETTINGS };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
  }
}

async function captureActiveTabNow() {
  let tab;
  try {
    tab = await getActiveChatgptTab();
  } catch (error) {
    return { ok: false, error: error?.message || 'no_active_chatgpt_tab' };
  }
  if (!tab || !/^https:\/\/chatgpt\.com\/c\//.test(tab.url || '')) {
    return { ok: false, error: 'not_conversation_tab' };
  }
  await focusTab(tab.id, tab.windowId);
  await injectCaptureModule(tab.id);
  const res = await callCapture(tab.id).catch((error) => ({ ok: false, error: error?.message || String(error) }));
  if (!res?.ok) {
    return { ok: false, error: res?.error || 'capture_failed' };
  }
  const stored = await persistCapture(res.payload);
  await notifyListUpdated();
  return { ok: true, item: stored };
}

async function scanAllChatgptTabs() {
  const tabs = await getAllChatgptTabs();
  const storedItems = [];
  for (const tab of tabs) {
    if (!/^https:\/\/chatgpt\.com\/c\//.test(tab.url || '')) {
      continue;
    }
    try {
      await focusTab(tab.id, tab.windowId);
      await injectCaptureModule(tab.id);
      const res = await callCapture(tab.id);
      if (res?.ok) {
        const stored = await persistCapture(res.payload);
        storedItems.push(stored);
        await notifyListUpdated();
      }
    } catch (error) {
      console.warn('[Cleaner][bg] capture_tab_fail', tab.id, error?.message || error);
    }
    await delay(randomBetween(100, 200));
  }
  return { ok: true, items: storedItems };
}

async function getList(showAll) {
  const items = await db.getAll();
  if (showAll) {
    return { ok: true, items };
  }
  return { ok: true, items: items.filter((item) => item.eligible && !item.deletedAt) };
}

async function deleteSelected(convoIds, cancel) {
  if (cancel) {
    if (deletionRun && deletionRun.active) {
      deletionRun.cancelled = true;
      return { ok: true, cancelled: true };
    }
    return { ok: false, error: 'no_deletion_running' };
  }
  if (!Array.isArray(convoIds) || !convoIds.length) {
    return { ok: false, error: 'empty_selection' };
  }
  if (deletionRun && deletionRun.active) {
    return { ok: false, error: 'deletion_in_progress' };
  }
  if (!settingsCache.risky.enabled) {
    return { ok: false, error: 'risky_disabled' };
  }
  deletionRun = { active: true, cancelled: false };
  const items = await db.getMany(convoIds);
  const total = items.length;
  let done = 0;
  let okCount = 0;
  let failCount = 0;
  for (const item of items) {
    if (deletionRun.cancelled) {
      break;
    }
    const convoId = item.convoId;
    try {
      const { tabId, windowId } = await ensureConversationTab(convoId);
      await focusTab(tabId, windowId);
      const probeOutcome = await runAutomation(tabId, 'probe', {
        convoId,
        profile: {},
        settings: settingsCache.risky
      });
      if (!probeOutcome?.header || !probeOutcome?.menu || !probeOutcome?.confirm) {
        failCount += 1;
        await db.update(convoId, {
          lastDeletionAttemptAt: new Date().toISOString(),
          lastDeletionOutcome: 'fail',
          lastDeletionReason: probeOutcome?.error || 'probe_failed'
        });
        await notifyListUpdated();
      } else {
        const deleteOutcome = await runAutomation(tabId, 'runDelete', {
          convoId,
          profile: {},
          settings: settingsCache.risky
        });
        if (deleteOutcome?.ok) {
          okCount += 1;
          await db.update(convoId, {
            lastDeletionAttemptAt: new Date().toISOString(),
            lastDeletionOutcome: 'ok',
            lastDeletionReason: 'verify_ok',
            deletedAt: Date.now()
          });
          await notifyListUpdated();
        } else {
          failCount += 1;
          await db.update(convoId, {
            lastDeletionAttemptAt: new Date().toISOString(),
            lastDeletionOutcome: 'fail',
            lastDeletionReason: deleteOutcome?.reason || deleteOutcome?.code || 'delete_failed'
          });
        }
      }
    } catch (error) {
      failCount += 1;
      await db.update(convoId, {
        lastDeletionAttemptAt: new Date().toISOString(),
        lastDeletionOutcome: 'fail',
        lastDeletionReason: error?.message || 'exception'
      });
    }
    done += 1;
    chrome.runtime.sendMessage({
      type: 'deleteProgress',
      payload: {
        done,
        total,
        ok: okCount,
        fail: failCount
      }
    });
    await delay(settingsCache.risky.risky_between_tabs_ms);
  }
  deletionRun.active = false;
  chrome.runtime.sendMessage({
    type: 'deleteProgress',
    payload: {
      done,
      total,
      ok: okCount,
      fail: failCount
    }
  });
  await notifyListUpdated();
  return { ok: true, done, total, cancelled: deletionRun.cancelled };
}

async function deleteCurrentTab() {
  if (!settingsCache.risky?.enabled) {
    return { ok: false, error: 'risky_disabled' };
  }
  let tab;
  try {
    tab = await getActiveChatgptTab();
  } catch (error) {
    console.log('[RiskyMode][bg]', 'active_tab_fail', error?.message || 'no_active_tab');
    return { ok: false, error: error?.message || 'no_active_chatgpt_tab' };
  }
  const convoId = getConvoIdFromUrl(tab.url);
  if (!convoId) {
    return { ok: false, error: 'no_convo_id' };
  }
  await focusTab(tab.id, tab.windowId);
  let probeOutcome;
  try {
    probeOutcome = await runAutomation(tab.id, 'probe', {
      convoId,
      profile: {},
      settings: settingsCache.risky
    });
  } catch (error) {
    console.log('[RiskyMode][bg]', 'probe_error', convoId, error?.message || 'probe_exception');
    await db.update(convoId, {
      lastDeletionAttemptAt: new Date().toISOString(),
      lastDeletionOutcome: 'fail',
      lastDeletionReason: error?.message || 'probe_failed'
    });
    await notifyListUpdated();
    return { ok: false, error: 'probe_failed', reason: error?.message || 'probe_failed' };
  }
  if (!probeOutcome?.header || !probeOutcome?.menu || !probeOutcome?.confirm) {
    console.log('[RiskyMode][bg]', 'probe_fail', convoId, probeOutcome?.error || 'probe_failed');
    await db.update(convoId, {
      lastDeletionAttemptAt: new Date().toISOString(),
      lastDeletionOutcome: 'fail',
      lastDeletionReason: probeOutcome?.error || 'probe_failed'
    });
    await notifyListUpdated();
    return {
      ok: false,
      error: 'probe_failed',
      reason: probeOutcome?.error || 'probe_failed'
    };
  }
  let deleteOutcome;
  try {
    deleteOutcome = await runAutomation(tab.id, 'runDelete', {
      convoId,
      profile: {},
      settings: settingsCache.risky
    });
  } catch (error) {
    console.log('[RiskyMode][bg]', 'delete_exec_fail', convoId, error?.message || 'delete_exception');
    await db.update(convoId, {
      lastDeletionAttemptAt: new Date().toISOString(),
      lastDeletionOutcome: 'fail',
      lastDeletionReason: error?.message || 'delete_failed'
    });
    await notifyListUpdated();
    return { ok: false, error: 'delete_failed', reason: error?.message || 'delete_failed' };
  }
  if (deleteOutcome?.ok) {
    await db.update(convoId, {
      lastDeletionAttemptAt: new Date().toISOString(),
      lastDeletionOutcome: 'ok',
      lastDeletionReason: 'verify_ok',
      deletedAt: Date.now()
    });
    await notifyListUpdated();
    console.log('[RiskyMode][bg]', 'delete_ok', convoId);
    return { ok: true };
  }
  await db.update(convoId, {
    lastDeletionAttemptAt: new Date().toISOString(),
    lastDeletionOutcome: 'fail',
    lastDeletionReason: deleteOutcome?.reason || deleteOutcome?.code || 'delete_failed'
  });
  await notifyListUpdated();
  console.log('[RiskyMode][bg]', 'delete_fail', convoId, deleteOutcome?.code || deleteOutcome?.reason || 'unknown');
  return {
    ok: false,
    error: 'delete_failed',
    code: deleteOutcome?.code || 'delete_failed',
    reason: deleteOutcome?.reason || 'delete_failed'
  };
}

async function probeActiveTab() {
  const tab = await getActiveChatgptTab();
  await focusTab(tab.id, tab.windowId);
  const result = await runAutomation(tab.id, 'probe', {
    convoId: getConvoIdFromUrl(tab.url),
    profile: {},
    settings: settingsCache.risky
  });
  return { ok: true, result };
}

async function reEvaluateSelected(convoIds) {
  const items = Array.isArray(convoIds) && convoIds.length ? await db.getMany(convoIds) : await db.getAll();
  for (const item of items) {
    const evaluation = computeEligibility(item, settingsCache);
    await db.update(item.convoId, {
      eligible: evaluation.eligible,
      eligibilityReason: evaluation.reason || null
    });
  }
  await notifyListUpdated();
  return { ok: true };
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
    func: async () => {
      if (!window.__MYCHAT_CAPTURE__) {
        throw new Error('capture_api_missing');
      }
      return await window.__MYCHAT_CAPTURE__.captureNow();
    }
  });
  return result;
}

async function persistCapture(payload) {
  const evaluation = computeEligibility(payload, settingsCache);
  const stored = await db.put({
    ...payload,
    eligible: evaluation.eligible,
    eligibilityReason: evaluation.reason || null
  });
  return stored;
}

async function notifyListUpdated() {
  chrome.runtime.sendMessage({ type: 'listUpdated' });
}

async function getAllChatgptTabs() {
  return chrome.tabs.query({ url: 'https://chatgpt.com/*' });
}

async function ensureConversationTab(convoId) {
  const url = getConvoUrl(convoId);
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    const tab = existing[0];
    if (tab.status !== 'complete') {
      await waitForTabReady(tab.id);
    }
    return { tabId: tab.id, windowId: tab.windowId };
  }
  const created = await chrome.tabs.create({ url, active: false });
  await waitForTabReady(created.id);
  return { tabId: created.id, windowId: created.windowId };
}

async function runAutomation(tabId, method, args) {
  const result = await execInTab(tabId, method, args);
  if (!result.ok) {
    throw new Error(result.err || 'automation_failed');
  }
  return result.value;
}

async function execInTab(tabId, method, args) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['automation/header.js'],
      world: 'ISOLATED'
    });
    if (!method) {
      return { ok: true };
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (name, payload) => {
        const api = window.__MYCHAT_HEADER__;
        if (!api || typeof api[name] !== 'function') {
          return { ok: false, error: 'missing_method' };
        }
        return api[name](payload);
      },
      args: [method, args]
    });
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, err: error?.message || 'exec_failed' };
  }
}

async function waitForTabReady(tabId) {
  const timeout = 15000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_error) {
      throw new Error('tab_closed');
    }
    if (tab.status === 'complete') {
      return;
    }
    await delay(150);
  }
}
