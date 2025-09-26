(async () => {
  const moduleUrl = chrome.runtime.getURL('utils.js');
  const { sanitizeHTML, log, LogLevel, getConversationIdFromUrl } = await import(moduleUrl);

  const observerConfig = { childList: true, subtree: true };
  let pending = false;
  let lastSignature = '';
  let readySignalSent = false;

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

  window.addEventListener('popstate', () => {
    lastSignature = '';
    scheduleSend('history-change');
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
      return false;
    }
    if (message.type === 'RUN_CAPTURE_NOW') {
      void trySendCandidate('manual-scan').then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
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
    if (readySignalSent) {
      return;
    }
    readySignalSent = true;
    try {
      await chrome.runtime.sendMessage({ type: 'ACTIVE_TAB_READY', reason });
    } catch (_error) {
      // Background service worker môže spať; ignorujeme.
    }
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
  async function trySendCandidate(reason) {
    try {
      const summary = extractSummary();
      if (!summary) {
        return;
      }
      const signature = JSON.stringify([summary.convoId, summary.userPrompt, summary.answerHTML, summary.messageCount]);
      if (signature === lastSignature) {
        return;
      }
      lastSignature = signature;
      await chrome.runtime.sendMessage({ type: 'CANDIDATE_CONVERSATION', payload: summary, reason });
      await log(LogLevel.INFO, 'content', 'Sent candidate', { convoId: summary.convoId, reason });
    } catch (error) {
      await log(LogLevel.ERROR, 'content', 'Capture failed', { message: error?.message });
    }
  }

  /** Slovensky: Vyberie prvý užívateľský a asistenčný turn. */
  function extractSummary() {
    const convoId = getConversationIdFromUrl(window.location.href);
    if (!convoId) {
      return null;
    }
    const rootNode = getConversationRoot();
    if (!rootNode) {
      return null;
    }
    const turns = Array.from(rootNode.querySelectorAll('[data-testid="conversation-turn"]'));
    if (!turns.length) {
      return null;
    }
    const userTurn = turns.find((turn) => turn.getAttribute('data-message-author-role') === 'user');
    const assistantTurn = turns.find((turn) => turn.getAttribute('data-message-author-role') === 'assistant');
    if (!userTurn || !assistantTurn) {
      return null;
    }
    const userPrompt = readTurnText(userTurn);
    const answerHTML = sanitizeHTML(readAssistantHtml(assistantTurn));
    if (!userPrompt || !answerHTML) {
      return null;
    }
    return {
      convoId,
      url: window.location.href,
      userPrompt,
      answerHTML,
      firstAnswerHTML: answerHTML,
      createdAt: readTurnTimestamp(userTurn),
      capturedAt: Date.now(),
      messageCount: turns.length
    };
  }

  /** Slovensky: Prečíta text z uvedeného turnu. */
  function readTurnText(turn) {
    const target = turn.querySelector('[data-message-content="true"]') || turn;
    return (target.textContent || '').trim();
  }

  /** Slovensky: Prečíta HTML odpovede asistenta. */
  function readAssistantHtml(turn) {
    const target = turn.querySelector('[data-message-content="true"]') || turn;
    const html = target.innerHTML || '';
    return stripUnsafe(html);
  }

  /** Slovensky: Získa časovú známku z turnu. */
  function readTurnTimestamp(turn) {
    const timeEl = turn.querySelector('time');
    if (timeEl?.dateTime) {
      const parsed = Date.parse(timeEl.dateTime);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return Date.now();
  }

  /** Slovensky: Odstráni rizikové skripty z HTML. */
  function stripUnsafe(html) {
    return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/on\w+\s*=\s*"[^"]*"/gi, '');
  }
})();
