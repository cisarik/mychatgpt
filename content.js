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
        summary.meta?.messageCountsApprox || 0,
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
    const turns = await waitForFirstTurns({ timeoutMs: 6000 });
    if (!turns?.userTurn || !turns?.assistantTurn) {
      return null;
    }
    const userPromptText = readTurnText(turns.userTurn);
    const assistantRawHtml = turns.assistantHtml || readAssistantHtml(turns.assistantTurn);
    const assistantHTML = sanitizeHTML(assistantRawHtml);
    if (!userPromptText || !assistantHTML) {
      return null;
    }
    const createdAt = readTurnTimestamp(turns.userTurn);
    const meta = {
      messageCountsApprox: Number.isFinite(turns.messageCountsApprox) ? turns.messageCountsApprox : undefined,
      streamIncomplete: turns.streamIncomplete || undefined
    };
    if (!meta.streamIncomplete) {
      delete meta.streamIncomplete;
    }
    if (meta.messageCountsApprox === undefined) {
      delete meta.messageCountsApprox;
    }
    return {
      convoId,
      url: window.location.href,
      createdAt,
      capturedAt: Date.now(),
      userPromptText,
      assistantHTML,
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

  /** Slovensky: Čaká na prvý užívateľský a asistenčný turn. */
  async function waitForFirstTurns({ timeoutMs = 6000 } = {}) {
    const settleMs = 360;
    const pollMs = 140;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let lastSignature = '';
    let stableSince = Date.now();
    let latest = null;

    while (Date.now() <= deadline) {
      const turns = getConversationTurns();
      const userTurn = turns.find((turn) => getTurnRole(turn) === 'user');
      const assistantTurn = turns.find((turn) => getTurnRole(turn) === 'assistant');
      if (userTurn && assistantTurn) {
        const userText = readTurnText(userTurn);
        const assistantContent = readAssistantContent(assistantTurn);
        if (userText && assistantContent.text) {
          const candidate = {
            userTurn,
            assistantTurn,
            userText,
            assistantHtml: assistantContent.html,
            assistantText: assistantContent.text,
            messageCountsApprox: turns.length,
            streamIncomplete: true
          };
          latest = candidate;
          const signature = `${assistantContent.text.length}:${assistantContent.html.length}`;
          if (signature !== lastSignature) {
            lastSignature = signature;
            stableSince = Date.now();
          } else if (Date.now() - stableSince >= settleMs) {
            candidate.streamIncomplete = false;
            return candidate;
          }
        }
      }
      await waitDelay(pollMs);
    }

    return latest || {
      userTurn: null,
      assistantTurn: null,
      assistantHtml: '',
      assistantText: '',
      messageCountsApprox: 0,
      streamIncomplete: true
    };
  }

  /** Slovensky: Bezpečne čaká daný čas. */
  async function waitDelay(ms) {
    if (selectorsSleep) {
      await selectorsSleep(ms);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  /** Slovensky: Získa zoznam turnov naprieč shadow DOM. */
  function getConversationTurns() {
    const seen = new Set();
    const result = [];
    const candidates = [
      ...safeQueryAllDeep('[data-testid*="conversation-turn" i]'),
      ...safeQueryAllDeep('[data-message-author-role]')
    ];
    for (const node of candidates) {
      if (!(node instanceof Element)) {
        continue;
      }
      let element = node;
      if (!hasTurnMarker(element)) {
        element = element.closest('[data-message-author-role], [data-testid*="conversation-turn" i]') || element;
      }
      if (element instanceof Element && !seen.has(element)) {
        seen.add(element);
        result.push(element);
      }
    }
    return result;
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
