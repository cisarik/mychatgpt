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

  return undefined;
});
