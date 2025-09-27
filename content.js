/* Slovensky komentar: Zamedzi duplicitnemu logu pri reinjekcii. */
const csGlobal = typeof window !== 'undefined' ? window : self;
if (!csGlobal.__mychatgptContentLogged) {
  console.info('[MyChatGPT] content.js loaded');
  csGlobal.__mychatgptContentLogged = true;
}

/* Slovensky komentar: Sleduje udalosti na jemne potvrdenie aktivity skriptu. */
const announcementState = { pageShow: false, visibility: false };

window.addEventListener('pageshow', () => {
  if (announcementState.pageShow) {
    return;
  }
  announcementState.pageShow = true;
  console.info('[MyChatGPT] content.js active (pageshow)');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || announcementState.visibility) {
    return;
  }
  announcementState.visibility = true;
  console.info('[MyChatGPT] content.js active (visibilitychange)');
});

/* Slovensky komentar: Ziska ID konverzacie z URL, ak existuje. */
function extractConvoId(url) {
  if (!url) {
    return null;
  }
  const match = url.match(/\/c\/([0-9a-f-]+)/i);
  return match ? match[1] : null;
}

/* Slovensky komentar: Pokusi sa najst elementy sprav roznych typov pre heuristiku. */
function collectMessageElements() {
  const elementNodeType = typeof Node !== 'undefined' ? Node.ELEMENT_NODE : 1;
  const strategies = [
    () => Array.from(document.querySelectorAll('[data-testid="conversation-turn"]')),
    () => Array.from(document.querySelectorAll('[data-message-id]')),
    () => Array.from(document.querySelectorAll('[data-message-author-role]')),
    () => Array.from(document.querySelectorAll('main [role="listitem"]')),
    () => Array.from(document.querySelectorAll('main article'))
  ];
  for (const strategy of strategies) {
    const nodes = strategy().filter((node) => node && node.nodeType === elementNodeType);
    if (nodes.length) {
      return nodes;
    }
  }
  return [];
}

/* Slovensky komentar: Vypocita pocet sprav a pripadny rozpis autora. */
function computeMessageCounts(messageNodes) {
  if (!Array.isArray(messageNodes)) {
    return { total: null, user: null, assistant: null };
  }
  if (!messageNodes.length) {
    return { total: 0, user: null, assistant: null };
  }
  let userCount = 0;
  let assistantCount = 0;
  let hasAmbiguous = false;
  messageNodes.forEach((node) => {
    const datasetRole = node.dataset ? node.dataset.messageAuthorRole : undefined;
    const role = (node.getAttribute('data-message-author-role') || datasetRole || '')
      .toString()
      .toLowerCase();
    if (role === 'user') {
      userCount += 1;
      return;
    }
    if (role === 'assistant') {
      assistantCount += 1;
      return;
    }
    if (role === 'system' || role === 'tool') {
      return;
    }
    if (role) {
      hasAmbiguous = true;
      return;
    }
    const className = typeof node.className === 'string' ? node.className.toLowerCase() : '';
    if (className.includes('user')) {
      userCount += 1;
    } else if (className.includes('assistant')) {
      assistantCount += 1;
    } else if (className.includes('system') || className.includes('tool')) {
      return;
    } else {
      hasAmbiguous = true;
    }
  });

  return {
    total: messageNodes.length,
    user: hasAmbiguous ? null : userCount,
    assistant: hasAmbiguous ? null : assistantCount
  };
}

/* Slovensky komentar: Z dedikovaneho nodu urci rolu spravy. */
function detectMessageRole(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  const datasetRole = node.dataset ? node.dataset.messageAuthorRole : undefined;
  const explicitRole = (node.getAttribute && node.getAttribute('data-message-author-role')) || datasetRole || '';
  const directRole = explicitRole.toString().toLowerCase();
  if (directRole) {
    if (directRole === 'user' || directRole === 'assistant') {
      return directRole;
    }
    if (directRole === 'system' || directRole === 'tool') {
      return null;
    }
  }
  const className = typeof node.className === 'string' ? node.className.toLowerCase() : '';
  if (className.includes('user')) {
    return 'user';
  }
  if (className.includes('assistant')) {
    return 'assistant';
  }
  return null;
}

/* Slovensky komentar: Vyhlada posledny uzol pre zadanu rolu. */
function findLatestNodeByRole(role) {
  if (!role) {
    return null;
  }
  const selectors = [
    `[data-message-author-role="${role}"]`,
    `[data-author-role="${role}"]`,
    `[data-role="${role}"]`
  ];
  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector)).filter((node) => node && node.nodeType === 1);
    if (nodes.length) {
      return nodes[nodes.length - 1];
    }
  }
  const collected = collectMessageElements();
  for (let index = collected.length - 1; index >= 0; index -= 1) {
    const node = collected[index];
    if (detectMessageRole(node) === role) {
      return node;
    }
  }
  return null;
}

/* Slovensky komentar: Pripravi textovu podobu spravy. */
function normalizeMessageText(node) {
  if (!node || typeof node.textContent !== 'string') {
    return '';
  }
  return node.textContent.trim();
}

/* Slovensky komentar: Vyberie HTML odpovede bez modifikacie. */
function pickAnswerHtml(node) {
  if (!node) {
    return '';
  }
  if (node.getAttribute && node.getAttribute('data-message-author-role') === 'assistant') {
    return typeof node.innerHTML === 'string' ? node.innerHTML : '';
  }
  const assistantChild = node.querySelector && node.querySelector('[data-message-author-role="assistant"]');
  if (assistantChild && typeof assistantChild.innerHTML === 'string') {
    return assistantChild.innerHTML;
  }
  return typeof node.innerHTML === 'string' ? node.innerHTML : '';
}

/* Slovensky komentar: Zlozi snapshot najnovsej otazky a odpovede. */
function captureLatestConversationPair() {
  const userNode = findLatestNodeByRole('user');
  const assistantNode = findLatestNodeByRole('assistant');
  const questionText = normalizeMessageText(userNode);
  const answerHtml = pickAnswerHtml(assistantNode);
  return {
    questionText,
    answerHTML: answerHtml,
    userNode,
    assistantNode
  };
}

/* Slovensky komentar: Bezpecne vrati pole kandidatov podla selektora (ignoruje syntakticke chyby). */
const safeQueryAll = typeof window !== 'undefined' && typeof window.safeQueryAll === 'function'
  ? window.safeQueryAll
  : function safeQueryAllLocal(selector) {
      if (typeof selector !== 'string' || !selector) {
        return [];
      }
      try {
        return Array.from(document.querySelectorAll(selector));
      } catch (_error) {
        return [];
      }
    };

/* Slovensky komentar: Normalizuje text elementu na porovnavanie. */
const normalizeNodeText = typeof window !== 'undefined' && typeof window.normalizeNodeText === 'function'
  ? window.normalizeNodeText
  : function normalizeNodeTextLocal(node) {
      if (!node) {
        return '';
      }
      const raw = typeof node.innerText === 'string' && node.innerText.trim()
        ? node.innerText
        : typeof node.textContent === 'string'
        ? node.textContent
        : '';
      return raw.trim().toLowerCase();
    };

/* Slovensky komentar: Poskytne spolocne cakanie pre interakcie. */
const waitHelper = typeof window !== 'undefined' && typeof window.wait === 'function'
  ? window.wait
  : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Slovensky komentar: Normalizuje text cez globalny helper. */
function readNormalized(node) {
  if (typeof window !== 'undefined' && typeof window.normText === 'function') {
    return window.normText(node);
  }
  return normalizeNodeText(node);
}

/* Slovensky komentar: Overi, ci je element interaktivny a nie je zakazany. */
function isNodeEnabled(node) {
  if (!node) {
    return false;
  }
  if (typeof node.disabled === 'boolean' && node.disabled) {
    return false;
  }
  const ariaDisabled = typeof node.getAttribute === 'function' ? node.getAttribute('aria-disabled') : null;
  if (ariaDisabled && ariaDisabled.toLowerCase() === 'true') {
    return false;
  }
  return true;
}

/* Slovensky komentar: Klikne na element po jeho ziskani s opakovanim. */
async function clickAndWait(sel, { textEquals = null, timeoutMs = 1500 } = {}) {
  const start = Date.now();
  const expectedText = typeof textEquals === 'string' ? textEquals.trim().toLowerCase() : null;
  const isElementNode = sel && typeof sel === 'object' && typeof sel.nodeType === 'number';
  const getter = typeof sel === 'function'
    ? sel
    : isElementNode
    ? () => sel
    : () => {
        const candidates = safeQueryAll(sel);
        if (!candidates.length) {
          return null;
        }
        if (expectedText) {
          const match = candidates.find((node) => readNormalized(node) === expectedText);
          if (match) {
            return match;
          }
          return null;
        }
        return candidates[0];
      };

  let element = null;
  while (Date.now() - start < timeoutMs) {
    element = getter();
    if (element) {
      break;
    }
    await waitHelper(70);
  }

  if (!element) {
    return { ok: false, element: null };
  }

  try {
    if (typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center' });
    }
  } catch (_scrollError) {
    // Slovensky komentar: Scroll zlyhanie ignorujeme.
  }

  try {
    element.click();
  } catch (clickError) {
    return { ok: false, element, error: clickError };
  }

  await waitHelper(120);
  return { ok: true, element };
}

/* Slovensky komentar: Najde tlacidlo pre kebab menu dostupne vo view. */
function findMoreActionsButton() {
  const selectors = [
    'button[aria-label="More actions"]',
    'button[aria-haspopup="menu"][aria-label*="More"]',
    'button[aria-label="Options"]',
    'button[aria-label="More"]'
  ];
  for (const selector of selectors) {
    const candidates = safeQueryAll(`${selector}:not([disabled])`).filter((node) => isNodeEnabled(node));
    if (candidates.length) {
      return candidates[0];
    }
  }
  return null;
}

/* Slovensky komentar: Najde polozku Delete v otvorenom menu. */
function findDeleteMenuItem() {
  const targetText = 'delete';
  const roleMatches = safeQueryAll('[role="menuitem"]');
  for (const node of roleMatches) {
    if (!isNodeEnabled(node)) {
      continue;
    }
    if (readNormalized(node) === targetText) {
      return node;
    }
  }

  const menuSelectors = ['[role="menu"]', '[data-popover-root]'];
  for (const selector of menuSelectors) {
    const scopes = safeQueryAll(selector);
    for (const scope of scopes) {
      const interactive = Array.from(scope.querySelectorAll('button, div, a'));
      for (const node of interactive) {
        if (!isNodeEnabled(node)) {
          continue;
        }
        const normalized = readNormalized(node);
        if (normalized === targetText || normalized.includes(targetText)) {
          return node;
        }
      }
    }
  }

  const fallback = safeQueryAll('button, div, a');
  for (const node of fallback) {
    if (!isNodeEnabled(node)) {
      continue;
    }
    const normalized = readNormalized(node);
    if (normalized === targetText || normalized.includes(targetText)) {
      return node;
    }
  }
  return null;
}

/* Slovensky komentar: Najde tlacidlo Delete v potvrzovacom dialogu. */
function findDeleteConfirmButton() {
  const dialogs = safeQueryAll('[role="dialog"], [role="alertdialog"]');
  for (const dialog of dialogs) {
    const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]'));
    for (const node of buttons) {
      if (!isNodeEnabled(node)) {
        continue;
      }
      if (readNormalized(node).includes('delete')) {
        return node;
      }
    }
  }

  const fallbackButtons = safeQueryAll('button, [role="button"]');
  for (const node of fallbackButtons) {
    if (!isNodeEnabled(node)) {
      continue;
    }
    if (readNormalized(node).includes('delete')) {
      return node;
    }
  }
  return null;
}

/* Slovensky komentar: Obsahovy skript reaguje na ping a metadata bez zmeny DOM. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return undefined;
  }

  if (message.type === 'ping') {
    const traceId = message.traceId;
    const payload = {
      ok: true,
      traceId,
      url: window.location.href,
      title: document.title,
      markers: {
        hasAppRoot: Boolean(document.querySelector('#__next')),
        hasComposer: Boolean(document.querySelector('textarea, [contenteditable]'))
      }
    };
    sendResponse(payload);
    return undefined;
  }

  if (message.type === 'debug_console_log') {
    console.info('[MyChatGPT] Test log (page)', message.payload || {});
    return undefined;
  }

  if (message.type === 'probe_metadata') {
    const traceId = message.traceId;
    try {
      const currentUrl = window.location.href;
      const messageNodes = collectMessageElements();
      const counts = computeMessageCounts(messageNodes);
      const hasAppRoot = Boolean(document.querySelector('#__next'));
      const hasComposer = Boolean(document.querySelector('textarea, [contenteditable]'));
      const guessChatView = messageNodes.length > 0;
      const payload = {
        ok: true,
        traceId,
        url: currentUrl,
        title: document.title ? document.title.trim() : '',
        convoId: extractConvoId(currentUrl),
        counts,
        markers: {
          hasAppRoot,
          hasComposer,
          guessChatView
        }
      };
      sendResponse(payload);
    } catch (error) {
      sendResponse({
        ok: false,
        traceId,
        url: window.location.href,
        title: document.title,
        convoId: null,
        counts: { total: null, user: null, assistant: null },
        markers: {
          hasAppRoot: Boolean(document.querySelector('#__next')),
          hasComposer: Boolean(document.querySelector('textarea, [contenteditable]')),
          guessChatView: false
        },
        error: error && error.message
      });
    }
    return undefined;
  }

  if (message.type === 'capture_preview') {
    const traceId = message.traceId;
    try {
      const snapshot = captureLatestConversationPair();
      const currentUrl = window.location.href;
      sendResponse({
        ok: true,
        traceId,
        url: currentUrl,
        title: document.title,
        convoId: extractConvoId(currentUrl),
        questionText: snapshot.questionText || null,
        answerHTML: snapshot.answerHTML || null
      });
    } catch (error) {
      sendResponse({
        ok: false,
        traceId,
        url: window.location.href,
        title: document.title,
        convoId: extractConvoId(window.location.href),
        error: error && error.message ? error.message : String(error)
      });
    }
    return undefined;
  }

  if (message.type === 'ui_delete_active') {
    (async () => {
      const steps = { menu: false, item: false, confirm: false };
      try {
        const menuButton = findMoreActionsButton();
        if (!menuButton) {
          sendResponse({ ok: false, reason: 'menu_not_found', steps, ts: Date.now() });
          return;
        }

        const menuClick = await clickAndWait(() => menuButton, { timeoutMs: 1000 });
        if (!menuClick.ok) {
          sendResponse({ ok: false, reason: 'ui_click_failed', steps, ts: Date.now() });
          return;
        }
        steps.menu = true;

        const itemResult = await clickAndWait(() => findDeleteMenuItem(), { timeoutMs: 2000 });
        if (!itemResult.ok) {
          const reason = itemResult.element ? 'ui_click_failed' : 'delete_item_not_found';
          sendResponse({ ok: false, reason, steps, ts: Date.now() });
          return;
        }
        steps.item = true;

        const confirmResult = await clickAndWait(() => findDeleteConfirmButton(), { timeoutMs: 2500 });
        if (!confirmResult.ok) {
          const reason = confirmResult.element ? 'ui_click_failed' : 'confirm_dialog_not_found';
          sendResponse({ ok: false, reason, steps, ts: Date.now() });
          return;
        }
        steps.confirm = true;

        sendResponse({ ok: true, reason: 'ui_delete_ok', steps, ts: Date.now() });
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
        sendResponse({ ok: false, reason: 'ui_click_failed', steps, error: messageText, ts: Date.now() });
      }
    })();
    return true;
  }

  return undefined;
});
