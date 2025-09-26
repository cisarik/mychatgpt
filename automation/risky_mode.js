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
          await reloadTab(tab.id);
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
        await reloadTab(tab.id);
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
async function reloadTab(tabId) {
  try {
    await chrome.tabs.reload(tabId, { bypassCache: true });
  } catch (_error) {}
}

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

  const failure = (step, error) => ({
    ok: false,
    reason: error?.reason || error?.code || 'automation_failed',
    step,
    details: toErrorMeta(error)
  });

  const dispatchClick = (element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  };

  const maybeClick = (element, evidence) => {
    if (dryRun) {
      console.log(`${prefix} DRY RUN would click:`, evidence);
    }
    dispatchClick(element);
  };

  const timedStep = async (step, path, action) => {
    const started = Date.now();
    try {
      const result = await action();
      const duration = Date.now() - started;
      const evidence = result?.evidence || result;
      if (evidence !== undefined) {
        log('log', `step=${step} path=${path} ok in ${duration}ms`, evidence);
      } else {
        log('log', `step=${step} path=${path} ok in ${duration}ms`);
      }
      return { ok: true, result, duration };
    } catch (error) {
      const duration = Date.now() - started;
      log('warn', `step=${step} path=${path} failed in ${duration}ms`, toErrorMeta(error));
      return { ok: false, error, duration };
    }
  };

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

  const shellStep = await timedStep('guard', 'appShell', () => selectors.waitForAppShell({ timeoutMs: stepTimeout }));
  if (!shellStep.ok) {
    return failure('guard', shellStep.error);
  }

  const conversationStatus = await selectors.waitForConversationView({ timeoutMs: stepTimeout });
  if (conversationStatus.ready) {
    log('log', 'step=guard path=conversation ok', conversationStatus.evidence);
  } else {
    log('warn', 'step=guard path=conversation not-ready', {
      attempted: conversationStatus.attempted,
      timeoutMs: conversationStatus.timeoutMs
    });
  }

  const profile = detectUiProfile();
  const toastRegex = profile.toast_regex || selectors.TOAST_REGEX;
  const useHeader = settings?.risky_simple_header !== false;
  const allowSidebarFallback = Boolean(settings?.risky_allow_sidebar_fallback);

  const logHeaderSummary = (summary) => {
    if (!Array.isArray(summary) || !summary.length) {
      return;
    }
    const parts = summary.map((entry) => {
      const label = entry.label || 'step';
      const okMark = entry.ok ? '✓' : '×';
      const duration = Number.isFinite(entry.duration) ? `${entry.duration}ms` : '';
      return `${label}${okMark}${duration ? `(${duration})` : ''}`;
    });
    log('log', `header: ${parts.join(' ')}`);
  };

  let headerOutcome = { ok: false, summary: [] };
  if (useHeader) {
    headerOutcome = await attemptHeaderPath();
    logHeaderSummary(headerOutcome.summary);
  }

  if (headerOutcome.ok) {
    log('log', `attempt=${attempt} completed`, { reason: headerOutcome.reason, path: 'header' });
    return { ok: true, reason: headerOutcome.reason, step: 'verify' };
  }

  if (useHeader && !allowSidebarFallback) {
    const errorMeta = toErrorMeta(headerOutcome.error || { code: 'header_path_failed' });
    errorMeta.step = headerOutcome.step || 'header';
    errorMeta.code = 'header_path_failed';
    return { ok: false, reason: 'header_path_failed', step: headerOutcome.step || 'header', details: errorMeta };
  }

  const sidebarOutcome = await attemptSidebarPath();
  if (!sidebarOutcome.ok) {
    return sidebarOutcome.failure;
  }

  log('log', `attempt=${attempt} completed`, { reason: sidebarOutcome.reason, path: 'sidebar' });
  return { ok: true, reason: sidebarOutcome.reason, step: 'verify' };

  async function attemptHeaderPath() {
    const summary = [];
    const record = async (label, action) => {
      const stepId = `header-${label}`;
      const outcome = await timedStep(stepId, 'header', action);
      summary.push({ label, ok: outcome.ok, duration: outcome.duration });
      return outcome;
    };

    const toolbarStep = await record('share', () => selectors.waitForHeaderToolbar({ timeoutMs: stepTimeout }));
    if (!toolbarStep.ok) {
      return { ok: false, step: 'header-share', error: toolbarStep.error, summary };
    }

    const toolbarContext = toolbarStep.result;
    const kebabStep = await record('kebab', () => selectors.findHeaderKebabNearShare(toolbarContext, { timeoutMs: stepTimeout }));
    if (!kebabStep.ok) {
      return { ok: false, step: 'header-kebab', error: kebabStep.error, summary };
    }

    const kebab = kebabStep.result?.element;
    if (!(kebab instanceof HTMLElement)) {
      return { ok: false, step: 'header-kebab', error: { code: 'kebab_missing', reason: 'header_kebab_missing' }, summary };
    }

    await selectors.reveal(kebab);
    log('log', 'step=reveal path=header target=kebab', kebabStep.result.evidence);
    maybeClick(kebab, kebabStep.result.evidence);
    await selectors.sleep(150);

    const menuStep = await record('menu', () => selectors.findDeleteInOpenMenu(profile, { timeoutMs: stepTimeout }));
    if (!menuStep.ok) {
      return { ok: false, step: 'header-menu', error: menuStep.error, summary };
    }

    const deleteButton = menuStep.result?.element;
    if (!(deleteButton instanceof HTMLElement)) {
      return { ok: false, step: 'header-menu', error: { code: 'delete_missing', reason: 'delete_button_missing' }, summary };
    }

    await selectors.reveal(deleteButton);
    log('log', 'step=reveal path=header target=delete', menuStep.result.evidence);
    maybeClick(deleteButton, menuStep.result.evidence);
    await selectors.sleep(150);

    const confirmStep = await record('confirm', () => selectors.findConfirmDelete(profile, { timeoutMs: stepTimeout }));
    if (!confirmStep.ok) {
      return { ok: false, step: 'header-confirm', error: confirmStep.error, summary };
    }

    const confirmButton = confirmStep.result?.element;
    if (!(confirmButton instanceof HTMLElement)) {
      return { ok: false, step: 'header-confirm', error: { code: 'confirm_missing', reason: 'confirm_button_missing' }, summary };
    }

    await selectors.reveal(confirmButton);
    log('log', 'step=reveal path=header target=confirm', confirmStep.result.evidence);
    if (dryRun) {
      console.log(`${prefix} DRY RUN would click:`, confirmStep.result.evidence);
      dismissDialog(confirmButton);
      return { ok: true, reason: 'dry_run', summary };
    }

    dispatchClick(confirmButton);

    const verifyStep = await timedStep('verify', 'header', async () => {
      const outcome = await verifyDeletion({ selectors, convoId, url, timeout: stepTimeout, toastRegex });
      if (!outcome.ok) {
        throw { code: outcome.reason || 'verify_timeout', reason: outcome.reason || 'verify_timeout', timeoutMs: outcome.timeoutMs };
      }
      return outcome;
    });

    if (!verifyStep.ok) {
      return { ok: false, step: 'verify', error: verifyStep.error, summary };
    }

    return { ok: true, reason: verifyStep.result.reason, summary };
  }

  async function attemptSidebarPath() {
    if (!convoId) {
      return { ok: false, failure: failure('findKebab', { code: 'convo_id_missing', message: 'Conversation ID missing for sidebar lookup' }) };
    }

    const ensureSidebar = await timedStep('ensureSidebar', 'sidebar', () => selectors.ensureSidebarVisible({ timeoutMs: stepTimeout }));
    if (!ensureSidebar.ok) {
      return { ok: false, failure: failure('findKebab', ensureSidebar.error) };
    }

    const sidebarAttempt = await timedStep('findKebab', 'sidebar', () => selectors.findSidebarSelectedItemByConvoId(convoId, { timeoutMs: stepTimeout }));
    if (!sidebarAttempt.ok) {
      return { ok: false, failure: failure('findKebab', sidebarAttempt.error) };
    }

    const kebabResult = sidebarAttempt.result;
    const kebab = kebabResult?.element;
    if (!(kebab instanceof HTMLElement)) {
      return { ok: false, failure: failure('findKebab', { code: 'kebab_missing', message: 'Conversation kebab missing' }) };
    }

    await selectors.reveal(kebab);
    log('log', 'step=reveal path=sidebar target=kebab', kebabResult.evidence);
    maybeClick(kebab, kebabResult.evidence);
    await selectors.sleep(150);

    const menuResult = await timedStep('findMenu', 'sidebar', () => selectors.findDeleteInOpenMenu(profile, { timeoutMs: stepTimeout }));
    if (!menuResult.ok) {
      return { ok: false, failure: failure('findMenu', menuResult.error) };
    }

    const deleteButton = menuResult.result?.element;
    if (!(deleteButton instanceof HTMLElement)) {
      return { ok: false, failure: failure('findMenu', { code: 'delete_missing', message: 'Delete menu item missing' }) };
    }

    await selectors.reveal(deleteButton);
    log('log', 'step=reveal path=sidebar target=delete', menuResult.result.evidence);
    maybeClick(deleteButton, menuResult.result.evidence);
    await selectors.sleep(150);

    const confirmResult = await timedStep('findConfirm', 'sidebar', () => selectors.findConfirmDelete(profile, { timeoutMs: stepTimeout }));
    if (!confirmResult.ok) {
      return { ok: false, failure: failure('findConfirm', confirmResult.error) };
    }

    const confirmButton = confirmResult.result?.element;
    if (!(confirmButton instanceof HTMLElement)) {
      return { ok: false, failure: failure('findConfirm', { code: 'confirm_missing', message: 'Confirm button missing' }) };
    }

    await selectors.reveal(confirmButton);
    log('log', 'step=reveal path=sidebar target=confirm', confirmResult.result.evidence);
    if (dryRun) {
      console.log(`${prefix} DRY RUN would click:`, confirmResult.result.evidence);
      dismissDialog(confirmButton);
      return { ok: true, reason: 'dry_run' };
    }

    dispatchClick(confirmButton);

    const verifyStep = await timedStep('verify', 'sidebar', async () => {
      const outcome = await verifyDeletion({ selectors, convoId, url, timeout: stepTimeout, toastRegex });
      if (!outcome.ok) {
        throw { code: outcome.reason || 'verify_timeout', reason: outcome.reason || 'verify_timeout', timeoutMs: outcome.timeoutMs };
      }
      return outcome;
    });

    if (!verifyStep.ok) {
      return { ok: false, failure: failure('verify', verifyStep.error) };
    }

    return { ok: true, reason: verifyStep.result.reason };
  }
}

/** Slovensky: Overí, že konverzácia zmizla. */
async function verifyDeletion({ selectors, convoId, url, timeout, toastRegex }) {
  const timeoutMs = Math.max(2000, Number.isFinite(timeout) ? timeout : 5000);
  const deadline = Date.now() + timeoutMs;
  const targetPath = (() => {
    try {
      return new URL(url, location.origin).pathname;
    } catch (_error) {
      return null;
    }
  })();
  const convoRegex = convoId ? new RegExp(`/c/${convoId}(/|$)`) : null;

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  while (Date.now() <= deadline) {
    if (targetPath && location.pathname !== targetPath) {
      return { ok: true, reason: 'url_changed', evidence: { from: targetPath, to: location.pathname } };
    }
    if (convoRegex && !convoRegex.test(location.pathname)) {
      return { ok: true, reason: 'url_changed', evidence: { to: location.pathname } };
    }

    const headerVisible = selectors
      .queryAllDeep(document, 'main header[data-testid*="conversation" i]', 'main [data-testid*="conversation-header" i]')
      .some(isVisible);
    if (!headerVisible) {
      return { ok: true, reason: 'header_missing' };
    }

    const toast = selectors.byTextDeep(document.body, toastRegex || selectors.TOAST_REGEX);
    if (toast) {
      const host = toast.closest('[role="alert"],[role="status"],[data-testid*="toast" i]') || toast;
      return { ok: true, reason: 'toast', evidence: selectors.describeElement(host) };
    }

    await selectors.sleep(200);
  }

  return { ok: false, reason: 'verify_timeout', timeoutMs };
}

/** Slovensky: Krátko zavrie modálne okno pri dry-run režime. */
function dismissDialog(button) {
  const dialog = button?.closest('[role="dialog"],[role="alertdialog"]');
  if (!dialog) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return;
  }
  const closeButton = dialog.querySelector('button[aria-label*="close" i], button[aria-label*="cancel" i]');
  if (closeButton instanceof HTMLElement) {
    closeButton.click();
  } else {
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
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
