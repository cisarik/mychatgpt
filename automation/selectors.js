(() => {
  const POLL_STEP_MS = 120;
  const DEFAULT_TIMEOUT_MS = 5000;
  const MENU_LABEL_REGEX = /(more|actions|options|menu)/i;
  const DELETE_TEXT_PATTERNS = [
    /^(delete|delete chat|delete conversation|remove)$/i,
    /^(odstrániť|odstranit|zmazať|zmazat)$/i
  ];
  const DELETE_TESTID_REGEX = /(delete|remove)/i;
  const CONFIRM_TEXT_PATTERNS = [
    /^(delete|confirm delete|yes, delete)$/i,
    /^(odstrániť|zmazať|áno, odstrániť|ano, odstranit)$/i
  ];
  const CONFIRM_TESTID_REGEX = /confirm/i;
  const TOAST_REGEX = /(deleted|removed|odstránen|zmazan)/i;

  /**
   * Slovensky: Trpezlivo čaká na splnenie podmienky.
   * @template T
   * @param {() => (T | false | null | undefined | Promise<T | false | null | undefined>)} predicate
   * @param {{timeoutMs?:number, stepMs?:number}=} options
   * @returns {Promise<T>}
   */
  async function waitFor(predicate, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const stepMs = Number.isFinite(options.stepMs) ? Math.max(16, options.stepMs) : POLL_STEP_MS;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() <= deadline) {
      try {
        const value = await predicate();
        if (value) {
          return value;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(stepMs);
    }
    if (lastError) {
      throw lastError;
    }
    throw new Error('waitFor_timeout');
  }

  /** Slovensky: Čaká krátku dobu. */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  /** Slovensky: Vráti Regex inštanciu. */
  function ensureRegex(value, flags = 'i') {
    if (value instanceof RegExp) {
      return value;
    }
    return new RegExp(String(value), flags);
  }

  /** Slovensky: Určí rozsah vyhľadávania. */
  function resolveScope(root) {
    if (!root) {
      return typeof document !== 'undefined' ? document : null;
    }
    if (root.nodeType === Node.DOCUMENT_NODE) {
      return /** @type {Document} */ (root);
    }
    if (root.ownerDocument) {
      return /** @type {Document} */ (root.ownerDocument);
    }
    if (typeof document !== 'undefined') {
      return document;
    }
    return null;
  }

  /** Slovensky: Vyhľadá element podľa textového regexu. */
  function byText(root, regex) {
    const scope = resolveScope(root) || root;
    if (!scope) {
      return null;
    }
    const matcher = ensureRegex(regex, regex instanceof RegExp ? undefined : 'i');
    const doc = scope.ownerDocument || (scope.nodeType === Node.DOCUMENT_NODE ? scope : document);
    const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!(node instanceof HTMLElement)) {
          return NodeFilter.FILTER_SKIP;
        }
        const text = (node.textContent || '').trim();
        if (!text) {
          return NodeFilter.FILTER_SKIP;
        }
        return matcher.test(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    return /** @type {HTMLElement|null} */ (walker.nextNode());
  }

  /** Slovensky: Nájde elementy podľa ARIA role a voliteľného textu. */
  function roleQuery(root, role, textRegex = null) {
    const scope = resolveScope(root) || root;
    if (!scope || !role) {
      return [];
    }
    const matcher = textRegex ? ensureRegex(textRegex) : null;
    return Array.from(scope.querySelectorAll(`[role="${role}"]`)).filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      if (!matcher) {
        return true;
      }
      return matchesAnyText(node, [matcher]);
    });
  }

  /** Slovensky: Čaká na nachystanie shellu aplikácie. */
  async function waitForAppShell(options = {}) {
    return waitFor(() => {
      const root = document.querySelector('[data-testid*="app" i], [id*="root" i], #__next');
      if (!root) {
        return false;
      }
      const main = root.querySelector('[role="main"], main[role="main"]') || document.querySelector('[role="main"]');
      if (!main) {
        return false;
      }
      return { root, main };
    }, options);
  }

  /** Slovensky: Čaká na zobrazenie vlákna konverzácie. */
  async function waitForConversationView(options = {}) {
    return waitFor(() => {
      const main = document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
      if (!main) {
        return false;
      }
      const headerCandidate = getConversationHeader(main);
      if (headerCandidate) {
        return { area: headerCandidate, source: 'header' };
      }
      const thread = main.querySelector('[data-testid="conversation-main"], [data-testid*="conversation-turn"], [data-message-author-role]');
      if (thread) {
        return { area: thread, source: 'thread' };
      }
      const sidebar = getSelectedSidebarItem(main.ownerDocument || document);
      if (sidebar) {
        return { area: sidebar, source: 'sidebar' };
      }
      return false;
    }, options);
  }

  /** Slovensky: Nájde kebab menu tlačidlo. */
  async function findKebabButton(root, options = {}) {
    const attempts = [];
    try {
      return await waitFor(() => locateKebab(root, attempts), options);
    } catch (error) {
      throw selectorError('findKebab', attempts, error);
    }
  }

  /** Slovensky: Nájde položku Delete v menu. */
  async function findDeleteMenuItem(root, options = {}) {
    const attempts = [];
    try {
      return await waitFor(() => locateDelete(root, attempts), options);
    } catch (error) {
      throw selectorError('findDelete', attempts, error);
    }
  }

  /** Slovensky: Nájde potvrdenie v modale. */
  async function findConfirmDeleteButton(root, options = {}) {
    const attempts = [];
    try {
      return await waitFor(() => locateConfirm(root, attempts), options);
    } catch (error) {
      throw selectorError('findConfirm', attempts, error);
    }
  }

  /** Slovensky: Pokus o lokalizáciu kebab tlačidla. */
  function locateKebab(root, attempts) {
    const doc = resolveScope(root);
    if (!doc) {
      return false;
    }
    const main = doc.querySelector('[role="main"]') || doc.querySelector('main') || doc.body || doc;
    const header = getConversationHeader(main);

    if (header) {
      const ariaButton = header.querySelector('button[aria-label*="conversation actions" i]');
      recordAttempt(attempts, 'header_aria_conversation_actions', ariaButton);
      if (isUsableButton(ariaButton)) {
        return ensureInteractive(ariaButton);
      }

      const byRole = roleQuery(header, 'button').find((node) => matchesLabel(node, MENU_LABEL_REGEX));
      recordAttempt(attempts, 'header_role_button_label', byRole);
      if (isUsableButton(byRole)) {
        return ensureInteractive(byRole);
      }

      const actionsTestId = header.querySelector('[data-testid*="actions" i] button, button[data-testid*="actions" i]');
      recordAttempt(attempts, 'header_data_testid_actions', actionsTestId);
      if (isUsableButton(actionsTestId)) {
        return ensureInteractive(actionsTestId);
      }

      const headerDots = Array.from(header.querySelectorAll('button, [role="button"]')).find((node) => looksLikeKebab(node));
      recordAttempt(attempts, 'header_svg_three_dots', headerDots);
      if (isUsableButton(headerDots)) {
        return ensureInteractive(headerDots);
      }
    } else {
      recordAttempt(attempts, 'conversation_header_missing', null);
    }

    const actionsFallback = main.querySelector('[data-testid*="actions" i] button, button[data-testid*="actions" i]');
    recordAttempt(attempts, 'main_data_testid_actions', actionsFallback);
    if (isUsableButton(actionsFallback)) {
      return ensureInteractive(actionsFallback);
    }

    const generalDots = Array.from(main.querySelectorAll('button, [role="button"]')).find((node) => looksLikeKebab(node));
    recordAttempt(attempts, 'main_svg_three_dots', generalDots);
    if (isUsableButton(generalDots)) {
      return ensureInteractive(generalDots);
    }

    const sidebarItem = getSelectedSidebarItem(doc);
    recordAttempt(attempts, 'sidebar_selected_item', sidebarItem);
    if (sidebarItem) {
      const ariaSidebar = sidebarItem.querySelector('button[aria-label*="more" i], button[aria-label*="actions" i], button[title*="more" i], button[title*="actions" i]');
      recordAttempt(attempts, 'sidebar_aria_actions', ariaSidebar);
      if (isUsableButton(ariaSidebar)) {
        return ensureInteractive(ariaSidebar);
      }

      const sidebarTestId = sidebarItem.querySelector('[data-testid*="conversation-item" i] button, button[data-testid*="conversation-item" i]');
      recordAttempt(attempts, 'sidebar_data_testid_item', sidebarTestId);
      if (isUsableButton(sidebarTestId)) {
        return ensureInteractive(sidebarTestId);
      }

      const sidebarDots = Array.from(sidebarItem.querySelectorAll('button, [role="button"]')).find((node) => looksLikeKebab(node));
      recordAttempt(attempts, 'sidebar_svg_three_dots', sidebarDots);
      if (isUsableButton(sidebarDots)) {
        return ensureInteractive(sidebarDots);
      }
    }

    return false;
  }

  /** Slovensky: Pokus o lokalizáciu delete položky. */
  function locateDelete(root, attempts) {
    const doc = resolveScope(root);
    if (!doc) {
      return false;
    }
    const searchRoots = getMenuSearchRoots(doc);

    for (const container of searchRoots) {
      const roleMatch = roleQuery(container, 'menuitem').find((node) => matchesAnyText(node, DELETE_TEXT_PATTERNS));
      recordAttempt(attempts, 'menu_role_menuitem_text', roleMatch);
      if (isUsableButton(roleMatch)) {
        return ensureInteractive(roleMatch);
      }

      const testIdMatch = queryByTestId(container, DELETE_TESTID_REGEX);
      recordAttempt(attempts, 'menu_data_testid_delete', testIdMatch);
      if (isUsableButton(testIdMatch)) {
        return ensureInteractive(testIdMatch);
      }
    }

    const textFallback = findByAnyText(doc, DELETE_TEXT_PATTERNS);
    recordAttempt(attempts, 'document_text_delete', textFallback);
    if (isUsableButton(textFallback)) {
      return ensureInteractive(textFallback);
    }

    return false;
  }

  /** Slovensky: Pokus o lokalizáciu confirm tlačidla. */
  function locateConfirm(root, attempts) {
    const doc = resolveScope(root);
    if (!doc) {
      return false;
    }
    const searchRoots = getDialogSearchRoots(doc);

    for (const container of searchRoots) {
      const roleButtons = roleQuery(container, 'button');
      const roleMatch = roleButtons.find((node) => matchesAnyText(node, CONFIRM_TEXT_PATTERNS));
      recordAttempt(attempts, 'dialog_role_button_text', roleMatch);
      if (isUsableButton(roleMatch)) {
        return ensureInteractive(roleMatch);
      }

      const testIdMatch = queryByTestId(container, CONFIRM_TESTID_REGEX);
      recordAttempt(attempts, 'dialog_data_testid_confirm', testIdMatch);
      if (isUsableButton(testIdMatch)) {
        return ensureInteractive(testIdMatch);
      }
    }

    const textFallback = findByAnyText(doc, CONFIRM_TEXT_PATTERNS);
    recordAttempt(attempts, 'document_text_confirm', textFallback);
    if (isUsableButton(textFallback)) {
      return ensureInteractive(textFallback);
    }

    return false;
  }

  /** Slovensky: Spustí jednorazovú sondu selektorov. */
  async function probeSelectorsOnce(options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const prefix = typeof options.prefix === 'string' ? options.prefix : '[RiskyMode]';
    const log = createLogger(prefix);
    const summary = { kebab: false, deleteMenu: false, confirm: false };

    try {
      await waitForAppShell({ timeoutMs });
      await waitForConversationView({ timeoutMs });
    } catch (error) {
      log('Probe guard failed', makeErrorMeta(error));
      return summary;
    }

    let kebab;
    try {
      kebab = await findKebabButton(document, { timeoutMs });
      summary.kebab = true;
      log('Probe FOUND kebab', describeElement(kebab));
    } catch (error) {
      log('Probe NOT FOUND kebab', makeErrorMeta(error));
      return summary;
    }

    safeClick(kebab);
    await delay(80);

    let deleteItem;
    try {
      deleteItem = await findDeleteMenuItem(document, { timeoutMs });
      summary.deleteMenu = true;
      log('Probe FOUND delete menu', describeElement(deleteItem));
    } catch (error) {
      log('Probe NOT FOUND delete menu', makeErrorMeta(error));
      closeMenus();
      return summary;
    }

    safeClick(deleteItem);
    await delay(120);

    try {
      const confirm = await findConfirmDeleteButton(document, { timeoutMs });
      summary.confirm = true;
      log('Probe FOUND confirm button', describeElement(confirm));
      dismissDialog(confirm);
    } catch (error) {
      log('Probe NOT FOUND confirm', makeErrorMeta(error));
      closeMenus();
    }

    return summary;
  }

  /** Slovensky: Popíše element pre log. */
  function describeElement(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }
    const tag = node.tagName.toLowerCase();
    const id = node.id ? `#${node.id}` : '';
    const classes = node.className ? `.${String(node.className).trim().split(/\s+/).join('.')}` : '';
    const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
    const text = (node.textContent || '').trim().slice(0, 60);
    return { tag: `${tag}${id}${classes}`, label, text };
  }

  /** Slovensky: Vráti aktívny logovací callback. */
  function createLogger(prefix) {
    return (message, meta) => {
      if (meta !== undefined) {
        console.log(`${prefix} ${message}`, meta);
      } else {
        console.log(`${prefix} ${message}`);
      }
    };
  }

  /** Slovensky: Formátuje chybu selektora. */
  function makeErrorMeta(error) {
    if (!error) {
      return { message: 'unknown_error' };
    }
    const meta = { message: error.message || error.code || String(error) };
    if (error.code) {
      meta.code = error.code;
    }
    if (Array.isArray(error.attempted)) {
      meta.attempted = error.attempted;
    }
    return meta;
  }

  /** Slovensky: Uzatvorí otvorené menu (Escape). */
  function closeMenus() {
    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
    menus.forEach((menu) => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
  }

  /** Slovensky: Zatvorí modal bez potvrdenia. */
  function dismissDialog(confirmButton) {
    const dialog = confirmButton?.closest('[role="dialog"],[role="alertdialog"]');
    if (!dialog) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    const cancel = dialog.querySelector('button[aria-label*="cancel" i], button.secondary, button[data-testid*="cancel" i]');
    if (cancel) {
      safeClick(cancel);
    } else {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  }

  /** Slovensky: Bezpečne klikne na element. */
  function safeClick(node) {
    const el = ensureInteractive(node);
    if (!el) {
      return;
    }
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  }

  /** Slovensky: Vybuduje chybu selektora. */
  function selectorError(code, attempts, error) {
    return {
      code,
      attempted: collapseAttempts(attempts),
      message: error?.message || error?.code || 'timeout'
    };
  }

  /** Slovensky: Zaznamená pokus. */
  function recordAttempt(attempts, label, node) {
    attempts.push({ label, success: Boolean(node) });
  }

  /** Slovensky: Zlúči pokusy. */
  function collapseAttempts(attempts) {
    const map = new Map();
    attempts.forEach((entry) => {
      if (!map.has(entry.label) || entry.success) {
        map.set(entry.label, { label: entry.label, success: Boolean(entry.success) });
      }
    });
    return Array.from(map.values());
  }

  /** Slovensky: Získa konverzačný header. */
  function getConversationHeader(main) {
    if (!main) {
      return null;
    }
    const selectors = [
      '[data-testid*="conversation"] header',
      '[data-testid*="thread"] header',
      'header[data-testid*="conversation" i]',
      '[data-testid*="view-header" i]',
      '[data-testid*="conversation-header" i]'
    ];
    for (const selector of selectors) {
      const candidate = main.querySelector(selector);
      if (candidate instanceof HTMLElement) {
        return candidate;
      }
    }
    return null;
  }

  /** Slovensky: Nájde vybranú položku v sidebare. */
  function getSelectedSidebarItem(doc) {
    if (!doc) {
      return null;
    }
    const selectors = [
      '[aria-selected="true"][data-testid*="conversation" i]',
      '[data-testid*="conversation-item" i][data-selected="true"]',
      '[data-testid*="conversation-item" i].bg-token-sidebar-surface-selected',
      'nav [aria-selected="true"][role="option"], nav [aria-current="true"]'
    ];
    for (const selector of selectors) {
      const candidate = doc.querySelector(selector);
      if (candidate instanceof HTMLElement) {
        return candidate;
      }
    }
    return null;
  }

  /** Slovensky: Získa viditeľné menu korene. */
  function getMenuSearchRoots(doc) {
    const menus = Array.from(doc.querySelectorAll('[role="menu"]')).filter((node) => node instanceof HTMLElement && isVisible(node));
    return menus.length ? menus : [doc.body || doc];
  }

  /** Slovensky: Získa viditeľné dialógové korene. */
  function getDialogSearchRoots(doc) {
    const dialogs = Array.from(doc.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter((node) => node instanceof HTMLElement && isVisible(node));
    return dialogs.length ? dialogs : [doc.body || doc];
  }

  /** Slovensky: Overí textové popisky. */
  function matchesLabel(node, regex) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const aria = node.getAttribute('aria-label') || '';
    const title = node.getAttribute('title') || '';
    const text = (node.textContent || '').trim();
    const matcher = ensureRegex(regex);
    return matcher.test(aria) || matcher.test(title) || matcher.test(text);
  }

  /** Slovensky: Overí viditeľnosť a dostupnosť. */
  function isUsableButton(node) {
    const el = ensureInteractive(node);
    if (!el) {
      return false;
    }
    return isVisible(el) && !el.hasAttribute('disabled');
  }

  /** Slovensky: Kontroluje viditeľnosť elementu. */
  function isVisible(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Slovensky: Zaistí interaktívny element. */
  function ensureInteractive(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }
    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
      return node;
    }
    const closest = node.closest('button, a, [role="button"], [role="menuitem"]');
    return closest instanceof HTMLElement ? closest : node;
  }

  /** Slovensky: Rozhodne či element vyzerá ako tri bodky. */
  function looksLikeKebab(node) {
    const el = ensureInteractive(node);
    if (!el) {
      return false;
    }
    const svg = el.querySelector('svg');
    if (!svg) {
      return false;
    }
    const circles = svg.querySelectorAll('circle').length;
    if (circles === 3) {
      return true;
    }
    const paths = svg.querySelectorAll('path').length;
    return paths > 0 && paths <= 3;
  }

  /** Slovensky: Zistí textové hodnoty pre regex. */
  function textCandidates(node) {
    if (!(node instanceof HTMLElement)) {
      return [];
    }
    const aria = node.getAttribute('aria-label') || '';
    const title = node.getAttribute('title') || '';
    const text = (node.textContent || '').trim();
    return [aria, title, text];
  }

  /** Slovensky: Otestuje viac regexov naraz. */
  function matchesAnyText(node, patterns) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const candidates = textCandidates(node);
    return patterns.some((pattern) => {
      const regex = ensureRegex(pattern);
      return candidates.some((value) => regex.test(value));
    });
  }

  /** Slovensky: Hľadá podľa data-testid. */
  function queryByTestId(root, regex) {
    const scope = root instanceof HTMLElement || root instanceof Document ? root : document;
    const matcher = ensureRegex(regex);
    return Array.from(scope.querySelectorAll('[data-testid]')).find((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const testId = node.getAttribute('data-testid') || '';
      return matcher.test(testId);
    }) || null;
  }

  /** Slovensky: Nájde prvý výskyt podľa textu. */
  function findByAnyText(root, patterns) {
    const scope = root instanceof HTMLElement || root instanceof Document ? root : document;
    for (const pattern of patterns) {
      const found = byText(scope, pattern);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const api = {
    waitFor,
    byText,
    roleQuery,
    waitForAppShell,
    waitForConversationView,
    findKebabButton,
    findDeleteMenuItem,
    findConfirmDeleteButton,
    probeSelectorsOnce,
    describeElement,
    TOAST_REGEX
  };

  if (typeof globalThis !== 'undefined') {
    const existing = globalThis.RiskySelectors || {};
    globalThis.RiskySelectors = { ...existing, ...api };
  }
})();
