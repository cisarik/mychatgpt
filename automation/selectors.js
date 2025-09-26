const POLL_STEP_MS = 120;
const DEFAULT_TIMEOUT_MS = 5000;
const MENU_LABEL_REGEX = /(more|actions|options|menu)/i;
const DELETE_REGEX = /delete/i;
const CONFIRM_REGEX = /(delete|confirm delete)/i;

/**
 * Slovensky: Trpezlivo počká na splnenie podmienky.
 * @template T
 * @param {() => (T | false | null | undefined | Promise<T | false | null | undefined>)} predicate
 * @param {number} [timeoutMs]
 * @param {number} [stepMs]
 * @returns {Promise<T>}
 */
export async function waitFor(predicate, timeoutMs = DEFAULT_TIMEOUT_MS, stepMs = POLL_STEP_MS) {
  const deadline = Date.now() + Math.max(0, timeoutMs || 0);
  const interval = Math.max(16, stepMs || POLL_STEP_MS);
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
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error('waitFor_timeout');
}

/** Slovensky: Vyhľadá element s daným textom (case-insensitive). */
export function queryByText(root, regex) {
  if (!root || !regex) {
    return null;
  }
  const doc = root.ownerDocument || (root.nodeType === Node.DOCUMENT_NODE ? root : document);
  const matcher = regex instanceof RegExp ? regex : new RegExp(regex, 'i');
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
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

/**
 * Slovensky: Nájde kebab menu tlačidlo konverzácie.
 * @param {Document|Element} doc
 * @param {number} [timeoutMs]
 * @returns {Promise<HTMLElement>}
 */
export async function findKebabButton(doc, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const attempts = new Map();
  try {
    const result = await waitFor(() => locateKebab(doc, attempts), timeoutMs, POLL_STEP_MS);
    if (!result) {
      throw new Error('kebab_not_found');
    }
    return result;
  } catch (error) {
    throw buildSelectorError('kebab_not_found', attempts, error);
  }
}

/**
 * Slovensky: Nájde položku menu pre mazanie.
 * @param {Document|Element} doc
 * @param {number} [timeoutMs]
 * @returns {Promise<HTMLElement>}
 */
export async function findDeleteMenuItem(doc, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const attempts = new Map();
  try {
    const result = await waitFor(() => locateDelete(doc, attempts), timeoutMs, POLL_STEP_MS);
    if (!result) {
      throw new Error('delete_menu_not_found');
    }
    return result;
  } catch (error) {
    throw buildSelectorError('delete_menu_not_found', attempts, error);
  }
}

/**
 * Slovensky: Nájde potvrdzovacie tlačidlo v modale.
 * @param {Document|Element} doc
 * @param {number} [timeoutMs]
 * @returns {Promise<HTMLElement>}
 */
export async function findConfirmDeleteButton(doc, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const attempts = new Map();
  try {
    const result = await waitFor(() => locateConfirm(doc, attempts), timeoutMs, POLL_STEP_MS);
    if (!result) {
      throw new Error('confirm_delete_not_found');
    }
    return result;
  } catch (error) {
    throw buildSelectorError('confirm_delete_not_found', attempts, error);
  }
}

/** Slovensky: Skúsi nájsť tlačidlo kebabu podľa viacerých signálov. */
function locateKebab(root, attempts) {
  const scope = resolveScope(root);
  if (!scope) {
    return null;
  }
  const direct = scope.querySelector('button[aria-label*="conversation actions" i]');
  noteAttempt(attempts, 'aria_conversation_actions', direct);
  if (isVisibleButton(direct)) {
    return direct;
  }

  const roleButtons = scope.querySelectorAll('[role="button"],button');
  const labeled = Array.from(roleButtons).find((el) => matchesLabel(el, MENU_LABEL_REGEX));
  noteAttempt(attempts, 'role_button_label', labeled);
  if (isVisibleButton(labeled)) {
    return ensureInteractive(labeled);
  }

  const testId = scope.querySelector('[data-testid*="actions" i]');
  noteAttempt(attempts, 'data_testid_actions', testId);
  if (isVisibleButton(testId)) {
    return ensureInteractive(testId);
  }

  const svgCandidate = Array.from(scope.querySelectorAll('button, [role="button"]')).find((el) => looksLikeKebab(el));
  noteAttempt(attempts, 'svg_three_dots', svgCandidate);
  if (isVisibleButton(svgCandidate)) {
    return ensureInteractive(svgCandidate);
  }
  return null;
}

/** Slovensky: Skúsi nájsť položku Delete v menu. */
function locateDelete(root, attempts) {
  const scope = resolveScope(root);
  if (!scope) {
    return null;
  }
  const menuItems = scope.querySelectorAll('[role="menuitem"]');
  const byRole = Array.from(menuItems).find((el) => DELETE_REGEX.test((el.textContent || '').trim()));
  noteAttempt(attempts, 'role_menuitem_delete', byRole);
  if (isVisibleButton(byRole)) {
    return ensureInteractive(byRole);
  }

  const byTestId = scope.querySelector('[data-testid*="delete" i]');
  noteAttempt(attempts, 'data_testid_delete', byTestId);
  if (isVisibleButton(byTestId)) {
    return ensureInteractive(byTestId);
  }

  const exactDelete = queryByText(scope.body || scope, DELETE_REGEX);
  noteAttempt(attempts, 'text_delete', exactDelete);
  if (isVisibleButton(exactDelete)) {
    return ensureInteractive(exactDelete);
  }
  return null;
}

/** Slovensky: Skúsi nájsť tlačidlo potvrdenia Delete. */
function locateConfirm(root, attempts) {
  const scope = resolveScope(root);
  if (!scope) {
    return null;
  }
  const roleButtons = scope.querySelectorAll('[role="button"]');
  const candidate = Array.from(roleButtons).find((el) => CONFIRM_REGEX.test((el.textContent || '').trim()));
  noteAttempt(attempts, 'role_button_confirm', candidate);
  if (isVisibleButton(candidate)) {
    return ensureInteractive(candidate);
  }

  const byTestId = scope.querySelector('[data-testid*="confirm" i]');
  noteAttempt(attempts, 'data_testid_confirm', byTestId);
  if (isVisibleButton(byTestId)) {
    return ensureInteractive(byTestId);
  }

  const textual = queryByText(scope.body || scope, CONFIRM_REGEX);
  noteAttempt(attempts, 'text_confirm_delete', textual);
  if (isVisibleButton(textual)) {
    return ensureInteractive(textual);
  }
  return null;
}

/** Slovensky: Vyhodnotí pokusy na jednoduché pole. */
function buildSelectorError(code, attempts, error) {
  return {
    code,
    attempted: Array.from(attempts.entries()).map(([label, success]) => ({ label, success })),
    message: error?.message || 'timeout'
  };
}

/** Slovensky: Zaistí, že pokus bude zapamätaný. */
function noteAttempt(attempts, label, result) {
  if (!attempts.has(label)) {
    attempts.set(label, Boolean(result));
    return;
  }
  if (result) {
    attempts.set(label, true);
  }
}

/** Slovensky: Vyberie dokument alebo koreň pre selektory. */
function resolveScope(root) {
  if (!root) {
    return typeof document !== 'undefined' ? document : null;
  }
  if (typeof root.querySelector === 'function') {
    return /** @type {Document|Element} */ (root);
  }
  if (root.ownerDocument) {
    return root.ownerDocument;
  }
  return typeof document !== 'undefined' ? document : null;
}

/** Slovensky: Overí, či element vizuálne existuje. */
function isVisibleButton(node) {
  const el = ensureInteractive(node);
  if (!el) {
    return false;
  }
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  if (!rect) {
    return true;
  }
  const visible = rect.width > 0 && rect.height > 0;
  return visible && !el.hasAttribute('disabled') && window.getComputedStyle(el).visibility !== 'hidden';
}

/** Slovensky: Vráti rodičovský interaktívny element. */
function ensureInteractive(node) {
  if (!node) {
    return null;
  }
  if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
    return node;
  }
  if (node instanceof HTMLElement) {
    const interactive = node.closest('button, a, [role="button"], [role="menuitem"]');
    return /** @type {HTMLElement|null} */ (interactive || node);
  }
  return null;
}

/** Slovensky: Posúdi, či element vyzerá ako tri bodky. */
function looksLikeKebab(node) {
  const el = ensureInteractive(node);
  if (!el) {
    return false;
  }
  const svg = el.querySelector('svg');
  if (!svg) {
    return false;
  }
  const width = parseFloat(svg.getAttribute('width') || '');
  const height = parseFloat(svg.getAttribute('height') || '');
  const box = svg.getAttribute('viewBox');
  const [boxW, boxH] = (box || '').split(/\s+/).slice(-2).map((part) => parseFloat(part));
  const w = !Number.isNaN(width) ? width : boxW;
  const h = !Number.isNaN(height) ? height : boxH;
  if (!Number.isFinite(w) || !Number.isFinite(h)) {
    return false;
  }
  if (Math.abs(w - h) > Math.max(1, w * 0.1)) {
    return false;
  }
  const circleCount = svg.querySelectorAll('circle').length;
  if (circleCount === 3) {
    return true;
  }
  const pathCount = svg.querySelectorAll('path').length;
  return pathCount > 0 && pathCount <= 3;
}

/** Slovensky: Skontroluje textové popisky elementu. */
function matchesLabel(node, regex) {
  const el = ensureInteractive(node);
  if (!el) {
    return false;
  }
  const aria = el.getAttribute('aria-label') || '';
  const title = el.getAttribute('title') || '';
  const text = (el.textContent || '').trim();
  return regex.test(aria) || regex.test(title) || regex.test(text);
}
