(function () {
  if (window.__MYCHAT_CAPTURE__) {
    return;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForMain(timeout = 8000) {
    const start = Date.now();
    let main = document.querySelector('main,[role="main"]');
    while (!main) {
      if (Date.now() - start > timeout) {
        throw new Error('main_timeout');
      }
      await sleep(120);
      main = document.querySelector('main,[role="main"]');
    }
    return main;
  }

  function getConvoIdFromUrl(href = location.href) {
    const match = href.match(/\/c\/([a-f0-9-]{10,})/i);
    return match ? match[1] : null;
  }

  function textFromNode(node) {
    if (!node) {
      return '';
    }
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    let out = '';
    while (walker.nextNode()) {
      out += walker.currentNode.nodeValue;
    }
    return out.trim();
  }

  function sanitizeHtml(node) {
    if (!node) {
      return '';
    }
    const clone = node.cloneNode(true);
    clone.querySelectorAll('script,style').forEach((el) => el.remove());
    clone.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return clone.innerHTML;
  }

  function detectAuthor(node) {
    if (!node) {
      return null;
    }
    const attr = node.getAttribute?.('data-message-author') || node.dataset?.messageAuthor;
    if (attr) {
      return attr.toLowerCase();
    }
    if (node.dataset?.testid) {
      if (/assistant/i.test(node.dataset.testid)) {
        return 'assistant';
      }
      if (/user/i.test(node.dataset.testid)) {
        return 'user';
      }
    }
    const role = node.getAttribute?.('data-testid') || '';
    if (/assistant/i.test(role)) {
      return 'assistant';
    }
    if (/user/i.test(role)) {
      return 'user';
    }
    return null;
  }

  function collectMessages(main) {
    return Array.from(
      main.querySelectorAll('[data-message-author], [data-testid*="message"], article')
    ).filter((node) => detectAuthor(node));
  }

  function countTurns(main) {
    const messages = collectMessages(main);
    let user = 0;
    let assistant = 0;
    for (const node of messages) {
      const author = detectAuthor(node);
      if (author === 'user') {
        user += 1;
      } else if (author === 'assistant') {
        assistant += 1;
      }
    }
    return { user, assistant };
  }

  async function extractFirstPair(timeout = 8000) {
    const main = await waitForMain(timeout);
    const convoId = getConvoIdFromUrl();
    if (!convoId) {
      throw new Error('not_conversation_url');
    }

    const messages = collectMessages(main);
    let userNode = null;
    let assistantNode = null;
    for (const node of messages) {
      const author = detectAuthor(node);
      if (!userNode && author === 'user') {
        userNode = node;
        continue;
      }
      if (userNode && author === 'assistant') {
        assistantNode = node;
        break;
      }
    }

    if (!userNode && messages.length) {
      userNode = messages[0];
    }
    if (!assistantNode) {
      assistantNode = messages.find((node) => detectAuthor(node) === 'assistant') || null;
    }

    const userText = userNode ? textFromNode(userNode).slice(0, 4000) : '';
    const assistantHTML = assistantNode ? sanitizeHtml(assistantNode) : '';

    return {
      convoId,
      createdAt: Date.now(),
      userText,
      assistantHTML,
      counts: countTurns(main)
    };
  }

  async function captureNow() {
    const payload = await extractFirstPair();
    return { ok: true, payload };
  }

  window.__MYCHAT_CAPTURE__ = { captureNow, extractFirstPair };
})();
