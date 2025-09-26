(async () => {
  const moduleUrl = chrome.runtime.getURL('utils.js');
  const { sanitizeHTML, log, LogLevel, getConversationIdFromUrl } = await import(moduleUrl);

  const observerConfig = { childList: true, subtree: true }; // Slovensky: Sleduje zmeny v rozhovore.
  let pending = false;
  let lastSignature = '';

  if (!isConversationPage()) {
    return;
  }

  await trySendCandidate('initial');

  const root = getConversationRoot();
  if (root) {
    const observer = new MutationObserver(() => scheduleSend('mutation'));
    observer.observe(root, observerConfig);
  }
  window.addEventListener('popstate', () => {
    lastSignature = '';
    scheduleSend('nav_popstate');
  });

  function isConversationPage() {
    return Boolean(getConversationIdFromUrl(window.location.href));
  }

  function getConversationRoot() {
    return document.querySelector('[data-testid="conversation-main"]') || document.body;
  }

  function scheduleSend(reason) {
    if (pending) {
      return;
    }
    pending = true;
    setTimeout(() => {
      pending = false;
      void trySendCandidate(reason);
    }, 800);
  }

  async function trySendCandidate(reason) {
    try {
      const summary = extractSummary();
      if (!summary) {
        return;
      }
      const signature = JSON.stringify([summary.convoId, summary.userPrompt, summary.firstAnswerHTML, summary.messageCount]);
      if (signature === lastSignature) {
        return;
      }
      lastSignature = signature;
      await chrome.runtime.sendMessage({ type: 'CANDIDATE_CONVERSATION', payload: summary, reason });
      await log(LogLevel.INFO, 'content', 'Sent candidate', { convoId: summary.convoId, reason });
    } catch (error) {
      await log(LogLevel.ERROR, 'content', 'Candidate send failed', { message: error?.message });
    }
  }

  function extractSummary() {
    const convoId = getConversationIdFromUrl(window.location.href);
    if (!convoId) {
      return null;
    }
    const root = getConversationRoot();
    if (!root) {
      return null;
    }
    const turns = Array.from(root.querySelectorAll('[data-testid="conversation-turn"]'));
    if (!turns.length) {
      return null;
    }
    const userTurn = turns.find((turn) => turn.getAttribute('data-message-author-role') === 'user');
    const assistantTurn = turns.find((turn) => turn.getAttribute('data-message-author-role') === 'assistant');
    if (!userTurn || !assistantTurn) {
      return null;
    }
    const userPrompt = readTurnText(userTurn);
    const firstAnswerHTML = readAssistantHtml(assistantTurn);
    if (!userPrompt || !firstAnswerHTML) {
      return null;
    }
    return {
      convoId,
      url: window.location.href,
      userPrompt,
      firstAnswerHTML: sanitizeHTML(firstAnswerHTML),
      createdAt: readTurnTimestamp(userTurn),
      capturedAt: Date.now(),
      messageCount: turns.length
    };
  }

  function readTurnText(turn) {
    const target = turn.querySelector('[data-message-content="true"]') || turn;
    return (target.textContent || '').trim();
  }

  function readAssistantHtml(turn) {
    const target = turn.querySelector('[data-message-content="true"]') || turn;
    return target.innerHTML || '';
  }

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
})();

