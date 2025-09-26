(function () {
  if (window.__MYCHAT_HEADER__) {
    return;
  }

  const DEFAULT_TIMEOUT = 10000;

  window.__MYCHAT_HEADER__ = {
    async probe({ settings } = {}) {
      const config = applySettings(settings);
      try {
        await waitForAppShell(config.timeout);
        await dismissOpen();
        const toolbar = await waitForHeaderToolbar(config.timeout);
        const share = await findShare(toolbar, config.timeout);
        const kebab = await findKebabNearShare(share, config.timeout);
        await ensureFocusHover(kebab);
        await clickHard(kebab);
        await delay(config.wait_after_open);
        const menu = await findDeleteGlobal();
        const confirm = await findConfirmGlobal();
        const menuMark = Boolean(menu) ? '\u2713' : '\u2717';
        const confirmMark = Boolean(confirm) ? '\u2713' : '\u2717';
        logRisky(`share\u2713 kebab\u2713 menu${menuMark} confirm${confirmMark}`);
        await dismissOpen();
        return {
          header: Boolean(toolbar),
          menu: Boolean(menu),
          confirm: Boolean(confirm)
        };
      } catch (error) {
        logRisky('probe_fail', error?.message || String(error));
        return { header: false, menu: false, confirm: false, error: error?.message || 'probe_failed' };
      }
    },
    async runDelete({ convoId, settings } = {}) {
      const config = applySettings(settings);
      const attempted = [];
      try {
        await waitForAppShell(config.timeout);
        await dismissOpen();
        const toolbar = await waitForHeaderToolbar(config.timeout);
        attempted.push('toolbar');
        const share = await findShare(toolbar, config.timeout);
        attempted.push('share');
        const kebab = await findKebabNearShare(share, config.timeout);
        attempted.push('kebab');
        await ensureFocusHover(kebab);
        await clickHard(kebab);
        attempted.push('openMenu');
        await delay(config.wait_after_open);
        const deleteButton = await waitFor(() => findDeleteGlobal(), config.timeout);
        if (!deleteButton) {
          throw stepError('findDelete', 'not_found');
        }
        attempted.push('delete');
        await ensureFocusHover(deleteButton);
        await clickHard(deleteButton);
        await delay(config.wait_after_click);
        const confirmButton = await waitFor(() => findConfirmGlobal(), config.timeout);
        if (!confirmButton) {
          throw stepError('findConfirm', 'not_found');
        }
        attempted.push('confirm');
        await ensureFocusHover(confirmButton);
        await clickHard(confirmButton);
        attempted.push('confirm_click');
        await delay(config.wait_after_click);
        const verified = await verifyDeletion(convoId, config.timeout);
        if (!verified) {
          throw stepError('verify', 'not_verified');
        }
        logRisky('share✓ kebab✓ menu✓ delete✓ confirm✓ verify✓');
        return { ok: true };
      } catch (error) {
        const code = error?.code || mapErrorToCode(error?.message);
        const reason = error?.message || 'delete_failed';
        logRisky(`FAIL code=${code} attempted=[${attempted.join('>')}]`);
        return {
          ok: false,
          code,
          reason,
          evidence: attempted
        };
      }
    }
  };

  async function waitForAppShell(timeout) {
    const root = await waitFor(() => document.querySelector('header') || document.querySelector('[data-testid="toolbar"]'), timeout);
    if (!root) {
      throw new Error('header_missing');
    }
    return root;
  }

  async function waitForHeaderToolbar(timeout) {
    const toolbar = await waitFor(() => document.querySelector('[data-testid="toolbar"]') || document.querySelector('header'), timeout);
    if (!toolbar) {
      throw new Error('toolbar_missing');
    }
    return toolbar;
  }

  async function findShare(toolbar, timeout) {
    const share = await waitFor(() => {
      const candidates = queryDeep(toolbar || document.body, (el) => matchShare(el));
      return candidates[0] || null;
    }, timeout);
    if (!share) {
      throw new Error('share_missing');
    }
    return share;
  }

  async function findKebabNearShare(share, timeout) {
    const kebab = await waitFor(() => {
      const scope = share.closest('header, [data-testid="toolbar"], nav') || share.parentElement || document.body;
      const local = queryDeep(scope, (el) => matchKebab(el));
      if (local.length) {
        return local[0];
      }
      const global = queryDeep(document.body, (el) => matchKebab(el));
      return global[0] || null;
    }, timeout);
    if (!kebab) {
      throw new Error('kebab_missing');
    }
    return kebab;
  }

  function findDeleteGlobal() {
    const matches = queryDeep(document.body, (el) => matchDelete(el)).filter((el) => isVisible(el));
    return matches[0] || null;
  }

  function findConfirmGlobal() {
    const matches = queryDeep(document.body, (el) => matchConfirm(el)).filter((el) => isVisible(el));
    if (!matches.length) {
      return null;
    }
    return pickTopMost(matches);
  }

  async function verifyDeletion(convoId, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const urlGone = !location.pathname.includes(`/c/${convoId}`);
      const toolbarGone = !document.querySelector('[data-testid="toolbar"]');
      const toast = queryDeep(document.body, (el) => /deleted|removed|odstránen|zmazan/i.test(textContent(el)));
      if (urlGone || toolbarGone || toast.length) {
        return true;
      }
      await delay(150);
    }
    return false;
  }

  function ensureFocusHover(element) {
    if (!element) {
      return;
    }
    element.focus?.({ preventScroll: true });
    element.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  }

  async function clickHard(element) {
    if (!element) {
      throw new Error('element_missing');
    }
    const eventOptions = { bubbles: true, cancelable: true, button: 0 };
    element.dispatchEvent(new MouseEvent('pointerdown', eventOptions));
    element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    element.dispatchEvent(new MouseEvent('click', eventOptions));
  }

  async function dismissOpen() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(50);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function applySettings(settings) {
    const timeout = Number(settings?.risky_step_timeout_ms) || DEFAULT_TIMEOUT;
    return {
      timeout,
      wait_after_open: Number(settings?.risky_wait_after_open_ms) || 260,
      wait_after_click: Number(settings?.risky_wait_after_click_ms) || 160
    };
  }

  async function waitFor(factory, timeout = DEFAULT_TIMEOUT) {
    const start = Date.now();
    let result = factory();
    while (!result) {
      if (Date.now() - start > timeout) {
        break;
      }
      await delay(100);
      result = factory();
    }
    return result || null;
  }

  function queryDeep(root, predicate) {
    const start = root instanceof Document ? root.documentElement : root;
    if (!start) {
      return [];
    }
    const results = [];
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT, null, false);
    let current = walker.currentNode;
    while (current) {
      if (predicate(current)) {
        results.push(current);
      }
      if (current.shadowRoot) {
        results.push(...queryDeep(current.shadowRoot, predicate));
      }
      current = walker.nextNode();
    }
    return results;
  }

  function matchShare(element) {
    if (!isClickable(element)) {
      return false;
    }
    const label = labelText(element);
    return /share/i.test(label);
  }

  function matchKebab(element) {
    if (!isClickable(element)) {
      return false;
    }
    const label = labelText(element);
    if (/(more|menu|options|actions)/i.test(label)) {
      return true;
    }
    return hasDotsIcon(element);
  }

  function matchDelete(element) {
    if (!isClickable(element) || !isVisible(element)) {
      return false;
    }
    const label = labelText(element);
    return /(delete|remove|odstrán|zmaz|vymaž)/i.test(label) || element.dataset?.testid?.includes('delete');
  }

  function matchConfirm(element) {
    if (!isClickable(element) || !isVisible(element)) {
      return false;
    }
    const label = labelText(element);
    return /(confirm|delete|remove|yes|ok|áno|potvr)/i.test(label);
  }

  function labelText(element) {
    const aria = element.getAttribute('aria-label') || element.getAttribute('title') || '';
    const text = textContent(element);
    return `${aria} ${text}`.trim();
  }

  function textContent(element) {
    return element.textContent || '';
  }

  function isClickable(element) {
    if (!element || element.hasAttribute('disabled')) {
      return false;
    }
    const tag = element.tagName?.toLowerCase();
    if (tag === 'button' || element.getAttribute('role') === 'button') {
      return true;
    }
    return Boolean(element.onclick);
  }

  function hasDotsIcon(element) {
    const svgs = element.querySelectorAll('svg');
    for (const svg of svgs) {
      const circles = svg.querySelectorAll('circle');
      if (circles.length >= 3) {
        return true;
      }
      const paths = svg.querySelectorAll('path');
      if (paths.length && /\.\.\./.test(paths[0].getAttribute('d') || '')) {
        return true;
      }
    }
    return false;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function pickTopMost(elements) {
    let winner = elements[0];
    let winnerScore = scoreElement(winner);
    for (let i = 1; i < elements.length; i += 1) {
      const candidate = elements[i];
      const candidateScore = scoreElement(candidate);
      if (candidateScore > winnerScore) {
        winner = candidate;
        winnerScore = candidateScore;
      } else if (candidateScore === winnerScore) {
        const pos = winner.compareDocumentPosition(candidate);
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
          winner = candidate;
          winnerScore = candidateScore;
        }
      }
    }
    return winner;
  }

  function scoreElement(element) {
    const root = findDialogRoot(element) || element;
    const style = window.getComputedStyle(root);
    const zIndex = Number.parseFloat(style.zIndex);
    const safeZ = Number.isFinite(zIndex) ? zIndex : 0;
    return safeZ * 10000 + (element.dataset?.testid ? 1 : 0);
  }

  function findDialogRoot(element) {
    return element.closest('dialog,[role="dialog"],[aria-modal="true"],[data-state="open"]');
  }

  function stepError(code, reason) {
    const error = new Error(reason || code);
    error.code = code;
    return error;
  }

  function mapErrorToCode(message) {
    switch (message) {
      case 'header_missing':
      case 'toolbar_missing':
      case 'share_missing':
      case 'kebab_missing':
      case 'kebab_fail':
        return 'findKebab';
      case 'delete_missing':
        return 'findDelete';
      case 'confirm_missing':
      case 'not_found':
        return 'findConfirm';
      case 'verify_failed':
      case 'not_verified':
        return 'verify';
      case 'element_missing':
      default:
        return 'openMenu';
    }
  }

  function logRisky(...args) {
    console.log('[RiskyMode][tab]', ...args);
  }
})();
