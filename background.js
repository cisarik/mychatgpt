import { initDb, backups } from './db.js';
import {
  log,
  logTrace,
  logDebug,
  logInfo,
  logWarn,
  logError,
  minutesSince,
  ReasonCodes,
  buildPatchHttpReason,
  buildUndoHttpReason,
  getPatchEndpoint,
  createStopwatch,
  measureAsync
} from './utils.js';

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
  REPORT_LIMIT: 200,
  INCLUDE_BACKUP_SNAPSHOT_ID: true,
  DEBUG_LEVEL: 'INFO',
  TRACE_EXTRACTOR: false,
  TRACE_RUNNER: false,
  REDACT_TEXT_IN_DIAGNOSTICS: true,
  DIAGNOSTICS_SAFE_SNAPSHOT: false,
  LIVE_MODE_ENABLED: false,
  LIVE_WHITELIST_HOSTS: ['chatgpt.com'],
  LIVE_PATCH_BATCH_LIMIT: 5,
  LIVE_PATCH_RATE_LIMIT_PER_MIN: 10,
  LIVE_REQUIRE_EXPLICIT_CONFIRM: true,
  AUDIT_LOG_LIMIT: 1000,
  UNDO_BATCH_LIMIT: 5,
  SHOW_UNDO_TOOLS: true
};

const cooldownMemory = {
  globalLastRun: 0,
  perTab: {}
};

const SCAN_DELAY_MS = 1000;
const INJECT_RETRY_DELAY_MS = 150;

let scheduledScan = null;
let scheduledTimer = null;

const RUNNER_SCOPE = 'runner';
const CHAT_URL_PREFIX = 'https://chatgpt.com';
const CHAT_URL_PATTERN = 'https://chatgpt.com/*';
const REPORT_STORAGE_KEY = 'would_delete_report';
const SOFT_DELETE_PLAN_KEY = 'soft_delete_plan';
const SOFT_DELETE_CONFIRMED_HISTORY_KEY = 'soft_delete_confirmed_history';
const SOFT_DELETE_CONFIRMED_HISTORY_LIMIT = 200;
const AUDIT_LOG_STORAGE_KEY = 'audit_log';

const DEFAULT_AUDIT_LIMIT = DEFAULT_SETTINGS.AUDIT_LOG_LIMIT;
const DEFAULT_UNDO_BATCH_LIMIT = DEFAULT_SETTINGS.UNDO_BATCH_LIMIT;

const BRIDGE_READY_TIMEOUT_MS = 2000;
const BRIDGE_REQUEST_TIMEOUT_MS = 8000;
const LIVE_RATE_LIMIT_WINDOW_MS = 60000;

const liveBridgePending = new Map();
const liveRateLimiter = {
  lastRefill: 0,
  tokens: 0,
  capacity: DEFAULT_SETTINGS.LIVE_PATCH_RATE_LIMIT_PER_MIN
};

const PATCH_DIAG_CACHE_LIMIT = 50;
const patchDiagCache = new Map();

function rememberPatchDiag(diag) {
  const requestId = typeof diag?.requestId === 'string' ? diag.requestId : null;
  if (!requestId) {
    return;
  }
  if (patchDiagCache.size >= PATCH_DIAG_CACHE_LIMIT) {
    const [firstKey] = patchDiagCache.keys();
    if (firstKey) {
      patchDiagCache.delete(firstKey);
    }
  }
  patchDiagCache.set(requestId, diag);
}

function consumePatchDiag(requestId) {
  if (!requestId) {
    return null;
  }
  const diag = patchDiagCache.get(requestId) || null;
  if (requestId) {
    patchDiagCache.delete(requestId);
  }
  return diag;
}

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

function isLiveModeArmed(settings) {
  if (!settings) {
    return false;
  }
  return !settings.LIST_ONLY && !settings.DRY_RUN && Boolean(settings.LIVE_MODE_ENABLED);
}

function hostWhitelisted(url, settings) {
  if (typeof url !== 'string') {
    return false;
  }
  if (url.trim() !== url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.hostname !== parsed.hostname.trim()) {
      return false;
    }
    const allowed = Array.isArray(settings?.LIVE_WHITELIST_HOSTS)
      ? settings.LIVE_WHITELIST_HOSTS
      : DEFAULT_SETTINGS.LIVE_WHITELIST_HOSTS;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || '/';
    if (!allowed.some((token) => token && host === token.toLowerCase())) {
      return false;
    }
    if (!path.startsWith('/')) {
      return false;
    }
    return !/\s/.test(path);
  } catch (_error) {
    return false;
  }
}

function ensureRateLimiter(settings) {
  const capacity = Number.isFinite(settings?.LIVE_PATCH_RATE_LIMIT_PER_MIN)
    ? settings.LIVE_PATCH_RATE_LIMIT_PER_MIN
    : DEFAULT_SETTINGS.LIVE_PATCH_RATE_LIMIT_PER_MIN;
  const now = Date.now();
  if (liveRateLimiter.capacity !== capacity) {
    liveRateLimiter.capacity = capacity;
    liveRateLimiter.tokens = capacity;
    liveRateLimiter.lastRefill = now;
  }
  if (capacity <= 0) {
    liveRateLimiter.tokens = Number.POSITIVE_INFINITY;
    liveRateLimiter.lastRefill = now;
    return;
  }
  if (!liveRateLimiter.lastRefill) {
    liveRateLimiter.lastRefill = now;
    liveRateLimiter.tokens = capacity;
    return;
  }
  const elapsed = now - liveRateLimiter.lastRefill;
  if (elapsed >= LIVE_RATE_LIMIT_WINDOW_MS) {
    liveRateLimiter.tokens = capacity;
    liveRateLimiter.lastRefill = now;
  }
}

function consumeRateToken(settings) {
  ensureRateLimiter(settings);
  if (liveRateLimiter.capacity <= 0) {
    return true;
  }
  if (liveRateLimiter.tokens <= 0) {
    return false;
  }
  liveRateLimiter.tokens -= 1;
  if (!liveRateLimiter.lastRefill) {
    liveRateLimiter.lastRefill = Date.now();
  }
  return true;
}

function createBridgeRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createAuditId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function awaitBridgeResponse(requestId, timeoutMs = BRIDGE_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      liveBridgePending.delete(requestId);
      resolve({ ok: false, reasonCode: ReasonCodes.PATCH_BRIDGE_TIMEOUT });
    }, timeoutMs);
    liveBridgePending.set(requestId, { resolve, timer });
  });
}

function mergeDiagIntoPayload(payload, diag) {
  if (!diag || !payload || typeof payload !== 'object') {
    return payload;
  }
  if (!('status' in payload) && Number.isFinite(diag.status)) {
    payload.status = diag.status;
  }
  if (!('method' in payload) && typeof diag.method === 'string') {
    payload.method = diag.method;
  }
  if (!('endpoint' in payload) && typeof diag.endpoint === 'string') {
    payload.endpoint = diag.endpoint;
  }
  if (!('usedAuth' in payload) && typeof diag.usedAuth === 'boolean') {
    payload.usedAuth = diag.usedAuth;
  }
  if (!('reasonCode' in payload) && typeof diag.reason === 'string') {
    payload.reasonCode = diag.reason;
  }
  if (!('tried' in payload) && Array.isArray(diag.tried)) {
    payload.tried = diag.tried;
  }
  return payload;
}

function settleBridgeResponse(requestId, payload) {
  const pending = liveBridgePending.get(requestId);
  if (!pending) {
    return false;
  }
  const diag = consumePatchDiag(requestId);
  if (diag) {
    mergeDiagIntoPayload(payload, diag);
  }
  clearTimeout(pending.timer);
  liveBridgePending.delete(requestId);
  pending.resolve(payload);
  return true;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function ensureBridgeReadyInTab(tabId) {
  try {
    const response = await sendMessageToTab(tabId, { type: 'ENSURE_BRIDGE_READY' });
    return Boolean(response?.ok);
  } catch (error) {
    await runnerWarn('Bridge ensure message failed', withReason('bridge_inject_failed', { tabId, error: error?.message }));
    return false;
  }
}

async function dispatchBridgePatch({ tabId, convoId, visible }) {
  const requestId = createBridgeRequestId();
  const waitPromise = awaitBridgeResponse(requestId, BRIDGE_REQUEST_TIMEOUT_MS);
  try {
    await sendMessageToTab(tabId, {
      type: 'PATCH_VISIBILITY',
      requestId,
      convoId,
      visible,
      endpoint: getPatchEndpoint(convoId)
    });
  } catch (error) {
    settleBridgeResponse(requestId, {
      ok: false,
      reasonCode: ReasonCodes.PATCH_BRIDGE_ERROR,
      error: error?.message || 'sendMessage-failed'
    });
    throw error;
  }
  return waitPromise;
}

async function dispatchBridgeProbe({ tabId, convoId, dryRun, endpoint }) {
  const requestId = createBridgeRequestId();
  const waitPromise = awaitBridgeResponse(requestId, BRIDGE_REQUEST_TIMEOUT_MS);
  try {
    await sendMessageToTab(tabId, {
      type: 'PATCH_ENDPOINT_PROBE',
      requestId,
      convoId,
      dryRun: dryRun !== false,
      endpoint
    });
  } catch (error) {
    settleBridgeResponse(requestId, {
      ok: false,
      reasonCode: ReasonCodes.PATCH_BRIDGE_ERROR,
      error: error?.message || 'sendMessage-failed'
    });
    throw error;
  }
  return waitPromise;
}

function resolveAuditLimit(settings) {
  const raw = Number.parseInt(settings?.AUDIT_LOG_LIMIT, 10);
  if (!Number.isFinite(raw)) {
    return DEFAULT_AUDIT_LIMIT;
  }
  return Math.max(1, Math.floor(raw));
}

function resolveUndoBatchLimit(settings) {
  const raw = Number.parseInt(settings?.UNDO_BATCH_LIMIT, 10);
  if (!Number.isFinite(raw)) {
    return DEFAULT_UNDO_BATCH_LIMIT;
  }
  return Math.max(1, Math.floor(raw));
}

function sanitizeAuditNote(note) {
  if (typeof note !== 'string') {
    return '';
  }
  const trimmed = note.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.slice(0, 500);
}

function normalizeAuditEntry(entry) {
  const now = Date.now();
  const id = entry?.id || createAuditId();
  const ts = Number.isFinite(entry?.ts) ? entry.ts : now;
  const op = entry?.op === 'undo' ? 'undo' : 'hide';
  const actor = entry?.actor === 'auto' ? 'auto' : 'user';
  const request = entry?.request && typeof entry.request === 'object'
    ? {
        endpoint: typeof entry.request.endpoint === 'string' ? entry.request.endpoint : '',
        body: entry.request.body ?? null
      }
    : { endpoint: '', body: null };
  const response = entry?.response && typeof entry.response === 'object'
    ? {
        status: Number.isFinite(entry.response.status)
          ? Math.floor(entry.response.status)
          : entry.response.status === null
          ? null
          : Number.isFinite(Number.parseInt(entry.response.status, 10))
          ? Math.floor(Number.parseInt(entry.response.status, 10))
          : null,
        ok: entry.response.ok === true
      }
    : { status: null, ok: false };
  const normalized = {
    id,
    ts,
    op,
    actor,
    convoId: typeof entry?.convoId === 'string' ? entry.convoId : '',
    url: typeof entry?.url === 'string' ? entry.url : '',
    title: typeof entry?.title === 'string' ? entry.title : '',
    request,
    response,
    reasonCode: typeof entry?.reasonCode === 'string' ? entry.reasonCode : '',
    note: sanitizeAuditNote(entry?.note)
  };
  return normalized;
}

async function auditAppend(entry, { settings } = {}) {
  if (!entry) {
    return null;
  }
  const normalized = normalizeAuditEntry(entry);
  const stored = await chrome.storage.local.get([AUDIT_LOG_STORAGE_KEY]);
  const existing = Array.isArray(stored[AUDIT_LOG_STORAGE_KEY]) ? stored[AUDIT_LOG_STORAGE_KEY] : [];
  const limit = resolveAuditLimit(settings);
  const updated = [...existing, normalized].slice(-limit);
  await chrome.storage.local.set({ [AUDIT_LOG_STORAGE_KEY]: updated });
  return normalized;
}

async function auditTail({ limit = 100 } = {}) {
  const stored = await chrome.storage.local.get([AUDIT_LOG_STORAGE_KEY]);
  const existing = Array.isArray(stored[AUDIT_LOG_STORAGE_KEY]) ? stored[AUDIT_LOG_STORAGE_KEY] : [];
  if (!Number.isFinite(limit) || limit <= 0) {
    return existing.slice();
  }
  return existing.slice(-Math.floor(limit));
}

async function auditClear() {
  await chrome.storage.local.set({ [AUDIT_LOG_STORAGE_KEY]: [] });
  return [];
}

async function auditAddNote({ id, note }) {
  if (!id) {
    return null;
  }
  const stored = await chrome.storage.local.get([AUDIT_LOG_STORAGE_KEY]);
  const existing = Array.isArray(stored[AUDIT_LOG_STORAGE_KEY]) ? stored[AUDIT_LOG_STORAGE_KEY] : [];
  const index = existing.findIndex((entry) => entry?.id === id);
  if (index === -1) {
    return null;
  }
  const updated = existing.slice();
  const entry = { ...updated[index], note: sanitizeAuditNote(note) };
  updated[index] = entry;
  await chrome.storage.local.set({ [AUDIT_LOG_STORAGE_KEY]: updated });
  return entry;
}

async function dispatchBridgeConnectivity({ tabId }) {
  const requestId = createBridgeRequestId();
  const waitPromise = awaitBridgeResponse(requestId, BRIDGE_REQUEST_TIMEOUT_MS);
  try {
    await sendMessageToTab(tabId, { type: 'BRIDGE_CONNECTIVITY', requestId });
  } catch (error) {
    settleBridgeResponse(requestId, {
      ok: false,
      reasonCode: ReasonCodes.BRIDGE_CONNECTIVITY_FAILED,
      error: error?.message || 'sendMessage-failed'
    });
    throw error;
  }
  return waitPromise;
}

async function findLiveChatTab() {
  const active = await getActiveChatTab();
  if (active) {
    return active;
  }
  try {
    const tabs = await chrome.tabs.query({ url: [CHAT_URL_PATTERN] });
    if (!Array.isArray(tabs) || !tabs.length) {
      return null;
    }
    return tabs
      .slice()
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  } catch (error) {
    await runnerWarn('Failed to enumerate live chat tabs', withReason('chat_tab_query_failed', { error: error?.message }));
    return null;
  }
}

function defaultReport() {
  return {
    ts: 0,
    items: [],
    totalSeen: 0,
    totalQualified: 0
  };
}

function defaultSoftDeletePlan() {
  return {
    ts: 0,
    items: [],
    totals: { planned: 0 }
  };
}

function buildReportItem({ url, meta, reasons, qualifies, snapshotId }) {
  const summary = summarizeMeta(meta) || {};
  return {
    ts: Date.now(),
    url,
    convoId: summary.convoId || '',
    title: summary.title || '',
    messageCount: summary.messageCount ?? null,
    userMessageCount: summary.userMessageCount ?? null,
    lastMessageAgeMin: summary.lastMessageAgeMin ?? null,
    reasons: Array.isArray(reasons) ? reasons.slice() : [],
    qualifies: Boolean(qualifies),
    snapshotId: snapshotId || undefined
  };
}

async function loadWouldDeleteReport(limit) {
  const stored = await chrome.storage.local.get([REPORT_STORAGE_KEY]);
  const existing = stored[REPORT_STORAGE_KEY];
  if (!existing || typeof existing !== 'object') {
    return defaultReport();
  }
  const report = {
    ts: existing.ts || 0,
    totalSeen: Number.isFinite(existing.totalSeen) ? existing.totalSeen : 0,
    totalQualified: Number.isFinite(existing.totalQualified) ? existing.totalQualified : 0,
    items: Array.isArray(existing.items) ? existing.items.slice(0, limit) : []
  };
  if (report.items.length > limit) {
    report.items = report.items.slice(0, limit);
  }
  report.totalQualified = report.items.filter((item) => item.qualifies).length;
  return report;
}

async function loadSoftDeletePlan() {
  const stored = await chrome.storage.local.get([SOFT_DELETE_PLAN_KEY]);
  const plan = stored[SOFT_DELETE_PLAN_KEY];
  if (!plan || typeof plan !== 'object') {
    return defaultSoftDeletePlan();
  }
  const items = Array.isArray(plan.items) ? plan.items.slice() : [];
  return {
    ts: Number.isFinite(plan.ts) ? plan.ts : Number.parseInt(plan.ts, 10) || 0,
    items,
    totals: {
      planned: Number.isFinite(plan?.totals?.planned)
        ? plan.totals.planned
        : Array.isArray(items)
        ? items.length
        : 0
    }
  };
}

async function persistWouldDeleteReport(report) {
  await chrome.storage.local.set({ [REPORT_STORAGE_KEY]: report });
  await runnerDebug('Would-delete report stored', withReason('report_update_ok', {
    totalSeen: report.totalSeen,
    totalQualified: report.totalQualified,
    items: report.items.length
  }));
}

async function persistSoftDeletePlan(plan, { reasonCode = 'plan_rebuilt', meta = {} } = {}) {
  const normalized = {
    ts: plan?.ts || Date.now(),
    items: Array.isArray(plan?.items) ? plan.items : [],
    totals: {
      planned: Number.isFinite(plan?.totals?.planned)
        ? plan.totals.planned
        : Array.isArray(plan?.items)
        ? plan.items.length
        : 0
    }
  };
  await chrome.storage.local.set({ [SOFT_DELETE_PLAN_KEY]: normalized });
  await runnerInfo('Soft-delete DRY-RUN plan persisted', withReason(reasonCode, {
    planned: normalized.totals.planned,
    ...meta
  }));
  return normalized;
}

function summarizeHeuristicBoolean({ passes, successCode, failureCode }) {
  return {
    code: passes ? successCode : failureCode,
    value: Boolean(passes)
  };
}

function coerceFinite(value) {
  if (Number.isFinite(value)) {
    return value;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSoftDeleteJustification(item, settings) {
  const maxMessages = Number.isFinite(settings?.MAX_MESSAGES)
    ? settings.MAX_MESSAGES
    : DEFAULT_SETTINGS.MAX_MESSAGES;
  const maxUserMessages = Number.isFinite(settings?.USER_MESSAGES_MAX)
    ? settings.USER_MESSAGES_MAX
    : DEFAULT_SETTINGS.USER_MESSAGES_MAX;
  const minAge = Number.isFinite(settings?.MIN_AGE_MINUTES)
    ? settings.MIN_AGE_MINUTES
    : DEFAULT_SETTINGS.MIN_AGE_MINUTES;

  const totalMessages = coerceFinite(item.messageCount);
  const userMessages = coerceFinite(item.userMessageCount);
  const ageMinutes = coerceFinite(item.lastMessageAgeMin);

  const messageCheck = Number.isFinite(totalMessages)
    ? summarizeHeuristicBoolean({
        passes: totalMessages <= maxMessages,
        successCode: 'messages_leq_max',
        failureCode: 'messages_gt_max'
      })
    : { code: 'messages_unknown', value: null };

  const userMessageCheck = Number.isFinite(userMessages)
    ? summarizeHeuristicBoolean({
        passes: userMessages <= maxUserMessages,
        successCode: 'user_messages_leq_max',
        failureCode: 'user_messages_gt_max'
      })
    : { code: 'user_messages_unknown', value: null };

  const ageCheck = Number.isFinite(ageMinutes)
    ? summarizeHeuristicBoolean({
        passes: ageMinutes >= minAge,
        successCode: 'age_ge_min',
        failureCode: 'age_lt_min'
      })
    : { code: 'age_unknown', value: null };

  const summaryTokens = ['heuristics'];
  summaryTokens.push(
    messageCheck.value === false
      ? `messages>${maxMessages}`
      : `messages<=${maxMessages}`
  );
  summaryTokens.push(
    userMessageCheck.value === false
      ? `user>${maxUserMessages}`
      : `user<=${maxUserMessages}`
  );
  summaryTokens.push(
    ageCheck.value === false ? `age<${minAge}` : `age>=${minAge}`
  );

  const details = [
    {
      code: messageCheck.code,
      value: messageCheck.value,
      expected: `<=${maxMessages}`,
      actual: totalMessages
    },
    {
      code: userMessageCheck.code,
      value: userMessageCheck.value,
      expected: `<=${maxUserMessages}`,
      actual: userMessages
    },
    {
      code: ageCheck.code,
      value: ageCheck.value,
      expected: `>=${minAge}`,
      actual: ageMinutes
    }
  ];

  return {
    summary: summaryTokens.join(', '),
    details
  };
}

function buildSoftDeletePlanItem(item, settings) {
  const justification = buildSoftDeleteJustification(item, settings);
  const endpoint = getPatchEndpoint(item.convoId) || `/conversation/${encodeURIComponent(item.convoId || '')}`;
  const planItem = {
    convoId: item.convoId || '',
    url: item.url || '',
    title: item.title || '',
    messageCount: item.messageCount ?? null,
    userMessageCount: item.userMessageCount ?? null,
    lastMessageAgeMin: item.lastMessageAgeMin ?? null,
    qualifies: Boolean(item.qualifies),
    reasons: Array.isArray(item.reasons) ? item.reasons.slice() : [],
    patch: {
      method: 'PATCH',
      endpoint,
      body: { is_visible: false }
    },
    justification,
    diffPreview: {
      before: { is_visible: true },
      after: { is_visible: false }
    },
    createdAt: new Date().toISOString()
  };

  if (item.snapshotId) {
    planItem.snapshotId = item.snapshotId;
  }

  return planItem;
}

async function regenerateSoftDeletePlanFromReport({ report, settings, reasonCode = 'plan_rebuilt' }) {
  try {
    const activeSettings = settings || (await getSettings());
    const limit = activeSettings?.REPORT_LIMIT || DEFAULT_SETTINGS.REPORT_LIMIT;
    const snapshot = report || (await loadWouldDeleteReport(limit));
    const seen = new Set();
    const qualified = [];
    for (const item of (snapshot.items || [])) {
      if (!item?.qualifies) {
        continue;
      }
      const key = item.convoId || item.url;
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      qualified.push(buildSoftDeletePlanItem(item, activeSettings));
      if (qualified.length >= limit) {
        break;
      }
    }
    const plan = {
      ts: Date.now(),
      items: qualified,
      totals: { planned: qualified.length }
    };
    return await persistSoftDeletePlan(plan, { reasonCode });
  } catch (error) {
    await runnerWarn('Soft-delete plan regeneration failed', withReason('plan_rebuild_failed', {
      error: error?.message || 'unknown'
    }));
    return defaultSoftDeletePlan();
  }
}

async function clearSoftDeletePlan({ reasonCode = 'plan_cleared' } = {}) {
  const cleared = {
    ts: Date.now(),
    items: [],
    totals: { planned: 0 }
  };
  await persistSoftDeletePlan(cleared, { reasonCode });
  return cleared;
}

async function removePlanItem({ convoId, url }) {
  const plan = await loadSoftDeletePlan();
  const key = convoId || url;
  if (!key) {
    return plan;
  }
  const filtered = plan.items.filter((item) => (item.convoId || item.url) !== key);
  const next = {
    ts: Date.now(),
    items: filtered,
    totals: { planned: filtered.length }
  };
  const removalMeta = {};
  if (convoId) {
    removalMeta.convoId = convoId;
  }
  if (url) {
    removalMeta.url = url;
  }
  await persistSoftDeletePlan(next, {
    reasonCode: 'plan_item_removed',
    meta: removalMeta
  });
  return next;
}

async function appendConfirmedHistory(items) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }
  const stored = await chrome.storage.local.get([SOFT_DELETE_CONFIRMED_HISTORY_KEY]);
  const history = Array.isArray(stored[SOFT_DELETE_CONFIRMED_HISTORY_KEY])
    ? stored[SOFT_DELETE_CONFIRMED_HISTORY_KEY]
    : [];
  const updated = [...history, ...items].slice(-SOFT_DELETE_CONFIRMED_HISTORY_LIMIT);
  await chrome.storage.local.set({ [SOFT_DELETE_CONFIRMED_HISTORY_KEY]: updated });
  return updated;
}

async function loadConfirmedHistory() {
  const stored = await chrome.storage.local.get([SOFT_DELETE_CONFIRMED_HISTORY_KEY]);
  const history = Array.isArray(stored[SOFT_DELETE_CONFIRMED_HISTORY_KEY])
    ? stored[SOFT_DELETE_CONFIRMED_HISTORY_KEY]
    : [];
  return history.slice();
}

function isHideHistoryEntry(entry) {
  return Boolean(entry?.patch?.is_visible === false);
}

async function getRecentHidden({ limit = 10, windowMs = 86400000 } = {}) {
  const history = await loadConfirmedHistory();
  const cutoff = Date.now() - windowMs;
  return history
    .filter((entry) => Number.isFinite(entry?.ts) && entry.ts >= cutoff && isHideHistoryEntry(entry))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
    .map((entry) => ({
      ts: entry.ts,
      convoId: entry?.convoId || '',
      url: entry?.url || '',
      title: entry?.title || ''
    }));
}

async function countRecentHidden({ windowMs = 86400000 } = {}) {
  const history = await loadConfirmedHistory();
  const cutoff = Date.now() - windowMs;
  return history.filter((entry) => Number.isFinite(entry?.ts) && entry.ts >= cutoff && isHideHistoryEntry(entry)).length;
}

async function updateWouldDeleteReport({ url, meta, reasons, qualifies, snapshotId, settings }) {
  try {
    const limit = settings?.REPORT_LIMIT || 200;
    const report = await loadWouldDeleteReport(limit);
    report.ts = Date.now();
    report.totalSeen = (report.totalSeen || 0) + 1;
    const entry = buildReportItem({ url, meta, reasons, qualifies, snapshotId });
    const key = entry.convoId || url;
    const previousIndex = report.items.findIndex((item) => (item.convoId || item.url) === key);
    if (previousIndex !== -1) {
      report.items.splice(previousIndex, 1);
      if (qualifies) {
        await runnerInfo('Would-delete candidate updated', withReason('candidate_updated', {
          url,
          convoId: entry.convoId,
          meta: summarizeMeta(meta)
        }));
      } else {
        await runnerDebug('Would-delete record refreshed (non-qualified)', withReason('qualify_false_update', {
          url,
          convoId: entry.convoId,
          reasons
        }));
      }
    } else {
      if (qualifies) {
        await runnerInfo('Would-delete candidate recorded', withReason('candidate_recorded', {
          url,
          convoId: entry.convoId,
          meta: summarizeMeta(meta)
        }));
      } else {
        await runnerDebug('Would-delete record stored (non-qualified)', withReason('qualify_false_recorded', {
          url,
          convoId: entry.convoId,
          reasons
        }));
      }
    }
    report.items.unshift(entry);
    if (report.items.length > limit) {
      report.items = report.items.slice(0, limit);
    }
    report.totalQualified = report.items.filter((item) => item.qualifies).length;
    await persistWouldDeleteReport(report);
    await regenerateSoftDeletePlanFromReport({ report, settings, reasonCode: 'plan_rebuilt' });
    return entry;
  } catch (error) {
    await runnerWarn('Failed to update would-delete report', withReason('report_update_failed', {
      url,
      error: error?.message
    }));
    return null;
  }
}

async function clearWouldDeleteReport() {
  const blank = { ...defaultReport(), ts: Date.now() };
  await chrome.storage.local.set({ [REPORT_STORAGE_KEY]: blank });
  await runnerInfo('Would-delete report cleared', withReason('report_cleared'));
  await clearSoftDeletePlan({ reasonCode: 'plan_cleared' });
  return blank;
}

function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (!Array.isArray(merged.SAFE_URL_PATTERNS)) {
    merged.SAFE_URL_PATTERNS = String(merged.SAFE_URL_PATTERNS || '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(merged.LIVE_WHITELIST_HOSTS)) {
    merged.LIVE_WHITELIST_HOSTS = String(merged.LIVE_WHITELIST_HOSTS || '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
  }
  const parsedLimit = Number.parseInt(merged.REPORT_LIMIT, 10);
  merged.REPORT_LIMIT = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.floor(parsedLimit))
    : DEFAULT_SETTINGS.REPORT_LIMIT;
  const parsedCooldown = Number.parseInt(merged.COOLDOWN_MIN, 10);
  merged.COOLDOWN_MIN = Number.isFinite(parsedCooldown)
    ? Math.max(0, Math.floor(parsedCooldown))
    : DEFAULT_SETTINGS.COOLDOWN_MIN;
  const parsedBatch = Number.parseInt(merged.LIVE_PATCH_BATCH_LIMIT, 10);
  merged.LIVE_PATCH_BATCH_LIMIT = Number.isFinite(parsedBatch)
    ? Math.max(1, Math.floor(parsedBatch))
    : DEFAULT_SETTINGS.LIVE_PATCH_BATCH_LIMIT;
  const parsedRate = Number.parseInt(merged.LIVE_PATCH_RATE_LIMIT_PER_MIN, 10);
  merged.LIVE_PATCH_RATE_LIMIT_PER_MIN = Number.isFinite(parsedRate)
    ? Math.max(0, Math.floor(parsedRate))
    : DEFAULT_SETTINGS.LIVE_PATCH_RATE_LIMIT_PER_MIN;
  const parsedAudit = Number.parseInt(merged.AUDIT_LOG_LIMIT, 10);
  merged.AUDIT_LOG_LIMIT = Number.isFinite(parsedAudit)
    ? Math.max(1, Math.floor(parsedAudit))
    : DEFAULT_SETTINGS.AUDIT_LOG_LIMIT;
  const parsedUndoBatch = Number.parseInt(merged.UNDO_BATCH_LIMIT, 10);
  merged.UNDO_BATCH_LIMIT = Number.isFinite(parsedUndoBatch)
    ? Math.max(1, Math.floor(parsedUndoBatch))
    : DEFAULT_SETTINGS.UNDO_BATCH_LIMIT;
  merged.LIVE_MODE_ENABLED = Boolean(merged.LIVE_MODE_ENABLED);
  merged.LIVE_REQUIRE_EXPLICIT_CONFIRM = merged.LIVE_REQUIRE_EXPLICIT_CONFIRM !== false;
  merged.INCLUDE_BACKUP_SNAPSHOT_ID = Boolean(merged.INCLUDE_BACKUP_SNAPSHOT_ID);
  merged.SHOW_UNDO_TOOLS = merged.SHOW_UNDO_TOOLS !== false;
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (cooldownMemory.perTab[tabId]) {
    delete cooldownMemory.perTab[tabId];
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PATCH_RESULT') {
    if (message?.requestId) {
      settleBridgeResponse(message.requestId, message.payload || {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'PATCH_PROBE_RESULT') {
    if (message?.requestId) {
      settleBridgeResponse(message.requestId, message.payload || {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'BRIDGE_CONNECTIVITY_RESULT') {
    if (message?.requestId) {
      settleBridgeResponse(message.requestId, message.payload || {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'PATCH_DIAG') {
    rememberPatchDiag(message?.diag || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'CONTENT_ENSURE_BRIDGE') {
    (async () => {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, error: 'no-tab' });
        return;
      }
      try {
        const execOptions = {
          target: { tabId },
          world: 'MAIN',
          files: ['bridge.js']
        };
        if (typeof sender?.frameId === 'number') {
          execOptions.target.frameIds = [sender.frameId];
        }
        await chrome.scripting.executeScript(execOptions);
        sendResponse({ ok: true });
      } catch (error) {
        await runnerWarn('Bridge script injection failed', withReason('bridge_inject_failed', {
          tabId,
          frameId: sender?.frameId ?? null,
          error: error?.message
        }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }

  if (message?.type === 'LIVE_ENDPOINT_PROBE') {
    (async () => {
      const convoId = typeof message?.convoId === 'string' ? message.convoId.trim() : '';
      if (!convoId) {
        sendResponse({ ok: false, error: 'invalid-convo' });
        return;
      }
      try {
        const settings = await getSettings();
        const tab = await findLiveChatTab();
        if (!tab) {
          sendResponse({ ok: false, error: 'no_active_chat_tab_for_patch' });
          return;
        }
        await injectContentScriptIfNeeded(tab.id);
        const ready = await ensureBridgeReadyInTab(tab.id);
        if (!ready) {
          sendResponse({ ok: false, error: 'bridge_injection_failed' });
          return;
        }
        const dryRun = settings?.DRY_RUN !== false;
        const endpoint = typeof message?.endpoint === 'string' ? message.endpoint.trim() : undefined;
        const measurement = await measureAsync(() =>
          dispatchBridgeProbe({ tabId: tab.id, convoId, dryRun, endpoint })
        );
        if (measurement.error) {
          sendResponse({ ok: false, error: measurement.error?.message || 'probe-failed' });
          return;
        }
        const probeResult = measurement.value && typeof measurement.value === 'object' ? measurement.value : {};
        if (!Number.isFinite(probeResult.elapsedMs)) {
          probeResult.elapsedMs = measurement.elapsedMs;
        }
        probeResult.totalElapsedMs = measurement.elapsedMs;
        probeResult.dryRun = dryRun;
        try {
          await chrome.storage.local.set({ debug_last_endpoint_probe: { ts: Date.now(), result: probeResult } });
        } catch (_error) {}
        sendResponse({ ok: true, result: probeResult });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'probe-failed' });
      }
    })();
    return true;
  }

  if (message?.type === 'LIVE_TEST_CONNECTIVITY') {
    (async () => {
      const timer = createStopwatch();
      try {
        const settings = await getSettings();
        const tab = await findLiveChatTab();
        if (!tab) {
          sendResponse({ ok: false, error: 'no_active_chat_tab_for_patch' });
          return;
        }
        await injectContentScriptIfNeeded(tab.id);
        const ready = await ensureBridgeReadyInTab(tab.id);
        if (!ready) {
          sendResponse({ ok: false, error: 'bridge_injection_failed' });
          return;
        }
        let result;
        try {
          result = await dispatchBridgeConnectivity({ tabId: tab.id });
        } catch (error) {
          result = { ok: false, reasonCode: ReasonCodes.BRIDGE_CONNECTIVITY_FAILED, error: error?.message };
        }
        const elapsedMs = Math.round(timer.elapsedMs());
        if (!result?.ok) {
          const reason = result?.reasonCode || ReasonCodes.BRIDGE_CONNECTIVITY_FAILED;
          await runnerWarn('Live connectivity test failed', withReason(reason, {
            error: result?.error || 'bridge-connectivity-failed',
            tabId: tab.id,
            elapsedMs
          }));
          sendResponse({ ok: false, error: result?.error || 'bridge-connectivity-failed', reason, elapsedMs });
          return;
        }
        await runnerInfo('Live connectivity test succeeded', withReason(ReasonCodes.BRIDGE_CONNECTIVITY_OK, {
          status: result.status ?? null,
          tabId: tab.id,
          elapsedMs,
          armed: isLiveModeArmed(settings)
        }));
        sendResponse({ ok: true, status: result.status ?? null, elapsedMs });
      } catch (error) {
        await runnerWarn('LIVE_TEST_CONNECTIVITY failed', withReason('live_connectivity_error', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message || 'live-connectivity-error' });
      }
    })();
    return true;
  }

  if (message?.type === 'LIVE_EXECUTE_BATCH') {
    (async () => {
      try {
        const settings = await getSettings();
        if (!isLiveModeArmed(settings)) {
          await runnerWarn('Live batch blocked by safety guard', withReason(ReasonCodes.PATCH_BLOCKED_BY_SAFETY));
          sendResponse({ ok: false, reason: ReasonCodes.PATCH_BLOCKED_BY_SAFETY });
          return;
        }
        if (settings.LIVE_REQUIRE_EXPLICIT_CONFIRM && !message?.confirmed) {
          await runnerWarn('Live batch blocked: confirmation missing', withReason(ReasonCodes.PATCH_BLOCKED_BY_SAFETY));
          sendResponse({ ok: false, reason: ReasonCodes.PATCH_BLOCKED_BY_SAFETY });
          return;
        }
        if (!settings.CONFIRM_BEFORE_DELETE) {
          await runnerWarn('CONFIRM_BEFORE_DELETE disabled for live batch', withReason('confirm_disabled_live', {}));
        }
        const rawItems = Array.isArray(message?.items) ? message.items : [];
        if (!rawItems.length) {
          sendResponse({ ok: false, reason: 'no-items' });
          return;
        }
        const tab = await findLiveChatTab();
        if (!tab) {
          sendResponse({ ok: false, reason: 'no_active_chat_tab_for_patch' });
          return;
        }
        await injectContentScriptIfNeeded(tab.id);
        const bridgeReady = await ensureBridgeReadyInTab(tab.id);
        if (!bridgeReady) {
          sendResponse({ ok: false, reason: 'bridge_injection_failed' });
          return;
        }
        const batchLimit = Math.max(1, Number.parseInt(settings.LIVE_PATCH_BATCH_LIMIT, 10) || DEFAULT_SETTINGS.LIVE_PATCH_BATCH_LIMIT);
        const deleteLimit = Math.max(1, Number.parseInt(settings.DELETE_LIMIT, 10) || DEFAULT_SETTINGS.DELETE_LIMIT);
        const seen = new Set();
        const results = [];
        const historyEntries = [];
        let dispatched = 0;
        const actor = message?.actor === 'auto' ? 'auto' : 'user';

        const recordOutcome = async ({ result, auditEntry }) => {
          results.push(result);
          try {
            const storedAudit = await auditAppend(auditEntry, { settings });
            if (storedAudit?.id) {
              result.auditId = storedAudit.id;
            }
          } catch (error) {
            await runnerWarn('Audit append failed', withReason('audit_append_failed', { error: error?.message || 'unknown' }));
          }
        };

        for (const item of rawItems) {
          const convoId = (item?.convoId || '').trim();
          const url = item?.url || '';
          const title = item?.title || '';
          const key = convoId || url;
          const endpoint = getPatchEndpoint(convoId) || '';
          const auditEntry = {
            ts: Date.now(),
            op: 'hide',
            actor,
            convoId,
            url,
            title,
            request: { endpoint, body: { is_visible: false } },
            response: { status: null, ok: false },
            reasonCode: ''
          };
          const result = { convoId, url, title, ok: false };

          if (!key) {
            auditEntry.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_SAFETY;
            result.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_SAFETY;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          if (seen.has(key)) {
            auditEntry.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_DUPLICATE;
            result.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_DUPLICATE;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          seen.add(key);
          if (dispatched >= batchLimit) {
            auditEntry.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_BATCH_LIMIT;
            result.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_BATCH_LIMIT;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          if (dispatched >= deleteLimit) {
            auditEntry.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_DELETE_LIMIT;
            result.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_DELETE_LIMIT;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          if (!hostWhitelisted(url, settings)) {
            auditEntry.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_WHITELIST;
            result.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_WHITELIST;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          if (!convoId) {
            auditEntry.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_SAFETY;
            result.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_SAFETY;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          if (!consumeRateToken(settings)) {
            auditEntry.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_RATE_LIMIT;
            result.reasonCode = ReasonCodes.PATCH_BLOCKED_BY_RATE_LIMIT;
            await recordOutcome({ result, auditEntry });
            continue;
          }

          dispatched += 1;
          let patchResult;
          try {
            patchResult = await dispatchBridgePatch({ tabId: tab.id, convoId, visible: false });
          } catch (error) {
            patchResult = {
              ok: false,
              reasonCode: ReasonCodes.PATCH_BRIDGE_ERROR,
              error: error?.message || 'dispatch-failed'
            };
          }
          const attempts = Array.isArray(patchResult?.tried) ? patchResult.tried.slice(0, 3) : [];
          if (attempts.length) {
            result.tried = attempts;
          }
          if (typeof patchResult?.usedAuth === 'boolean') {
            result.usedAuth = patchResult.usedAuth;
          }
          if (typeof patchResult?.endpoint === 'string') {
            result.endpoint = patchResult.endpoint;
          }
          if (typeof patchResult?.method === 'string') {
            result.method = patchResult.method;
          }
          const http405Reason = buildPatchHttpReason(405);
          const saw405 = patchResult?.status === 405 || attempts.some((entry) => Number.parseInt(entry?.status, 10) === 405);
          if (!patchResult?.ok && saw405) {
            await runnerDebug('Visibility toggle rejected with 405', withReason(http405Reason, {
              convoId,
              endpoint: patchResult?.endpoint || null,
              method: patchResult?.method || null,
              attempts
            }));
          }
          if (!patchResult?.ok && patchResult?.reasonCode === ReasonCodes.ENDPOINT_NOT_SUPPORTED) {
            await runnerDebug('Endpoint autodetect failed', withReason(ReasonCodes.ENDPOINT_NOT_SUPPORTED, {
              convoId,
              attempts
            }));
          }
          if (patchResult?.usedAuth === false) {
            result.indicators = Array.isArray(result.indicators) ? result.indicators : [];
            if (!result.indicators.includes(ReasonCodes.AUTH_MISSING)) {
              result.indicators.push(ReasonCodes.AUTH_MISSING);
            }
            await runnerDebug('Authorization token missing for PATCH attempt', withReason(ReasonCodes.AUTH_MISSING, {
              convoId,
              endpoint: patchResult?.endpoint || null
            }));
          }
          auditEntry.response.status = patchResult?.status ?? null;
          auditEntry.response.ok = Boolean(patchResult?.ok);
          if (patchResult?.ok) {
            auditEntry.reasonCode = ReasonCodes.PATCH_OK;
            result.ok = true;
            result.reasonCode = ReasonCodes.PATCH_OK;
            result.status = patchResult.status ?? null;
            historyEntries.push({
              ts: Date.now(),
              convoId,
              url,
              title,
              patch: { is_visible: false },
              result: 'ok'
            });
          } else if (patchResult?.reasonCode === ReasonCodes.PATCH_BRIDGE_TIMEOUT) {
            auditEntry.reasonCode = ReasonCodes.PATCH_BRIDGE_TIMEOUT;
            result.reasonCode = ReasonCodes.PATCH_BRIDGE_TIMEOUT;
          } else if (patchResult?.status) {
            const reason = buildPatchHttpReason(patchResult.status);
            auditEntry.reasonCode = reason;
            result.reasonCode = reason;
            result.status = patchResult.status;
            if (patchResult?.error) {
              result.error = patchResult.error;
            }
          } else {
            const reason = patchResult?.reasonCode || ReasonCodes.PATCH_BRIDGE_ERROR;
            auditEntry.reasonCode = reason;
            result.reasonCode = reason;
            if (patchResult?.error) {
              result.error = patchResult.error;
            }
          }
          await recordOutcome({ result, auditEntry });
        }

        if (historyEntries.length) {
          await appendConfirmedHistory(historyEntries);
        }
        await runnerInfo('Live patch batch completed', withReason(ReasonCodes.LIVE_BATCH_COMPLETED, {
          requested: rawItems.length,
          dispatched,
          successes: historyEntries.length,
          tabId: tab.id
        }));
        sendResponse({ ok: true, results, meta: { requested: rawItems.length, dispatched } });
      } catch (error) {
        await runnerWarn('LIVE_EXECUTE_BATCH failed', withReason('live_execute_failed', { error: error?.message }));
        sendResponse({ ok: false, reason: error?.message || 'live-execute-failed' });
      }
    })();
    return true;
  }

  if (message?.type === 'LIVE_EXECUTE_UNDO_BATCH') {
    (async () => {
      try {
        const settings = await getSettings();
        if (!isLiveModeArmed(settings)) {
          await runnerWarn('Undo batch blocked by safety guard', withReason(ReasonCodes.UNDO_BLOCKED_BY_SAFETY));
          sendResponse({ ok: false, reason: ReasonCodes.UNDO_BLOCKED_BY_SAFETY });
          return;
        }
        if (settings.LIVE_REQUIRE_EXPLICIT_CONFIRM && !message?.confirmed) {
          await runnerWarn('Undo batch blocked: confirmation missing', withReason(ReasonCodes.UNDO_BLOCKED_BY_SAFETY));
          sendResponse({ ok: false, reason: ReasonCodes.UNDO_BLOCKED_BY_SAFETY });
          return;
        }
        const rawItems = Array.isArray(message?.items) ? message.items : [];
        if (!rawItems.length) {
          sendResponse({ ok: false, reason: 'no-items' });
          return;
        }
        const tab = await findLiveChatTab();
        if (!tab) {
          sendResponse({ ok: false, reason: 'no_active_chat_tab_for_patch' });
          return;
        }
        await injectContentScriptIfNeeded(tab.id);
        const bridgeReady = await ensureBridgeReadyInTab(tab.id);
        if (!bridgeReady) {
          sendResponse({ ok: false, reason: 'bridge_injection_failed' });
          return;
        }
        const batchLimit = resolveUndoBatchLimit(settings);
        const seen = new Set();
        const results = [];
        const historyEntries = [];
        let dispatched = 0;
        const actor = message?.actor === 'auto' ? 'auto' : 'user';

        const recordOutcome = async ({ result, auditEntry }) => {
          results.push(result);
          try {
            const storedAudit = await auditAppend(auditEntry, { settings });
            if (storedAudit?.id) {
              result.auditId = storedAudit.id;
            }
          } catch (error) {
            await runnerWarn('Audit append failed', withReason('audit_append_failed', { error: error?.message || 'unknown' }));
          }
        };

        for (const item of rawItems) {
          const convoId = (item?.convoId || '').trim();
          const url = item?.url || '';
          const title = item?.title || '';
          const key = convoId || url;
          const endpoint = getPatchEndpoint(convoId) || '';
          const auditEntry = {
            ts: Date.now(),
            op: 'undo',
            actor,
            convoId,
            url,
            title,
            request: { endpoint, body: { is_visible: true } },
            response: { status: null, ok: false },
            reasonCode: ''
          };
          const result = { convoId, url, title, ok: false };

          if (!key) {
            auditEntry.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_SAFETY;
            result.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_SAFETY;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          if (seen.has(key)) {
            auditEntry.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_DUPLICATE;
            result.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_DUPLICATE;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          seen.add(key);
          if (dispatched >= batchLimit) {
            auditEntry.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_BATCH_LIMIT;
            result.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_BATCH_LIMIT;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          if (!hostWhitelisted(url, settings)) {
            auditEntry.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_WHITELIST;
            result.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_WHITELIST;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          if (!convoId) {
            auditEntry.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_SAFETY;
            result.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_SAFETY;
            await recordOutcome({ result, auditEntry });
            continue;
          }
          if (!consumeRateToken(settings)) {
            auditEntry.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_RATE_LIMIT;
            result.reasonCode = ReasonCodes.UNDO_BLOCKED_BY_RATE_LIMIT;
            await recordOutcome({ result, auditEntry });
            continue;
          }

          dispatched += 1;
          let patchResult;
          try {
            patchResult = await dispatchBridgePatch({ tabId: tab.id, convoId, visible: true });
          } catch (error) {
            patchResult = {
              ok: false,
              reasonCode: ReasonCodes.PATCH_BRIDGE_ERROR,
              error: error?.message || 'dispatch-failed'
            };
          }
          auditEntry.response.status = patchResult?.status ?? null;
          auditEntry.response.ok = Boolean(patchResult?.ok);
          if (patchResult?.ok) {
            auditEntry.reasonCode = ReasonCodes.UNDO_OK;
            result.ok = true;
            result.reasonCode = ReasonCodes.UNDO_OK;
            result.status = patchResult.status ?? null;
            historyEntries.push({
              ts: Date.now(),
              convoId,
              url,
              title,
              after: { is_visible: true },
              result: 'ok'
            });
          } else if (patchResult?.reasonCode === ReasonCodes.PATCH_BRIDGE_TIMEOUT) {
            auditEntry.reasonCode = ReasonCodes.UNDO_BRIDGE_TIMEOUT;
            result.reasonCode = ReasonCodes.UNDO_BRIDGE_TIMEOUT;
          } else if (patchResult?.reasonCode === ReasonCodes.PATCH_BRIDGE_ERROR) {
            auditEntry.reasonCode = ReasonCodes.UNDO_BRIDGE_ERROR;
            result.reasonCode = ReasonCodes.UNDO_BRIDGE_ERROR;
            if (patchResult?.error) {
              result.error = patchResult.error;
            }
          } else if (patchResult?.status) {
            const reason = buildUndoHttpReason(patchResult.status);
            auditEntry.reasonCode = reason;
            result.reasonCode = reason;
            result.status = patchResult.status;
            if (patchResult?.error) {
              result.error = patchResult.error;
            }
          } else {
            const rawReason = typeof patchResult?.reasonCode === 'string' ? patchResult.reasonCode : '';
            const reason = rawReason && rawReason.startsWith('undo_') ? rawReason : ReasonCodes.UNDO_BRIDGE_ERROR;
            auditEntry.reasonCode = reason;
            result.reasonCode = reason;
            if (patchResult?.error) {
              result.error = patchResult.error;
            }
          }
          await recordOutcome({ result, auditEntry });
        }

        if (historyEntries.length) {
          await appendConfirmedHistory(historyEntries);
        }
        await runnerInfo('Live undo batch completed', withReason(ReasonCodes.UNDO_BATCH_COMPLETED, {
          requested: rawItems.length,
          dispatched,
          restored: historyEntries.length,
          tabId: tab.id
        }));
        sendResponse({ ok: true, results, meta: { requested: rawItems.length, dispatched } });
      } catch (error) {
        await runnerWarn('LIVE_EXECUTE_UNDO_BATCH failed', withReason('undo_execute_failed', { error: error?.message }));
        sendResponse({ ok: false, reason: error?.message || 'undo-execute-failed' });
      }
    })();
    return true;
  }

  if (message?.type === 'AUDIT_TAIL') {
    (async () => {
      try {
        const limitRaw = Number.parseInt(message?.limit, 10);
        const entries = await auditTail({ limit: Number.isFinite(limitRaw) ? limitRaw : undefined });
        sendResponse({ ok: true, entries });
      } catch (error) {
        await runnerWarn('AUDIT_TAIL failed', withReason('audit_tail_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message || 'audit-tail-failed' });
      }
    })();
    return true;
  }

  if (message?.type === 'AUDIT_CLEAR') {
    (async () => {
      try {
        await auditClear();
        sendResponse({ ok: true });
      } catch (error) {
        await runnerWarn('AUDIT_CLEAR failed', withReason('audit_clear_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message || 'audit-clear-failed' });
      }
    })();
    return true;
  }

  if (message?.type === 'AUDIT_EXPORT') {
    (async () => {
      try {
        const entries = await auditTail({ limit: 0 });
        sendResponse({ ok: true, entries });
      } catch (error) {
        await runnerWarn('AUDIT_EXPORT failed', withReason('audit_export_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message || 'audit-export-failed' });
      }
    })();
    return true;
  }

  if (message?.type === 'AUDIT_ADD_NOTE') {
    (async () => {
      try {
        const updated = await auditAddNote({ id: message?.id, note: message?.note });
        if (!updated) {
          sendResponse({ ok: false, error: 'not-found' });
          return;
        }
        sendResponse({ ok: true, entry: updated });
      } catch (error) {
        await runnerWarn('AUDIT_ADD_NOTE failed', withReason('audit_note_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message || 'audit-note-failed' });
      }
    })();
    return true;
  }

  if (message?.type === 'UNDO_GET_RECENT_HIDDEN') {
    (async () => {
      try {
        const limitRaw = Number.parseInt(message?.limit, 10);
        const windowMs = Number.isFinite(message?.windowMs)
          ? Math.max(0, Math.floor(message.windowMs))
          : 86400000;
        const entries = await getRecentHidden({
          limit: Number.isFinite(limitRaw) ? Math.max(1, limitRaw) : 10,
          windowMs
        });
        sendResponse({ ok: true, entries });
      } catch (error) {
        await runnerWarn('UNDO_GET_RECENT_HIDDEN failed', withReason('undo_recent_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message || 'undo-recent-failed' });
      }
    })();
    return true;
  }

  if (message?.type === 'UNDO_RECENT_HIDDEN_COUNT') {
    (async () => {
      try {
        const windowMs = Number.isFinite(message?.windowMs)
          ? Math.max(0, Math.floor(message.windowMs))
          : 86400000;
        const count = await countRecentHidden({ windowMs });
        sendResponse({ ok: true, count });
      } catch (error) {
        await runnerWarn('UNDO_RECENT_HIDDEN_COUNT failed', withReason('undo_recent_count_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message || 'undo-recent-count-failed' });
      }
    })();
    return true;
  }

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
  if (message?.type === 'REPORT_GET') {
    (async () => {
      try {
        const settings = await getSettings();
        const report = await loadWouldDeleteReport(settings.REPORT_LIMIT);
        sendResponse({ ok: true, report });
      } catch (error) {
        await runnerWarn('REPORT_GET failed', withReason('report_get_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'REPORT_CLEAR') {
    (async () => {
      try {
        const cleared = await clearWouldDeleteReport();
        sendResponse({ ok: true, report: cleared });
      } catch (error) {
        await runnerWarn('REPORT_CLEAR failed', withReason('report_clear_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'REPORT_EXPORT') {
    (async () => {
      try {
        const settings = await getSettings();
        const report = await loadWouldDeleteReport(settings.REPORT_LIMIT);
        await runnerInfo('Report export requested', withReason('report_export_started', {
          count: report.items.length
        }));
        sendResponse({ ok: true, items: report.items, ts: report.ts });
      } catch (error) {
        await runnerWarn('REPORT_EXPORT failed', withReason('report_export_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'PLAN_GET') {
    (async () => {
      try {
        const plan = await loadSoftDeletePlan();
        sendResponse({ ok: true, plan });
      } catch (error) {
        await runnerWarn('PLAN_GET failed', withReason('plan_get_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'PLAN_REGENERATE') {
    (async () => {
      try {
        const settings = await getSettings();
        const plan = await regenerateSoftDeletePlanFromReport({ settings, reasonCode: 'plan_rebuilt' });
        sendResponse({ ok: true, plan });
      } catch (error) {
        await runnerWarn('PLAN_REGENERATE failed', withReason('plan_rebuild_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'PLAN_CLEAR') {
    (async () => {
      try {
        const plan = await clearSoftDeletePlan({ reasonCode: 'plan_cleared' });
        sendResponse({ ok: true, plan });
      } catch (error) {
        await runnerWarn('PLAN_CLEAR failed', withReason('plan_clear_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'PLAN_REMOVE_ITEM') {
    (async () => {
      try {
        const plan = await removePlanItem({ convoId: message?.convoId, url: message?.url });
        sendResponse({ ok: true, plan });
      } catch (error) {
        await runnerWarn('PLAN_REMOVE_ITEM failed', withReason('plan_remove_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'PLAN_EXPORT') {
    (async () => {
      try {
        const plan = await loadSoftDeletePlan();
        await runnerInfo('Soft-delete plan export requested', withReason('plan_export_started', {
          planned: plan?.totals?.planned ?? plan?.items?.length ?? 0
        }));
        sendResponse({ ok: true, items: plan.items || [], ts: plan.ts || Date.now() });
      } catch (error) {
        await runnerWarn('PLAN_EXPORT failed', withReason('plan_export_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'PLAN_CONFIRM_DRY_RUN') {
    (async () => {
      try {
        const plan = await loadSoftDeletePlan();
        const items = Array.isArray(plan.items) ? plan.items : [];
        const now = Date.now();
        const historyEntries = items.map((item) => ({
          ts: now,
          convoId: item.convoId || '',
          url: item.url || '',
          patch: item.patch,
          justification: item.justification,
          result: 'simulated-ok'
        }));
        await appendConfirmedHistory(historyEntries);
        await runnerInfo('Soft-delete DRY-RUN confirmation simulated', withReason('dry_run_confirmed', {
          count: items.length
        }));
        sendResponse({ ok: true, count: items.length });
      } catch (error) {
        await runnerWarn('PLAN_CONFIRM_DRY_RUN failed', withReason('plan_confirm_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
    return true;
  }
  if (message?.type === 'SCAN_ALL_TABS_NOW') {
    (async () => {
      try {
        await runnerInfo('Manual scan-all requested', withReason('scan_all_triggered', {
          bypass: Boolean(message?.bypassCooldown)
        }));
        const total = await triggerScanForAllTabs(Boolean(message?.bypassCooldown));
        await runnerInfo('Manual scan-all completed', withReason('scan_all_completed', { total }));
        sendResponse({ ok: true, total });
      } catch (error) {
        await runnerWarn('SCAN_ALL_TABS_NOW failed', withReason('scan_all_failed', { error: error?.message }));
        sendResponse({ ok: false, error: error?.message });
      }
    })();
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
  if (!bypassCooldown) {
    const tabLast = cooldownMemory.perTab[tabId] || 0;
    const tabElapsed = minutesSince(tabLast);
    if (tabLast && tabElapsed < settings.COOLDOWN_MIN) {
      const remaining = Math.max(settings.COOLDOWN_MIN - tabElapsed, 0);
      await runnerDebug('Per-tab cooldown active, skipping run', withReason('cooldown_active', {
        trigger,
        scope: 'tab',
        tabId,
        elapsed: tabElapsed,
        remaining
      }));
      await persistSummary({
        trigger,
        outcome: 'cooldown-skip',
        details: { elapsed: tabElapsed, remaining, scope: 'tab', tabId }
      });
      return {
        ran: false,
        trigger,
        reason: 'cooldown-tab',
        elapsed: tabElapsed,
        remaining
      };
    }
    const globalElapsed = minutesSince(cooldownMemory.globalLastRun);
    if (cooldownMemory.globalLastRun && globalElapsed < settings.COOLDOWN_MIN) {
      const remaining = Math.max(settings.COOLDOWN_MIN - globalElapsed, 0);
      await runnerDebug('Global cooldown active, skipping run', withReason('cooldown_active', {
        trigger,
        scope: 'global',
        elapsed: globalElapsed,
        remaining
      }));
      await persistSummary({
        trigger,
        outcome: 'cooldown-skip',
        details: { elapsed: globalElapsed, remaining, scope: 'global' }
      });
      return {
        ran: false,
        trigger,
        reason: 'cooldown-global',
        elapsed: globalElapsed,
        remaining
      };
    }
  }

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
    await updateWouldDeleteReport({
      url,
      meta: null,
      reasons: ['domain_mismatch'],
      qualifies: false,
      settings
    });
    return { ran: false, trigger, reason: 'url-mismatch' };
  }

  if (shouldSkipUrl(url, settings)) {
    await runnerInfo('SAFE_URL_PATTERNS match, skipping', withReason('tab_ignored_safe_url', { trigger, url }));
    await persistSummary({ trigger, outcome: 'safe-url-skip', details: { url } });
    await updateWouldDeleteReport({
      url,
      meta: null,
      reasons: ['tab_ignored_safe_url'],
      qualifies: false,
      settings
    });
    return { ran: false, trigger, reason: 'safe-url' };
  }

  cooldownMemory.perTab[tabId] = now;
  cooldownMemory.globalLastRun = now;

  await runnerInfo('Scan started', withReason('scan_started', { trigger, manual }));
  await trace('Requesting conversation meta', { trigger });

  const meta = await requestFromContent(tabId, { type: 'MYCHATGPT:getConversationMeta' });
  if (!meta) {
    await runnerWarn('Meta extraction failed', withReason('meta_missing', { trigger, manual }));
    await persistSummary({ trigger, outcome: 'meta-missing' });
    await updateWouldDeleteReport({
      url,
      meta: null,
      reasons: ['missing_meta'],
      qualifies: false,
      settings
    });
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
        url,
        meta: summarizedMeta
      }));
    }
    await runnerInfo('Conversation disqualified', withReason('qualify_false', {
      trigger,
      url,
      reasons: qualifier.reasons,
      meta: summarizedMeta
    }));
    await persistSummary({ trigger, outcome: 'disqualified', details: { reasons: qualifier.reasons } });
    await updateWouldDeleteReport({
      url,
      meta,
      reasons: qualifier.reasons,
      qualifies: false,
      settings
    });
    return {
      ran: true,
      trigger,
      qualified: false,
      reasons: qualifier.reasons,
      meta
    };
  }

  const deleteLimit = Number.parseInt(settings.DELETE_LIMIT, 10);
  if (Number.isFinite(deleteLimit) && deleteLimit > 0) {
    const snapshot = await loadWouldDeleteReport(settings.REPORT_LIMIT);
    const activeQualified = (snapshot.items || []).filter((item) => item.qualifies).length;
    if (activeQualified >= deleteLimit) {
      const reasons = ['delete_limit_reached'];
      await runnerInfo('Delete limit reached, skipping candidate', withReason('qualify_false_delete_limit_reached', {
        trigger,
        url,
        meta: summarizedMeta,
        activeQualified,
        deleteLimit
      }));
      await updateWouldDeleteReport({
        url,
        meta,
        reasons,
        qualifies: false,
        settings
      });
      return {
        ran: true,
        trigger,
        qualified: false,
        reasons,
        meta
      };
    }
  }

  await runnerInfo('Conversation qualifies', withReason('qualify_true', { trigger, url, meta: summarizedMeta }));

  const mayPersist = !settings.LIST_ONLY || settings.ALLOW_LOCAL_BACKUP_WHEN_LIST_ONLY;
  if (!mayPersist) {
    await runnerInfo('LIST_ONLY mode prevents backup storage', withReason('backup_skipped_list_only', {
      trigger,
      manual,
      meta: summarizedMeta
    }));
    await persistSummary({ trigger, outcome: 'would-backup', details: { meta: summarizedMeta } });
    await updateWouldDeleteReport({
      url,
      meta,
      reasons: [],
      qualifies: true,
      settings
    });
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
    await updateWouldDeleteReport({
      url,
      meta,
      reasons: ['qa_missing'],
      qualifies: true,
      settings
    });
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
  try {
    const id = await backups.add(entry);
    await runnerInfo('Backup stored', withReason('backup_stored', {
      trigger,
      id,
      manual,
      meta: summarizedMeta
    }));
    await persistSummary({ trigger, outcome: 'stored', details: { id } });
    notifyBackupsChanged();
    await updateWouldDeleteReport({
      url,
      meta,
      reasons: [],
      qualifies: true,
      snapshotId: settings.INCLUDE_BACKUP_SNAPSHOT_ID ? id : undefined,
      settings
    });
    return {
      ran: true,
      trigger,
      qualified: true,
      stored: true,
      id,
      meta
    };
  } catch (error) {
    await runnerWarn('Backup storage failed', withReason('backup_failed', {
      trigger,
      error: error?.message,
      meta: summarizedMeta
    }));
    await persistSummary({
      trigger,
      outcome: 'store-failed',
      details: { error: error?.message }
    });
    await updateWouldDeleteReport({
      url,
      meta,
      reasons: ['backup_failed'],
      qualifies: true,
      settings
    });
    return {
      ran: true,
      trigger,
      qualified: true,
      stored: false,
      error: 'backup-failed'
    };
  }
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
    reasons.push('messages_gt_max');
  }

  if (typeof meta.userMessageCount === 'number' && meta.userMessageCount > maxUserMessages) {
    reasons.push('user_messages_gt_max');
  }

  if (typeof meta.lastMessageAgeMin === 'number' && meta.lastMessageAgeMin < minAge) {
    reasons.push('age_lt_min');
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

async function triggerScanForAllTabs(bypassCooldown) {
  try {
    const tabs = await chrome.tabs.query({ url: [CHAT_URL_PATTERN] });
    let processed = 0;
    for (const tab of tabs) {
      if (typeof tab?.id !== 'number') {
        continue;
      }
      processed += 1;
      try {
        await runScan({
          tabId: tab.id,
          trigger: 'scan-all-manual',
          bypassCooldown,
          manual: true,
          forcedUrl: tab.url
        });
      } catch (error) {
        await runnerWarn('Scan-all iteration failed', withReason('scan_all_tab_failed', {
          tabId: tab.id,
          error: error?.message
        }));
      }
      await delay(50);
    }
    return processed;
  } catch (error) {
    await runnerWarn('Scan-all query failed', withReason('scan_all_query_failed', { error: error?.message }));
    return 0;
  }
}
