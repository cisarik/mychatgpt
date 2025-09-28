/* Slovensky komentar: Zamedzi duplicitnemu logu pri reinjekcii. */
const csGlobal = typeof window !== 'undefined' ? window : self;
if (!csGlobal.__mychatgptContentLogged) {
  console.info('[MyChatGPT] content.js loaded');
  csGlobal.__mychatgptContentLogged = true;
}

let __VERBOSE = false;
(async () => {
  try {
    const { VERBOSE_CONSOLE } = await chrome.storage.local.get({ VERBOSE_CONSOLE: false });
    __VERBOSE = Boolean(VERBOSE_CONSOLE);
  } catch (_error) {
    // Slovensky komentar: Tiche zlyhanie zachova povodny stav.
  }
})();

if (chrome && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes || !changes.VERBOSE_CONSOLE) {
      return;
    }
    const nextValue = changes.VERBOSE_CONSOLE.newValue;
    __VERBOSE = Boolean(nextValue);
  });
}

function CDBG(...args) {
  if (__VERBOSE) {
    console.debug('[MyChatGPT][content][ui-delete]', ...args);
  }
}

function CINFO(...args) {
  if (__VERBOSE) {
    console.info('[MyChatGPT][content][ui-delete]', ...args);
  }
}

function CWARN(...args) {
  if (__VERBOSE) {
    console.warn('[MyChatGPT][content][ui-delete]', ...args);
  }
}

function CERR(...args) {
  console.error('[MyChatGPT][content][ui-delete]', ...args);
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

/* Slovensky komentar: Normalizuje nazvy konverzacie pre porovnavanie. */
function normalizeTitleValue(raw) {
  if (!raw) {
    return '';
  }
  let text = String(raw);
  text = text.replace(/[\u2026]/g, '');
  text = text.replace(/\s*-\s*ChatGPT\s*$/i, '');
  text = text.replace(/\s+/g, ' ');
  return text.trim().toLowerCase();
}

/* Slovensky komentar: Porovna dve normalizovane hodnoty tolerantne. */
function titlesMatchNormalized(candidate, target) {
  if (!candidate || !target) {
    return false;
  }
  if (candidate === target) {
    return true;
  }
  const minLen = 6;
  if (candidate.length >= minLen && target.includes(candidate)) {
    return true;
  }
  if (target.length >= minLen && candidate.includes(target)) {
    return true;
  }
  return false;
}

/* Slovensky komentar: Urci povod zhody titulku pre debug merania. */
function resolveMatchSource(candidateValue, normalizedTargets, targetMetaMap) {
  const normalizedCandidate = normalizeTitleValue(candidateValue);
  if (!normalizedCandidate) {
    return null;
  }
  const targets = Array.isArray(normalizedTargets) ? normalizedTargets : [];
  const meta = targetMetaMap instanceof Map ? targetMetaMap : null;
  for (const target of targets) {
    if (!target) {
      continue;
    }
    if (!titlesMatchNormalized(normalizedCandidate, target)) {
      continue;
    }
    const baseSource = meta && meta.has(target) ? meta.get(target) : 'title';
    if (normalizedCandidate === target) {
      return baseSource;
    }
    const prefixMatch = (normalizedCandidate.length >= 6 && target.includes(normalizedCandidate))
      || (target.length >= 6 && normalizedCandidate.includes(target));
    if (prefixMatch) {
      return 'prefix';
    }
    return baseSource;
  }
  return null;
}

/* Slovensky komentar: Ziska aktualny titulok konverzacie z dokumentu. */
function getDocumentConversationTitle() {
  const candidate = document.querySelector('[data-testid="conversation-title"], header h1, main h1');
  if (candidate && typeof candidate.textContent === 'string' && candidate.textContent.trim()) {
    return candidate.textContent.trim();
  }
  return typeof document.title === 'string' ? document.title : '';
}

/* Slovensky komentar: Zbiera interaktivne prvky so zoznamom konverzacii v sidebare. */
function collectSidebarCandidates() {
  const selectors = [
    'nav a[href*="/c/"]',
    'aside a[href*="/c/"]',
    '[data-testid*="conversation-list"] a[href*="/c/"]',
    'a[data-testid*="conversation-item"]',
    'button[data-testid*="conversation-item"]'
  ];
  const seen = new Set();
  const collected = [];
  selectors.forEach((selector) => {
    const matches = safeQueryAll(selector);
    matches.forEach((node) => {
      const interactive = node.closest('a[href], button, [role="button"]') || node;
      if (!interactive || seen.has(interactive)) {
        return;
      }
      seen.add(interactive);
      collected.push(interactive);
    });
  });
  return collected;
}

/* Slovensky komentar: Overi, ci je sidebar viditelny. */
function isSidebarVisible() {
  const candidates = collectSidebarCandidates();
  return candidates.some((node) => node && typeof node.offsetParent !== 'undefined' && node.offsetParent !== null);
}

/* Slovensky komentar: Najde tlacidlo na otvorenie sidebara. */
function findSidebarToggleButton() {
  const selectors = [
    'button[aria-label="Open sidebar"]',
    'button[aria-label="Show sidebar"]',
    'button[aria-label*="open sidebar" i]',
    'button[aria-label*="toggle sidebar" i]',
    'button[aria-label*="expand sidebar" i]'
  ];
  for (const selector of selectors) {
    const matches = safeQueryAll(selector).filter((node) => isNodeEnabled(node));
    if (matches.length) {
      return matches[0];
    }
  }
  return null;
}

/* Slovensky komentar: Zabezpeci, ze sidebar je otvoreny. */
async function ensureSidebarVisible() {
  if (isSidebarVisible()) {
    return { ok: true, reason: 'already_visible' };
  }
  const toggle = findSidebarToggleButton();
  if (!toggle) {
    return { ok: false, reason: 'sidebar_toggle_not_found' };
  }
  const toggleResult = await clickAndWait(() => toggle, { timeoutMs: 1500 });
  if (!toggleResult.ok) {
    return { ok: false, reason: 'sidebar_open_failed' };
  }
  const start = Date.now();
  while (Date.now() - start < 1600) {
    if (isSidebarVisible()) {
      return { ok: true, reason: 'opened' };
    }
    await waitHelper(80);
  }
  return { ok: false, reason: 'sidebar_not_visible' };
}

/* Slovensky komentar: Ziska textove tokeny pre kandidat konverzacie. */
function collectNodeTitleTokens(node) {
  if (!node) {
    return [];
  }
  const tokens = new Set();
  const addToken = (value) => {
    const normalized = normalizeTitleValue(value);
    if (normalized) {
      tokens.add(normalized);
    }
  };
  if (typeof node.textContent === 'string') {
    addToken(node.textContent);
  }
  if (typeof node.getAttribute === 'function') {
    const ariaLabel = node.getAttribute('aria-label');
    if (ariaLabel) {
      addToken(ariaLabel);
    }
    const titleAttr = node.getAttribute('title');
    if (titleAttr) {
      addToken(titleAttr);
    }
  }
  const descendants = node.querySelectorAll('[title], [aria-label]');
  descendants.forEach((desc) => {
    if (typeof desc.getAttribute === 'function') {
      const aria = desc.getAttribute('aria-label');
      if (aria) {
        addToken(aria);
      }
      const title = desc.getAttribute('title');
      if (title) {
        addToken(title);
      }
    }
    if (typeof desc.textContent === 'string') {
      addToken(desc.textContent);
    }
  });
  return Array.from(tokens);
}

/* Slovensky komentar: Najde polozku sidebara podla cielovych nazvov. */
function findConversationNodeByTitles(normalizedTargets, targetMetaMap) {
  if (!Array.isArray(normalizedTargets) || normalizedTargets.length === 0) {
    return { node: null, matchSource: null };
  }
  const nodes = collectSidebarCandidates();
  for (const node of nodes) {
    if (!isNodeEnabled(node)) {
      continue;
    }
    const tokens = collectNodeTitleTokens(node);
    for (const token of tokens) {
      const matchSource = resolveMatchSource(token, normalizedTargets, targetMetaMap);
      if (matchSource) {
        return { node, matchSource };
      }
    }
  }
  return { node: null, matchSource: null };
}

/* Slovensky komentar: Caka na zosuladenie titulku dokumentu s cielom. */
async function waitForDocumentTitleMatch(normalizedTargets, timeoutMs = 3600) {
  const safeTargets = Array.isArray(normalizedTargets) ? normalizedTargets : [];
  if (!safeTargets.length) {
    return false;
  }
  const deadline = Date.now() + Math.max(0, timeoutMs || 0);
  while (Date.now() < deadline) {
    const current = normalizeTitleValue(getDocumentConversationTitle());
    if (current && safeTargets.some((target) => titlesMatchNormalized(current, target))) {
      return true;
    }
    await waitHelper(110);
  }
  return false;
}

const DELETE_SELECTORS = [
  '[data-testid="delete-conversation"]',
  '[role="menuitem"][data-testid*="delete"]',
  '[role="menuitem"][aria-label*="Delete" i]',
  'button[aria-label*="Delete" i]',
  '[role="menuitem"]:has(svg[data-icon*="trash"])'
];

const DELETE_TEXT_TOKENS = ['delete', 'remove', 'vymazať', 'zmazať', 'odstrániť'];

const MORE_ACTIONS_BUTTON_SELECTORS = [
  'button[aria-label="More actions"]',
  'button[aria-haspopup="menu"][aria-label*="More"]',
  'button[aria-label="Options"]',
  'button[aria-label="More"]'
];

function collectMenuContainers(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return [];
  }
  const selectors = ['[role="menu"]', '[data-testid*="menu"]'];
  const seen = new Set();
  const containers = [];
  selectors.forEach((selector) => {
    let matches = [];
    try {
      matches = Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      matches = [];
    }
    matches.forEach((node) => {
      if (node && !seen.has(node)) {
        seen.add(node);
        containers.push(node);
      }
    });
  });
  return containers;
}

function collectMenuItems(root = document) {
  const containers = collectMenuContainers(root);
  const interactiveSelectors = [
    'button',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]'
  ];
  const seen = new Set();
  const items = [];
  const gatherFromScope = (scope) => {
    if (!scope || typeof scope.querySelectorAll !== 'function') {
      return;
    }
    interactiveSelectors.forEach((selector) => {
      let candidates = [];
      try {
        candidates = Array.from(scope.querySelectorAll(selector));
      } catch (_error) {
        candidates = [];
      }
      candidates.forEach((node) => {
        if (!node || seen.has(node) || !isNodeEnabled(node)) {
          return;
        }
        seen.add(node);
        items.push(node);
      });
    });
  };

  if (containers.length) {
    containers.forEach((container) => gatherFromScope(container));
  } else {
    gatherFromScope(root);
  }

  return items;
}

function countMenuItems(root = document) {
  return collectMenuItems(root).length;
}

function dumpMenuSnapshot(root = document) {
  const snapshot = [];
  const containers = collectMenuContainers(root);
  const scopes = containers.length ? containers : [root];
  scopes.forEach((scope, index) => {
    const items = collectMenuItems(scope);
    items.forEach((node) => {
      let rect = null;
      try {
        const bounds = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
        if (bounds) {
          rect = {
            x: Number(bounds.x) || 0,
            y: Number(bounds.y) || 0,
            w: Number(bounds.width) || 0,
            h: Number(bounds.height) || 0
          };
        }
      } catch (_error) {
        rect = null;
      }
      const ariaLabel = typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : null;
      const role = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null;
      const testid = typeof node.getAttribute === 'function' ? node.getAttribute('data-testid') : null;
      const classes = typeof node.className === 'string'
        ? node.className
        : typeof node.getAttribute === 'function'
        ? node.getAttribute('class')
        : '';
      snapshot.push({
        text: readNormalized(node),
        ariaLabel: ariaLabel || null,
        role: role || null,
        testid: testid || null,
        classes: classes || '',
        rect,
        containerIndex: index,
        containerRole: scope && typeof scope.getAttribute === 'function' ? scope.getAttribute('role') || null : null,
        containerTestid: scope && typeof scope.getAttribute === 'function' ? scope.getAttribute('data-testid') || null : null
      });
    });
  });
  return snapshot;
}

/* Slovensky komentar: Vrati popis prvkov v dialógu pre debugovanie. */
function dumpDialogSnapshot(dialog) {
  if (!dialog || typeof dialog.querySelectorAll !== 'function') {
    return [];
  }
  const nodes = Array.from(dialog.querySelectorAll('button, [role], [data-testid]'));
  const snapshot = [];
  nodes.forEach((node, index) => {
    if (!node) {
      return;
    }
    let rect = null;
    try {
      const box = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
      if (box) {
        rect = {
          x: Number(box.x) || 0,
          y: Number(box.y) || 0,
          w: Number(box.width) || 0,
          h: Number(box.height) || 0
        };
      }
    } catch (_error) {
      rect = null;
    }
    const role = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null;
    const testid = typeof node.getAttribute === 'function' ? node.getAttribute('data-testid') : null;
    const ariaLabel = typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : null;
    const classes = typeof node.className === 'string'
      ? node.className
      : typeof node.getAttribute === 'function'
      ? node.getAttribute('class')
      : '';
    snapshot.push({
      index,
      text: readNormalized(node),
      ariaLabel: ariaLabel || null,
      role: role || null,
      testid: testid || null,
      classes: classes || '',
      rect,
      visible: isNodeVisible(node)
    });
  });
  return snapshot;
}

/* Slovensky komentar: Zbiera kandidatske dialógy so sirokym pokrytím. */
function collectDialogs(root = document) {
  const selectors = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[data-state="open"]',
    '[data-headlessui-state]',
    '.ReactModalPortal .ReactModal__Content',
    '[data-radix-portal] [role="dialog"]',
    '.modal, .Modal, .chakra-modal__content',
    '[data-overlay-container] [role="dialog"]',
    '[data-testid*="confirm"]'
  ];
  const set = new Set();
  selectors.forEach((selector) => {
    let nodes = [];
    try {
      nodes = Array.from(root.querySelectorAll(selector));
    } catch (_error) {
      nodes = [];
    }
    nodes.forEach((node) => {
      if (node) {
        set.add(node);
      }
    });
  });
  return Array.from(set).filter((node) => isNodeVisible(node));
}

/* Slovensky komentar: Vrati najvrchnejsi dialóg podla z-index a poradia. */
function getTopMostDialog() {
  const dialogs = collectDialogs();
  if (!dialogs.length) {
    return null;
  }
  dialogs.sort((a, b) => {
    const zDiff = numericZIndex(b) - numericZIndex(a);
    if (zDiff !== 0) {
      return zDiff;
    }
    if (a === b) {
      return 0;
    }
    const position = a.compareDocumentPosition ? a.compareDocumentPosition(b) : 0;
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return 1;
    }
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return -1;
    }
    return 0;
  });
  return dialogs[0];
}

/* Slovensky komentar: Pocka na zobrazenie dialógu s progresivnym fallbackom. */
async function waitForConfirmDialogAppear(timeoutMs = 1200) {
  let dialog = getTopMostDialog();
  if (dialog) {
    return dialog;
  }
  let resolver = null;
  let finished = false;
  const waitPromise = new Promise((resolve) => {
    resolver = (value) => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(value);
    };
  });
  const observer = new MutationObserver(() => {
    const candidate = getTopMostDialog();
    if (candidate) {
      resolver(candidate);
    }
  });
  try {
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (_error) {
    // Slovensky komentar: Ak nie je body, preskocime observer.
    if (resolver) {
      resolver(null);
    }
  }
  const timer = setTimeout(() => resolver(null), timeoutMs);
  dialog = await waitPromise;
  clearTimeout(timer);
  observer.disconnect();
  if (dialog) {
    return dialog;
  }
  const delays = [200, 350, 500];
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const retry = getTopMostDialog();
    if (retry) {
      return retry;
    }
  }
  return null;
}

const CONFIRM_SELECTORS = [
  '[data-testid="confirm-delete"]',
  'button[data-testid*="confirm"]',
  '[role="button"][data-testid*="confirm"]',
  'button[aria-label*="Delete" i]',
  'button',
  '[role="button"]'
];

const CONFIRM_TEXT_KEYS = [
  'delete',
  'confirm',
  'yes',
  'ok',
  'vymazať',
  'zmazať',
  'odstrániť',
  'potvrdiť',
  'áno',
  'okej'
];

/* Slovensky komentar: Porovna text/aria s podporou lokalizacie. */
function textMatches(node, keys = CONFIRM_TEXT_KEYS) {
  if (!node) {
    return false;
  }
  const label = typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') || '' : '';
  const raw = `${node.innerText || ''} ${label}`.toLowerCase();
  return keys.some((key) => raw.includes(key));
}

/* Slovensky komentar: Najde potvrdenie v dialógu s logom pokusov. */
function findConfirmButtonInDialog(dialog, trace = []) {
  if (!dialog) {
    return null;
  }
  for (const selector of CONFIRM_SELECTORS.slice(0, 4)) {
    trace.push(selector);
    let candidate = null;
    try {
      candidate = dialog.querySelector(selector);
    } catch (_error) {
      candidate = null;
    }
    if (candidate && isNodeVisible(candidate)) {
      return { node: candidate, via: selector };
    }
  }
  trace.push('text');
  let textCandidates = [];
  try {
    textCandidates = Array.from(
      dialog.querySelectorAll(`${CONFIRM_SELECTORS[4]}, ${CONFIRM_SELECTORS[5]}`)
    );
  } catch (_error) {
    textCandidates = [];
  }
  for (const candidate of textCandidates) {
    if (!isNodeVisible(candidate)) {
      continue;
    }
    if (textMatches(candidate)) {
      return { node: candidate, via: 'text' };
    }
  }
  return null;
}

/* Slovensky komentar: Klikne na potvrdenie s fallbackom na klavesnicu. */
async function clickConfirmButton(btn) {
  if (!btn) {
    return;
  }
  try {
    btn.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (_scrollError) {
    // Slovensky komentar: Scroll zlyhanie ignorujeme.
  }
  try {
    if (typeof btn.focus === 'function') {
      btn.focus({ preventScroll: true });
    }
  } catch (_focusError) {
    // Slovensky komentar: Focus nie je kriticky.
  }
  const events = [
    ['pointerdown', { bubbles: true }],
    ['mousedown', { bubbles: true }],
    ['pointerup', { bubbles: true }],
    ['mouseup', { bubbles: true }]
  ];
  events.forEach(([type, init]) => {
    try {
      btn.dispatchEvent(new MouseEvent(type, init));
    } catch (_eventError) {
      // Slovensky komentar: Ak udalost zlyha, pokracujeme.
    }
  });
  try {
    btn.click();
  } catch (_clickError) {
    // Slovensky komentar: Klik nemusí byt podporeny (napr. inert shadow), pokracujeme.
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (document.body.contains(btn) && document.activeElement === btn) {
    try {
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      btn.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    } catch (_keyboardError) {
      // Slovensky komentar: Klavesnicovy fallback je best-effort.
    }
  }
}

function resolveDeleteMenuItem() {
  const selectorsTried = [];
  for (const selector of DELETE_SELECTORS) {
    selectorsTried.push(selector);
    let candidate = null;
    try {
      candidate = document.querySelector(selector);
    } catch (_error) {
      candidate = null;
    }
    if (candidate && isNodeEnabled(candidate)) {
      return {
        node: candidate,
        selector,
        strategy: 'selector',
        selectorsTried: [...selectorsTried],
        menuSnapshotCount: countMenuItems(document),
        textToken: null,
        ariaLabel: candidate.getAttribute ? candidate.getAttribute('aria-label') || null : null,
        role: candidate.getAttribute ? candidate.getAttribute('role') || null : null
      };
    }
  }

  const menuItems = collectMenuItems();
  const lowerTokens = DELETE_TEXT_TOKENS.map((token) => token.toLowerCase());
  for (const node of menuItems) {
    const normalizedText = readNormalized(node);
    const ariaLabel = node && node.getAttribute ? node.getAttribute('aria-label') : null;
    for (const token of lowerTokens) {
      const ariaMatch = ariaLabel && ariaLabel.toLowerCase().includes(token);
      if (normalizedText.includes(token) || ariaMatch) {
        return {
          node,
          selector: null,
          strategy: 'text',
          selectorsTried: [...selectorsTried],
          menuSnapshotCount: menuItems.length,
          textToken: token,
          ariaLabel: ariaLabel || null,
          role: node && node.getAttribute ? node.getAttribute('role') || null : null
        };
      }
    }
  }

  return {
    node: null,
    selector: null,
    strategy: null,
    selectorsTried: [...selectorsTried],
    menuSnapshotCount: menuItems.length
  };
}

function makeDeleteGetter(resolution) {
  if (!resolution || typeof resolution !== 'object') {
    return () => null;
  }
  return () => {
    if (resolution.node && resolution.node.isConnected) {
      return resolution.node;
    }
    if (resolution.selector) {
      try {
        const node = document.querySelector(resolution.selector);
        if (node && isNodeEnabled(node)) {
          return node;
        }
      } catch (_error) {
        return null;
      }
    }
    if (resolution.strategy === 'text') {
      const items = collectMenuItems();
      for (const node of items) {
        const normalizedText = readNormalized(node);
        const ariaLabel = node && node.getAttribute ? node.getAttribute('aria-label') : null;
        if (!resolution.textToken) {
          if (normalizedText.includes('delete')) {
            return node;
          }
          continue;
        }
        const token = resolution.textToken;
        if (normalizedText.includes(token) || (ariaLabel && ariaLabel.toLowerCase().includes(token))) {
          return node;
        }
      }
    }
    return null;
  };
}

/* Slovensky komentar: Spolocna cast mazania cez menu s rozsirenym logovanim. */
async function executeMenuDeletionSteps(baseSteps = {}, attemptCtx = null) {
  const ctx = attemptCtx && typeof attemptCtx === 'object' ? attemptCtx : {};
  if (!ctx.steps || typeof ctx.steps !== 'object') {
    ctx.steps = {};
  }
  if (!ctx.timings || typeof ctx.timings !== 'object') {
    ctx.timings = {};
  }
  if (!ctx.selectorsTried || typeof ctx.selectorsTried !== 'object') {
    ctx.selectorsTried = { menu: [], delete: [], confirm: [] };
  }
  ctx.selectorsTried.menu = Array.isArray(ctx.selectorsTried.menu) ? ctx.selectorsTried.menu : [];
  ctx.selectorsTried.delete = Array.isArray(ctx.selectorsTried.delete) ? ctx.selectorsTried.delete : [];
  ctx.selectorsTried.confirm = Array.isArray(ctx.selectorsTried.confirm) ? ctx.selectorsTried.confirm : [];
  if (!Array.isArray(ctx.menuSnapshot)) {
    ctx.menuSnapshot = null;
  }
  if (!Array.isArray(ctx.dialogSnapshot)) {
    ctx.dialogSnapshot = null;
  }
  ctx.confirmVia = ctx.confirmVia || null;

  const steps = {
    sidebar: Boolean(baseSteps.sidebar),
    select: Boolean(baseSteps.select),
    menu: Boolean(baseSteps.menu),
    item: Boolean(baseSteps.item),
    confirm: Boolean(baseSteps.confirm)
  };
  const startedAt = Date.now();
  const debug = {
    selectors: [...DELETE_SELECTORS]
  };
  ctx.selectorsTried.menu = Array.from(new Set([...ctx.selectorsTried.menu, ...MORE_ACTIONS_BUTTON_SELECTORS]));

  const finalize = (result) => {
    const elapsed = Date.now() - startedAt;
    if (!Number.isFinite(result.elapsedMs)) {
      result.elapsedMs = elapsed;
    }
    ctx.steps = {
      sidebar: Boolean(steps.sidebar),
      select: Boolean(steps.select),
      menu: Boolean(steps.menu),
      item: Boolean(steps.item),
      confirm: Boolean(steps.confirm)
    };
    if (!ctx.reason) {
      ctx.reason = result.reason || (result.ok ? 'ok' : null);
    }
    ctx.timings.totalUiMs = Number.isFinite(ctx.timings.totalUiMs) ? ctx.timings.totalUiMs : elapsed;
    ctx.legacyDebug = { ...debug };
    return result;
  };

  const beforeMenuItems = countMenuItems();
  debug.menuItemsBefore = beforeMenuItems;

  const menuButton = findMoreActionsButton();
  if (!menuButton) {
    ctx.reason = 'menu_not_found';
    CWARN('menu_not_found', { phase: 'more_actions_button' });
    return finalize({ ok: false, reason: 'menu_not_found', steps, debug, elapsedMs: Date.now() - startedAt });
  }

  const menuClickStarted = Date.now();
  const menuClick = await clickAndWait(() => menuButton, { timeoutMs: 1000 });
  const menuClickElapsed = Date.now() - menuClickStarted;
  debug.menuClickMs = menuClickElapsed;
  debug.menuClickOk = Boolean(menuClick.ok);
  debug.menuItemsAfterMenuClick = countMenuItems();
  ctx.timings.menuMs = menuClickElapsed;
  CDBG('click menu button', { elapsedMs: menuClickElapsed, ok: menuClick.ok, items: debug.menuItemsAfterMenuClick });
  if (!menuClick.ok) {
    ctx.reason = 'ui_click_failed';
    return finalize({ ok: false, reason: 'ui_click_failed', steps, debug, elapsedMs: Date.now() - startedAt });
  }
  steps.menu = true;

  const containers = collectMenuContainers();
  const firstContainer = containers.length ? containers[0] : null;
  debug.menuContainerRole = firstContainer && firstContainer.getAttribute ? firstContainer.getAttribute('role') || null : null;
  debug.menuContainerTestid = firstContainer && firstContainer.getAttribute ? firstContainer.getAttribute('data-testid') || null : null;
  const menuItemsCount = countMenuItems();
  debug.menuItems = menuItemsCount;
  const fullMenuSnapshot = dumpMenuSnapshot();
  ctx.menuSnapshot = fullMenuSnapshot;
  ctx.menuSnapshotCount = Array.isArray(fullMenuSnapshot) ? fullMenuSnapshot.length : 0;
  debug.menuSnapshotCount = ctx.menuSnapshotCount;
  CINFO('menu opened', { items: menuItemsCount, containerRole: debug.menuContainerRole, elapsedMs: menuClickElapsed });

  CDBG('probing delete selectors', [...DELETE_SELECTORS]);
  const resolution = resolveDeleteMenuItem();
  const triedSelectors = resolution.selectorsTried || [...DELETE_SELECTORS];
  debug.selectorsTried = triedSelectors;
  ctx.selectorsTried.delete = Array.from(new Set([...ctx.selectorsTried.delete, ...triedSelectors]));

  if (!resolution.node) {
    ctx.reason = 'delete_item_not_found';
    const snapshot = Array.isArray(fullMenuSnapshot) ? fullMenuSnapshot : dumpMenuSnapshot();
    debug.snapshot = snapshot.slice(0, 25);
    ctx.menuSnapshot = snapshot;
    ctx.menuSnapshotCount = Array.isArray(snapshot) ? snapshot.length : 0;
    CERR('delete_item_not_found', { selectorsTried: [...DELETE_SELECTORS], snapshot: debug.snapshot });
    return finalize({
      ok: false,
      reason: 'delete_item_not_found',
      steps,
      debug,
      elapsedMs: Date.now() - startedAt
    });
  }

  debug.deleteMatch = {
    selector: resolution.selector || null,
    strategy: resolution.strategy || null,
    ariaLabel: resolution.ariaLabel || null,
    role: resolution.role || null,
    textToken: resolution.textToken || null,
    text: resolution.node ? readNormalized(resolution.node) : null
  };

  const deleteGetter = makeDeleteGetter(resolution);
  const deleteClickStarted = Date.now();
  const itemResult = await clickAndWait(deleteGetter, { timeoutMs: 2000 });
  const deleteElapsed = Date.now() - deleteClickStarted;
  debug.deleteClickMs = deleteElapsed;
  debug.deleteClickOk = Boolean(itemResult.ok);
  ctx.timings.deleteMs = deleteElapsed;
  CDBG('click delete item', {
    selector: resolution.selector || null,
    strategy: resolution.strategy || null,
    elapsedMs: deleteElapsed,
    ok: itemResult.ok
  });
  if (!itemResult.ok) {
    ctx.reason = 'ui_click_failed';
    return finalize({ ok: false, reason: 'ui_click_failed', steps, debug, elapsedMs: Date.now() - startedAt });
  }
  steps.item = true;

  const dialogWaitStarted = Date.now();
  const dialog = await waitForConfirmDialogAppear(1200);
  const dialogElapsed = Date.now() - dialogWaitStarted;
  ctx.timings.dialogMs = dialogElapsed;
  debug.dialogWaitMs = dialogElapsed;
  if (!dialog) {
    ctx.reason = 'confirm_dialog_not_found';
    ctx.dialogSnapshot = [];
    ctx.selectorsTried.confirm = [...CONFIRM_SELECTORS, 'text'];
    CWARN('confirm_dialog_not_found', { elapsedMs: dialogElapsed });
    return finalize({ ok: false, reason: 'confirm_dialog_not_found', steps, debug, elapsedMs: Date.now() - startedAt });
  }

  const dialogSnapshot = dumpDialogSnapshot(dialog);
  ctx.dialogSnapshot = dialogSnapshot;
  ctx.dialogSnapshotCount = Array.isArray(dialogSnapshot) ? dialogSnapshot.length : 0;
  debug.dialogSnapshotCount = ctx.dialogSnapshotCount;

  const confirmTrace = [];
  const confirmMatch = findConfirmButtonInDialog(dialog, confirmTrace);
  ctx.selectorsTried.confirm = Array.from(new Set([...ctx.selectorsTried.confirm, ...confirmTrace]));
  debug.confirmSelectors = [...confirmTrace];

  if (!confirmMatch || !confirmMatch.node) {
    ctx.reason = 'confirm_dialog_not_found';
    debug.dialogSnapshot = dialogSnapshot.slice(0, 25);
    CERR('confirm_dialog_not_found', { selectorsTried: confirmTrace, snapshot: debug.dialogSnapshot });
    return finalize({ ok: false, reason: 'confirm_dialog_not_found', steps, debug, elapsedMs: Date.now() - startedAt });
  }

  const confirmActionStarted = Date.now();
  await clickConfirmButton(confirmMatch.node);
  const confirmElapsed = Date.now() - confirmActionStarted;
  ctx.timings.confirmMs = confirmElapsed;
  debug.confirmActionMs = confirmElapsed;
  ctx.confirmVia = confirmMatch.via || null;
  debug.confirmVia = confirmMatch.via || null;
  debug.confirmButtonLabel = readNormalized(confirmMatch.node);

  steps.confirm = true;

  const totalElapsed = Date.now() - startedAt;
  debug.totalMs = totalElapsed;
  ctx.reason = 'ok';
  ctx.timings.totalUiMs = totalElapsed;
  CINFO('delete flow completed', { elapsedMs: totalElapsed, confirmVia: confirmMatch.via || null });
  return finalize({ ok: true, reason: 'ui_delete_ok', steps, debug, elapsedMs: totalElapsed });
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

/* Slovensky komentar: Skontroluje viditelnost a interaktivnost prvku v UI. */
function isNodeVisible(node) {
  if (!node || !(node instanceof Element)) {
    return false;
  }
  let style = null;
  try {
    style = getComputedStyle(node);
  } catch (_error) {
    return false;
  }
  if (!style) {
    return false;
  }
  if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
    return false;
  }
  if (style.pointerEvents === 'none') {
    return false;
  }
  if (typeof node.closest === 'function' && node.closest('[inert]')) {
    return false;
  }
  let rect = null;
  try {
    rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
  } catch (_rectError) {
    rect = null;
  }
  if (!rect || rect.width === 0 || rect.height === 0) {
    return false;
  }
  return true;
}

/* Slovensky komentar: Vrati numericky z-index alebo nulu. */
function numericZIndex(el) {
  if (!el || !(el instanceof Element)) {
    return 0;
  }
  try {
    const raw = getComputedStyle(el).zIndex;
    const num = Number(raw);
    return Number.isFinite(num) ? num : 0;
  } catch (_error) {
    return 0;
  }
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
    return { ok: false, element: null, elapsedMs: Date.now() - start };
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
    return { ok: false, element, error: clickError, elapsedMs: Date.now() - start };
  }

  await waitHelper(120);
  return { ok: true, element, elapsedMs: Date.now() - start };
}

/* Slovensky komentar: Skrati retazec na bezpecnu dlzku. */
function truncate(value, max = 400) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

/* Slovensky komentar: Pripravi finalny report pre orchestrator konzolu. */
function makeOrchestratorReport(ctx) {
  const source = ctx && typeof ctx === 'object' ? ctx : {};
  const rawSteps = source.steps && typeof source.steps === 'object' ? source.steps : {};
  const steps = {
    sidebar: Boolean(rawSteps.sidebar),
    select: Boolean(rawSteps.select),
    menu: Boolean(rawSteps.menu),
    item: Boolean(rawSteps.item),
    confirm: Boolean(rawSteps.confirm)
  };
  const rawTimings = source.timings && typeof source.timings === 'object' ? source.timings : {};
  const timings = {};
  ['menuMs', 'deleteMs', 'dialogMs', 'confirmMs', 'totalUiMs'].forEach((key) => {
    const value = Number(rawTimings[key]);
    if (Number.isFinite(value)) {
      timings[key] = value;
    }
  });
  const rawSelectors = source.selectorsTried && typeof source.selectorsTried === 'object' ? source.selectorsTried : {};
  const selectorsTried = {
    menu: Array.isArray(rawSelectors.menu) ? [...rawSelectors.menu] : [],
    delete: Array.isArray(rawSelectors.delete) ? [...rawSelectors.delete] : [],
    confirm: Array.isArray(rawSelectors.confirm) ? [...rawSelectors.confirm] : []
  };
  const menuSnapshot = Array.isArray(source.menuSnapshot) ? source.menuSnapshot.slice(0, 20) : null;
  const dialogSnapshot = Array.isArray(source.dialogSnapshot) ? source.dialogSnapshot.slice(0, 20) : null;
  const report = {
    kind: 'MyChatGPT:UIDeleteAttempt',
    ts: Date.now(),
    url: typeof location !== 'undefined' && location ? location.href : null,
    title: typeof source.title === 'string' ? truncate(source.title, 400) : source.title || null,
    alternativesCount: Array.isArray(source.alternatives) ? source.alternatives.length : 0,
    matchSource: source.matchSource || null,
    steps,
    timings,
    selectorsTried,
    menuSnapshot,
    menuSnapshotCount: Number.isFinite(source.menuSnapshotCount) ? source.menuSnapshotCount : menuSnapshot ? menuSnapshot.length : 0,
    dialogSnapshot,
    dialogSnapshotCount: Number.isFinite(source.dialogSnapshotCount) ? source.dialogSnapshotCount : dialogSnapshot ? dialogSnapshot.length : 0,
    confirmVia: source.confirmVia || null,
    reason: source.reason || 'ok'
  };
  if (source.legacyDebug && typeof source.legacyDebug === 'object') {
    const legacy = { ...source.legacyDebug };
    if (Array.isArray(legacy.snapshot)) {
      legacy.snapshot = legacy.snapshot.slice(0, 20);
    }
    report.legacyDebug = legacy;
  }
  return report;
}

/* Slovensky komentar: Zalogu report a vrati JSON pre runner. */
function logOrchestratorReport(ctx) {
  try {
    const report = makeOrchestratorReport(ctx);
    console.info('[OrchestratorReport]', JSON.stringify(report));
    return report;
  } catch (error) {
    console.error('[MyChatGPT][content] report_error', error);
    return null;
  }
}

/* Slovensky komentar: Najde tlacidlo pre kebab menu dostupne vo view. */
function findMoreActionsButton() {
  for (const selector of MORE_ACTIONS_BUTTON_SELECTORS) {
    const candidates = safeQueryAll(`${selector}:not([disabled])`).filter((node) => isNodeEnabled(node));
    if (candidates.length) {
      return candidates[0];
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

  if (message.type === 'ui_delete_by_title') {
    (async () => {
      const rawTitle = typeof message.title === 'string' ? message.title : '';
      const altInputs = Array.isArray(message.alternatives) ? message.alternatives : [];
      const steps = { sidebar: false, select: false, menu: false, item: false, confirm: false };
      const startedAt = Date.now();
      const normalizedTargets = [];
      const seen = new Set();
      const targetMeta = new Map();
      const sanitizedAlternatives = altInputs
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim());
      const orchestratorCtx = {
        title: rawTitle || null,
        alternatives: sanitizedAlternatives,
        matchSource: null,
        steps: { ...steps },
        selectorsTried: { menu: [], delete: [], confirm: [] },
        timings: {},
        menuSnapshot: null,
        dialogSnapshot: null,
        confirmVia: null,
        reason: null
      };
      const respond = (payload) => {
        const baseSteps = payload && payload.steps ? payload.steps : steps;
        const normalizedSteps = {
          sidebar: Boolean(baseSteps.sidebar),
          select: Boolean(baseSteps.select),
          menu: Boolean(baseSteps.menu),
          item: Boolean(baseSteps.item),
          confirm: Boolean(baseSteps.confirm)
        };
        orchestratorCtx.steps = { ...normalizedSteps };
        const inferredReason = payload && typeof payload.reason === 'string'
          ? payload.reason
          : payload && payload.ok
          ? 'ok'
          : orchestratorCtx.reason || null;
        if (inferredReason) {
          orchestratorCtx.reason = inferredReason === 'ui_delete_ok' ? 'ok' : inferredReason;
        }
        const resolvedMatchSource = payload && Object.prototype.hasOwnProperty.call(payload, 'matchSource')
          ? payload.matchSource
          : matchSource || orchestratorCtx.matchSource || null;
        orchestratorCtx.matchSource = resolvedMatchSource;
        if (!Number.isFinite(orchestratorCtx.timings.totalUiMs)) {
          orchestratorCtx.timings.totalUiMs = Date.now() - startedAt;
        }
        const report = logOrchestratorReport(orchestratorCtx);
        const response = {
          ok: false,
          steps: normalizedSteps,
          ts: Date.now(),
          ...payload
        };
        response.matchSource = resolvedMatchSource;
        response.debug = report;
        if (typeof response.elapsedMs !== 'number') {
          response.elapsedMs = Date.now() - startedAt;
        }
        if (typeof response.ok !== 'boolean') {
          response.ok = Boolean(payload && payload.ok);
        }
        return sendResponse(response);
      };
      const registerTarget = (value, source) => {
        const normalized = normalizeTitleValue(value);
        if (normalized && !seen.has(normalized)) {
          seen.add(normalized);
          normalizedTargets.push(normalized);
          targetMeta.set(normalized, source || 'title');
        }
      };
      registerTarget(rawTitle, 'title');
      altInputs.forEach((value) => registerTarget(value, 'alternative'));

      let matchSource = null;

      if (!normalizedTargets.length) {
        orchestratorCtx.reason = 'missing_title';
        respond({ ok: false, reason: 'missing_title', matchSource: null });
        return;
      }

      try {
        const currentTitle = normalizeTitleValue(getDocumentConversationTitle());
        const alreadyActive = currentTitle
          && normalizedTargets.some((target) => titlesMatchNormalized(currentTitle, target));

        if (!alreadyActive) {
          const ensureResult = await ensureSidebarVisible();
          if (!ensureResult.ok) {
            const reason = ensureResult.reason || 'sidebar_open_failed';
            if (ensureResult.reason === 'already_visible') {
              steps.sidebar = true;
            }
            orchestratorCtx.reason = reason;
            respond({ ok: false, reason, steps });
            return;
          }
          steps.sidebar = true;
          const { node: conversationNode, matchSource: nodeMatchSource } = findConversationNodeByTitles(normalizedTargets, targetMeta);
          if (nodeMatchSource) {
            matchSource = nodeMatchSource;
            orchestratorCtx.matchSource = nodeMatchSource;
          }
          if (!conversationNode) {
            orchestratorCtx.reason = 'convo_not_found';
            respond({ ok: false, reason: 'convo_not_found', steps });
            return;
          }
          const selectResult = await clickAndWait(() => conversationNode, { timeoutMs: 2000 });
          if (!selectResult.ok) {
            orchestratorCtx.reason = 'ui_click_failed';
            respond({ ok: false, reason: 'ui_click_failed', steps });
            return;
          }
          steps.select = true;
          const loaded = await waitForDocumentTitleMatch(normalizedTargets, 3600);
          if (!loaded) {
            orchestratorCtx.reason = 'select_load_timeout';
            respond({ ok: false, reason: 'select_load_timeout', steps });
            return;
          }
          const postLoadMatch = resolveMatchSource(getDocumentConversationTitle(), normalizedTargets, targetMeta);
          if (postLoadMatch) {
            matchSource = postLoadMatch;
            orchestratorCtx.matchSource = postLoadMatch;
          }
        } else {
          steps.select = true;
          if (isSidebarVisible()) {
            steps.sidebar = true;
          }
          const activeSource = resolveMatchSource(currentTitle, normalizedTargets, targetMeta);
          if (activeSource) {
            matchSource = activeSource;
            orchestratorCtx.matchSource = activeSource;
          }
        }

        const result = await executeMenuDeletionSteps(steps, orchestratorCtx);
        respond({
          ok: result.ok,
          reason: result.reason,
          steps: result.steps,
          matchSource: matchSource || null,
          elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : undefined
        });
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
        orchestratorCtx.reason = 'ui_click_failed';
        respond({ ok: false, reason: 'ui_click_failed', steps, error: messageText });
      }
    })();
    return true;
  }

  if (message.type === 'ui_delete_active') {
    (async () => {
      const steps = {
        sidebar: isSidebarVisible(),
        select: true,
        menu: false,
        item: false,
        confirm: false
      };
      const startedAt = Date.now();
      const activeTitle = getDocumentConversationTitle() || document.title || '';
      const orchestratorCtx = {
        title: activeTitle || null,
        alternatives: [],
        matchSource: 'active_conversation',
        steps: { ...steps },
        selectorsTried: { menu: [], delete: [], confirm: [] },
        timings: {},
        menuSnapshot: null,
        dialogSnapshot: null,
        confirmVia: null,
        reason: null
      };
      try {
        const result = await executeMenuDeletionSteps(steps, orchestratorCtx);
        orchestratorCtx.reason = result.ok ? 'ok' : result.reason || orchestratorCtx.reason;
        const report = logOrchestratorReport(orchestratorCtx);
        sendResponse({
          ok: result.ok,
          reason: result.reason,
          steps: result.steps,
          debug: report,
          ts: Date.now(),
          elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : Date.now() - startedAt
        });
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
        orchestratorCtx.reason = 'ui_click_failed';
        orchestratorCtx.timings.totalUiMs = Date.now() - startedAt;
        const report = logOrchestratorReport(orchestratorCtx);
        sendResponse({
          ok: false,
          reason: 'ui_click_failed',
          steps,
          error: messageText,
          debug: report,
          ts: Date.now(),
          elapsedMs: Date.now() - startedAt
        });
      }
    })();
    return true;
  }

  return undefined;
});
