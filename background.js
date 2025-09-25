import { initDb, backups } from './db.js';
import { log, logTrace, logDebug, logInfo, logWarn, logError, minutesSince } from './utils.js';

const SETTINGS_KEY = 'settings';
const DEFAULT_SETTINGS = {
  LIST_ONLY: true,
  DRY_RUN: true,
  CONFIRM_BEFORE_DELETE: true,
  AUTO_SCAN: true,
  COOLDOWN_MIN: 5,
  MAX_MESSAGES: 2,
  USER_MESSAGES_MAX: 2,
  MIN_AGE_MINUTES: 2,
  DELETE_LIMIT: 10,
  SAFE_URL_PATTERNS: ['/workspaces', '/projects', '/new-project'],
  ALLOW_LOCAL_BACKUP_WHEN_LIST_ONLY: false,
  DEBUG_LEVEL: 'INFO',
  TRACE_EXTRACTOR: false,
  TRACE_RUNNER: false,
  REDACT_TEXT_IN_DIAGNOSTICS: true,
  DIAGNOSTICS_SAFE_SNAPSHOT: false
};

const cooldownMemory = {
  lastRun: 0
};

const SCAN_DELAY_MS = 1000;
const INJECT_RETRY_DELAY_MS = 150;

let scheduledScan = null;
let scheduledTimer = null;

const RUNNER_SCOPE = 'runner';
const CHAT_URL_PREFIX = 'https://chatgpt.com';
const CHAT_URL_PATTERN = 'https://chatgpt.com/*';

const runnerTrace = (msg, meta = {}) => logTrace(RUNNER_SCOPE, msg, meta);
const runnerDebug = (msg, meta = {}) => logDebug(RUNNER_SCOPE, msg, meta);
const runnerInfo = (msg, meta = {}) => logInfo(RUNNER_SCOPE, msg, meta);
const runnerWarn = (msg, meta = {}) => logWarn(RUNNER_SCOPE, msg, meta);
const runnerError = (msg, meta = {}) => logError(RUNNER_SCOPE, msg, meta);

function isChatUrl(url) {
  return typeof url === 'string' && url.startsWith(CHAT_URL_PREFIX);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withReason(reasonCode, extra = {}) {
  return { ...extra, reasonCode };
}

function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (!Array.isArray(merged.SAFE_URL_PATTERNS)) {
    merged.SAFE_URL_PATTERNS = String(merged.SAFE_URL_PATTERNS || '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
  }
  return merged;
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap('install');
  injectIntoOpenChatTabs();
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap('startup');
  injectIntoOpenChatTabs();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') {
    return;
  }
  const url = tab?.url || '';
  if (isChatUrl(url)) {
    await injectContentScriptIfNeeded(tabId);
  }
  scheduleTabScan({ tabId, url, trigger: 'tab-updated' });
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url || '';
    if (isChatUrl(url)) {
      await injectContentScriptIfNeeded(tabId);
    }
    scheduleTabScan({ tabId, url, trigger: 'tab-activated' });
  } catch (error) {
    await runnerWarn('Failed to inspect activated tab', withReason('tab_lookup_failed', { error: error?.message }));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'scanNow') {
    handleScanRequest({
      trigger: 'manual-scan',
      bypassCooldown: true,
      manual: false,
      sendResponse
    });
    return true;
  }

  if (message?.type === 'manualBackup') {
    handleScanRequest({
      trigger: 'popup-manual-backup',
      bypassCooldown: true,
      manual: true,
      sendResponse
    });
    return true;
  }

  if (message?.type === 'getSettings') {
    getSettings()
      .then((settings) => sendResponse({ settings }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === 'ensureSettings') {
    ensureSettings()
      .then((settings) => sendResponse({ settings }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === 'RUN_DEBUG_PROBE') {
    (async () => {
      try {
        const settings = await getSettings();
        const tab = await getActiveChatTab();
        if (!tab) {
          await runnerWarn('Debug probe requested but no active chat tab', withReason('no_active_tab', {
            trigger: 'debug-manual'
          }));
          sendResponse({ ok: false, error: 'no-active-chat-tab' });
          return;
        }
        const probe = await runDebugProbeForDiagnostics({
          tabId: tab.id,
          trigger: 'debug-manual',
          url: tab.url,
          reason: 'manual',
          saveSnapshot: Boolean(settings.DIAGNOSTICS_SAFE_SNAPSHOT)
        });
        sendResponse({ ok: Boolean(probe), probe: probe || null });
      } catch (error) {
        await runnerError('Manual debug probe failed', withReason('probe_failed', {
          trigger: 'debug-manual',
          error: error?.message
        }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'FORCE_INJECT') {
    (async () => {
      try {
        const tab = await getActiveChatTab();
        if (!tab) {
          await runnerWarn('Force inject requested but no active chat tab', withReason('no_active_tab', {
            trigger: 'debug-force-inject'
          }));
          sendResponse({ ok: false, error: 'no-active-chat-tab' });
          return;
        }
        const injected = await injectContentScriptIfNeeded(tab.id);
        sendResponse({ ok: Boolean(injected) });
      } catch (error) {
        await runnerWarn('Force inject handling failed', withReason('inject_attempt', {
          outcome: 'error',
          error: error?.message,
          trigger: 'debug-force-inject'
        }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'mychatgpt:log') {
    log(message.level || 'info', message.scope || 'general', message.msg || 'Event', message.meta).finally(() =>
      sendResponse({ ok: true })
    );
    return true;
  }
  return undefined;
});

async function bootstrap(reason) {
  try {
    await initDb();
    const settings = await ensureSettings();
    await runnerInfo('Service worker ready', withReason('boot_complete', { reason, settings }));
  } catch (error) {
    await runnerError('Bootstrap failed', withReason('boot_failed', { reason, error: error.message }));
  }
}

async function ensureSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  const merged = normalizeSettings(stored[SETTINGS_KEY]);
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

async function getSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

function scheduleTabScan({ tabId, url, trigger }) {
  if (!isChatUrl(url)) {
    return;
  }

  scheduledScan = { tabId, url, trigger };

  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
  }

  scheduledTimer = setTimeout(async () => {
    scheduledTimer = null;
    const context = scheduledScan;
    scheduledScan = null;
    if (!context) {
      return;
    }

    const settings = await getSettings();
    if (!settings.AUTO_SCAN) {
      await runnerDebug('AUTO_SCAN disabled, skipping scheduled scan', withReason('auto_scan_disabled', { trigger: context.trigger }));
      return;
    }

    await runScan({
      tabId: context.tabId,
      trigger: context.trigger,
      bypassCooldown: false,
      manual: false
    });
  }, SCAN_DELAY_MS);
}

async function handleScanRequest({ trigger, bypassCooldown, manual, sendResponse }) {
  try {
    const tab = await getActiveChatTab();
    if (!tab) {
      await runnerWarn('Manual scan requested but no active chat tab', withReason('no_active_tab', { trigger }));
      sendResponse({ ran: false, error: 'no-active-chat-tab' });
      return;
    }

    const result = await runScan({
      tabId: tab.id,
      trigger,
      bypassCooldown,
      manual,
      forcedUrl: tab.url
    });
    sendResponse(result);
  } catch (error) {
    await runnerError('Manual scan failed', withReason('manual_scan_failed', { trigger, error: error?.message }));
    sendResponse({ ran: false, error: error?.message });
  }
}

async function getActiveChatTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!isChatUrl(tab?.url)) {
    return null;
  }
  return tab;
}

async function injectContentScriptIfNeeded(tabId) {
  if (typeof tabId !== 'number') {
    await runnerWarn('Invalid tabId for content script injection', withReason('inject_attempt', {
      tabId: tabId ?? null,
      outcome: 'error',
      error: 'invalid-tab-id'
    }));
    return false;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js']
    });
    await runnerInfo('Content script injection attempted', withReason('inject_attempt', {
      tabId,
      outcome: 'ok',
      framesInjected: Array.isArray(results) ? results.length : 0
    }));
    return true;
  } catch (error) {
    await runnerWarn('Content script injection failed', withReason('inject_attempt', {
      tabId,
      outcome: 'error',
      error: error?.message
    }));
    return false;
  }
}

async function injectIntoOpenChatTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: [CHAT_URL_PATTERN] });
    await Promise.all(
      tabs
        .map((tab) => tab?.id)
        .filter((tabId) => typeof tabId === 'number')
        .map((tabId) => injectContentScriptIfNeeded(tabId).catch(() => false))
    );
  } catch (error) {
    await runnerWarn('Failed to enumerate chat tabs for injection', withReason('inject_attempt', {
      outcome: 'error',
      error: error?.message,
      phase: 'query-tabs'
    }));
  }
}

async function runScan({ tabId, trigger, bypassCooldown, manual, forcedUrl = null }) {
  const settings = await getSettings();
  const traceRunnerEnabled = Boolean(settings.TRACE_RUNNER);
  const trace = (msg, meta = {}) => (traceRunnerEnabled ? runnerTrace(msg, meta) : Promise.resolve());

  await trace('Run invoked', { trigger, bypassCooldown, manual });

  const now = Date.now();
  const elapsed = minutesSince(cooldownMemory.lastRun);
  if (!bypassCooldown && cooldownMemory.lastRun && elapsed < settings.COOLDOWN_MIN) {
    const remaining = Math.max(settings.COOLDOWN_MIN - elapsed, 0);
    await runnerDebug('Cooldown active, skipping run', withReason('cooldown_active', {
      trigger,
      elapsed,
      remaining
    }));
    await persistSummary({
      trigger,
      outcome: 'cooldown-skip',
      details: { elapsed, remaining }
    });
    return {
      ran: false,
      trigger,
      reason: 'cooldown',
      elapsed,
      remaining
    };
  }

  cooldownMemory.lastRun = now;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    await runnerError('Failed to get tab during scan', withReason('tab_lookup_failed', { trigger, error: error?.message }));
    return { ran: false, trigger, error: 'tab-unavailable' };
  }

  const url = forcedUrl || tab?.url || '';
  await trace('Tab resolved for scan', { trigger, url });

  if (!url.startsWith('https://chatgpt.com')) {
    await runnerDebug('Tab outside chatgpt.com scope', withReason('tab_ignored_domain', { trigger, url }));
    await persistSummary({ trigger, outcome: 'url-mismatch', details: { url } });
    return { ran: false, trigger, reason: 'url-mismatch' };
  }

  if (shouldSkipUrl(url, settings)) {
    await runnerInfo('SAFE_URL_PATTERNS match, skipping', withReason('tab_ignored_safe_url', { trigger, url }));
    await persistSummary({ trigger, outcome: 'safe-url-skip', details: { url } });
    return { ran: false, trigger, reason: 'safe-url' };
  }

  await runnerInfo('Scan started', withReason('scan_started', { trigger, manual }));
  await trace('Requesting conversation meta', { trigger });

  const meta = await requestFromContent(tabId, { type: 'MYCHATGPT:getConversationMeta' });
  if (!meta) {
    await runnerWarn('Meta extraction failed', withReason('meta_missing', { trigger, manual }));
    await persistSummary({ trigger, outcome: 'meta-missing' });
    if (settings.DIAGNOSTICS_SAFE_SNAPSHOT) {
      await runDebugProbeForDiagnostics({
        tabId,
        trigger,
        url,
        reason: 'meta-missing',
        saveSnapshot: true
      });
    }
    return { ran: true, trigger, reason: 'meta-missing' };
  }

  const summarizedMeta = summarizeMeta(meta);
  await trace('Meta received', { trigger, meta: summarizedMeta });

  const qualifier = evaluateQualifiers(meta, settings);
  if (!qualifier.qualifies) {
    for (const reason of qualifier.reasons) {
      await runnerDebug('Conversation disqualified (detail)', withReason(`qualify_false_${reason}`, {
        trigger,
        meta: summarizedMeta
      }));
    }
    await runnerInfo('Conversation disqualified', withReason('qualify_false', {
      trigger,
      reasons: qualifier.reasons,
      meta: summarizedMeta
    }));
    await persistSummary({ trigger, outcome: 'disqualified', details: { reasons: qualifier.reasons } });
    return {
      ran: true,
      trigger,
      qualified: false,
      reasons: qualifier.reasons,
      meta
    };
  }

  await runnerInfo('Conversation qualifies', withReason('qualify_true', { trigger, meta: summarizedMeta }));

  const mayPersist = !settings.LIST_ONLY || settings.ALLOW_LOCAL_BACKUP_WHEN_LIST_ONLY;
  if (!mayPersist) {
    await runnerInfo('LIST_ONLY mode prevents backup storage', withReason('backup_skipped_list_only', {
      trigger,
      manual,
      meta: summarizedMeta
    }));
    await persistSummary({ trigger, outcome: 'would-backup', details: { meta: summarizedMeta } });
    return {
      ran: true,
      trigger,
      qualified: true,
      stored: false,
      wouldStore: true,
      meta
    };
  }

  await trace('Requesting Q/A payload', { trigger });
  const qa = await requestFromContent(tabId, { type: 'MYCHATGPT:getQandA' });
  if (!qa) {
    await runnerWarn('Q/A extraction failed', withReason('qa_missing', { trigger, manual }));
    await persistSummary({ trigger, outcome: 'qa-missing' });
    return {
      ran: true,
      trigger,
      qualified: true,
      stored: false,
      reason: 'qa-missing'
    };
  }

  await trace('Q/A received', {
    trigger,
    questionLength: qa.questionText?.length || 0,
    answerLength: qa.answerHTML?.length || 0
  });

  const entry = buildBackupEntry(meta, qa);
  const id = await backups.add(entry);
  await runnerInfo('Backup stored', withReason('backup_stored', {
    trigger,
    id,
    manual,
    meta: summarizedMeta
  }));
  await persistSummary({ trigger, outcome: 'stored', details: { id } });

  notifyBackupsChanged();

  return {
    ran: true,
    trigger,
    qualified: true,
    stored: true,
    id,
    meta
  };
}

function shouldSkipUrl(url, settings) {
  const patterns = settings?.SAFE_URL_PATTERNS || [];
  if (!patterns.length) {
    return false;
  }
  return patterns.some((pattern) => pattern && url.includes(pattern));
}

function evaluateQualifiers(meta, settings) {
  const reasons = [];
  const maxMessages = settings.MAX_MESSAGES ?? 2;
  const maxUserMessages = settings.USER_MESSAGES_MAX ?? 2;
  const minAge = settings.MIN_AGE_MINUTES ?? 2;

  if (typeof meta.messageCount === 'number' && meta.messageCount > maxMessages) {
    reasons.push('message-limit');
  }

  if (typeof meta.userMessageCount === 'number' && meta.userMessageCount > maxUserMessages) {
    reasons.push('user-message-limit');
  }

  if (typeof meta.lastMessageAgeMin === 'number' && meta.lastMessageAgeMin < minAge) {
    reasons.push('too-fresh');
  }

  return {
    qualifies: reasons.length === 0,
    reasons
  };
}

function buildBackupEntry(meta, qa) {
  const title = deriveTitle(meta, qa);
  return {
    id: meta.id || undefined,
    title,
    questionText: qa.questionText || '',
    answerHTML: qa.answerHTML || '',
    timestamp: Date.now(),
    category: meta.category || undefined,
    convoId: meta.convoId || extractConvoIdFromUrl(meta.url)
  };
}

function deriveTitle(meta, qa) {
  if (meta?.title) {
    return meta.title;
  }
  const text = qa?.questionText || '';
  if (text) {
    const trimmed = text.trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed || 'Untitled backup';
  }
  return 'Untitled backup';
}

function extractConvoIdFromUrl(url) {
  if (!url) {
    return '';
  }
  const match = url.match(/\/c\/([^/?#]+)/);
  return match ? match[1] : '';
}

function summarizeMeta(meta) {
  if (!meta) {
    return null;
  }
  return {
    messageCount: meta.messageCount ?? null,
    userMessageCount: meta.userMessageCount ?? null,
    lastMessageAgeMin: meta.lastMessageAgeMin ?? null,
    title: meta.title ?? null,
    convoId: meta.convoId ?? null
  };
}

async function requestFromContent(tabId, payload) {
  const send = async () => {
    const response = await chrome.tabs.sendMessage(tabId, payload);
    if (response?.ok === false) {
      await runnerWarn('Content script returned error response', withReason('content_error', {
        action: payload?.type,
        error: response.error || 'unknown'
      }));
      return null;
    }
    return response;
  };

  try {
    const response = await send();
    if (response !== undefined) {
      return response;
    }
  } catch (error) {
    await runnerWarn('Content script request failed', withReason('no_injection', {
      action: payload?.type,
      error: error?.message
    }));
  }

  await injectContentScriptIfNeeded(tabId);
  await delay(INJECT_RETRY_DELAY_MS);

  try {
    return await send();
  } catch (error) {
    await runnerWarn('Content script retry failed', withReason('inject_retry_failed', {
      action: payload?.type,
      error: error?.message
    }));
    return null;
  }
}

async function runDebugProbeForDiagnostics({ tabId, trigger, url, reason, saveSnapshot }) {
  try {
    await runnerDebug('Running extractor debug probe', withReason('probe_started', { trigger, reason }));
    const probe = await chrome.tabs.sendMessage(tabId, { type: 'MYCHATGPT:runDebugProbe' });
    if (!probe) {
      await runnerWarn('Extractor debug probe returned empty payload', withReason('probe_failed', {
        trigger,
        reason
      }));
      return null;
    }
    await runnerDebug('Extractor debug probe completed', withReason('probe_completed', {
      trigger,
      reason,
      warnings: probe.warnings?.length || 0,
      errors: probe.errors?.length || 0
    }));
    if (saveSnapshot) {
      await storeExtractorSnapshot({ trigger, url, probe });
    }
    return probe;
  } catch (error) {
    await runnerWarn('Extractor debug probe failed', withReason('probe_failed', {
      trigger,
      reason,
      error: error?.message
    }));
    return null;
  }
}

async function storeExtractorSnapshot({ trigger, url, probe }) {
  try {
    const summary = {
      ts: Date.now(),
      trigger,
      url,
      found: probe.found,
      warnings: probe.warnings,
      errors: probe.errors,
      metaPreview: probe.metaPreview,
      qnaPreview: probe.qnaPreview,
      strategiesTried: (probe.strategiesTried || []).slice(-8)
    };
    await chrome.storage.local.set({ debug_last_extractor_dump: summary });
    await runnerDebug('Extractor snapshot persisted', withReason('snapshot_saved', { trigger }));
  } catch (error) {
    await runnerWarn('Failed to persist extractor snapshot', withReason('snapshot_failed', {
      trigger,
      error: error?.message
    }));
  }
}

async function persistSummary({ trigger, outcome, details = {} }) {
  const summary = `${trigger}: ${outcome}`;
  await chrome.storage.local.set({
    last_scan_summary: summary,
    last_scan_at: Date.now(),
    last_scan_details: details
  });
}

function notifyBackupsChanged() {
  chrome.runtime.sendMessage({ type: 'mychatgpt-backups-changed' }).catch(() => {
    /* Slovensky: Ignoruje chybu keď popup nie je otvorený. */
  });
}
