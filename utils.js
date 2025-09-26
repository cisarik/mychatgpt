const SETTINGS_KEY = 'cleaner_settings_v2';

export const DEFAULT_SETTINGS = Object.freeze({
  heuristics: Object.freeze({
    MAX_AGE_MINUTES: 15,
    MAX_LEN_PROMPT: 240,
    MAX_LEN_ANSWER: 600
  }),
  risky: Object.freeze({
    enabled: false,
    risky_step_timeout_ms: 10000,
    risky_wait_after_open_ms: 260,
    risky_wait_after_click_ms: 160,
    risky_between_tabs_ms: 800
  })
});

export { SETTINGS_KEY };

export function normalizeSettings(candidate) {
  const heuristics = { ...DEFAULT_SETTINGS.heuristics, ...(candidate?.heuristics || {}) };
  const riskyRaw = { ...DEFAULT_SETTINGS.risky, ...(candidate?.risky || {}) };
  const risky = {
    ...riskyRaw,
    risky_step_timeout_ms: coerceWait(riskyRaw.risky_step_timeout_ms, 500, 60000, DEFAULT_SETTINGS.risky.risky_step_timeout_ms),
    risky_wait_after_open_ms: coerceWait(riskyRaw.risky_wait_after_open_ms, 40, 5000, DEFAULT_SETTINGS.risky.risky_wait_after_open_ms),
    risky_wait_after_click_ms: coerceWait(riskyRaw.risky_wait_after_click_ms, 40, 5000, DEFAULT_SETTINGS.risky.risky_wait_after_click_ms),
    risky_between_tabs_ms: coerceWait(riskyRaw.risky_between_tabs_ms, 40, 60000, DEFAULT_SETTINGS.risky.risky_between_tabs_ms)
  };
  return { heuristics, risky };
}

export function computeEligibility(item, rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const counts = item?.counts || {};
  const userTurns = Number.isFinite(counts.user) ? Number(counts.user) : 0;
  const assistantTurns = Number.isFinite(counts.assistant) ? Number(counts.assistant) : 0;
  const userText = (item?.userText || '').trim();
  const assistantHTML = String(item?.assistantHTML || '');
  const assistantText = stripHtml(assistantHTML);
  const createdAt = normalizeTimestamp(item?.createdAt);

  if (userTurns !== 1) {
    return { eligible: false, reason: 'missing_user_turn' };
  }
  if (assistantTurns !== 1) {
    return { eligible: false, reason: 'missing_assistant_turn' };
  }
  if (!userText) {
    return { eligible: false, reason: 'empty_prompt' };
  }
  if (!assistantText) {
    return { eligible: false, reason: 'empty_answer' };
  }
  if (userText.length > settings.heuristics.MAX_LEN_PROMPT) {
    return { eligible: false, reason: 'prompt_too_long' };
  }
  if (assistantText.length > settings.heuristics.MAX_LEN_ANSWER) {
    return { eligible: false, reason: 'answer_too_long' };
  }
  if (!createdAt) {
    return { eligible: false, reason: 'missing_created_at' };
  }
  const ageMinutes = (Date.now() - createdAt) / 60000;
  if (!Number.isFinite(ageMinutes) || ageMinutes > settings.heuristics.MAX_AGE_MINUTES) {
    return { eligible: false, reason: 'too_old' };
  }
  return { eligible: true, reason: null };
}

export function getConvoUrl(convoId) {
  return `https://chatgpt.com/c/${convoId}`;
}

export function getConvoIdFromUrl(href) {
  if (!href) {
    return null;
  }
  try {
    const parsed = new URL(href);
    const parts = parsed.pathname.split('/');
    const idx = parts.indexOf('c');
    if (idx >= 0 && parts[idx + 1]) {
      return parts[idx + 1];
    }
  } catch (_error) {
    return null;
  }
  return null;
}

export function sleep(ms) {
  const value = Number(ms);
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(value) ? Math.max(0, value) : 0));
}

export async function focusTab(tabId, windowId) {
  if (typeof windowId === 'number') {
    await chrome.windows.update(windowId, { focused: true });
  }
  await chrome.tabs.update(tabId, { active: true });
  await sleep(randomBetween(120, 180));
}

export function randomBetween(min, max) {
  const safeMin = Number.isFinite(min) ? Math.max(0, Math.floor(min)) : 0;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, Math.floor(max)) : safeMin;
  if (safeMax <= safeMin) {
    return safeMin;
  }
  const span = safeMax - safeMin + 1;
  return safeMin + Math.floor(Math.random() * span);
}

export function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function logBg(...args) {
  console.log('[Cleaner][bg]', ...args);
}

function coerceWait(value, min, max, fallback) {
  const numeric = Number.isFinite(value) ? Number(value) : Number.parseFloat(value);
  const candidate = Number.isFinite(numeric) ? numeric : fallback;
  const boundedMin = Math.max(0, Number.isFinite(min) ? Number(min) : 0);
  const boundedMax = Math.max(boundedMin, Number.isFinite(max) ? Number(max) : boundedMin);
  const clamped = Math.max(boundedMin, Math.min(boundedMax, Number(candidate) || 0));
  return Math.round(clamped);
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}
