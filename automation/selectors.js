(() => {
  const POLL_STEP_MS = 150;
  const DEFAULT_TIMEOUTS = Object.freeze({
    appShell: 8000,
    conversation: 8000,
    finder: 6000
  });
  const WALK_STOP = Symbol('walk-stop');
  const TOAST_REGEX = /(deleted|removed|odstránen|odstranen|zmazan|zmazané)/i;
  const MENUITEM_PATTERNS = [
    /^(delete|delete chat|delete conversation|remove)$/i,
    /^(odstrániť|odstranit|zmazať|zmazat)$/i
  ];
  const MENUITEM_TESTID_REGEX = /(delete|remove)/i;
  const CONFIRM_PATTERNS = [
    /^(delete|confirm delete|yes, delete)$/i,
    /^(odstrániť|zmazať|áno, odstrániť|ano, odstranit)$/i
  ];
  const CONFIRM_TESTID_REGEX = /confirm/i;
  const CONVO_HEADER_SELECTORS = [
    'main [data-testid*="conversation" i] header',
    'main header[data-testid*="conversation" i]',
    'main [data-testid*="thread-header" i]',
    '[data-testid*="conversation"] header',
    '[data-testid*="thread"] header'
  ];
  const SIDEBAR_ROOT_SELECTORS = [
    'nav[aria-label*="conversations" i]',
    'nav [data-testid*="sidebar" i]',
    'aside nav',
    '[data-testid*="sidebar" i]'
  ];
  const KEBAB_FALLBACK_SELECTORS = [
    'button[aria-label*="conversation actions" i]',
    '[data-testid*="actions" i] button',
    'button[aria-label*="more" i]',
    'button[title*="more" i]',
    'button[aria-label*="options" i]',
    'button[title*="options" i]',
    'button[data-testid*="actions" i]',
    'button[data-testid*="menu" i]',
    '[role="button"][aria-label*="more" i]',
    '[role="button"][title*="more" i]'
  ];
  const SIDEBAR_ITEM_SELECTORS = [
    '[data-testid*="conversation-item" i][data-selected="true"], [data-testid*="conversation-item" i].bg-token-sidebar-surface-selected',
    'a[aria-current="page" i]',
    'li[aria-selected="true" i]',
    '[role="option"][aria-selected="true" i]'
  ];
  const TOGGLE_BUTTON_LABEL = /(sidebar|menu|toggle|panel)/i;

  function now() {
    return Date.now();
  }

  function sleep(ms) {
    const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
    return new Promise((resolve) => setTimeout(resolve, safe));
  }

  function withTimeout(promise, timeoutMs, code = 'timeout') {
    const limit = Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUTS.finder);
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject({ code, timeoutMs: limit });
        }, limit);
      })
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Depth-first walk that includes open shadow roots.
   * @param {Node|Document|ShadowRoot|null|undefined} root
   * @param {(node: Node) => (void|symbol)} predicate
   */
  function walk(root, predicate) {
    const start = normalizeRoot(root);
    if (!start || typeof predicate !== 'function') {
      return;
    }
    const visited = new Set();
    const stack = [start];
    while (stack.length) {
      const node = stack.pop();
      if (!node || visited.has(node)) {
        continue;
      }
      visited.add(node);
      const signal = predicate(node);
      if (signal === WALK_STOP) {
        return;
      }
      const children = collectChildren(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
    }
  }

  function collectChildren(node) {
    if (!node) {
      return [];
    }
    const output = [];
    if (node instanceof Element) {
      if (node.shadowRoot && node.shadowRoot.mode === 'open') {
        output.push(node.shadowRoot);
      }
    }
    if (node instanceof Element || node instanceof Document || node instanceof DocumentFragment || node instanceof ShadowRoot) {
      for (let index = 0; index < node.childNodes.length; index += 1) {
        output.push(node.childNodes[index]);
      }
    }
    return output;
  }

  function normalizeRoot(root) {
    if (!root) {
      return typeof document !== 'undefined' ? document : null;
    }
    if (root instanceof Document || root instanceof ShadowRoot || root instanceof DocumentFragment) {
      return root;
    }
    if (root instanceof Element) {
      return root;
    }
    return typeof document !== 'undefined' ? document : null;
  }

  function ensureArray(value) {
    if (Array.isArray(value)) {
      return value;
    }
    if (value === undefined || value === null) {
      return [];
    }
    return [value];
  }

  function queryAllDeep(rootOrSelector, ...selectorList) {
    const { root, selectors } = parseQueryArgs(rootOrSelector, selectorList);
    if (!root || !selectors.length) {
      return [];
    }
    const matches = new Set();
    walk(root, (node) => {
      if (!(node instanceof Element)) {
        return;
      }
      for (const selector of selectors) {
        try {
          if (node.matches(selector)) {
            matches.add(node);
            return;
          }
        } catch (_error) {}
      }
    });
    return Array.from(matches);
  }

  function parseQueryArgs(rootOrSelector, selectorList) {
    let root = null;
    const selectors = [];
    const maybeRoot = rootOrSelector;
    if (maybeRoot instanceof Element || maybeRoot instanceof Document || maybeRoot instanceof ShadowRoot) {
      root = maybeRoot;
      selectors.push(...flattenSelectors(selectorList));
    } else {
      root = normalizeRoot(null);
      selectors.push(...flattenSelectors([maybeRoot, ...selectorList]));
    }
    return { root, selectors };
  }

  function flattenSelectors(list) {
    const flat = [];
    for (const item of list.flat()) {
      if (!item) {
        continue;
      }
      if (Array.isArray(item)) {
        flat.push(...flattenSelectors(item));
      } else if (typeof item === 'string') {
        flat.push(item);
      }
    }
    return flat;
  }

  function closestDeep(start, predicate) {
    let current = start instanceof Element ? start : null;
    while (current) {
      if (predicate(current)) {
        return current;
      }
      current = parentThroughShadow(current);
    }
    return null;
  }

  function parentThroughShadow(node) {
    if (!(node instanceof Element)) {
      return null;
    }
    if (node.parentElement) {
      return node.parentElement;
    }
    const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    if (root instanceof ShadowRoot) {
      const host = root.host;
      return host instanceof Element ? host : null;
    }
    return null;
  }

  function ensureRegex(value) {
    if (value instanceof RegExp) {
      return value;
    }
    if (value === undefined || value === null) {
      return null;
    }
    return new RegExp(String(value), 'i');
  }

  function byTextDeep(rootOrRegex, regexMaybe) {
    const { root, regex } = parseTextArgs(rootOrRegex, regexMaybe);
    if (!regex) {
      return null;
    }
    let found = null;
    walk(root, (node) => {
      if (!(node instanceof Element)) {
        return;
      }
      if (!isVisible(node)) {
        return;
      }
      const text = visibleText(node);
      if (regex.test(text)) {
        found = node;
        return WALK_STOP;
      }
    });
    return found;
  }

  function roleQueryDeep(rootOrRole, roleMaybe, textRegexMaybe) {
    const { root, role, regex } = parseRoleArgs(rootOrRole, roleMaybe, textRegexMaybe);
    if (!role) {
      return [];
    }
    const matches = [];
    walk(root, (node) => {
      if (!(node instanceof Element)) {
        return;
      }
      const attrRole = (node.getAttribute('role') || '').toLowerCase();
      if (attrRole !== role) {
        return;
      }
      if (!isVisible(node)) {
        return;
      }
      if (!regex) {
        matches.push(node);
        return;
      }
      const name = accessibleName(node);
      if (regex.test(name) || regex.test(node.textContent || '')) {
        matches.push(node);
      }
    });
    return matches;
  }

  function parseTextArgs(rootOrRegex, regexMaybe) {
    if (rootOrRegex instanceof Element || rootOrRegex instanceof Document || rootOrRegex instanceof ShadowRoot) {
      return { root: rootOrRegex, regex: ensureRegex(regexMaybe) };
    }
    return { root: normalizeRoot(null), regex: ensureRegex(rootOrRegex) };
  }

  function parseRoleArgs(rootOrRole, roleMaybe, regexMaybe) {
    if (typeof rootOrRole === 'string') {
      return {
        root: normalizeRoot(null),
        role: rootOrRole.toLowerCase(),
        regex: ensureRegex(regexMaybe)
      };
    }
    const root = normalizeRoot(rootOrRole);
    const role = typeof roleMaybe === 'string' ? roleMaybe.toLowerCase() : '';
    return { root, role, regex: ensureRegex(regexMaybe) };
  }

  function visibleText(node) {
    if (!(node instanceof Element)) {
      return '';
    }
    const doc = node.ownerDocument || document;
    const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_REJECT;
        }
        return isVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let text = '';
    while (walker.nextNode()) {
      text += (walker.currentNode.textContent || '') + ' ';
    }
    return text.trim();
  }

  function accessibleName(node) {
    if (!(node instanceof Element)) {
      return '';
    }
    const aria = node.getAttribute('aria-label') || '';
    if (aria.trim()) {
      return aria.trim();
    }
    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/).filter(Boolean);
      const doc = node.ownerDocument || document;
      const labelText = ids
        .map((id) => doc.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      if (labelText) {
        return labelText;
      }
    }
    const title = node.getAttribute('title');
    if (title) {
      return title.trim();
    }
    return (node.textContent || '').trim();
  }

  function isVisible(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
    if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function waitForAppShell(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUTS.appShell;
    const deadline = now() + timeoutMs;
    const attempts = [];
    return (async () => {
      while (now() <= deadline) {
        const main = document.querySelector('main[role="main"], main');
        if (main) {
          return {
            ready: true,
            main,
            evidence: describeElement(main)
          };
        }
        const appRoot = document.querySelector('[data-testid*="app" i], [id*="__next" i], *[data-reactroot]');
        if (appRoot) {
          return {
            ready: true,
            main: appRoot,
            evidence: describeElement(appRoot)
          };
        }
        attempts.push('main/app-root-missing');
        await sleep(POLL_STEP_MS);
      }
      throw {
        code: 'waitForAppShell_timeout',
        message: 'App shell not ready',
        timeoutMs,
        attempted: Array.from(new Set(attempts))
      };
    })();
  }

  function waitForConversationView(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUTS.conversation;
    const deadline = now() + timeoutMs;
    const attempts = [];
    return (async () => {
      while (now() <= deadline) {
        const header = queryAllDeep(document, CONVO_HEADER_SELECTORS).find(isVisible);
        if (header) {
          return {
            ready: true,
            area: header,
            source: 'header',
            evidence: describeElement(header)
          };
        }
        const viewport = queryAllDeep(document, 'main [data-viewport*="conversation" i]').find(isVisible);
        if (viewport) {
          return {
            ready: true,
            area: viewport,
            source: 'viewport',
            evidence: describeElement(viewport)
          };
        }
        const thread = queryAllDeep(document, '[data-testid*="conversation-turn" i], [data-message-author-role]').find(isVisible);
        if (thread) {
          return {
            ready: true,
            area: thread,
            source: 'thread',
            evidence: describeElement(thread)
          };
        }
        attempts.push('conversation:header/thread/viewport');
        await sleep(POLL_STEP_MS);
      }
      return {
        ready: false,
        attempted: Array.from(new Set(attempts)),
        timeoutMs
      };
    })();
  }

  async function ensureSidebarVisible(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUTS.finder;
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
      const sidebar = locateSidebar();
      if (sidebar?.visible) {
        return sidebar;
      }
      const toggle = queryAllDeep(document, 'button', '[role="button"]').find((node) => {
        if (!(node instanceof Element)) {
          return false;
        }
        const label = accessibleName(node).toLowerCase();
        return TOGGLE_BUTTON_LABEL.test(label);
      });
      if (toggle instanceof Element) {
        await reveal(toggle);
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
        await sleep(180);
      } else {
        await sleep(POLL_STEP_MS);
      }
    }
    throw {
      code: 'ensureSidebarVisible_timeout',
      message: 'Sidebar toggle not found',
      timeoutMs,
      attempted: ['sidebar-visible', 'toggle-button']
    };
  }

  function locateSidebar() {
    const containers = queryAllDeep(document, SIDEBAR_ROOT_SELECTORS);
    for (const container of containers) {
      if (container instanceof Element && isVisible(container)) {
        return { root: container, visible: true, evidence: describeElement(container) };
      }
    }
    return null;
  }

  async function findSidebarSelectedItemByConvoId(convoId, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUTS.finder;
    const deadline = now() + timeoutMs;
    const attempted = [];
    const needle = `/c/${convoId}`;
    while (now() <= deadline) {
      const anchors = queryAllDeep(document, `a[href*="${needle}"]`);
      for (const anchor of anchors) {
        if (!(anchor instanceof Element)) {
          continue;
        }
        const container = closestDeep(anchor, (node) => {
          if (!(node instanceof Element)) {
            return false;
          }
          return node.matches('[role="option"], li, div');
        });
        if (!container || !(container instanceof Element)) {
          attempted.push('sidebar-container-missing');
          continue;
        }
        if (!isVisible(container)) {
          attempted.push('sidebar-container-hidden');
          continue;
        }
        const kebab = locateKebabInContainer(container, attempted, 'sidebar');
        if (kebab) {
          return {
            element: kebab,
            evidence: {
              item: describeElement(container),
              button: describeElement(kebab)
            }
          };
        }
        attempted.push('sidebar-kebab-missing');
      }
      await sleep(POLL_STEP_MS);
    }
    throw selectorError('findSidebarKebab', attempted, timeoutMs);
  }

  async function findHeaderKebab(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUTS.finder;
    const deadline = now() + timeoutMs;
    const attempted = [];
    while (now() <= deadline) {
      const header = queryAllDeep(document, CONVO_HEADER_SELECTORS).find(isVisible);
      if (header) {
        const kebab = locateKebabInContainer(header, attempted, 'header');
        if (kebab) {
          return {
            element: kebab,
            evidence: {
              header: describeElement(header),
              button: describeElement(kebab)
            }
          };
        }
        attempted.push('header-kebab-missing');
      } else {
        attempted.push('header-missing');
      }
      await sleep(POLL_STEP_MS);
    }
    throw selectorError('findHeaderKebab', attempted, timeoutMs);
  }

  function locateKebabInContainer(container, attempted, scopeLabel) {
    for (const selector of KEBAB_FALLBACK_SELECTORS) {
      const candidate = queryAllDeep(container, selector)[0];
      attempted.push(`${scopeLabel}:${selector}`);
      if (candidate && candidate instanceof Element && isActionable(candidate)) {
        return ensureInteractive(candidate);
      }
    }
    const fallback = queryAllDeep(container, 'button', '[role="button"]').find((node) => looksLikeKebab(node));
    attempted.push(`${scopeLabel}:svg-kebab`);
    if (fallback && fallback instanceof Element && isActionable(fallback)) {
      return ensureInteractive(fallback);
    }
    return null;
  }

  async function findDeleteMenuItem(options = {}) {
    return pollForMenuMatch({
      timeoutMs: options.timeoutMs,
      code: 'findDelete',
      search: () => {
        const menus = queryAllDeep(document, '[role="menu"], [data-testid*="menu" i]');
        const candidates = [];
        for (const menu of menus) {
          if (!(menu instanceof Element) || !isVisible(menu)) {
            continue;
          }
          const byRole = roleQueryDeep(menu, 'menuitem');
          candidates.push(...byRole.filter((node) => matchesPatterns(node, MENUITEM_PATTERNS)));
          const byTestId = Array.from(menu.querySelectorAll('[data-testid]')).filter((node) => {
            if (!(node instanceof Element)) {
              return false;
            }
            const value = node.getAttribute('data-testid') || '';
            return MENUITEM_TESTID_REGEX.test(value);
          });
          candidates.push(...byTestId);
        }
        if (!candidates.length) {
          const fallback = candidatesFromDocument(MENUITEM_PATTERNS);
          candidates.push(...fallback);
        }
        const first = candidates.find((node) => node instanceof Element && isVisible(node));
        if (first) {
          return {
            element: ensureInteractive(first),
            evidence: { button: describeElement(first) }
          };
        }
        return null;
      }
    });
  }

  async function findConfirmDeleteButton(options = {}) {
    return pollForMenuMatch({
      timeoutMs: options.timeoutMs,
      code: 'findConfirm',
      search: () => {
        const dialogs = queryAllDeep(document, '[role="dialog"], [role="alertdialog"]').filter(isVisible);
        const candidates = [];
        for (const dialog of dialogs) {
          const buttons = roleQueryDeep(dialog, 'button');
          candidates.push(...buttons.filter((node) => matchesPatterns(node, CONFIRM_PATTERNS)));
          const byTestId = Array.from(dialog.querySelectorAll('[data-testid]')).filter((node) => {
            if (!(node instanceof Element)) {
              return false;
            }
            return CONFIRM_TESTID_REGEX.test(node.getAttribute('data-testid') || '');
          });
          candidates.push(...byTestId);
        }
        if (!candidates.length) {
          candidates.push(...candidatesFromDocument(CONFIRM_PATTERNS));
        }
        const first = candidates.find((node) => node instanceof Element && isVisible(node));
        if (first) {
          return {
            element: ensureInteractive(first),
            evidence: { button: describeElement(first) }
          };
        }
        return null;
      }
    });
  }

  async function pollForMenuMatch({ timeoutMs, code, search }) {
    const limit = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : DEFAULT_TIMEOUTS.finder;
    const deadline = now() + limit;
    const attempted = [];
    while (now() <= deadline) {
      const match = search();
      if (match) {
        return match;
      }
      attempted.push(code);
      await sleep(POLL_STEP_MS);
    }
    throw selectorError(code, attempted, limit);
  }

  function matchesPatterns(node, patterns) {
    if (!(node instanceof Element)) {
      return false;
    }
    const values = [accessibleName(node), node.textContent || ''];
    return patterns.some((pattern) => ensureRegex(pattern).test(values.join(' ')));
  }

  function candidatesFromDocument(patterns) {
    const list = [];
    walk(document, (node) => {
      if (!(node instanceof Element)) {
        return;
      }
      if (!isVisible(node)) {
        return;
      }
      if (matchesPatterns(node, patterns)) {
        list.push(node);
      }
    });
    return list;
  }

  function ensureInteractive(node) {
    if (!(node instanceof Element)) {
      return null;
    }
    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
      return node;
    }
    const closest = node.closest('button, a, [role="button"], [role="menuitem"]');
    return closest instanceof Element ? closest : node;
  }

  function isActionable(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    if (!isVisible(node)) {
      return false;
    }
    if (node.hasAttribute('disabled')) {
      return false;
    }
    return true;
  }

  function looksLikeKebab(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    const el = ensureInteractive(node);
    if (!el) {
      return false;
    }
    const svg = el.querySelector('svg');
    if (!svg) {
      return false;
    }
    const circles = svg.querySelectorAll('circle');
    if (circles.length === 3) {
      return true;
    }
    const paths = svg.querySelectorAll('path');
    return paths.length > 0 && paths.length <= 3;
  }

  function selectorError(code, attempted, timeoutMs) {
    return {
      code,
      message: 'not_found',
      attempted: Array.from(new Set(ensureArray(attempted).map(String))),
      timeoutMs
    };
  }

  async function reveal(node) {
    if (!(node instanceof Element)) {
      return;
    }
    node.scrollIntoView({ block: 'center', inline: 'center' });
    node.dispatchEvent(new Event('mouseenter', { bubbles: true, composed: true }));
    node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
    if (typeof node.focus === 'function') {
      node.focus({ preventScroll: true });
    }
    await sleep(80);
  }

  function describeElement(node) {
    if (!(node instanceof Element)) {
      return null;
    }
    const tag = node.tagName.toLowerCase();
    const id = node.id ? `#${node.id}` : '';
    const className = node.className && typeof node.className === 'string'
      ? `.${node.className.trim().split(/\s+/).filter(Boolean).join('.')}`
      : '';
    const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
    const text = (node.textContent || '').trim().slice(0, 60);
    return { tag: `${tag}${id}${className}`, label, text };
  }

  const api = {
    sleep,
    now,
    withTimeout,
    walk,
    queryAllDeep,
    byTextDeep,
    roleQueryDeep,
    waitForAppShell,
    waitForConversationView,
    ensureSidebarVisible,
    findSidebarSelectedItemByConvoId,
    findHeaderKebab,
    findDeleteMenuItem,
    findConfirmDeleteButton,
    reveal,
    describeElement,
    TOAST_REGEX
  };

  if (typeof globalThis !== 'undefined') {
    const existing = globalThis.RiskySelectors || {};
    globalThis.RiskySelectors = { ...existing, ...api };
  }
})();
