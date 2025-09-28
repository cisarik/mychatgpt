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
async function executeMenuDeletionSteps(baseSteps = {}) {
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

  const beforeMenuItems = countMenuItems();
  debug.menuItemsBefore = beforeMenuItems;

  const menuButton = findMoreActionsButton();
  if (!menuButton) {
    CWARN('menu_not_found', { phase: 'more_actions_button' });
    return { ok: false, reason: 'menu_not_found', steps, debug, elapsedMs: Date.now() - startedAt };
  }

  const menuClickStarted = Date.now();
  const menuClick = await clickAndWait(() => menuButton, { timeoutMs: 1000 });
  const menuClickElapsed = Date.now() - menuClickStarted;
  debug.menuClickMs = menuClickElapsed;
  debug.menuClickOk = Boolean(menuClick.ok);
  debug.menuItemsAfterMenuClick = countMenuItems();
  CDBG('click menu button', { elapsedMs: menuClickElapsed, ok: menuClick.ok, items: debug.menuItemsAfterMenuClick });
  if (!menuClick.ok) {
    return { ok: false, reason: 'ui_click_failed', steps, debug, elapsedMs: Date.now() - startedAt };
  }
  steps.menu = true;

  const containers = collectMenuContainers();
  const firstContainer = containers.length ? containers[0] : null;
  debug.menuContainerRole = firstContainer && firstContainer.getAttribute ? firstContainer.getAttribute('role') || null : null;
  debug.menuContainerTestid = firstContainer && firstContainer.getAttribute ? firstContainer.getAttribute('data-testid') || null : null;
  const menuItemsCount = countMenuItems();
  debug.menuItems = menuItemsCount;
  CINFO('menu opened', { items: menuItemsCount, containerRole: debug.menuContainerRole, elapsedMs: menuClickElapsed });

  CDBG('probing delete selectors', [...DELETE_SELECTORS]);
  const resolution = resolveDeleteMenuItem();
  debug.selectorsTried = resolution.selectorsTried || [...DELETE_SELECTORS];
  debug.menuSnapshotCount = Number.isFinite(resolution.menuSnapshotCount)
    ? resolution.menuSnapshotCount
    : menuItemsCount;

  if (!resolution.node) {
    const snapshot = dumpMenuSnapshot();
    const limited = snapshot.slice(0, 25);
    debug.snapshot = limited;
    debug.menuSnapshotCount = snapshot.length;
    CERR('delete_item_not_found', { selectorsTried: [...DELETE_SELECTORS], snapshot: limited });
    return {
      ok: false,
      reason: 'delete_item_not_found',
      steps,
      debug,
      elapsedMs: Date.now() - startedAt
    };
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
  CDBG('click delete item', {
    selector: resolution.selector || null,
    strategy: resolution.strategy || null,
    elapsedMs: deleteElapsed,
    ok: itemResult.ok
  });
  if (!itemResult.ok) {
    const reason = itemResult.element ? 'ui_click_failed' : 'ui_click_failed';
    return { ok: false, reason, steps, debug, elapsedMs: Date.now() - startedAt };
  }
  steps.item = true;

  const confirmClickStarted = Date.now();
  const confirmResult = await clickAndWait(() => findDeleteConfirmButton(), { timeoutMs: 2500 });
  const confirmElapsed = Date.now() - confirmClickStarted;
  debug.confirmClickMs = confirmElapsed;
  debug.confirmClickOk = Boolean(confirmResult.ok);
  CDBG('click confirm delete', { elapsedMs: confirmElapsed, ok: confirmResult.ok });
  if (!confirmResult.ok) {
    const reason = confirmResult.element ? 'ui_click_failed' : 'confirm_dialog_not_found';
    if (reason === 'confirm_dialog_not_found') {
      CWARN('confirm_dialog_not_found', { elapsedMs: confirmElapsed });
    }
    return { ok: false, reason, steps, debug, elapsedMs: Date.now() - startedAt };
  }
  steps.confirm = true;
  debug.confirmButtonLabel = confirmResult.element ? readNormalized(confirmResult.element) : null;

  const totalElapsed = Date.now() - startedAt;
  debug.totalMs = totalElapsed;
  CINFO('delete flow completed', { elapsedMs: totalElapsed });
  return { ok: true, reason: 'ui_delete_ok', steps, debug, elapsedMs: totalElapsed };
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

  if (message.type === 'ui_delete_by_title') {
    (async () => {
      const rawTitle = typeof message.title === 'string' ? message.title : '';
      const altInputs = Array.isArray(message.alternatives) ? message.alternatives : [];
      const steps = { sidebar: false, select: false, menu: false, item: false, confirm: false };
      const startedAt = Date.now();
      const normalizedTargets = [];
      const seen = new Set();
      const targetMeta = new Map();
      const respond = (payload) => {
        const baseSteps = payload && payload.steps ? payload.steps : steps;
        const response = {
          ok: false,
          steps: {
            sidebar: Boolean(baseSteps.sidebar),
            select: Boolean(baseSteps.select),
            menu: Boolean(baseSteps.menu),
            item: Boolean(baseSteps.item),
            confirm: Boolean(baseSteps.confirm)
          },
          matchSource: matchSource || null,
          ts: Date.now(),
          ...payload
        };
        if (!('matchSource' in payload)) {
          response.matchSource = matchSource || null;
        }
        if (typeof response.elapsedMs !== 'number') {
          response.elapsedMs = Date.now() - startedAt;
        }
        sendResponse(response);
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
            respond({ ok: false, reason, steps });
            return;
          }
          steps.sidebar = true;
          const { node: conversationNode, matchSource: nodeMatchSource } = findConversationNodeByTitles(normalizedTargets, targetMeta);
          if (nodeMatchSource) {
            matchSource = nodeMatchSource;
          }
          if (!conversationNode) {
            respond({ ok: false, reason: 'convo_not_found', steps });
            return;
          }
          const selectResult = await clickAndWait(() => conversationNode, { timeoutMs: 2000 });
          if (!selectResult.ok) {
            respond({ ok: false, reason: 'ui_click_failed', steps });
            return;
          }
          steps.select = true;
          const loaded = await waitForDocumentTitleMatch(normalizedTargets, 3600);
          if (!loaded) {
            respond({ ok: false, reason: 'select_load_timeout', steps });
            return;
          }
          const postLoadMatch = resolveMatchSource(getDocumentConversationTitle(), normalizedTargets, targetMeta);
          if (postLoadMatch) {
            matchSource = postLoadMatch;
          }
        } else {
          steps.select = true;
          if (isSidebarVisible()) {
            steps.sidebar = true;
          }
          const activeSource = resolveMatchSource(currentTitle, normalizedTargets, targetMeta);
          if (activeSource) {
            matchSource = activeSource;
          }
        }

        const result = await executeMenuDeletionSteps(steps);
        respond({
          ok: result.ok,
          reason: result.reason,
          steps: result.steps,
          matchSource: matchSource || null,
          debug: result.debug || null,
          elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : undefined
        });
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
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
      try {
        const result = await executeMenuDeletionSteps(steps);
        sendResponse({
          ok: result.ok,
          reason: result.reason,
          steps: result.steps,
          debug: result.debug || null,
          ts: Date.now(),
          elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : Date.now() - startedAt
        });
      } catch (error) {
        const messageText = error && error.message ? error.message : String(error);
        sendResponse({
          ok: false,
          reason: 'ui_click_failed',
          steps,
          error: messageText,
          ts: Date.now(),
          elapsedMs: Date.now() - startedAt
        });
      }
    })();
    return true;
  }

  return undefined;
});
