(() => {
  const POLL_STEP_MS = 150;
  const DEFAULT_TIMEOUTS = Object.freeze({
    appShell: 8000,
    conversation: 8000,
    finder: 6000
  });
  const WALK_STOP = Symbol('walk-stop');
  const TOAST_REGEX = /(deleted|removed|odstránen|odstranen|zmazan|zmazané)/i;
  const LOG_PREFIX = '[RiskyMode]';
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
  const HEADER_TOOLBAR_HINTS = [
    '[role="toolbar"]',
    '[data-testid*="header-actions" i]',
    '[data-testid*="toolbar" i]',
    '[class*="header-actions" i]'
  ];
  const SHARE_LABEL_REGEX = /share/i;
  const HEADER_ACTION_LABEL_REGEX = /(more|options|menu|actions)/i;

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

  async function waitForHeaderToolbar(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUTS.finder;
    await waitForAppShell({ timeoutMs });
    const deadline = now() + timeoutMs;
    const attempted = [];
    while (now() <= deadline) {
      const context = findShare();
      if (context) {
        return context;
      }
      attempted.push('share-missing');
      await sleep(POLL_STEP_MS);
    }
    throw selectorError('waitForHeaderToolbar', attempted, timeoutMs);
  }

  function findShare() {
    const headerAreas = queryAllDeep(document, CONVO_HEADER_SELECTORS);
    const headerSet = new Set(headerAreas.filter((node) => node instanceof Element));
    const rules = [
      () => roleQueryDeep(document, 'button', SHARE_LABEL_REGEX),
      () => queryAllDeep(document, '[aria-label*="share" i]'),
      () => queryAllDeep(document, '[data-testid*="share" i]')
    ];
    for (let index = 0; index < rules.length; index += 1) {
      const rawMatches = ensureArray(rules[index]()).filter((node) => node instanceof Element);
      if (!rawMatches.length) {
        continue;
      }
      const candidates = Array.from(new Set(rawMatches.map((node) => ensureInteractive(node)).filter(Boolean)));
      if (!candidates.length) {
        continue;
      }
      const prioritized = candidates.find((node) => isWithinHeader(node, headerSet)) || candidates[0];
      if (!prioritized) {
        continue;
      }
      const toolbarEl = deriveToolbarFromShare(prioritized, headerSet);
      if (!toolbarEl) {
        continue;
      }
      const shareEl = ensureInteractive(prioritized);
      const evidence = {
        toolbar: describeElement(toolbarEl),
        share: describeElement(shareEl)
      };
      console.log(`${LOG_PREFIX} share rule=${index + 1}`, evidence);
      return { toolbarEl, shareEl, evidence, ruleIndex: index + 1 };
    }
    return null;
  }

  async function findHeaderKebabNearShare(toolbarEl, shareEl, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUTS.finder;
    const shareButton = shareEl instanceof Element ? ensureInteractive(shareEl) : null;
    const rules = [
      {
        label: 'aria-haspopup',
        finder: () => pickToolbarCandidate(toolbarEl, shareButton, (node) => {
          const value = (node.getAttribute('aria-haspopup') || '').toLowerCase();
          return value === 'menu' || value === 'true';
        })
      },
      {
        label: 'label',
        finder: () => pickToolbarCandidate(toolbarEl, shareButton, (node) => HEADER_ACTION_LABEL_REGEX.test(accessibleName(node)))
      },
      {
        label: 'sibling',
        finder: () => {
          if (!shareButton) {
            return null;
          }
          const baseContainer = toolbarEl instanceof Element ? toolbarEl : shareButton.parentElement;
          if (!(baseContainer instanceof Element)) {
            return null;
          }
          const siblings = collectToolbarButtons(baseContainer, shareButton);
          const candidate = siblings.find((node) => looksLikeKebab(node) && isActionable(node));
          return candidate ? wrapMatch(candidate) : null;
        }
      },
      {
        label: 'svg',
        finder: () => pickToolbarCandidate(toolbarEl, shareButton, (node) => looksLikeKebab(node))
      }
    ];
    const match = await pollRules('kebab', rules, timeoutMs);
    return { kebabEl: match.element, evidence: match.evidence };
  }

  async function findDeleteInOpenMenu(profile, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUTS.finder;
    const deletePatterns = patternsFromProfile(profile || {}, 'delete_menu_items', MENUITEM_PATTERNS);
    const deleteTestIdRegex = profileRegex(profile || {}, 'delete_menu_testid_regex', MENUITEM_TESTID_REGEX);
    const rules = [
      {
        label: 'menuitem-text',
        finder: () => {
          const items = roleQueryDeep(document, 'menuitem');
          const matches = items.filter((node) => matchesPatterns(node, deletePatterns));
          return selectMenuCandidate(matches, { includeHidden: true });
        }
      },
      {
        label: 'data-testid',
        finder: () => {
          const matches = queryAllDeep(document, '[data-testid]').filter((node) => {
            if (!(node instanceof Element)) {
              return false;
            }
            const value = node.getAttribute('data-testid') || '';
            return deleteTestIdRegex.test(value);
          });
          return selectMenuCandidate(matches, { includeHidden: true });
        }
      },
      {
        label: 'aria-label',
        finder: () => {
          const matches = queryAllDeep(document, 'button[aria-label], [role="menuitem"][aria-label]');
          const filtered = matches.filter((node) => matchesPatterns(node, deletePatterns));
          return selectMenuCandidate(filtered, { includeHidden: true });
        }
      }
    ];
    const match = await pollRules('menu', rules, timeoutMs);
    return { element: match.element, evidence: match.evidence };
  }

  async function findConfirmDelete(profile, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUTS.finder;
    const confirmPatterns = patternsFromProfile(profile || {}, 'confirm_buttons', CONFIRM_PATTERNS);
    const confirmTestIdRegex = profileRegex(profile || {}, 'confirm_testid_regex', CONFIRM_TESTID_REGEX);
    const rules = [
      {
        label: 'dialog-button',
        finder: () => {
          const dialogs = queryAllDeep(document, '[role="dialog"], [role="alertdialog"]');
          const buttons = dialogs.flatMap((dialog) => roleQueryDeep(dialog, 'button'));
          const matches = buttons.filter((node) => matchesPatterns(node, confirmPatterns));
          return selectMenuCandidate(matches, { includeHidden: true });
        }
      },
      {
        label: 'data-testid',
        finder: () => {
          const matches = queryAllDeep(document, '[data-testid]').filter((node) => {
            if (!(node instanceof Element)) {
              return false;
            }
            const value = node.getAttribute('data-testid') || '';
            return confirmTestIdRegex.test(value);
          });
          return selectMenuCandidate(matches, { includeHidden: true });
        }
      },
      {
        label: 'aria-label',
        finder: () => {
          const matches = queryAllDeep(document, 'button[aria-label]');
          const filtered = matches.filter((node) => matchesPatterns(node, confirmPatterns));
          return selectMenuCandidate(filtered, { includeHidden: true });
        }
      }
    ];
    const match = await pollRules('confirm', rules, timeoutMs);
    return { element: match.element, evidence: match.evidence };
  }

  function pickToolbarCandidate(toolbarEl, shareButton, predicate) {
    if (!(toolbarEl instanceof Element)) {
      return null;
    }
    const buttons = queryAllDeep(toolbarEl, 'button', '[role="button"]');
    const seen = new Set();
    for (const button of buttons) {
      if (!(button instanceof Element)) {
        continue;
      }
      const interactive = ensureInteractive(button);
      if (!(interactive instanceof Element)) {
        continue;
      }
      if (seen.has(interactive)) {
        continue;
      }
      seen.add(interactive);
      if (shareButton && interactive.isSameNode(shareButton)) {
        continue;
      }
      if (typeof predicate === 'function' && !predicate(interactive)) {
        continue;
      }
      if (!isActionable(interactive)) {
        continue;
      }
      return wrapMatch(interactive);
    }
    return null;
  }

  function selectMenuCandidate(nodes, options = {}) {
    const includeHidden = options.includeHidden !== false;
    let hidden = null;
    for (const node of nodes) {
      if (!(node instanceof Element)) {
        continue;
      }
      const interactive = ensureInteractive(node);
      if (!(interactive instanceof Element)) {
        continue;
      }
      if (isActionable(interactive)) {
        return wrapMatch(interactive);
      }
      if (includeHidden && !hidden) {
        hidden = wrapMatch(interactive, { hidden: true });
      }
    }
    return hidden;
  }

  function deriveToolbarFromShare(shareButton, headerSet = new Set()) {
    const interactive = ensureInteractive(shareButton);
    if (!(interactive instanceof Element)) {
      return null;
    }
    let current = interactive;
    while (current instanceof Element) {
      if (matchesToolbarHint(current)) {
        return current;
      }
      current = parentThroughShadow(current);
    }
    current = interactive;
    while (current instanceof Element) {
      if (headerSet?.has(current)) {
        return current;
      }
      current = parentThroughShadow(current);
    }
    return interactive.parentElement instanceof Element ? interactive.parentElement : null;
  }

  function matchesToolbarHint(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    return HEADER_TOOLBAR_HINTS.some((selector) => matchesSelector(node, selector));
  }

  function matchesSelector(node, selector) {
    if (!(node instanceof Element) || typeof selector !== 'string') {
      return false;
    }
    try {
      return node.matches(selector);
    } catch (_error) {
      return false;
    }
  }

  function isWithinHeader(node, headerSet) {
    if (!(node instanceof Element) || !(headerSet instanceof Set)) {
      return false;
    }
    let current = node;
    while (current instanceof Element) {
      if (headerSet.has(current)) {
        return true;
      }
      current = parentThroughShadow(current);
    }
    return false;
  }

  function collectToolbarButtons(toolbarEl, exclude) {
    if (!(toolbarEl instanceof Element)) {
      return [];
    }
    const buttons = queryAllDeep(toolbarEl, 'button', '[role="button"]');
    const seen = new Set();
    return buttons.filter((node) => {
      if (!(node instanceof Element)) {
        return false;
      }
      const interactive = ensureInteractive(node);
      if (!(interactive instanceof Element)) {
        return false;
      }
      if (exclude && interactive.isSameNode(exclude)) {
        return false;
      }
      if (seen.has(interactive)) {
        return false;
      }
      seen.add(interactive);
      return true;
    });
  }

  async function pollRules(step, rules, timeoutMs) {
    const limit = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : DEFAULT_TIMEOUTS.finder;
    const deadline = now() + limit;
    const attempted = new Set();
    while (now() <= deadline) {
      for (let index = 0; index < rules.length; index += 1) {
        const rule = rules[index];
        attempted.add(rule.label);
        let result = null;
        try {
          result = rule.finder();
        } catch (_error) {
          result = null;
        }
        if (result && result.element instanceof Element) {
          const interactive = ensureInteractive(result.element);
          if (!(interactive instanceof Element)) {
            continue;
          }
          const evidence = {
            ...(result.evidence || {}),
            node: describeElement(interactive),
            rule: rule.label
          };
          console.log(`${LOG_PREFIX} ${step} rule=${index + 1}`, evidence);
          return { element: interactive, evidence };
        }
      }
      await sleep(POLL_STEP_MS);
    }
    const codeMap = { kebab: 'findHeaderKebab', menu: 'findDelete', confirm: 'findConfirmDelete' };
    throw {
      code: codeMap[step] || step,
      attempted: Array.from(attempted),
      timeoutMs: limit
    };
  }

  function patternsFromProfile(profile, key, defaults) {
    const raw = ensureArray(profile?.[key]).filter(Boolean);
    const source = raw.length ? raw : defaults;
    return source
      .map((pattern) => {
        if (pattern instanceof RegExp) {
          return pattern;
        }
        try {
          return new RegExp(String(pattern), 'i');
        } catch (_error) {
          return null;
        }
      })
      .filter((item) => item instanceof RegExp);
  }

  function profileRegex(profile, key, fallback) {
    const raw = profile?.[key];
    if (raw instanceof RegExp) {
      return raw;
    }
    if (typeof raw === 'string' && raw) {
      try {
        return new RegExp(raw, 'i');
      } catch (_error) {}
    }
    return fallback instanceof RegExp ? fallback : ensureRegex(fallback) || /.^/;
  }

  function wrapMatch(element, extra = {}) {
    if (!(element instanceof Element)) {
      return null;
    }
    const interactive = ensureInteractive(element);
    if (!(interactive instanceof Element)) {
      return null;
    }
    return { element: interactive, evidence: { ...extra } };
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
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const pointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    const pointerOptions = { bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse' };
    node.dispatchEvent(new pointerCtor('pointerover', pointerOptions));
    node.dispatchEvent(new pointerCtor('pointerenter', pointerOptions));
    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
    if (typeof node.focus === 'function') {
      try {
        node.focus({ preventScroll: true });
      } catch (_error) {}
    }
    await sleep(60);
  }

  async function clickHard(node) {
    if (!(node instanceof Element)) {
      return;
    }
    const pointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    const pointerOptions = { bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse' };
    const sequence = [
      { ctor: pointerCtor, type: 'pointerover', options: pointerOptions },
      { ctor: pointerCtor, type: 'pointerenter', options: pointerOptions },
      { ctor: pointerCtor, type: 'pointerdown', options: { ...pointerOptions, buttons: 1 } },
      { ctor: MouseEvent, type: 'mousedown', options: { bubbles: true, composed: true, button: 0 } },
      { ctor: pointerCtor, type: 'pointerup', options: { ...pointerOptions, buttons: 0 } },
      { ctor: MouseEvent, type: 'mouseup', options: { bubbles: true, composed: true, button: 0 } },
      { ctor: MouseEvent, type: 'click', options: { bubbles: true, composed: true, button: 0 } }
    ];
    for (const step of sequence) {
      const EventCtor = step.ctor || MouseEvent;
      const init = step.options || { bubbles: true, composed: true };
      const event = new EventCtor(step.type, { bubbles: true, cancelable: true, composed: true, ...init });
      node.dispatchEvent(event);
    }
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

  async function dismissOpenMenusAndDialogs() {
    const keyInit = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) {
      return;
    }
    for (let index = 0; index < 2; index += 1) {
      doc.dispatchEvent(new KeyboardEvent('keydown', keyInit));
      doc.dispatchEvent(new KeyboardEvent('keyup', keyInit));
      await sleep(90);
    }
  }

  async function ensureFocusHover(node) {
    if (!(node instanceof Element)) {
      return;
    }
    await reveal(node);
    if (typeof node.focus === 'function') {
      try {
        node.focus({ preventScroll: true });
      } catch (_error) {}
    }
    await sleep(60);
  }

  async function delay(ms) {
    await sleep(ms);
  }

  const api = {
    sleep,
    delay,
    now,
    withTimeout,
    walk,
    queryAllDeep,
    byTextDeep,
    roleQueryDeep,
    waitForAppShell,
    waitForConversationView,
    waitForHeaderToolbar,
    findShare,
    findHeaderKebabNearShare,
    findDeleteInOpenMenu,
    findConfirmDelete,
    dismissOpenMenusAndDialogs,
    ensureFocusHover,
    reveal,
    clickHard,
    describeElement,
    TOAST_REGEX
  };

  if (typeof window !== 'undefined') {
    window.__MYCHAT_SELECTORS__ = {
      ...(window.__MYCHAT_SELECTORS__ || {}),
      ...api
    };
    if (typeof globalThis !== 'undefined') {
      globalThis.RiskySelectors = window.__MYCHAT_SELECTORS__;
    }
  }
})();
