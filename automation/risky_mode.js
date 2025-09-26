(() => {
  const LOG_PREFIX = '[RiskyMode][tab]';

  const PROFILE_SK = {
    delete_menu_items: [/^(odstrániť|odstranit)$/i, /^(zmazať|zmazat)$/i],
    confirm_buttons: [/^(odstrániť|odstranit)$/i, /^(zmazať|zmazat)$/i, /^(áno, odstrániť|ano, odstranit)$/i],
    toast_texts: [/odstránen/i, /odstranen/i, /zmazan/i]
  };

  const PROFILE_EN = {
    delete_menu_items: [/^(delete|delete chat|delete conversation)$/i, /^remove$/i],
    confirm_buttons: [/^(delete|delete conversation)$/i, /^yes, delete$/i],
    toast_texts: [/deleted/i, /removed/i]
  };

  async function runHeaderDelete(params = {}) {
    const selectors = window.__MYCHAT_SELECTORS__;
    if (!selectors) {
      throw new Error('selectors missing');
    }

    const {
      waitForAppShell,
      waitForHeaderToolbar,
      findHeaderKebabNearShare,
      findDeleteInOpenMenu,
      findConfirmDelete,
      dismissOpenMenusAndDialogs,
      ensureFocusHover,
      clickHard,
      delay,
      describeElement,
      findShare,
      byTextDeep,
      TOAST_REGEX
    } = selectors;

    const settings = params.settings || {};
    const dryRun = Boolean(settings.dry_run);
    const timings = resolveTimings(settings);
    const stepTimeout = normalizeTimeout(settings.risky_step_timeout_ms);
    const profile = compileProfile(params.profile);

    const context = {
      convoId: params.convoId || null,
      url: params.url || window.location.href,
      dryRun
    };

    console.log(`${LOG_PREFIX} header delete start`, context);

    const selectorOptions = { settings };
    const logStep = (name, evidence) => {
      if (evidence !== undefined) {
        console.log(`${LOG_PREFIX} ${name}✓`, evidence);
      } else {
        console.log(`${LOG_PREFIX} ${name}✓`);
      }
    };

    const failure = (step, error) => {
      const meta = formatErrorMeta(error);
      const code = meta.code || meta.reason || 'automation_failed';
      console.error(`${LOG_PREFIX} FAIL code=${code} step=${step}`, meta);
      return {
        ok: false,
        reason: code,
        code,
        step,
        details: meta
      };
    };

    try {
      if (typeof dismissOpenMenusAndDialogs === 'function') {
        await dismissOpenMenusAndDialogs(selectorOptions);
      }
      await delay(80);

      if (!isLoggedIn()) {
        return failure('guard-login', { code: 'not_logged_in', message: 'User not logged in' });
      }

      await dismissDraftBanner((meta) => {
        if (meta) {
          console.log(`${LOG_PREFIX} dismiss draft`, meta);
        }
      }, delay);

      await waitForAppShell({ timeoutMs: stepTimeout });

      const header = await waitForHeaderToolbar({ timeoutMs: stepTimeout });
      const toolbarEl = header?.toolbarEl;
      const shareEl = header?.shareEl;
      if (!(toolbarEl instanceof Element) || !(shareEl instanceof Element)) {
        return failure('share', { code: 'header_missing', message: 'Conversation header missing' });
      }

      await ensureFocusHover(shareEl);
      logStep('share', header?.evidence || describeElement(shareEl));

      const kebabMatch = await findHeaderKebabNearShare(toolbarEl, shareEl, { timeoutMs: stepTimeout });
      const kebabEl = kebabMatch?.kebabEl || kebabMatch?.element;
      if (!(kebabEl instanceof Element)) {
        return failure('kebab', { code: 'kebab_missing', message: 'Header kebab missing' });
      }

      await ensureFocusHover(kebabEl);
      logStep('kebab', kebabMatch?.evidence || describeElement(kebabEl));

      if (dryRun) {
        console.log(`${LOG_PREFIX} DRY RUN would click kebab`, kebabMatch?.evidence || describeElement(kebabEl));
        logStep('menu', { skip: true });
        logStep('delete', { skip: true });
        logStep('confirm', { skip: true });
        logStep('verify', { skip: true });
        return {
          ok: true,
          reason: 'dry_run',
          step: 'dry_run',
          evidence: {
            kebab: kebabMatch?.evidence || describeElement(kebabEl)
          }
        };
      }

      let deleteMatch = null;
      let confirmMatch = null;
      let lastError = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await dismissOpenMenusAndDialogs(selectorOptions);
          await ensureFocusHover(kebabEl);
          await clickHard(kebabEl, selectorOptions);
          await delay(timings.waitAfterOpen);

          deleteMatch = await findDeleteInOpenMenu(profile, {
            timeoutMs: stepTimeout,
            settings,
            skipInitialWait: true
          });
          const deleteEl = deleteMatch?.element;
          if (!(deleteEl instanceof Element)) {
            throw { code: 'delete_missing', reason: 'delete_missing' };
          }
          logStep('menu', deleteMatch?.evidence || describeElement(deleteEl));

          await ensureFocusHover(deleteEl);
          await clickHard(deleteEl, selectorOptions);
          logStep('delete', deleteMatch?.evidence || describeElement(deleteEl));

          confirmMatch = await findConfirmDelete(profile, { timeoutMs: stepTimeout, settings });
          const confirmEl = confirmMatch?.element;
          if (!(confirmEl instanceof Element)) {
            throw { code: 'confirm_missing', reason: 'confirm_missing' };
          }
          await ensureFocusHover(confirmEl);
          await clickHard(confirmEl, selectorOptions);
          logStep('confirm', confirmMatch?.evidence || describeElement(confirmEl));
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= 1) {
            throw error;
          }
          console.warn(`${LOG_PREFIX} retry delete-flow`, formatErrorMeta(error));
        }
      }

      if (!(confirmMatch?.element instanceof Element)) {
        throw lastError || { code: 'confirm_missing', reason: 'confirm_missing' };
      }

      const verify = await verifyDeletion({
        selectors: { delay, findShare, byTextDeep, describeElement, TOAST_REGEX },
        profile,
        convoId: params.convoId,
        timeoutMs: stepTimeout
      });
      if (!verify.ok) {
        throw { ...verify, step: 'verify' };
      }
      logStep('verify', verify.evidence || { reason: verify.reason });

      const outcome = {
        ok: true,
        reason: verify.reason || 'deleted',
        step: 'verify',
        evidence: verify.evidence || null
      };
      console.log(`${LOG_PREFIX} success`, outcome);
      return outcome;
    } catch (error) {
      return failure(error?.step || error?.code || 'automation', error);
    }
  }

  function verifyDeletion({ selectors, profile, convoId, timeoutMs }) {
    const limit = normalizeTimeout(timeoutMs || 8000);
    const deadline = Date.now() + limit;
    const toastRegex = profile?.toast_regex || selectors.TOAST_REGEX;
    const convoPattern = convoId ? new RegExp(`/c/${escapeRegex(convoId)}\\b`) : null;

    return (async () => {
      while (Date.now() <= deadline) {
        if (convoPattern && !convoPattern.test(window.location.href)) {
          return { ok: true, reason: 'url_changed', evidence: { url: window.location.href } };
        }
        const header = typeof selectors.findShare === 'function' ? selectors.findShare() : null;
        if (!header || !(header.shareEl instanceof Element)) {
          return { ok: true, reason: 'header_missing' };
        }
        if (toastRegex && typeof selectors.byTextDeep === 'function') {
          const toast = selectors.byTextDeep(document.body, toastRegex);
          if (toast) {
            const host = toast.closest('[role="alert"],[role="status"],[data-testid*="toast" i]') || toast;
            return { ok: true, reason: 'toast', evidence: selectors.describeElement(host) };
          }
        }
        await selectors.delay(150);
      }
      return {
        ok: false,
        reason: 'verify_timeout',
        code: 'verify_timeout',
        timeoutMs: limit,
        evidence: { url: window.location.href }
      };
    })();
  }

  function formatErrorMeta(error) {
    if (!error) {
      return { code: 'error', message: 'unknown' };
    }
    if (error.meta && typeof error.meta === 'object') {
      return { ...error.meta };
    }
    const meta = {};
    if (error.code) {
      meta.code = error.code;
    }
    if (error.reason) {
      meta.reason = error.reason;
    }
    if (error.message) {
      meta.message = error.message;
    }
    if (Array.isArray(error.attempted) && error.attempted.length) {
      meta.attempted = error.attempted;
    }
    if (Number.isFinite(error.timeoutMs)) {
      meta.timeoutMs = error.timeoutMs;
    }
    if (error.details && typeof error.details === 'object') {
      meta.details = { ...error.details };
    }
    return meta;
  }

  function compileProfile(raw) {
    const fallback = detectUiProfile();
    const source = raw && typeof raw === 'object' ? raw : {};
    const deletePatterns = toRegExpList(source.delete_menu_items?.length ? source.delete_menu_items : fallback.delete_menu_items);
    const confirmPatterns = toRegExpList(source.confirm_buttons?.length ? source.confirm_buttons : fallback.confirm_buttons);
    const toastPatterns = toRegExpList(source.toast_texts?.length ? source.toast_texts : fallback.toast_texts);
    const toast_regex = toastPatterns.length
      ? new RegExp(toastPatterns.map((regex) => regex.source).join('|'), 'i')
      : null;
    return {
      delete_menu_items: deletePatterns,
      confirm_buttons: confirmPatterns,
      toast_regex
    };
  }

  function toRegExpList(value) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list
      .map((entry) => {
        if (entry instanceof RegExp) {
          return entry;
        }
        try {
          return new RegExp(String(entry), 'i');
        } catch (_error) {
          return null;
        }
      })
      .filter((entry) => entry instanceof RegExp);
  }

  function detectUiProfile() {
    const langs = [];
    if (Array.isArray(navigator?.languages)) {
      langs.push(...navigator.languages);
    }
    if (typeof navigator?.language === 'string') {
      langs.push(navigator.language);
    }
    if (typeof document?.documentElement?.lang === 'string') {
      langs.push(document.documentElement.lang);
    }
    const normalized = langs
      .map((code) => String(code || '').toLowerCase())
      .filter(Boolean);
    const isSk = normalized.some((code) => /^sk|^cs|^cz/.test(code));
    return isSk ? PROFILE_SK : PROFILE_EN;
  }

  function normalizeTimeout(raw) {
    if (!Number.isFinite(raw)) {
      return 8000;
    }
    return Math.max(500, raw);
  }

  function resolveTimings(settings) {
    return {
      waitAfterOpen: clampTimingSetting(settings?.risky_wait_after_open_ms, 80, 2000, 220),
      waitAfterClick: clampTimingSetting(settings?.risky_wait_after_click_ms, 60, 2000, 160)
    };
  }

  function clampTimingSetting(value, min, max, fallback) {
    if (Number.isFinite(value)) {
      const rounded = Math.round(value);
      if (rounded < min) {
        return min;
      }
      if (rounded > max) {
        return max;
      }
      return rounded;
    }
    return fallback;
  }

  function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function dismissDraftBanner(logger, delayFn) {
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
    if (typeof delayFn === 'function') {
      await delayFn(120);
    }
  }

  function summarizeElement(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }
    const tag = node.tagName.toLowerCase();
    const id = node.id ? `#${node.id}` : '';
    const classes = node.className ? `.${String(node.className).trim().split(/\s+/).join('.')}` : '';
    const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
    const text = (node.textContent || '').trim().slice(0, 48);
    return { tag: `${tag}${id}${classes}`, label, text };
  }

  function isLoggedIn() {
    const login = document.querySelector('a[href*="/login"], button[data-testid*="login" i]');
    const appShell = document.querySelector('#__next [data-testid="conversation-main"], main [data-testid="conversation-main"]');
    return !login && Boolean(appShell);
  }

  if (typeof window !== 'undefined') {
    window.__MYCHAT_RISKY__ = {
      ...(window.__MYCHAT_RISKY__ || {}),
      runHeaderDelete
    };
  }
})();
