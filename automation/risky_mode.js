import {
  DeletionStrategyIds,
  DEFAULT_SETTINGS,
  getConvoUrl,
  getConvoIdFromUrl,
  normalizeChatUrl,
  normalizeSettings,
  now,
  randomJitter,
  sleep
} from '../utils.js';

const PREFIX = '[RiskyMode]';

const UI_PROFILES = [
  {
    id: 'sk-cz',
    match(langs) {
      return langs.some((code) => /^sk|^cs|^cz/.test(code));
    },
    delete_menu_items: [
      /^(odstrániť|odstranit)$/i,
      /^(zmazať|zmazat)$/i
    ],
    confirm_buttons: [
      /^(odstrániť|odstranit)$/i,
      /^(zmazať|zmazat)$/i,
      /^(áno, odstrániť|ano, odstranit)$/i
    ],
    toast_texts: [/odstránen/i, /odstranen/i, /zmazan/i]
  },
  {
    id: 'en',
    match() {
      return true;
    },
    delete_menu_items: [
      /^(delete|delete chat|delete conversation)$/i,
      /^remove$/i
    ],
    confirm_buttons: [
      /^(delete|delete conversation)$/i,
      /^yes, delete$/i
    ],
    toast_texts: [/deleted/i, /removed/i]
  }
];

/**
 * Slovensky: Vytvorí riskantnú automatizačnú stratégiu.
 * @param {{
 *   getSettings: () => Partial<typeof DEFAULT_SETTINGS>,
 *   getDebug?: () => boolean,
 *   shouldCancel?: () => (boolean|Promise<boolean>)
 * }} deps
 * @returns {import('../utils.js').DeletionStrategy}
 */
export function createUiAutomationDeletionStrategy(deps = {}) {
  const getSettings = typeof deps.getSettings === 'function' ? deps.getSettings : () => DEFAULT_SETTINGS;
  const getDebug = typeof deps.getDebug === 'function' ? deps.getDebug : () => normalizeSettings(getSettings()).debugLogs;
  const shouldCancel = typeof deps.shouldCancel === 'function' ? deps.shouldCancel : null;

  return {
    id: DeletionStrategyIds.UI_AUTOMATION,
    async isAvailable() {
      try {
        const tab = await findLikelyChatTab();
        if (!tab?.id || !isChatHost(tab.url)) {
          return false;
        }
        await preloadSelectors(tab.id);
        const [injected] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'ISOLATED',
          func: detectChatAvailability,
          args: [{ prefix: PREFIX }]
        });
        return Boolean(injected?.result?.ok);
      } catch (_error) {
        return false;
      }
    },
    async deleteMany(convoUrls) {
      const urls = Array.isArray(convoUrls) ? convoUrls.filter(Boolean) : [];
      const normalizedSettings = normalizeSettings(getSettings());
      const { risky_max_retries: maxRetries } = normalizedSettings;
      const results = [];
      let cancelled = false;
      for (let index = 0; index < urls.length; index += 1) {
        if (shouldCancel && await shouldCancel()) {
          cancelled = true;
          break;
        }
        const rawUrl = urls[index];
        const canonical = normalizeChatUrl(rawUrl) || getConvoUrl(getConvoIdFromUrl(rawUrl));
        const convoId = getConvoIdFromUrl(canonical) || getConvoIdFromUrl(rawUrl) || '';
        if (!canonical) {
          results.push({
            convoId,
            url: rawUrl,
            ok: false,
            reason: 'invalid_url',
            strategyId: DeletionStrategyIds.UI_AUTOMATION
          });
          continue;
        }
        const attemptResult = await attemptAutomation({
          convoId,
          url: canonical,
          settings: normalizedSettings,
          maxRetries,
          debug: getDebug()
        });
        results.push(attemptResult);
        if (index < urls.length - 1) {
          await maybeDelayBetweenTabs(normalizedSettings);
        }
      }
      const opened = results.filter((item) => item.ok).length;
      return {
        strategyId: DeletionStrategyIds.UI_AUTOMATION,
        attempted: urls.length,
        opened,
        notes: cancelled ? ['cancelled'] : [],
        results
      };
    }
  };
}

/** Slovensky: Pokúsi sa automatizovať mazanie s retry logikou. */
async function attemptAutomation({ convoId, url, settings, maxRetries, debug }) {
  const totalAttempts = Math.max(1, Number.isFinite(maxRetries) ? maxRetries + 1 : 1);
  let lastError = { reason: 'unknown', step: 'init' };
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      const tab = await ensureTabReady(url, settings.risky_step_timeout_ms, debug);
      await preloadSelectors(tab.id);
      const guardStatus = await guardConversationReady(tab.id, settings.risky_step_timeout_ms);
      if (!guardStatus?.ok) {
        lastError = {
          reason: guardStatus?.reason || 'conversation_not_ready',
          step: 'guard',
          attempt: attempt + 1
        };
        if (attempt < totalAttempts - 1) {
          await sleep(180);
          continue;
        }
        break;
      }
      const jitter = randomJitter(settings.risky_jitter_ms);
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: runDeletionAutomation,
        args: [
          {
            url,
            convoId,
            jitter,
            attempt: attempt + 1,
            settings,
            debug,
            prefix: PREFIX
          }
        ]
      });
      const result = injected?.[0]?.result;
      if (result?.ok) {
        return {
          convoId,
          url,
          ok: true,
          reason: result.reason || 'deleted',
          step: 'verify',
          attempt: attempt + 1,
          strategyId: DeletionStrategyIds.UI_AUTOMATION
        };
      }
      lastError = {
        reason: result?.reason || 'automation_failed',
        step: result?.step || 'unknown',
        attempt: attempt + 1
      };
      if (attempt < totalAttempts - 1) {
        await sleep(200);
      }
    } catch (error) {
      lastError = {
        reason: parseChromeError(error),
        step: 'execute',
        attempt: attempt + 1
      };
    }
  }
  return {
    convoId,
    url,
    ok: false,
    reason: lastError.reason,
    step: lastError.step,
    attempt: lastError.attempt,
    strategyId: DeletionStrategyIds.UI_AUTOMATION
  };
}

/** Slovensky: Vyhľadá rozumný chatGPT tab na dostupnosť. */
async function findLikelyChatTab() {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  return tabs.find((tab) => Boolean(tab?.id));
}

/** Slovensky: Overí, či URL patrí hostu chatgpt.com. */
function isChatHost(url) {
  if (typeof url !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(url, 'https://chatgpt.com');
    return parsed.hostname.endsWith('chatgpt.com');
  } catch (_error) {
    return false;
  }
}

/** Slovensky: Zaistí, že tab je načítaný a pripravený. */
async function ensureTabReady(url, timeoutMs, debug) {
  const normalized = normalizeChatUrl(url) || url;
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  let target = tabs.find((tab) => normalizeChatUrl(tab.url) === normalized);
  if (!target) {
    target = await chrome.tabs.create({ url: normalized, active: true });
  } else if (target.discarded && target.id) {
    await chrome.tabs.reload(target.id);
  }
  if (!target?.id) {
    throw new Error('tab_not_found');
  }
  try {
    if (target.windowId !== undefined) {
      await chrome.windows.update(target.windowId, { focused: true });
    }
  } catch (_error) {}
  try {
    await chrome.tabs.update(target.id, { active: true });
  } catch (_error) {}
  await waitForTabLoad(target.id, timeoutMs, debug);
  return await chrome.tabs.get(target.id);
}

/** Slovensky: Počká na úplné načítanie tabu. */
async function waitForTabLoad(tabId, timeoutMs, debug) {
  const limit = now() + Math.max(2000, timeoutMs || 5000);
  while (now() < limit) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: () => document.readyState
        });
        const state = injected?.[0]?.result;
        if (state === 'complete') {
          return;
        }
      } catch (error) {
        if (debug) {
          console.log(PREFIX, 'readyState check failed', error?.message || error);
        }
      }
    }
    await sleep(120);
  }
  throw new Error('tab_load_timeout');
}

/** Slovensky: Po reťazci pokusov reštartuje tab. */
/** Slovensky: Prednačíta selektory do tabu. */
async function preloadSelectors(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['automation/selectors.js']
  });
}

/** Slovensky: Overí, či je konverzačná stránka pripravená. */
async function guardConversationReady(tabId, timeoutMs) {
  const [response] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: ({ timeoutMs, prefix }) => {
      const selectors = globalThis.RiskySelectors;
      if (!selectors?.waitForAppShell) {
        console.warn(`${prefix} Guard: selectors missing`);
        return { ok: false, reason: 'selectors_missing' };
      }
      return selectors
        .waitForAppShell({ timeoutMs })
        .then(async (shell) => ({
          ok: true,
          shell,
          conversation: await selectors.waitForConversationView({ timeoutMs })
        }))
        .catch((error) => {
          console.warn(`${prefix} Guard failed`, {
            message: error?.message || String(error),
            code: error?.code
          });
          return {
            ok: false,
            reason: error?.code || 'guard_failed',
            message: error?.message || String(error)
          };
        });
    },
    args: [{ timeoutMs, prefix: PREFIX }]
  });
  return response?.result || { ok: false, reason: 'guard_failed' };
}

/** Slovensky: Prenos logiky na stránku. */

async function runDeletionAutomation(payload) {
  const {
    url,
    convoId,
    jitter,
    attempt,
    settings,
    prefix
  } = payload;

  const selectors = globalThis.RiskySelectors;
  if (!selectors) {
    console.warn(`${prefix} selectors unavailable`);
    return { ok: false, reason: 'selectors_missing', step: 'init' };
  }

  const dryRun = Boolean(settings?.dry_run);
  const stepTimeout = Number.isFinite(settings?.risky_step_timeout_ms)
    ? Math.max(500, settings.risky_step_timeout_ms)
    : 8000;
  const stepRetryLimit = Number.isFinite(settings?.risky_max_retries)
    ? Math.max(0, settings.risky_max_retries)
    : 0;

  const log = (level, message, meta) => {
    if (meta !== undefined) {
      console[level](`${prefix} ${message}`, meta);
    } else {
      console[level](`${prefix} ${message}`);
    }
  };

  const toErrorMeta = (error) => {
    if (!error) {
      return { code: 'error', message: 'unknown' };
    }
    const meta = {
      code: error.code || error.reason || 'error',
      message: error.message || error.code || error.reason || String(error)
    };
    if (error.reason) {
      meta.reason = error.reason;
    }
    if (Array.isArray(error.attempted) && error.attempted.length) {
      meta.attempted = error.attempted;
    }
    if (Number.isFinite(error.timeoutMs)) {
      meta.timeoutMs = error.timeoutMs;
    }
    return meta;
  };

  const logMarker = (label, evidence) => {
    if (evidence !== undefined) {
      log('log', label, evidence);
    } else {
      log('log', label);
    }
  };

  const runStep = async (name, executor, options = {}) => {
    const retryable = options.retryable !== false;
    const skip = Boolean(options.skip);
    const maxRetries = retryable ? stepRetryLimit : 0;
    for (let index = 0; index <= maxRetries; index += 1) {
      try {
        const result = await executor({ skip: skip && index === 0, attempt: index + 1 });
        const evidence = result?.evidence || result?.meta;
        logMarker(`${name}✓`, evidence);
        return result || {};
      } catch (error) {
        const meta = toErrorMeta(error);
        if (index >= maxRetries) {
          log('error', `FAIL code=${meta.code || meta.reason || 'error'} step=${name}`, meta);
          throw { ...error, step: name };
        }
        log('warn', `retry step=${name}`, meta);
        await selectors.sleep(120);
      }
    }
    throw { code: 'step_failed', reason: name };
  };

  const failure = (step, error) => ({
    ok: false,
    reason: error?.reason || error?.code || 'automation_failed',
    step,
    details: toErrorMeta(error)
  });

  log('log', `attempt=${attempt} start`, { convoId, url });
  if (Number.isFinite(jitter) && jitter > 0) {
    log('log', 'step=jitter apply', { ms: jitter });
    await selectors.sleep(jitter);
  }

  if (!isLoggedIn()) {
    log('warn', 'login guard failed');
    return { ok: false, reason: 'not_logged_in', step: 'guard-login' };
  }

  await dismissDraftBanner((meta) => log('log', 'closing draft banner', meta));

  const profile = detectUiProfile();

  try {
    await selectors.waitForAppShell({ timeoutMs: stepTimeout });
    await selectors.sleep(50);

    const header = await runStep('share', () => selectors.waitForHeaderToolbar({ timeoutMs: stepTimeout }), { retryable: true });
    const toolbarEl = header?.toolbarEl;
    const shareEl = header?.shareEl;
    if (!(toolbarEl instanceof Element) || !(shareEl instanceof Element)) {
      return failure('share', { code: 'header_missing', message: 'Header toolbar missing' });
    }

    const kebab = await runStep('kebab', () => selectors.findHeaderKebabNearShare(toolbarEl, shareEl, { timeoutMs: stepTimeout }), {
      retryable: true
    });
    const kebabEl = kebab?.kebabEl || kebab?.element;
    if (!(kebabEl instanceof Element)) {
      return failure('kebab', { code: 'kebab_missing', message: 'Header kebab missing' });
    }

    const menu = await runStep(
      'menu',
      async ({ skip }) => {
        await selectors.reveal(kebabEl);
        if (skip) {
          console.log(`${prefix} DRY RUN would click kebab`, kebab?.evidence);
        } else {
          await selectors.clickHard(kebabEl);
        }
        try {
          const lookupTimeout = skip ? Math.min(400, stepTimeout) : stepTimeout;
          const found = await selectors.findDeleteInOpenMenu(profile, { timeoutMs: lookupTimeout });
          return found;
        } catch (error) {
          if (skip) {
            return { element: null, evidence: { skip: true, ...toErrorMeta(error) } };
          }
          throw error;
        }
      },
      { skip: dryRun, retryable: true }
    );

    const deleteStep = await runStep(
      'delete',
      async ({ skip }) => {
        let target = menu?.element;
        let evidence = menu?.evidence;
        if (!target) {
          try {
            const lookupTimeout = skip ? Math.min(400, stepTimeout) : stepTimeout;
            const refreshed = await selectors.findDeleteInOpenMenu(profile, { timeoutMs: lookupTimeout });
            target = refreshed.element;
            evidence = refreshed.evidence;
          } catch (error) {
            if (!skip) {
              throw error;
            }
            return { evidence: { skip: true, ...toErrorMeta(error) } };
          }
        }
        if (!(target instanceof Element)) {
          if (skip) {
            return { evidence: { skip: true, reason: 'delete_missing' } };
          }
          throw { code: 'delete_missing', message: 'Delete menu item missing' };
        }
        if (skip) {
          console.log(`${prefix} DRY RUN would click delete`, evidence);
          return { element: target, evidence: { ...evidence, skip: true } };
        }
        await selectors.reveal(target);
        await selectors.clickHard(target);
        return { element: target, evidence };
      },
      { skip: dryRun, retryable: true }
    );

    const confirm = await runStep(
      'confirm',
      async ({ skip }) => {
        try {
          const lookupTimeout = skip ? Math.min(400, stepTimeout) : stepTimeout;
          const match = await selectors.findConfirmDelete(profile, { timeoutMs: lookupTimeout });
          if (!(match.element instanceof Element)) {
            throw { code: 'confirm_missing', message: 'Confirm button missing' };
          }
          if (skip) {
            console.log(`${prefix} DRY RUN would click confirm`, match.evidence);
            return { element: match.element, evidence: { ...match.evidence, skip: true } };
          }
          await selectors.reveal(match.element);
          await selectors.clickHard(match.element);
          return match;
        } catch (error) {
          if (skip) {
            return { evidence: { skip: true, ...toErrorMeta(error) } };
          }
          throw error;
        }
      },
      { skip: dryRun, retryable: true }
    );

    if (dryRun) {
      log('log', 'dry_run complete', {
        kebab: kebab?.evidence,
        delete: deleteStep?.evidence,
        confirm: confirm?.evidence
      });
      return { ok: true, reason: 'dry_run', step: 'dry_run' };
    }

    const verify = await runStep(
      'verify',
      async () => {
        const outcome = await verifyDeletion({ selectors, profile, convoId, timeoutMs: stepTimeout });
        if (!outcome.ok) {
          throw outcome;
        }
        return { evidence: outcome.evidence, reason: outcome.reason };
      },
      { retryable: false }
    );

    log('log', `attempt=${attempt} completed`, { reason: verify.reason || 'deleted', path: 'header' });
    return { ok: true, reason: verify.reason || 'deleted', step: 'verify' };
  } catch (error) {
    return failure(error?.step || 'automation', error);
  }
}

function verifyDeletion({ selectors, profile, convoId, timeoutMs }) {
  const limit = Number.isFinite(timeoutMs) ? Math.max(500, timeoutMs) : 8000;
  const deadline = Date.now() + limit;
  const toastRegex = profile?.toast_regex || selectors.TOAST_REGEX;
  const convoPattern = convoId ? new RegExp(`/c/${escapeRegex(convoId)}\b`) : null;

  return (async () => {
    while (Date.now() <= deadline) {
      if (convoPattern && !convoPattern.test(window.location.pathname)) {
        return { ok: true, reason: 'url_changed', evidence: { url: window.location.href } };
      }
      const header = selectors.findShare?.();
      if (!header || !(header.shareEl instanceof Element)) {
        return { ok: true, reason: 'header_missing' };
      }
      const toastNode = selectors.byTextDeep(document.body, toastRegex);
      if (toastNode) {
        const host = toastNode.closest('[role="alert"],[role="status"],[data-testid*="toast" i]') || toastNode;
        return { ok: true, reason: 'toast', evidence: selectors.describeElement(host) };
      }
      await selectors.sleep(150);
    }
    return { ok: false, reason: 'verify_timeout', timeoutMs: limit, evidence: { url: window.location.href } };
  })();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\$&');
}
function detectUiProfile() {
  const langs = normalizeLanguages();
  const base = UI_PROFILES.find((profile) => {
    try {
      return typeof profile.match === 'function' ? profile.match(langs) : false;
    } catch (_error) {
      return false;
    }
  }) || UI_PROFILES[UI_PROFILES.length - 1];
  return compileProfile(base);
}

function normalizeLanguages() {
  const collected = [];
  if (Array.isArray(navigator?.languages)) {
    collected.push(...navigator.languages);
  }
  if (typeof navigator?.language === 'string') {
    collected.push(navigator.language);
  }
  if (typeof document?.documentElement?.lang === 'string') {
    collected.push(document.documentElement.lang);
  }
  return collected
    .map((code) => String(code || '').toLowerCase())
    .filter(Boolean);
}

function compileProfile(base) {
  const toastPatterns = Array.isArray(base?.toast_texts)
    ? base.toast_texts.map((pattern) => (pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')))
    : [];
  const toast_regex = toastPatterns.length
    ? new RegExp(toastPatterns.map((regex) => regex.source).join('|'), 'i')
    : null;
  return {
    delete_menu_items: base?.delete_menu_items || [],
    confirm_buttons: base?.confirm_buttons || [],
    toast_texts: base?.toast_texts || [],
    toast_regex
  };
}

/** Slovensky: Pokus o zatvorenie baneru s draftom. */
async function dismissDraftBanner(logger) {
  const banner = document.querySelector('[data-testid*="draft"]');
  if (!banner) {
    return;
  }
  const close = banner.querySelector('button, [role="button"]');
  if (!close || !(close instanceof HTMLElement)) {
    return;
  }
  if (typeof logger === 'function') {
    logger(summarizeElement(close));
  }
  close.click();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/** Slovensky: Overí prítomnosť prihlásenia. */
function isLoggedIn() {
  const login = document.querySelector('a[href*="/login"], button[data-testid*="login" i]');
  const appShell = document.querySelector('#__next [data-testid="conversation-main"], main [data-testid="conversation-main"]');
  return !login && Boolean(appShell);
}

/** Slovensky: Zhrnie element pre logovanie. */
function summarizeElement(node) {
  if (!(node instanceof HTMLElement)) {
    return null;
  }
  const tag = node.tagName.toLowerCase();
  const id = node.id ? `#${node.id}` : '';
  const classes = node.className ? `.${String(node.className).trim().split(/\s+/).join('.')}` : '';
  const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
  const text = (node.textContent || '').trim().slice(0, 42);
  return { tag: `${tag}${id}${classes}`, label, text };
}

/** Slovensky: Parsuje chybu z chrome API. */
function parseChromeError(error) {
  if (!error) {
    return 'chrome_error';
  }
  if (typeof error === 'string') {
    return error;
  }
  return error.message || error.code || 'chrome_error';
}

/** Slovensky: Jednoduchá pauza medzi tabuľkami. */
async function maybeDelayBetweenTabs(settings) {
  const baseDelay = Math.max(0, settings.risky_between_tabs_ms || 0);
  const jitter = randomJitter(settings.risky_jitter_ms);
  await sleep(baseDelay + jitter);
}

/** Slovensky: Deteguje dostupnosť aplikácie na aktívnom tabe. */
function detectChatAvailability({ prefix }) {
  const hostOk = window.location.hostname.endsWith('chatgpt.com');
  if (!hostOk) {
    console.warn(`${prefix} Availability guard: unexpected host`, window.location.hostname);
    return { ok: false, reason: 'host_mismatch' };
  }
  const selectors = globalThis.RiskySelectors;
  if (!selectors?.waitForAppShell) {
    console.warn(`${prefix} Availability guard: selectors missing`);
    return { ok: false, reason: 'selectors_missing' };
  }
  return selectors
    .waitForAppShell({ timeoutMs: 3000 })
    .then(() => selectors.waitForConversationView({ timeoutMs: 3000 }))
    .then(() => ({ ok: true }))
    .catch((error) => {
      console.warn(`${prefix} Availability guard failed`, error?.message || error);
      return { ok: false, reason: error?.message || 'guard_failed' };
    });
}
