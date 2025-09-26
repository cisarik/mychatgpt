(function () {
  const READY_LOG_PREFIX = '[Cleaner][content] Active tab ready';
  const READY_TIMEOUT_MS = 8000;

  logReady();
  hookHistory();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'RUN_CAPTURE_NOW') {
      return false;
    }
    (async () => {
      const payload = await extractFirstPair();
      if (!payload.convoId) {
        return { ok: false, error: 'missing_convo_id' };
      }
      if (payload.counts.user !== 1 || payload.counts.assistant !== 1) {
        return { ok: false, error: 'no_turns' };
      }
      return { ok: true, payload };
    })()
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error?.message || 'capture_error' }));
    return true;
  });

  async function extractFirstPair() {
    await waitForShell();
    const threadRoot = await waitForThread();
    const convoId = extractConvoId(location.href);
    const userNode = findFirst(threadRoot, (el) => getRole(el) === 'user');
    const assistantNode = findFirst(threadRoot, (el) => getRole(el) === 'assistant');
    const createdAt = resolveTimestamp(userNode) || resolveTimestamp(assistantNode) || new Date().toISOString();
    const userText = userNode ? normalizeWhitespace(userNode.textContent || '') : '';
    const assistantHTML = assistantNode ? serializeHtml(assistantNode) : '';
    return {
      convoId,
      createdAt,
      userText,
      assistantHTML,
      counts: {
        user: userNode ? 1 : 0,
        assistant: assistantNode ? 1 : 0
      }
    };
  }

  async function waitForShell() {
    if (document.readyState === 'complete') {
      return;
    }
    await new Promise((resolve) => {
      if (document.readyState === 'interactive') {
        resolve();
        return;
      }
      window.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
  }

  async function waitForThread() {
    const start = Date.now();
    while (Date.now() - start < READY_TIMEOUT_MS) {
      const found = findThreadRoot();
      if (found) {
        return found;
      }
      await delay(100);
    }
    throw new Error('thread_timeout');
  }

  function findThreadRoot() {
    const selectors = ['[data-testid="conversation-turns"]', 'main'];
    for (const selector of selectors) {
      const candidate = document.querySelector(selector);
      if (candidate) {
        return candidate;
      }
    }
    return document.body;
  }

  function findFirst(root, predicate) {
    const walker = createDeepWalker(root || document.body);
    let current = walker.next().value;
    while (current) {
      if (predicate(current)) {
        return current;
      }
      current = walker.next().value;
    }
    return null;
  }

  function* createDeepWalker(root) {
    if (!root) {
      return;
    }
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === Node.ELEMENT_NODE) {
        yield node;
        const shadow = node.shadowRoot;
        if (shadow) {
          stack.push(shadow);
        }
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          stack.push(node.children[i]);
        }
      } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        const childNodes = node.childNodes;
        for (let i = childNodes.length - 1; i >= 0; i -= 1) {
          stack.push(childNodes[i]);
        }
      }
    }
  }

  function getRole(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }
    const attr = element.getAttribute('data-message-author-role') || element.getAttribute('data-role');
    if (attr) {
      return attr;
    }
    if (element.matches('[data-testid="user-turn"], [data-testid="conversation-turn-user"]')) {
      return 'user';
    }
    if (element.matches('[data-testid="assistant-turn"], [data-testid="conversation-turn-assistant"]')) {
      return 'assistant';
    }
    return null;
  }

  function resolveTimestamp(element) {
    if (!element) {
      return null;
    }
    const attr =
      element.getAttribute('data-message-timestamp') ||
      element.getAttribute('data-timestamp') ||
      element.getAttribute('datetime');
    if (attr) {
      const parsed = Date.parse(attr);
      if (Number.isFinite(parsed)) {
        return new Date(parsed).toISOString();
      }
    }
    return null;
  }

  function serializeHtml(element) {
    const clone = element.cloneNode(true);
    const scripts = clone.querySelectorAll('script, style');
    scripts.forEach((node) => node.remove());
    return clone.innerHTML.trim();
  }

  function normalizeWhitespace(value) {
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function extractConvoId(url) {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/');
      const idx = parts.indexOf('c');
      if (idx >= 0 && parts[idx + 1]) {
        return parts[idx + 1];
      }
    } catch (_error) {
      // ignore
    }
    return null;
  }

  function logReady() {
    console.log(`${READY_LOG_PREFIX} ${location.href}`);
  }

  function hookHistory() {
    const wrap = (original) =>
      function wrapped(...args) {
        const result = original.apply(this, args);
        queueMicrotask(logReady);
        return result;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', () => logReady());
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
