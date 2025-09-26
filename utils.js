const SETTINGS_KEY = 'cleaner_settings_v2';
const WAIT_MIN = 40;
const WAIT_MAX = 5000;

export const DEFAULT_SETTINGS = Object.freeze({
  heuristics: Object.freeze({
    MAX_AGE_MINUTES: 15,
    MAX_LEN_PROMPT: 240,
    MAX_LEN_ANSWER: 600
  }),
  risky: Object.freeze({
    enabled: false,
    dry_run: false,
    risky_step_timeout_ms: 10000,
    risky_between_tabs_ms: 800,
    risky_wait_after_open_ms: 260,
    risky_wait_after_click_ms: 160
  })
});

export { SETTINGS_KEY };

export function normalizeSettings(candidate) {
  const heuristics = { ...DEFAULT_SETTINGS.heuristics, ...(candidate?.heuristics || {}) };
  const riskyRaw = { ...DEFAULT_SETTINGS.risky, ...(candidate?.risky || {}) };
  const risky = {
    ...riskyRaw,
    risky_wait_after_open_ms: coerceWait(riskyRaw.risky_wait_after_open_ms, 40, 5000, DEFAULT_SETTINGS.risky.risky_wait_after_open_ms),
    risky_wait_after_click_ms: coerceWait(riskyRaw.risky_wait_after_click_ms, 40, 5000, DEFAULT_SETTINGS.risky.risky_wait_after_click_ms),
    risky_step_timeout_ms: coerceWait(riskyRaw.risky_step_timeout_ms, 500, 60000, DEFAULT_SETTINGS.risky.risky_step_timeout_ms),
    risky_between_tabs_ms: coerceWait(riskyRaw.risky_between_tabs_ms, 40, 60000, DEFAULT_SETTINGS.risky.risky_between_tabs_ms)
  };
  return { heuristics, risky };
}

export function computeEligibility(item, rawSettings) {
  const settings = normalizeSettings(rawSettings);
  const counts = item?.counts || {};
  const userText = (item?.userText || '').trim();
  const assistantHTML = String(item?.assistantHTML || '');
  const assistantText = stripHtml(assistantHTML);
  const createdAt = normalizeDate(item?.createdAt);

  if (counts.user !== 1) {
    return { eligible: false, reason: 'missing_user_turn' };
  }
  if (counts.assistant !== 1) {
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
  if (ageMinutes > settings.heuristics.MAX_AGE_MINUTES) {
    return { eligible: false, reason: 'too_old' };
  }
  return { eligible: true };
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
    // ignore
  }
  return null;
}

export function log(...args) {
  console.log('[Cleaner]', ...args);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function delay(ms) {
  return sleep(ms);
}

export function coerceWait(value, min = WAIT_MIN, max = WAIT_MAX, fallback = DEFAULT_SETTINGS.risky.risky_wait_after_click_ms) {
  const numeric = Number.isFinite(value) ? Number(value) : Number.parseFloat(value);
  const candidate = Number.isFinite(numeric) ? numeric : fallback;
  return clampWait(candidate, min, max);
}

export function randomBetween(min, max) {
  const clampedMin = Number.isFinite(min) ? Math.max(0, Math.floor(min)) : 0;
  const clampedMax = Number.isFinite(max) ? Math.max(clampedMin, Math.floor(max)) : clampedMin;
  if (clampedMax <= clampedMin) {
    return clampedMin;
  }
  const span = clampedMax - clampedMin + 1;
  return clampedMin + Math.floor(Math.random() * span);
}

export function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
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

function clampWait(raw, min, max) {
  const clampedMin = Number.isFinite(min) ? Math.max(0, min) : 0;
  const clampedMax = Number.isFinite(max) ? Math.max(clampedMin, max) : clampedMin;
  const next = Math.max(clampedMin, Math.min(clampedMax, Number(raw) || 0));
  return Math.round(next);
}

export async function getActiveChatgptTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: 'https://chatgpt.com/*'
  });
  if (!tab) {
    throw new Error('no_active_chatgpt_tab');
  }
  return tab;
}

export async function focusTab(tabId, windowId) {
  if (typeof windowId === 'number') {
    await chrome.windows.update(windowId, { focused: true });
  }
  await chrome.tabs.update(tabId, { active: true });
  await sleep(150);
}
