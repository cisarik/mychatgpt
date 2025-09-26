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
    const stepTimeout = normalizeTimeout(settings.risky_step_timeout_ms);
    const maxRetries = normalizeRetries(settings.risky_max_retries);
    const profile = compileProfile(params.profile);

    const context = {
      convoId: params.convoId || null,
      url: params.url || window.location.href,
      dryRun
    };

    console.log(`${LOG_PREFIX} header delete start`, context);

    const runStep = async (name, executor, options = {}) => {
      const retryable = options.retryable !== false;
      const skip = Boolean(options.skip);
      const attempts = retryable ? maxRetries + 1 : 1;
      for (let index = 0; index < attempts; index += 1) {
        const attempt = index + 1;
        try {
          const result = await executor({ attempt, skip: skip && attempt === 1 });
          const evidence = result?.evidence || result?.meta;
          if (evidence !== undefined) {
            console.log(`${LOG_PREFIX} ${name}✓`, evidence);
          } else {
            console.log(`${LOG_PREFIX} ${name}✓`);
          }
          return result || {};
        } catch (error) {
          const meta = formatErrorMeta(error);
          if (attempt >= attempts) {
            meta.attempt = attempt;
            throw { ...error, step: name, meta };
          }
          console.warn(`${LOG_PREFIX} retry step=${name}`, { ...meta, attempt });
          await delay(120);
        }
      }
      throw { code: 'step_failed', reason: name };
    };

    const failure = (step, error) => {
      const meta = formatErrorMeta(error);
      const outcome = {
        ok: false,
        reason: meta.code || meta.reason || meta.message || 'automation_failed',
        step,
        details: meta
      };
      console.error(`${LOG_PREFIX} FAIL step=${step}`, outcome);
      return outcome;
    };

    try {
      if (typeof dismissOpenMenusAndDialogs === 'function') {
        await dismissOpenMenusAndDialogs();
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
      await delay(60);

      const header = await runStep('share', () => waitForHeaderToolbar({ timeoutMs: stepTimeout }), { retryable: true });
      const toolbarEl = header?.toolbarEl;
      const shareEl = header?.shareEl;
      if (!(toolbarEl instanceof Element) || !(shareEl instanceof Element)) {
        return failure('share', { code: 'header_missing', message: 'Conversation header missing' });
      }

      const kebab = await runStep(
        'kebab',
        () => findHeaderKebabNearShare(toolbarEl, shareEl, { timeoutMs: stepTimeout }),
        { retryable: true }
      );
      const kebabEl = kebab?.kebabEl || kebab?.element;
      if (!(kebabEl instanceof Element)) {
        return failure('kebab', { code: 'kebab_missing', message: 'Header kebab missing' });
      }

      const menu = await runStep(
        'menu',
        async ({ skip }) => {
          if (typeof dismissOpenMenusAndDialogs === 'function') {
            await dismissOpenMenusAndDialogs();
          }
          await ensureFocusHover(shareEl);
          await ensureFocusHover(kebabEl);
          if (skip) {
            console.log(`${LOG_PREFIX} menu dry-run`, kebab?.evidence || describeElement(kebabEl));
          } else {
            await clickHard(kebabEl);
            await delay(150);
          }
          try {
            const lookupTimeout = skip ? Math.min(400, stepTimeout) : stepTimeout;
            const found = await findDeleteInOpenMenu(profile, { timeoutMs: lookupTimeout });
            return found;
          } catch (error) {
            if (skip) {
              return { element: null, evidence: { skip: true, ...formatErrorMeta(error) } };
            }
            throw error;
          }
        },
        { retryable: true, skip: dryRun }
      );

      const deleteStep = await runStep(
        'delete',
        async ({ skip }) => {
          let target = menu?.element;
          let evidence = menu?.evidence;
          if (!target) {
            const refreshed = await findDeleteInOpenMenu(profile, { timeoutMs: stepTimeout });
            target = refreshed?.element;
            evidence = refreshed?.evidence;
          }
          if (!(target instanceof Element)) {
            throw { code: 'delete_missing', message: 'Delete menu item missing' };
          }
          if (skip) {
            return { element: target, evidence: { ...(evidence || describeElement(target)), skip: true } };
          }
          await ensureFocusHover(target);
          await clickHard(target);
          await delay(160);
          return { element: target, evidence: evidence || describeElement(target) };
        },
        { retryable: true, skip: dryRun }
      );

      const confirm = await runStep(
        'confirm',
        async ({ skip }) => {
          const match = await findConfirmDelete(profile, { timeoutMs: stepTimeout });
          const element = match?.element;
          if (!(element instanceof Element)) {
            throw { code: 'confirm_missing', message: 'Confirm button missing' };
          }
          if (skip) {
            return { element, evidence: { ...(match?.evidence || describeElement(element)), skip: true } };
          }
          await ensureFocusHover(element);
          await clickHard(element);
          await delay(160);
          return { element, evidence: match?.evidence || describeElement(element) };
        },
        { retryable: true, skip: dryRun }
      );

      if (dryRun) {
        const outcome = {
          ok: true,
          reason: 'dry_run',
          step: 'dry_run',
          evidence: {
            kebab: kebab?.evidence || describeElement(kebabEl),
            delete: deleteStep?.evidence,
            confirm: confirm?.evidence
          }
        };
        console.log(`${LOG_PREFIX} dry run complete`, outcome.evidence);
        return outcome;
      }

      const verify = await runStep(
        'verify',
        async () => {
          const outcome = await verifyDeletion({
            selectors: {
              delay,
              findShare,
              byTextDeep,
              describeElement,
              TOAST_REGEX
            },
            profile,
            convoId: params.convoId,
            timeoutMs: stepTimeout
          });
          if (!outcome.ok) {
            throw outcome;
          }
          return outcome;
        },
        { retryable: false }
      );

      const success = {
        ok: true,
        reason: verify.reason || 'deleted',
        step: 'verify',
        evidence: verify.evidence || null
      };
      console.log(`${LOG_PREFIX} success`, success);
      return success;
    } catch (error) {
      return failure(error?.step || 'automation', error);
    }
  }

  function verifyDeletion({ selectors, profile, convoId, timeoutMs }) {
    const limit = normalizeTimeout(timeoutMs || 8000);
    const deadline = Date.now() + limit;
    const toastRegex = profile?.toast_regex || selectors.TOAST_REGEX;
    const convoPattern = convoId ? new RegExp(`/c/${escapeRegex(convoId)}\\b`) : null;

    return (async () => {
      while (Date.now() <= deadline) {
        if (convoPattern && !convoPattern.test(window.location.pathname)) {
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
        await selectors.delay(160);
      }
      return {
        ok: false,
        reason: 'verify_timeout',
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

  function normalizeRetries(raw) {
    if (!Number.isFinite(raw)) {
      return 0;
    }
    return Math.max(0, Math.floor(raw));
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
