import {
  DeletionStrategyIds,
  DEFAULT_SETTINGS,
  getConvoUrl,
  getConversationIdFromUrl,
  normalizeChatUrl,
  normalizeSettings,
  now,
  randomJitter,
  sleep
} from '../utils.js';

const PREFIX = '[RiskyMode]';

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
        const canonical = normalizeChatUrl(rawUrl) || getConvoUrl(getConversationIdFromUrl(rawUrl));
        const convoId = getConversationIdFromUrl(canonical) || getConversationIdFromUrl(rawUrl) || '';
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
      const guardOk = await guardConversationReady(tab.id, settings.risky_step_timeout_ms);
      if (!guardOk) {
        lastError = {
          reason: 'conversation_not_ready',
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
        .then(() => selectors.waitForConversationView({ timeoutMs }))
        .then(() => ({ ok: true }))
        .catch((error) => {
          console.warn(`${prefix} Guard failed`, {
            message: error?.message || String(error),
            code: error?.code
          });
          return { ok: false, reason: error?.message || 'guard_failed', code: error?.code };
        });
    },
    args: [{ timeoutMs, prefix: PREFIX }]
  });
  return Boolean(response?.result?.ok);
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
  const start = Date.now();
  const pageLog = (message, meta = undefined) => {
    if (meta !== undefined) {
      console.log(`${prefix} ${message}`, meta);
    } else {
      console.log(`${prefix} ${message}`);
    }
  };
  const sleepFrame = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const selectors = globalThis.RiskySelectors;
  if (!selectors) {
    pageLog('Selectors unavailable');
    return { ok: false, reason: 'selectors_missing', step: 'init' };
  }
  const triggerClick = (node) => {
    if (node instanceof HTMLElement) {
      node.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
      );
    }
  };

  try {
    pageLog('Probe start', { attempt });
    pageLog(`Attempt ${attempt}: started`, { convoId, url });
    if (jitter > 0) {
      pageLog(`Applying jitter ${jitter}ms`);
      await sleepFrame(jitter);
    }
    if (!isLoggedIn()) {
      pageLog('Login guard failed');
      return { ok: false, reason: 'not_logged_in', step: 'guard-login' };
    }
    await dismissDraftBanner(pageLog);
    const kebab = await selectors.findKebabButton(document, {
      timeoutMs: settings.risky_step_timeout_ms
    });
    pageLog('FOUND kebab button', summarizeElement(kebab));
    if (settings.dry_run) {
      pageLog('DRY RUN: opening kebab menu for validation', summarizeElement(kebab));
    }
    triggerClick(kebab);
    await sleepFrame(120);

    const menuItem = await selectors.findDeleteMenuItem(document, {
      timeoutMs: settings.risky_step_timeout_ms
    });
    pageLog('FOUND delete menu item', summarizeElement(menuItem));
    if (settings.dry_run) {
      pageLog('DRY RUN: opening delete confirmation for validation', summarizeElement(menuItem));
      triggerClick(menuItem);
    } else {
      menuItem.click();
    }

    const confirmButton = await selectors.findConfirmDeleteButton(document, {
      timeoutMs: settings.risky_step_timeout_ms
    });
    pageLog('FOUND confirm button', summarizeElement(confirmButton));

    if (settings.dry_run) {
      pageLog('DRY RUN: would confirm deletion', summarizeElement(confirmButton));
      dismissDialog(confirmButton);
      return { ok: true, reason: 'dry_run', step: 'confirm' };
    }

    confirmButton.click();
    pageLog('Confirm click dispatched');

    const verified = await verifyDeletion({ selectors, convoId, url, timeout: settings.risky_step_timeout_ms, sleepFrame, pageLog });
    if (!verified) {
      return { ok: false, reason: 'verify_timeout', step: 'verify' };
    }
    pageLog(`Deletion verified in ${Date.now() - start}ms`);
    return { ok: true, reason: 'deleted', step: 'verify' };
  } catch (error) {
    const code = error?.code || 'error';
    const reason = typeof error?.reason === 'string' ? error.reason : code;
    pageLog('Automation error', {
      code,
      reason,
      message: error?.message || String(error),
      attempted: Array.isArray(error?.attempted) ? error.attempted : undefined
    });
    return {
      ok: false,
      reason,
      step: error?.step || code,
      details: error
    };
  }
}

/** Slovensky: Overí, že konverzácia zmizla. */
async function verifyDeletion({ selectors, convoId, url, timeout, sleepFrame, pageLog }) {
  const deadline = Date.now() + Math.max(2000, timeout || 5000);
  const targetPath = (() => {
    try {
      const parsed = new URL(url);
      return parsed.pathname;
    } catch (_error) {
      return `/c/${convoId}`;
    }
  })();
  while (Date.now() <= deadline) {
    if (location.pathname !== targetPath) {
      pageLog('URL changed, assuming success', { from: targetPath, to: location.pathname });
      return true;
    }
    const toast = selectors.byText(document.body, selectors.TOAST_REGEX || /(deleted|removed|odstránen|zmazan)/i);
    if (toast && toast.closest('[role="status"],[role="alert"]')) {
      pageLog('Toast detected', summarizeElement(toast));
      return true;
    }
    const header = document.querySelector('[data-testid="conversation-main"] header');
    if (!header) {
      pageLog('Conversation header missing, assuming removed');
      return true;
    }
    await sleepFrame(160);
  }
  return false;
}

/** Slovensky: Krátko zavrie modálne okno pri dry-run režime. */
function dismissDialog(button) {
  const dialog = button?.closest('[role="dialog"],[role="alertdialog"]');
  if (!dialog) {
    return;
  }
  const closeButton = dialog.querySelector('button[aria-label*="close" i], button[aria-label*="cancel" i]');
  if (closeButton) {
    closeButton.click();
    return;
  }
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

/** Slovensky: Pokus o zatvorenie baneru s draftom. */
async function dismissDraftBanner(pageLog) {
  const banner = document.querySelector('[data-testid*="draft"]');
  if (!banner) {
    return;
  }
  const close = banner.querySelector('button, [role="button"]');
  if (close) {
    pageLog('Closing draft banner', summarizeElement(close));
    close.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
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
