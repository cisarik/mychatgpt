const SETTINGS_KEY = 'cleaner_settings_v2';

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
  const risky = { ...DEFAULT_SETTINGS.risky, ...(candidate?.risky || {}) };
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

export function log(...args) {
  console.log('[Cleaner]', ...args);
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
