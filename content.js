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

const MENU_ROOT_SELECTORS = [
  '[role="menu"]',
  '[data-testid*="menu"]',
  '[id*="radix-portal"] [role="menu"]',
  '[data-radix-popper-content-wrapper]',
  '.chakra-portal [role="menu"]',
  '[data-overlay-container] [role="menu"]',
  '[class*="popover"] [role="menu"]'
];

const VISUAL_LAYER_CANDIDATE_SELECTORS = [
  '[role="menu"]',
  '[data-testid*="menu"]',
  '[data-radix-popper-content-wrapper]',
  '[data-radix-portal] *',
  '.chakra-portal *'
];

const DELETE_IN_MENU = [
  '[data-testid="delete-conversation"]',
  '[role="menuitem"][data-testid*="delete"]',
  '[role="menuitem"][aria-label*="Delete" i]',
  '[role="menuitem"]:has(svg[data-icon*="trash"])',
  'button[aria-label*="Delete" i]',
  '[role="menuitem"]',
  'button'
];

const DELETE_IGNORE_TEXT = [
  'search, click to remove',
  'search',
  'clear search',
  'remove pin',
  'unpin',
  'remove from pinned',
  'remove filter',
  'remove label',
  'close sidebar',
  'open sidebar',
  'odstrániť pripnutie',
  'odstranit pripnutie',
  'zrušiť vyhľadávanie',
  'zrusit vyhladavanie',
  'zrušiť filtr',
  'zrusit filtr',
  'odstrániť filter',
  'odstranit filter',
  'odstrániť filtr',
  'odstranit filtr',
  'odstrániť štítok',
  'odstranit stitok',
  'odstrániť značku',
  'odstranit znacku'
];

const DELETE_TEXT_KEYS = [
  'delete conversation',
  'delete chat',
  'delete',
  'vymazať konverzáciu',
  'zmazať konverzáciu',
  'vymazať',
  'zmazať',
  'odstrániť'
];

const INLINE_CONFIRM_TEXT_KEYS = ['yes', 'confirm', 'delete', 'áno', 'potvrdiť', 'vymazať', 'zmazať'];

const MORE_ACTIONS_BUTTON_SELECTORS = [
  'button[aria-label="More actions"]',
  'button[aria-haspopup="menu"][aria-label*="More"]',
  'button[aria-label="Options"]',
  'button[aria-label="More"]'
];

const HEADER_MENU_BUTTON_SELECTORS = [
  'header button[aria-label*="More" i]',
  'main header button[aria-label*="More" i]',
  'header button[aria-haspopup="menu"]',
  'main [role="toolbar"] button[aria-haspopup="menu"]',
  'main button[aria-haspopup="menu"][aria-label*="More" i]'
];

function collectMenuContainers(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return [];
  }
  const seen = new Set();
  const containers = [];
  MENU_ROOT_SELECTORS.forEach((selector) => {
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

/* Slovensky komentar: Bezpecne vrati rect elementu vrátane sirky a vysky. */
function getElementRect(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') {
    return null;
  }
  try {
    const raw = node.getBoundingClientRect();
    if (!raw) {
      return null;
    }
    const width = Number(raw.width);
    const height = Number(raw.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width === 0 || height === 0) {
      return null;
    }
    const rawX = 'x' in raw ? raw.x : raw.left;
    const rawY = 'y' in raw ? raw.y : raw.top;
    const x = Number.isFinite(rawX) ? Number(rawX) : 0;
    const y = Number.isFinite(rawY) ? Number(rawY) : 0;
    return {
      x,
      y,
      width,
      height,
      left: x,
      top: y
    };
  } catch (_error) {
    return null;
  }
}

/* Slovensky komentar: Spocita stred rect-u pre meranie vzdialenosti. */
function rectCenter(rect) {
  if (!rect || typeof rect !== 'object') {
    return null;
  }
  const x = Number.isFinite(rect.x) ? rect.x : Number.isFinite(rect.left) ? rect.left : null;
  const y = Number.isFinite(rect.y) ? rect.y : Number.isFinite(rect.top) ? rect.top : null;
  const width = Number.isFinite(rect.width) ? rect.width : Number.isFinite(rect.w) ? rect.w : null;
  const height = Number.isFinite(rect.height) ? rect.height : Number.isFinite(rect.h) ? rect.h : null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return { x: x + width / 2, y: y + height / 2 };
}

/* Slovensky komentar: Vrati euklidovsku vzdialenost stredov dvoch rectov. */
function rectDistance(a, b) {
  const centerA = rectCenter(a);
  const centerB = rectCenter(b);
  if (!centerA || !centerB) {
    return null;
  }
  return Math.hypot(centerA.x - centerB.x, centerA.y - centerB.y);
}

function centerDistance(a, b) {
  return rectDistance(a, b);
}

/* Slovensky komentar: Vyberie najlepsieho kandidata delete podla textu a polohy. */
function pickBestDeleteCandidate(candidates, kebabRect) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return null;
  }
  const kebabCenter = kebabRect ? rectCenter(kebabRect) : null;
  const scored = candidates.map((candidate) => {
    const rect = candidate.rect || getElementRect(candidate.node);
    const center = rectCenter(rect);
    const textLength = candidate.text ? candidate.text.length : candidate.ariaNormalized ? candidate.ariaNormalized.length : 999;
    const horizontalDelta = kebabCenter && center ? center.x - kebabCenter.x : null;
    const preferRight = horizontalDelta !== null && horizontalDelta >= 0 ? 0 : 1;
    const horizontalDistance = horizontalDelta !== null ? Math.abs(horizontalDelta) : Number.POSITIVE_INFINITY;
    return {
      candidate,
      textLength,
      preferRight,
      horizontalDistance
    };
  });
  scored.sort((a, b) => {
    if (a.preferRight !== b.preferRight) {
      return a.preferRight - b.preferRight;
    }
    if (a.textLength !== b.textLength) {
      return a.textLength - b.textLength;
    }
    if (a.horizontalDistance !== b.horizontalDistance) {
      return a.horizontalDistance - b.horizontalDistance;
    }
    return 0;
  });
  return scored[0].candidate;
}

function matchVisualLayerSelector(node) {
  if (!node || typeof node.matches !== 'function') {
    return null;
  }
  for (const selector of VISUAL_LAYER_CANDIDATE_SELECTORS) {
    try {
      if (node.matches(selector)) {
        return selector;
      }
    } catch (_error) {
      // Slovensky komentar: Neplatny selector ignorujeme.
    }
  }
  return null;
}

function hasInteractiveMenuItems(node) {
  if (!node || !(node instanceof Element)) {
    return false;
  }
  try {
    if (typeof node.matches === 'function' && node.matches('button, [role="menuitem"]')) {
      return true;
    }
  } catch (_error) {
    // Slovensky komentar: matches zlyhanie ignorujeme.
  }
  try {
    const found = node.querySelector('button, [role="menuitem"]');
    return Boolean(found);
  } catch (_error) {
    return false;
  }
}

function resolveMenuLayerCandidate(node) {
  let current = node && node instanceof Element ? node : null;
  while (current && current !== document.body) {
    if (!isNodeVisible(current)) {
      current = current.parentElement;
      continue;
    }
    const rect = getElementRect(current);
    if (!rect) {
      current = current.parentElement;
      continue;
    }
    let style = null;
    try {
      style = getComputedStyle(current);
    } catch (_error) {
      style = null;
    }
    const position = style ? style.position : '';
    const zIndex = style ? Number(style.zIndex) : Number.NaN;
    const selectorMatch = matchVisualLayerSelector(current);
    const matchesLayer = selectorMatch
      || position === 'fixed'
      || position === 'absolute';
    const zIndexOk = selectorMatch ? true : Number.isFinite(zIndex) ? zIndex >= 10 : numericZIndex(current) >= 10;
    if (matchesLayer && zIndexOk && hasInteractiveMenuItems(current)) {
      return {
        node: current,
        selector: selectorMatch,
        rect,
        zIndex: Number.isFinite(zIndex) ? zIndex : numericZIndex(current)
      };
    }
    current = current.parentElement;
  }
  return null;
}

function gatherKebabMeta(button) {
  if (!button || !(button instanceof Element)) {
    return {
      element: button || null,
      rect: null,
      ariaExpanded: null,
      ariaControls: null
    };
  }
  const rect = getElementRect(button);
  const ariaExpanded = typeof button.getAttribute === 'function' ? button.getAttribute('aria-expanded') : null;
  const ariaControls = typeof button.getAttribute === 'function' ? button.getAttribute('aria-controls') : null;
  return {
    element: button,
    rect,
    ariaExpanded: ariaExpanded || null,
    ariaControls: ariaControls || null
  };
}

function captureVisualLayerSnapshot(limit = 20) {
  if (!document || !document.body) {
    return [];
  }
  const nodes = [];
  const elements = Array.from(document.body.getElementsByTagName('*'));
  elements.forEach((node) => {
    if (!(node instanceof Element)) {
      return;
    }
    if (!isNodeVisible(node)) {
      return;
    }
    let style = null;
    try {
      style = getComputedStyle(node);
    } catch (_error) {
      style = null;
    }
    if (!style) {
      return;
    }
    if (style.position !== 'fixed' && style.position !== 'absolute') {
      return;
    }
    const zIndex = Number(style.zIndex);
    if (!Number.isFinite(zIndex) || zIndex < 10) {
      return;
    }
    const rect = getElementRect(node);
    if (!rect) {
      return;
    }
    nodes.push({ node, rect, zIndex });
  });
  nodes.sort((a, b) => b.zIndex - a.zIndex);
  return nodes.slice(0, limit).map(({ node, rect, zIndex }) => ({
    className: typeof node.className === 'string' ? node.className : '',
    role: typeof node.getAttribute === 'function' ? node.getAttribute('role') || null : null,
    testid: typeof node.getAttribute === 'function' ? node.getAttribute('data-testid') || null : null,
    rect,
    zIndex,
    text: truncate(readNormalized(node), 160)
  }));
}

/* Slovensky komentar: Najde najblizsi koren menu podla rectu kebabu s observerom. */
async function findMenuRootForButton(menuButton, { timeoutMs = 650 } = {}) {
  const meta = gatherKebabMeta(menuButton);
  const base = {
    node: null,
    selector: null,
    rect: null,
    itemsCount: null,
    distance: null,
    zIndex: null,
    strategy: null,
    kebabRect: meta.rect || null,
    kebabEl: meta.element || null,
    kebabAriaExpanded: meta.ariaExpanded,
    kebabAriaControls: meta.ariaControls
  };

  if (meta.ariaControls) {
    const ariaId = typeof meta.ariaControls === 'string' ? meta.ariaControls.trim() : '';
    const target = ariaId ? document.getElementById(ariaId) : null;
    if (target && target instanceof Element && isNodeVisible(target) && hasInteractiveMenuItems(target)) {
      const rect = getElementRect(target);
      if (rect) {
        const itemsCount = countMenuItems(target);
        if (itemsCount) {
          const distance = meta.rect && rect ? centerDistance(meta.rect, rect) : null;
          return {
            ...base,
            node: target,
            selector: ariaId ? `#${ariaId}` : null,
            rect,
            itemsCount: Number.isFinite(itemsCount) ? itemsCount : countMenuItems(target),
            distance: Number.isFinite(distance) ? distance : null,
            zIndex: numericZIndex(target),
            strategy: 'aria-controls'
          };
        }
      }
    }
  }

  const startedAt = Date.now();
  const candidates = new Map();

  const registerCandidate = (candidate) => {
    if (!candidate || !candidate.node) {
      return;
    }
    const container = candidate.node;
    if (!container.isConnected) {
      return;
    }
    const rect = candidate.rect || getElementRect(container);
    if (!rect) {
      return;
    }
    const itemsCount = countMenuItems(container);
    if (!itemsCount) {
      return;
    }
    const distance = meta.rect && rect ? centerDistance(meta.rect, rect) : null;
    const selector = candidate.selector || matchVisualLayerSelector(container) || null;
    const zIndex = Number.isFinite(candidate.zIndex) ? candidate.zIndex : numericZIndex(container);
    const payload = {
      node: container,
      selector,
      rect,
      itemsCount,
      distance: Number.isFinite(distance) ? distance : null,
      zIndex,
      strategy: 'visual-layer-proximity'
    };
    if (!candidates.has(container)) {
      candidates.set(container, payload);
    } else {
      const existing = candidates.get(container);
      const existingDist = Number.isFinite(existing.distance) ? existing.distance : Number.POSITIVE_INFINITY;
      const nextDist = Number.isFinite(payload.distance) ? payload.distance : Number.POSITIVE_INFINITY;
      const better = nextDist < existingDist
        || payload.itemsCount > (existing.itemsCount || 0)
        || payload.zIndex > (existing.zIndex || 0);
      if (better) {
        candidates.set(container, { ...existing, ...payload });
      }
    }
  };

  const considerNode = (node) => {
    if (!node || !(node instanceof Element)) {
      return;
    }
    const resolved = resolveMenuLayerCandidate(node);
    if (resolved) {
      registerCandidate(resolved);
    }
  };

  VISUAL_LAYER_CANDIDATE_SELECTORS.forEach((selector) => {
    const nodes = safeQueryAll(selector);
    nodes.forEach((node) => considerNode(node));
  });

  const pickBest = () => {
    if (!candidates.size) {
      return null;
    }
    const list = Array.from(candidates.values());
    list.sort((a, b) => {
      const distA = Number.isFinite(a.distance) ? a.distance : Number.POSITIVE_INFINITY;
      const distB = Number.isFinite(b.distance) ? b.distance : Number.POSITIVE_INFINITY;
      if (distA !== distB) {
        return distA - distB;
      }
      if ((b.itemsCount || 0) !== (a.itemsCount || 0)) {
        return (b.itemsCount || 0) - (a.itemsCount || 0);
      }
      return (b.zIndex || 0) - (a.zIndex || 0);
    });
    return list[0];
  };

  const immediate = pickBest();
  if (immediate) {
    return { ...base, ...immediate };
  }

  return new Promise((resolve) => {
    let finished = false;
    const observers = [];

    const finish = (candidate) => {
      if (finished) {
        return;
      }
      finished = true;
      observers.forEach((observer) => {
        try {
          observer.disconnect();
        } catch (_error) {
          // Slovensky komentar: Odpojenie observera je best-effort.
        }
      });
      if (candidate) {
        resolve({ ...base, ...candidate });
      } else {
        resolve({ ...base });
      }
    };

    try {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (!(node instanceof Element)) {
              return;
            }
            considerNode(node);
            VISUAL_LAYER_CANDIDATE_SELECTORS.forEach((selector) => {
              let nodes = [];
              try {
                nodes = Array.from(node.querySelectorAll(selector));
              } catch (_error) {
                nodes = [];
              }
              nodes.forEach((match) => considerNode(match));
            });
          });
        });
        const candidate = pickBest();
        if (candidate) {
          finish(candidate);
        }
      });
      if (document && document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
        observers.push(observer);
      }
    } catch (_error) {
      // Slovensky komentar: Observer je best-effort.
    }

    const poll = async () => {
      while (!finished && Date.now() - startedAt < timeoutMs) {
        await waitHelper(70);
        const candidate = pickBest();
        if (candidate) {
          finish(candidate);
          return;
        }
      }
      finish(null);
    };

    poll();
  });
}

/* Slovensky komentar: Sleduje, ci menu ostalo a ci pribudol inline confirm. */
async function waitForConfirmPattern(menuRoot, ignoreNode, { timeoutMs = 1200 } = {}) {
  if (!menuRoot || !menuRoot.isConnected) {
    return { pattern: 'modal', node: null };
  }
  const tokens = INLINE_CONFIRM_TEXT_KEYS.map((token) => token.toLowerCase());
  const startedAt = Date.now();

  const evaluateInline = () => {
    if (!menuRoot.isConnected || !isNodeVisible(menuRoot)) {
      return { pattern: 'modal', node: null };
    }
    const items = collectMenuItems(menuRoot);
    for (const item of items) {
      if (!item || item === ignoreNode || !isNodeEnabled(item) || !isNodeVisible(item)) {
        continue;
      }
      const text = readNormalized(item);
      const ariaRaw = item && typeof item.getAttribute === 'function' ? item.getAttribute('aria-label') : '';
      const ariaNormalized = typeof ariaRaw === 'string' ? ariaRaw.trim().toLowerCase() : '';
      const bundle = `${text} ${ariaNormalized}`.trim();
      if (!bundle) {
        continue;
      }
      const hit = tokens.find((token) => bundle.includes(token));
      if (hit) {
        return {
          pattern: 'inline',
          node: item,
          text,
          token: hit
        };
      }
    }
    return null;
  };

  const immediateInline = evaluateInline();
  if (immediateInline) {
    return immediateInline;
  }
  if (!menuRoot.isConnected || !isNodeVisible(menuRoot)) {
    return { pattern: 'modal', node: null };
  }

  return new Promise((resolve) => {
    const observers = [];
    let finished = false;
    const finish = (value) => {
      if (finished) {
        return;
      }
      finished = true;
      observers.forEach((observer) => {
        try {
          observer.disconnect();
        } catch (_error) {
          // Slovensky komentar: Ignorujeme chybu pri odpojeni.
        }
      });
      resolve(value);
    };

    const watchTarget = (target, options) => {
      if (!target) {
        return;
      }
      try {
        const observer = new MutationObserver(() => {
          if (!menuRoot.isConnected || !isNodeVisible(menuRoot)) {
            finish({ pattern: 'modal', node: null });
            return;
          }
          const inlineCandidate = evaluateInline();
          if (inlineCandidate) {
            finish(inlineCandidate);
          }
        });
        observer.observe(target, options);
        observers.push(observer);
      } catch (_error) {
        // Slovensky komentar: Ak observer zlyha, pokracujeme v poole.
      }
    };

    watchTarget(menuRoot, { childList: true, subtree: true });
    if (document && document.body) {
      watchTarget(document.body, { childList: true, subtree: true });
    }

    const poll = async () => {
      while (!finished && Date.now() - startedAt < timeoutMs) {
        await waitHelper(80);
        if (!menuRoot.isConnected || !isNodeVisible(menuRoot)) {
          finish({ pattern: 'modal', node: null });
          return;
        }
        const inlineCandidate = evaluateInline();
        if (inlineCandidate) {
          finish(inlineCandidate);
          return;
        }
      }
      if (!finished) {
        if (!menuRoot.isConnected || !isNodeVisible(menuRoot)) {
          finish({ pattern: 'modal', node: null });
          return;
        }
        const inlineCandidate = evaluateInline();
        if (inlineCandidate) {
          finish(inlineCandidate);
          return;
        }
        finish({ pattern: 'timeout', node: null });
      }
    };

    poll();
  });
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

function resolveDeleteMenuItem(menuRoot, kebabRect, debug) {
  const scope = menuRoot && menuRoot.isConnected ? menuRoot : document;
  const selectorsTried = [];
  const ignoreTokens = DELETE_IGNORE_TEXT.map((token) => token.toLowerCase());
  const allowedTokens = DELETE_TEXT_KEYS.map((token) => token.toLowerCase());
  const seen = new Set();
  const stageBuckets = {
    testid: [],
    aria: [],
    icon: [],
    text: []
  };
  const ignoredTexts = [];

  const rememberIgnored = (text) => {
    if (!text) {
      return;
    }
    const normalized = truncate(text, 160);
    if (!ignoredTexts.includes(normalized)) {
      ignoredTexts.push(normalized);
    }
  };

  const shouldIgnore = (text, aria) => {
    const bundle = [text || '', aria || '']
      .map((value) => (typeof value === 'string' ? value.toLowerCase() : ''))
      .join(' ')
      .trim();
    if (!bundle) {
      return false;
    }
    return ignoreTokens.some((token) => bundle.includes(token));
  };

  const matchDeleteToken = (text, aria) => {
    const normalizedText = typeof text === 'string' ? text.toLowerCase() : '';
    const normalizedAria = typeof aria === 'string' ? aria.toLowerCase() : '';
    for (const token of allowedTokens) {
      if (normalizedText.includes(token) || normalizedAria.includes(token)) {
        return token;
      }
    }
    return null;
  };

  const registerCandidate = (node, selector, stage, matchToken = null) => {
    if (!node || seen.has(node) || !isNodeEnabled(node) || !isNodeVisible(node)) {
      return;
    }
    const text = readNormalized(node);
    const ariaLabelRaw = node && typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : null;
    const ariaNormalized = typeof ariaLabelRaw === 'string' ? ariaLabelRaw.trim().toLowerCase() : '';
    if (shouldIgnore(text, ariaNormalized)) {
      rememberIgnored(text || ariaNormalized || '');
      return;
    }
    const candidate = {
      node,
      selector,
      via: stage,
      text,
      ariaLabel: ariaLabelRaw || null,
      ariaNormalized,
      textToken: matchToken,
      rect: getElementRect(node),
      role: node && typeof node.getAttribute === 'function' ? node.getAttribute('role') || null : null,
      testid: node && typeof node.getAttribute === 'function' ? node.getAttribute('data-testid') || null : null
    };
    stageBuckets[stage].push(candidate);
    seen.add(node);
  };

  const collectBySelector = (selector, stage, { requireTextMatch = false } = {}) => {
    selectorsTried.push(selector);
    let nodes = [];
    try {
      nodes = Array.from(scope.querySelectorAll(selector));
    } catch (_error) {
      nodes = [];
    }
    nodes.forEach((node) => {
      const text = readNormalized(node);
      const ariaLabelRaw = node && typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : null;
      const ariaNormalized = typeof ariaLabelRaw === 'string' ? ariaLabelRaw.trim().toLowerCase() : '';
      const ignore = shouldIgnore(text, ariaNormalized);
      if (ignore) {
        rememberIgnored(text || ariaNormalized || '');
        return;
      }
      let matchToken = null;
      if (requireTextMatch) {
        matchToken = matchDeleteToken(text, ariaNormalized);
        if (!matchToken) {
          return;
        }
      }
      registerCandidate(node, selector, stage, matchToken);
    });
  };

  const selectorConfig = [
    { selector: DELETE_IN_MENU[0], stage: 'testid' },
    { selector: DELETE_IN_MENU[1], stage: 'testid' },
    { selector: DELETE_IN_MENU[2], stage: 'aria' },
    { selector: DELETE_IN_MENU[4], stage: 'aria' },
    { selector: DELETE_IN_MENU[3], stage: 'icon' },
    { selector: DELETE_IN_MENU[5], stage: 'text', requireTextMatch: true },
    { selector: DELETE_IN_MENU[6], stage: 'text', requireTextMatch: true }
  ];

  selectorConfig.forEach(({ selector, stage, requireTextMatch }) => {
    collectBySelector(selector, stage, { requireTextMatch: Boolean(requireTextMatch) });
  });

  const menuItems = collectMenuItems(scope);
  const totalCandidates = Object.values(stageBuckets).reduce((acc, list) => acc + list.length, 0);
  debug.deleteCandidatesTotal = totalCandidates;
  debug.deleteIgnoredByText = ignoredTexts.slice(0, 10);

  const stageOrder = ['testid', 'aria', 'icon', 'text'];
  let chosenStage = null;
  let chosenCandidate = null;
  for (const stage of stageOrder) {
    if (stageBuckets[stage].length) {
      chosenStage = stage;
      chosenCandidate = pickBestDeleteCandidate(stageBuckets[stage], kebabRect || null);
      break;
    }
  }

  if (!chosenCandidate) {
    return {
      node: null,
      selector: null,
      strategy: null,
      selectorsTried: [...selectorsTried],
      menuSnapshotCount: menuItems.length,
      menuRoot: scope,
      via: null,
      textToken: null,
      ariaLabel: null,
      role: null,
      text: null
    };
  }

  debug.deleteChosenVia = chosenStage || null;
  debug.deleteChosenText = chosenCandidate.text || chosenCandidate.ariaNormalized || null;

  return {
    node: chosenCandidate.node,
    selector: chosenCandidate.selector,
    strategy: chosenStage === 'text' ? 'text' : 'selector',
    selectorsTried: [...selectorsTried],
    menuSnapshotCount: menuItems.length,
    menuRoot: scope,
    via: chosenStage,
    textToken: chosenCandidate.textToken || null,
    ariaLabel: chosenCandidate.ariaLabel || null,
    role: chosenCandidate.role || null,
    text: chosenCandidate.text || null
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
    const scope = resolution.menuRoot && resolution.menuRoot.isConnected ? resolution.menuRoot : document;
    if (resolution.selector && resolution.strategy !== 'text') {
      try {
        const nodes = Array.from(scope.querySelectorAll(resolution.selector)).filter(
          (node) => node && isNodeEnabled(node) && isNodeVisible(node)
        );
        if (nodes.length === 1) {
          return nodes[0];
        }
        if (nodes.length > 1) {
          const expectedText = typeof resolution.text === 'string' ? resolution.text : null;
          if (expectedText) {
            const textMatch = nodes.find((node) => readNormalized(node) === expectedText);
            if (textMatch) {
              return textMatch;
            }
          }
          const expectedAria = typeof resolution.ariaLabel === 'string'
            ? resolution.ariaLabel.toLowerCase()
            : null;
          if (expectedAria) {
            const ariaMatch = nodes.find((node) => {
              const aria = node && typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : null;
              return aria && aria.toLowerCase() === expectedAria;
            });
            if (ariaMatch) {
              return ariaMatch;
            }
          }
          return nodes[0];
        }
      } catch (_error) {
        return null;
      }
    }
    if (resolution.strategy === 'text') {
      const items = collectMenuItems(scope);
      for (const node of items) {
        if (!isNodeEnabled(node) || !isNodeVisible(node)) {
          continue;
        }
        const normalizedText = readNormalized(node);
        const ariaLabel = node && node.getAttribute ? node.getAttribute('aria-label') : null;
        if (!resolution.textToken) {
          if (normalizedText.includes('delete')) {
            return node;
          }
          continue;
        }
        const token = resolution.textToken;
        const ariaNormalized = ariaLabel && typeof ariaLabel === 'string' ? ariaLabel.toLowerCase() : '';
        if (normalizedText.includes(token) || ariaNormalized.includes(token)) {
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
  if (typeof ctx.fallbackHeaderPath !== 'boolean') {
    ctx.fallbackHeaderPath = false;
  }
  ctx.menuRootStrategy = ctx.menuRootStrategy || null;
  ctx.menuRootSelectorMatched = ctx.menuRootSelectorMatched || null;
  ctx.menuRootDistance = Number.isFinite(ctx.menuRootDistance) ? ctx.menuRootDistance : null;
  ctx.menuRootItemsCount = Number.isFinite(ctx.menuRootItemsCount) ? ctx.menuRootItemsCount : null;
  ctx.deleteCandidatesTotal = Number.isFinite(ctx.deleteCandidatesTotal) ? ctx.deleteCandidatesTotal : null;
  ctx.deleteIgnoredByText = Array.isArray(ctx.deleteIgnoredByText) ? ctx.deleteIgnoredByText.slice(0, 10) : [];
  ctx.confirmPattern = ctx.confirmPattern || null;

  const steps = {
    sidebar: Boolean(baseSteps.sidebar),
    select: Boolean(baseSteps.select),
    menu: Boolean(baseSteps.menu),
    item: Boolean(baseSteps.item),
    confirm: Boolean(baseSteps.confirm)
  };
  const startedAt = Date.now();
  const debug = {
    selectors: [...DELETE_IN_MENU]
  };
  debug.confirmSelectors = [];
  debug.headerMenuClickMs = null;
  debug.headerMenuClickOk = null;
  ctx.selectorsTried.menu = Array.from(
    new Set([
      ...ctx.selectorsTried.menu,
      ...MORE_ACTIONS_BUTTON_SELECTORS,
      ...HEADER_MENU_BUTTON_SELECTORS,
      ...MENU_ROOT_SELECTORS,
      ...VISUAL_LAYER_CANDIDATE_SELECTORS
    ])
  );
  debug.fallbackHeaderPath = false;

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

  const menuButtonMeta = gatherKebabMeta(menuButton);
  debug.menuButtonRect = menuButtonMeta.rect;
  debug.menuButtonAriaExpanded = menuButtonMeta.ariaExpanded;
  debug.menuButtonAriaControls = menuButtonMeta.ariaControls;

  const menuClickStarted = Date.now();
  const menuClick = await clickAndWait(() => menuButton, { timeoutMs: 1000 });
  const menuClickElapsed = Date.now() - menuClickStarted;
  let menuClickTotal = menuClickElapsed;
  debug.sidebarMenuClickMs = menuClickElapsed;
  debug.menuClickMs = menuClickTotal;
  debug.menuClickOk = Boolean(menuClick.ok);
  debug.menuItemsAfterMenuClick = countMenuItems();
  ctx.timings.menuMs = menuClickTotal;
  CDBG('click menu button', { elapsedMs: menuClickElapsed, ok: menuClick.ok, items: debug.menuItemsAfterMenuClick });
  if (!menuClick.ok) {
    ctx.reason = 'ui_click_failed';
    return finalize({ ok: false, reason: 'ui_click_failed', steps, debug, elapsedMs: Date.now() - startedAt });
  }
  steps.menu = true;

  const menuRootWaitStarted = Date.now();
  let menuRootResolution = await findMenuRootForButton(menuButton, { timeoutMs: 650 });
  if (!menuRootResolution || !menuRootResolution.node) {
    ctx.fallbackHeaderPath = true;
    debug.fallbackHeaderPath = true;
    const headerMenuButton = findHeaderMoreActionsButton();
    if (!headerMenuButton) {
      const menuRootElapsedFallback = Date.now() - menuRootWaitStarted;
      ctx.timings.menuRootFindMs = menuRootElapsedFallback;
      debug.menuRootFindMs = menuRootElapsedFallback;
      debug.menuRootStrategy = menuRootResolution ? menuRootResolution.strategy || null : null;
      debug.menuRootSelectorMatched = null;
      debug.menuRootDistance = null;
      debug.menuRootItemsCount = null;
      ctx.menuRootStrategy = null;
      ctx.menuRootSelectorMatched = null;
      ctx.menuRootDistance = null;
      ctx.menuRootItemsCount = null;
      const snapshotFallback = captureVisualLayerSnapshot(20);
      ctx.menuSnapshot = snapshotFallback;
      ctx.menuSnapshotCount = Array.isArray(snapshotFallback) ? snapshotFallback.length : 0;
      debug.menuSnapshot = Array.isArray(snapshotFallback) ? snapshotFallback.slice(0, 20) : null;
      debug.menuSnapshotCount = ctx.menuSnapshotCount;
      ctx.reason = 'menu_not_found';
      CWARN('menu_not_found', { phase: 'menu_root_fallback', elapsedMs: menuRootElapsedFallback });
      return finalize({ ok: false, reason: 'menu_not_found', steps, debug, elapsedMs: Date.now() - startedAt });
    }
    const headerMenuClickStarted = Date.now();
    const headerMenuClick = await clickAndWait(() => headerMenuButton, { timeoutMs: 1000 });
    const headerMenuClickElapsed = Date.now() - headerMenuClickStarted;
    debug.headerMenuClickMs = headerMenuClickElapsed;
    debug.headerMenuClickOk = Boolean(headerMenuClick.ok);
    menuClickTotal += headerMenuClickElapsed;
    ctx.timings.menuMs = menuClickTotal;
    debug.menuClickMs = menuClickTotal;
    debug.menuClickOk = Boolean(menuClick.ok || headerMenuClick.ok);
    if (!headerMenuClick.ok) {
      const menuRootElapsedFallback = Date.now() - menuRootWaitStarted;
      ctx.timings.menuRootFindMs = menuRootElapsedFallback;
      debug.menuRootFindMs = menuRootElapsedFallback;
      debug.menuRootStrategy = menuRootResolution ? menuRootResolution.strategy || null : null;
      debug.menuRootSelectorMatched = null;
      debug.menuRootDistance = null;
      debug.menuRootItemsCount = null;
      ctx.menuRootStrategy = null;
      ctx.menuRootSelectorMatched = null;
      ctx.menuRootDistance = null;
      ctx.menuRootItemsCount = null;
      const snapshotClickFail = captureVisualLayerSnapshot(20);
      ctx.menuSnapshot = snapshotClickFail;
      ctx.menuSnapshotCount = Array.isArray(snapshotClickFail) ? snapshotClickFail.length : 0;
      debug.menuSnapshot = Array.isArray(snapshotClickFail) ? snapshotClickFail.slice(0, 20) : null;
      debug.menuSnapshotCount = ctx.menuSnapshotCount;
      ctx.reason = 'ui_click_failed';
      return finalize({ ok: false, reason: 'ui_click_failed', steps, debug, elapsedMs: Date.now() - startedAt });
    }
    menuRootResolution = await findMenuRootForButton(headerMenuButton, { timeoutMs: 650 });
  } else {
    debug.menuClickOk = Boolean(menuClick.ok);
  }

  const menuRootElapsed = Date.now() - menuRootWaitStarted;
  ctx.timings.menuRootFindMs = menuRootElapsed;
  debug.menuRootFindMs = menuRootElapsed;

  const menuRootNode = menuRootResolution && menuRootResolution.node ? menuRootResolution.node : null;
  const menuRootStrategy = menuRootResolution ? menuRootResolution.strategy || null : null;
  const menuRootSelectorMatched = menuRootResolution ? menuRootResolution.selector || null : null;
  const menuRootDistanceRounded = menuRootResolution && Number.isFinite(menuRootResolution.distance)
    ? Math.round(menuRootResolution.distance * 10) / 10
    : null;

  debug.menuRootStrategy = menuRootStrategy;
  debug.menuRootSelectorMatched = menuRootSelectorMatched;
  debug.menuRootDistance = menuRootDistanceRounded;
  ctx.menuRootStrategy = menuRootStrategy;
  ctx.menuRootSelectorMatched = menuRootSelectorMatched;
  ctx.menuRootDistance = menuRootDistanceRounded;

  let menuItemsCount = 0;
  if (menuRootNode) {
    menuItemsCount = countMenuItems(menuRootNode);
  }
  const resolvedItemsCount = menuRootResolution && Number.isFinite(menuRootResolution.itemsCount)
    ? menuRootResolution.itemsCount
    : menuItemsCount;
  debug.menuRootItemsCount = menuRootNode ? resolvedItemsCount : null;
  ctx.menuRootItemsCount = menuRootNode ? resolvedItemsCount : null;

  if (!menuRootNode) {
    const snapshotFinal = captureVisualLayerSnapshot(20);
    ctx.menuSnapshot = snapshotFinal;
    ctx.menuSnapshotCount = Array.isArray(snapshotFinal) ? snapshotFinal.length : 0;
    debug.menuSnapshot = Array.isArray(snapshotFinal) ? snapshotFinal.slice(0, 20) : null;
    debug.menuSnapshotCount = ctx.menuSnapshotCount;
    ctx.reason = 'menu_not_found';
    CWARN('menu_not_found', { phase: 'menu_root', elapsedMs: menuRootElapsed });
    return finalize({ ok: false, reason: 'menu_not_found', steps, debug, elapsedMs: Date.now() - startedAt });
  }

  debug.menuContainerRole = menuRootNode && menuRootNode.getAttribute ? menuRootNode.getAttribute('role') || null : null;
  debug.menuContainerTestid = menuRootNode && menuRootNode.getAttribute ? menuRootNode.getAttribute('data-testid') || null : null;
  debug.menuItems = resolvedItemsCount;

  const fullMenuSnapshot = dumpMenuSnapshot(menuRootNode);
  ctx.menuSnapshot = fullMenuSnapshot;
  ctx.menuSnapshotCount = Array.isArray(fullMenuSnapshot) ? fullMenuSnapshot.length : 0;
  debug.menuSnapshotCount = ctx.menuSnapshotCount;
  CINFO('menu opened', {
    items: resolvedItemsCount,
    containerRole: debug.menuContainerRole,
    elapsedMs: menuClickElapsed,
    rootSelector: debug.menuRootSelectorMatched
  });

  CDBG('probing delete selectors', [...DELETE_IN_MENU]);
  const resolution = resolveDeleteMenuItem(menuRootNode, menuRootResolution.kebabRect || null, debug);
  const triedSelectors = resolution.selectorsTried || [...DELETE_IN_MENU];
  debug.selectorsTried = triedSelectors;
  ctx.selectorsTried.delete = Array.from(new Set([...ctx.selectorsTried.delete, ...triedSelectors]));
  ctx.deleteCandidatesTotal = Number.isFinite(debug.deleteCandidatesTotal)
    ? debug.deleteCandidatesTotal
    : null;
  ctx.deleteIgnoredByText = Array.isArray(debug.deleteIgnoredByText)
    ? debug.deleteIgnoredByText.slice(0, 10)
    : [];

  if (!resolution.node) {
    ctx.reason = 'delete_item_not_found';
    const snapshot = Array.isArray(fullMenuSnapshot) ? fullMenuSnapshot : dumpMenuSnapshot(menuRootNode);
    debug.snapshot = snapshot.slice(0, 25);
    ctx.menuSnapshot = snapshot;
    ctx.menuSnapshotCount = Array.isArray(snapshot) ? snapshot.length : 0;
    CERR('delete_item_not_found', { selectorsTried: [...DELETE_IN_MENU], snapshot: debug.snapshot });
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
    text: resolution.text || (resolution.node ? readNormalized(resolution.node) : null),
    via: resolution.via || null
  };

  const deleteGetter = makeDeleteGetter(resolution);
  const deleteClickStarted = Date.now();
  const itemResult = await clickAndWait(deleteGetter, { timeoutMs: 2000 });
  const deleteElapsed = Date.now() - deleteClickStarted;
  debug.deleteClickMs = deleteElapsed;
  debug.deleteClickOk = Boolean(itemResult.ok);
  ctx.timings.deleteMs = deleteElapsed;
  ctx.timings.deleteClickMs = deleteElapsed;
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

  let confirmFindTotal = 0;
  const confirmDetectStarted = Date.now();
  const confirmPatternResult = await waitForConfirmPattern(menuRootNode, resolution.node || null, { timeoutMs: 1200 });
  const confirmDetectElapsed = Date.now() - confirmDetectStarted;
  confirmFindTotal += confirmDetectElapsed;
  const initialPattern = confirmPatternResult ? confirmPatternResult.pattern : null;
  debug.confirmPattern = initialPattern || null;
  ctx.confirmPattern = initialPattern || null;

  if (confirmPatternResult && confirmPatternResult.pattern === 'inline' && confirmPatternResult.node) {
    ctx.timings.confirmFindMs = confirmFindTotal;
    ctx.confirmPattern = 'inline';
    const inlineNode = confirmPatternResult.node;
    const inlineToken = confirmPatternResult.token || null;
    const inlineText = confirmPatternResult.text || null;
    const inlineGetter = () => {
      if (inlineNode && inlineNode.isConnected) {
        return inlineNode;
      }
      const scope = menuRootNode && menuRootNode.isConnected ? menuRootNode : document;
      const items = collectMenuItems(scope);
      for (const node of items) {
        if (!isNodeEnabled(node) || !isNodeVisible(node)) {
          continue;
        }
        const text = readNormalized(node);
        const ariaRaw = node && typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : '';
        const ariaNormalized = typeof ariaRaw === 'string' ? ariaRaw.trim().toLowerCase() : '';
        if (inlineToken) {
          if (text.includes(inlineToken) || ariaNormalized.includes(inlineToken)) {
            return node;
          }
        } else if (inlineText && text === inlineText) {
          return node;
        }
      }
      return null;
    };
    const confirmActionStarted = Date.now();
    const inlineResult = await clickAndWait(inlineGetter, { timeoutMs: 1200 });
    const confirmElapsed = Date.now() - confirmActionStarted;
    ctx.timings.confirmMs = confirmElapsed;
    ctx.timings.confirmClickMs = confirmElapsed;
    debug.confirmActionMs = confirmElapsed;
    ctx.confirmVia = 'inline_menu';
    debug.confirmVia = 'inline_menu';
    const inlineElement = inlineResult && inlineResult.element ? inlineResult.element : inlineGetter();
    debug.confirmButtonLabel = inlineElement ? readNormalized(inlineElement) : readNormalized(inlineNode);
    ctx.dialogSnapshot = [];
    ctx.dialogSnapshotCount = 0;
    debug.dialogSnapshotCount = 0;
    if (!inlineResult.ok) {
      ctx.reason = 'ui_click_failed';
      return finalize({ ok: false, reason: 'ui_click_failed', steps, debug, elapsedMs: Date.now() - startedAt });
    }
    steps.confirm = true;
    const totalElapsedInline = Date.now() - startedAt;
    debug.totalMs = totalElapsedInline;
    ctx.reason = 'ok';
    ctx.timings.totalUiMs = totalElapsedInline;
    CINFO('delete flow completed', { elapsedMs: totalElapsedInline, confirmVia: 'inline_menu' });
    return finalize({ ok: true, reason: 'ui_delete_ok', steps, debug, elapsedMs: totalElapsedInline });
  }

  debug.confirmPattern = 'modal';
  ctx.confirmPattern = 'modal';

  const dialogWaitStarted = Date.now();
  const dialog = await waitForConfirmDialogAppear(1200);
  const dialogElapsed = Date.now() - dialogWaitStarted;
  confirmFindTotal += dialogElapsed;
  ctx.timings.dialogMs = dialogElapsed;
  ctx.timings.confirmFindMs = confirmFindTotal;
  debug.dialogWaitMs = dialogElapsed;
  if (!dialog) {
    ctx.reason = 'confirm_dialog_not_found';
    ctx.dialogSnapshot = [];
    ctx.dialogSnapshotCount = 0;
    debug.dialogSnapshotCount = 0;
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
  ctx.timings.confirmClickMs = confirmElapsed;
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
  [
    'menuMs',
    'deleteMs',
    'dialogMs',
    'confirmMs',
    'totalUiMs',
    'menuRootFindMs',
    'deleteClickMs',
    'confirmFindMs',
    'confirmClickMs'
  ].forEach((key) => {
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
    confirmPattern: typeof source.confirmPattern === 'string' ? source.confirmPattern : null,
    menuRootStrategy: typeof source.menuRootStrategy === 'string' ? source.menuRootStrategy : null,
    menuRootSelectorMatched: typeof source.menuRootSelectorMatched === 'string' ? source.menuRootSelectorMatched : null,
    menuRootDistance: Number.isFinite(source.menuRootDistance) ? source.menuRootDistance : null,
    menuRootItemsCount: Number.isFinite(source.menuRootItemsCount) ? source.menuRootItemsCount : null,
    fallbackHeaderPath: Boolean(source.fallbackHeaderPath),
    deleteCandidatesTotal: Number.isFinite(source.deleteCandidatesTotal) ? source.deleteCandidatesTotal : null,
    deleteIgnoredByText: Array.isArray(source.deleteIgnoredByText) ? source.deleteIgnoredByText.slice(0, 10) : [],
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

function findHeaderMoreActionsButton() {
  const scopes = [];
  const mainHeader = document.querySelector('main header');
  if (mainHeader) {
    scopes.push(mainHeader);
  }
  const toolbar = document.querySelector('main [role="toolbar"]');
  if (toolbar && !scopes.includes(toolbar)) {
    scopes.push(toolbar);
  }
  const globalHeader = document.querySelector('header');
  if (globalHeader && !scopes.includes(globalHeader)) {
    scopes.push(globalHeader);
  }
  scopes.push(document);
  const seen = new Set();
  for (const scope of scopes) {
    for (const selector of HEADER_MENU_BUTTON_SELECTORS) {
      let nodes = [];
      try {
        nodes = Array.from(scope.querySelectorAll(selector));
      } catch (_error) {
        nodes = [];
      }
      for (const node of nodes) {
        if (!node || seen.has(node)) {
          continue;
        }
        seen.add(node);
        if (!isNodeEnabled(node) || !isNodeVisible(node)) {
          continue;
        }
        return node;
      }
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
