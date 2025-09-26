(async () => {
  const utilsUrl = chrome.runtime.getURL('utils.js');
  const selectorsUrl = chrome.runtime.getURL('automation/selectors.js');
  const { sanitizeHTML, log, LogLevel, getConversationIdFromUrl } = await import(utilsUrl);

  try {
    await import(selectorsUrl);
  } catch (_error) {
    // Selektory sú best-effort; fallback riešenia nižšie.
  }

  const selectors = globalThis.RiskySelectors || {};
  const waitForAppShellFn = typeof selectors.waitForAppShell === 'function' ? selectors.waitForAppShell : null;
  const waitForConversationViewFn =
    typeof selectors.waitForConversationView === 'function' ? selectors.waitForConversationView : null;
  const queryAllDeepFn = typeof selectors.queryAllDeep === 'function' ? selectors.queryAllDeep : null;
  const selectorsSleep = typeof selectors.sleep === 'function' ? selectors.sleep : null;

  const observerConfig = { childList: true, subtree: true };
  let pending = false;
  let lastSignature = '';
  let initialReadySent = false;

  if (!isConversationPage()) {
    return;
  }

  await trySendCandidate('initial-load');
  void markActiveTabReady('initial-load');

  const root = getConversationRoot();
  if (root) {
    const observer = new MutationObserver(() => scheduleSend('mutation'));
    observer.observe(root, observerConfig);
  }

  if (typeof history.pushState === 'function') {
    const originalPushState = history.pushState.bind(history);
    history.pushState = function pushState(...args) {
      const result = originalPushState(...args);
      handleRouteChange('pushState');
      return result;
    };
  }

  if (typeof history.replaceState === 'function') {
    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = function replaceState(...args) {
      const result = originalReplaceState(...args);
      handleRouteChange('replaceState');
      return result;
    };
  }

  window.addEventListener('popstate', () => {
    handleRouteChange('popstate');
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
      return false;
    }
    if (message.type === 'RUN_CAPTURE_NOW') {
      void (async () => {
        try {
          const summary = await collectSummary();
          if (!summary) {
            sendResponse({ ok: false, error: 'summary_unavailable' });
            return;
          }
          await trySendCandidate('manual-scan', summary);
          sendResponse({ ok: true, summary });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || 'capture_failed' });
        }
      })();
      return true;
    }
    return false;
  });

  /** Slovensky: Zistí, či je stránka konverzácie. */
  function isConversationPage() {
    return Boolean(getConversationIdFromUrl(window.location.href));
  }

  /** Slovensky: Odošle signál o pripravenosti aktívneho tabu. */
  async function markActiveTabReady(reason) {
    if (reason === 'initial-load') {
      if (initialReadySent) {
        return;
      }
      initialReadySent = true;
    }
    console.log('[Cleaner][content] Active tab ready', { href: window.location.href, reason });
    try {
      await chrome.runtime.sendMessage({ type: 'ACTIVE_TAB_READY', reason });
    } catch (_error) {
      // Background service worker môže spať; ignorujeme.
    }
  }

  /** Slovensky: Spracuje zmenu trasy SPA aplikácie. */
  function handleRouteChange(reason) {
    lastSignature = '';
    scheduleSend(reason);
    void markActiveTabReady(reason);
  }

  /** Slovensky: Nájde koreňový uzol konverzácie. */
  function getConversationRoot() {
    return document.querySelector('[data-testid="conversation-main"]') || document.body;
  }

  /** Slovensky: Naplánuje odoslanie kandidáta s debounce. */
  function scheduleSend(reason) {
    if (pending) {
      return;
    }
    pending = true;
    setTimeout(() => {
      pending = false;
      void trySendCandidate(reason);
    }, 1200);
  }

  /** Slovensky: Pokúsi sa odoslať zachytený sumár. */
  async function trySendCandidate(reason, preCollected = null) {
    try {
      const summary = preCollected || (await collectSummary());
      if (!summary) {
        return null;
      }
      const signature = JSON.stringify([
        summary.convoId,
        summary.userPromptText,
        summary.assistantHTML,
        summary.counts?.user || 0,
        summary.counts?.assistant || 0,
        summary.meta?.streamIncomplete ? 1 : 0
      ]);
      if (signature === lastSignature) {
        return summary;
      }
      lastSignature = signature;
      await chrome.runtime.sendMessage({ type: 'CANDIDATE_CONVERSATION', payload: summary, reason });
      await log(LogLevel.INFO, 'content', 'Sent candidate', { convoId: summary.convoId, reason });
      return summary;
    } catch (error) {
      await log(LogLevel.ERROR, 'content', 'Capture failed', { message: error?.message });
      return null;
    }
  }

  /** Slovensky: Získa sumár prvých turnov. */
  async function collectSummary() {
    const convoId = getConversationIdFromUrl(window.location.href);
    if (!convoId) {
      return null;
    }
    await ensureConversationReady();
    const pair = await extractFirstPair({ timeoutMs: 6000 });
    if (!pair || !pair.userTurn || !pair.userText || !pair.assistantHTML) {
      return null;
    }
    const createdAt = readTurnTimestamp(pair.userTurn);
    const counts = {
      user: Number.isFinite(pair.counts?.user) ? pair.counts.user : 0,
      assistant: Number.isFinite(pair.counts?.assistant) ? pair.counts.assistant : 0
    };
    const meta = {};
    const turnsTotal = counts.user + counts.assistant;
    if (turnsTotal > 0) {
      meta.messageCountsApprox = turnsTotal;
    }
    if (pair.streamIncomplete) {
      meta.streamIncomplete = true;
    }
    return {
      convoId,
      url: window.location.href,
      createdAt,
      capturedAt: Date.now(),
      userPromptText: pair.userText,
      assistantHTML: pair.assistantHTML,
      counts,
      meta
    };
  }

  /** Slovensky: Počká na mount aplikácie. */
  async function ensureConversationReady() {
    if (waitForAppShellFn) {
      try {
        await waitForAppShellFn({ timeoutMs: 4000 });
      } catch (_error) {
        // fallback
      }
    }
    if (waitForConversationViewFn) {
      try {
        await waitForConversationViewFn({ timeoutMs: 4000 });
      } catch (_error) {
        // fallback
      }
    }
  }

  /** Slovensky: Vyextrahuje prvú dvojicu user/assistant z hlavného pohľadu. */
  async function extractFirstPair({ timeoutMs = 6000 } = {}) {
    const view = await resolveConversationView();
    if (!view) {
      return null;
    }
    const settleMs = 360;
    const pollMs = 140;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let latest = null;
    let lastSignature = '';
    let stableSince = Date.now();

    while (Date.now() <= deadline) {
      const snapshot = readFirstPairSnapshot(view);
      if (!snapshot || !snapshot.userTurn) {
        await waitDelay(pollMs);
        continue;
      }
      latest = snapshot;
      if (!snapshot.assistantHTML) {
        stableSince = Date.now();
        await waitDelay(pollMs);
        continue;
      }
      if (snapshot.signature !== lastSignature) {
        lastSignature = snapshot.signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= settleMs) {
        snapshot.streamIncomplete = false;
        return snapshot;
      }
      await waitDelay(pollMs);
    }

    return latest;
  }

  /** Slovensky: Určí hlavný kontajner konverzácie. */
  async function resolveConversationView() {
    if (waitForConversationViewFn) {
      try {
        const element = await waitForConversationViewFn({ timeoutMs: 4000 });
        if (element instanceof Element) {
          return element;
        }
      } catch (_error) {
        // Fallback nižšie.
      }
    }
    return document.querySelector('[data-testid="conversation-main"]') || document.body;
  }

  /** Slovensky: Prečíta aktuálnu prvú dvojicu turnov. */
  function readFirstPairSnapshot(view) {
    const turns = collectTurnCandidates(view);
    if (!turns.length) {
      return null;
    }
    let userTurn = null;
    let assistantTurn = null;
    for (const turn of turns) {
      const role = getTurnRole(turn);
      if (role === 'user' && !userTurn) {
        if (isValidTurn(turn, role)) {
          const text = readTurnText(turn);
          if (text) {
            userTurn = turn;
          }
        }
      } else if (role === 'assistant' && userTurn && !assistantTurn) {
        if (isValidTurn(turn, role)) {
          assistantTurn = turn;
        }
      }
      if (userTurn && assistantTurn) {
        break;
      }
    }
    if (!userTurn) {
      return null;
    }
    const userText = readTurnText(userTurn);
    const assistantContent = assistantTurn ? readAssistantContent(assistantTurn) : null;
    const assistantHTML = assistantContent?.html ? sanitizeHTML(assistantContent.html) : '';
    const assistantText = assistantContent?.text || '';
    const counts = {
      user: userText ? 1 : 0,
      assistant: assistantHTML ? 1 : 0
    };
    return {
      userTurn,
      assistantTurn,
      userText,
      assistantHTML,
      assistantText,
      counts,
      signature: `${assistantText.length}:${assistantHTML.length}`,
      streamIncomplete: true
    };
  }

  /** Slovensky: Zoženie kandidátov na turny len z hlavného pohľadu. */
  function collectTurnCandidates(view) {
    const seen = new Set();
    const result = [];
    const selectors = ['[data-testid*="conversation-turn" i]', '[data-message-author-role]'];
    for (const selector of selectors) {
      const matches = safeQueryAllDeep(selector, view);
      for (const node of matches) {
        if (!(node instanceof Element)) {
          continue;
        }
        let element = node;
        if (!hasTurnMarker(element)) {
          element = element.closest('[data-message-author-role], [data-testid*="conversation-turn" i]') || element;
        }
        if (!(element instanceof Element)) {
          continue;
        }
        if (seen.has(element)) {
          continue;
        }
        if (!view.contains(element)) {
          continue;
        }
        seen.add(element);
        result.push(element);
      }
    }
    result.sort((a, b) => {
      if (a === b) {
        return 0;
      }
      const position = a.compareDocumentPosition(b);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      return 0;
    });
    return result;
  }

  /** Slovensky: Zistí, či ide o relevantný turn. */
  function isValidTurn(node, role) {
    if (!(node instanceof Element)) {
      return false;
    }
    if (!isElementVisible(node)) {
      return false;
    }
    if (isIgnoredContainer(node)) {
      return false;
    }
    if (role === 'user') {
      return Boolean(readTurnText(node));
    }
    if (role === 'assistant') {
      const content = readAssistantContent(node);
      return Boolean(content?.text?.trim());
    }
    return false;
  }

  /** Slovensky: Zistí, či je element viditeľný. */
  function isElementVisible(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    if (!node.isConnected) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    const opacity = Number.parseFloat(style.opacity || '1');
    if (Number.isFinite(opacity) && opacity === 0) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Slovensky: Filtruje bannery, návrhy a nástroje. */
  function isIgnoredContainer(node) {
    if (!(node instanceof Element)) {
      return true;
    }
    const testId = (node.getAttribute('data-testid') || '').toLowerCase();
    if (testId.includes('suggest') || testId.includes('banner') || testId.includes('toast')) {
      return true;
    }
    if (node.closest('[data-testid*="suggest" i]')) {
      return true;
    }
    if (node.closest('[data-testid*="banner" i]')) {
      return true;
    }
    if (node.closest('[data-testid*="toast" i]')) {
      return true;
    }
    if (node.matches('[data-message-author-role="tool"], [data-message-author-role="system"]')) {
      return true;
    }
    if (node.querySelector('[data-message-author-role="tool"]')) {
      return true;
    }
    if (node.querySelector('[data-testid*="add-to-project" i]')) {
      return true;
    }
    return false;
  }

  /** Slovensky: Bezpečne čaká daný čas. */
  async function waitDelay(ms) {
    if (selectorsSleep) {
      await selectorsSleep(ms);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  /** Slovensky: Overí, či uzol vyzerá ako turn. */
  function hasTurnMarker(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    return (
      node.hasAttribute('data-message-author-role') ||
      (node.getAttribute('data-testid') || '').toLowerCase().includes('conversation-turn')
    );
  }

  /** Slovensky: Vráti rolu turnu. */
  function getTurnRole(turn) {
    if (!(turn instanceof Element)) {
      return '';
    }
    const direct = turn.getAttribute('data-message-author-role');
    if (direct) {
      return direct;
    }
    const nested = safeQueryAllDeep('[data-message-author-role]', turn).find((node) =>
      node instanceof Element && node.getAttribute('data-message-author-role')
    );
    if (nested) {
      return nested.getAttribute('data-message-author-role') || '';
    }
    const testId = (turn.getAttribute('data-testid') || '').toLowerCase();
    if (testId.includes('user')) {
      return 'user';
    }
    if (testId.includes('assistant')) {
      return 'assistant';
    }
    return '';
  }

  /** Slovensky: Prečíta text z uvedeného turnu. */
  function readTurnText(turn) {
    const target = findMessageContent(turn) || turn;
    return (target.textContent || '').trim();
  }

  /** Slovensky: Prečíta html a text asistenta. */
  function readAssistantContent(turn) {
    const target = findMessageContent(turn) || turn;
    return {
      html: serializeNode(target),
      text: (target.textContent || '').trim()
    };
  }

  /** Slovensky: Prečíta HTML odpovede asistenta. */
  function readAssistantHtml(turn) {
    return readAssistantContent(turn).html;
  }

  /** Slovensky: Získa časovú známku z turnu. */
  function readTurnTimestamp(turn) {
    const timeEl = safeQueryAllDeep('time', turn)[0] || null;
    if (timeEl?.dateTime) {
      const parsed = Date.parse(timeEl.dateTime);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return Date.now();
  }

  /** Slovensky: Nájde kontajner obsahu správy. */
  function findMessageContent(root) {
    if (!(root instanceof Element)) {
      return null;
    }
    if (root.getAttribute('data-message-content') === 'true') {
      return root;
    }
    const deep = safeQueryAllDeep('[data-message-content="true"]', root).find((node) => node instanceof Element);
    return deep || null;
  }

  /** Slovensky: Serializuje uzol vrátane shadow DOM. */
  function serializeNode(node) {
    if (!(node instanceof Element)) {
      return '';
    }
    if (node.shadowRoot) {
      return Array.from(node.shadowRoot.childNodes)
        .map((child) => serializeChild(child))
        .join('');
    }
    return node.innerHTML || '';
  }

  /** Slovensky: Serializuje dieťa uzla. */
  function serializeChild(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = /** @type {Element} */ (node);
      return element.outerHTML || '';
    }
    return node.textContent || '';
  }

  /** Slovensky: Bezpečná deep query cez shadow DOM. */
  function safeQueryAllDeep(selector, root = document) {
    if (queryAllDeepFn) {
      try {
        return queryAllDeepFn(root, selector);
      } catch (_error) {
        return [];
      }
    }
    if (root instanceof Element || root instanceof Document || root instanceof DocumentFragment) {
      return Array.from(root.querySelectorAll(selector));
    }
    return [];
  }
})();
