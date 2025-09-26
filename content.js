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

  return undefined;
});
