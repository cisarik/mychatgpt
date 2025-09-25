(async () => {
  const { sanitizeHTML, logTrace, logDebug, logWarn, logError } = await import(
    chrome.runtime.getURL('utils.js')
  );

  const DEFAULT_DIAGNOSTICS = {
    TRACE_EXTRACTOR: false,
    REDACT_TEXT_IN_DIAGNOSTICS: true
  };

  const LOG_SCOPE = 'extractor';

  const BRIDGE_ALLOWED_ORIGIN = 'https://chatgpt.com';
  const BRIDGE_SOURCE = 'MYCHATGPT';
  const BRIDGE_REPLY_SOURCE = 'MYCHATGPT_BRIDGE';
  const BRIDGE_READY_EVENT = 'BRIDGE_READY';
  const BRIDGE_PATCH_RESULT = 'PATCH_RESULT';
  const BRIDGE_CONNECTIVITY_RESULT = 'CONNECTIVITY_RESULT';

  const BRIDGE_READY_FLAG = '__MYCHATGPT_BRIDGE_CONTENT_READY__';
  let bridgeReady = false;
  let ensureBridgePromise = null;
  const bridgeReadyWaiters = [];

  function isBridgeContext() {
    return window.top === window && window.location.origin === BRIDGE_ALLOWED_ORIGIN;
  }

  function notifyBridgeReady() {
    bridgeReady = true;
    while (bridgeReadyWaiters.length) {
      const waiter = bridgeReadyWaiters.shift();
      if (waiter) {
        waiter(true);
      }
    }
  }

  function waitForBridgeReady(timeoutMs = 2000) {
    if (bridgeReady) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      bridgeReadyWaiters.push((ready) => {
        clearTimeout(timer);
        resolve(Boolean(ready));
      });
    });
  }

  function postToBridge(type, payload) {
    if (!isBridgeContext()) {
      return;
    }
    window.postMessage({ source: BRIDGE_SOURCE, type, payload }, '*');
  }

  async function ensureBridgeInjected() {
    if (!isBridgeContext()) {
      return false;
    }
    if (bridgeReady) {
      return true;
    }
    if (ensureBridgePromise) {
      return ensureBridgePromise;
    }
    ensureBridgePromise = new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'CONTENT_ENSURE_BRIDGE' }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          console.warn('MyChatGPT bridge inject error', lastError);
          ensureBridgePromise = null;
          resolve(false);
          return;
        }
        if (!response?.ok) {
          ensureBridgePromise = null;
          resolve(false);
          return;
        }
        waitForBridgeReady().then((ready) => {
          ensureBridgePromise = null;
          resolve(ready);
        });
      });
    });
    return ensureBridgePromise;
  }

  function forwardBridgeResult(type, payload) {
    if (!payload || typeof payload.requestId === 'undefined') {
      return;
    }
    chrome.runtime.sendMessage({ type, requestId: payload.requestId, payload }, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError && lastError.message) {
        console.warn('MyChatGPT bridge relay error', lastError.message);
      }
    });
  }

  function handleBridgeMessage(event) {
    if (event.source !== window) {
      return;
    }
    if (event.origin !== BRIDGE_ALLOWED_ORIGIN) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== BRIDGE_REPLY_SOURCE) {
      return;
    }
    if (data.type === BRIDGE_READY_EVENT) {
      notifyBridgeReady();
      return;
    }
    if (data.type === BRIDGE_PATCH_RESULT) {
      forwardBridgeResult('PATCH_RESULT', data.payload || {});
      return;
    }
    if (data.type === BRIDGE_CONNECTIVITY_RESULT) {
      forwardBridgeResult('BRIDGE_CONNECTIVITY_RESULT', data.payload || {});
    }
  }

  if (isBridgeContext() && !window[BRIDGE_READY_FLAG]) {
    window[BRIDGE_READY_FLAG] = true;
    window.addEventListener('message', handleBridgeMessage);
    ensureBridgeInjected().catch(() => {});
  }

  const USER_STRATEGIES = [
    createSelectorStrategy('user.data-role', '[data-message-author-role="user"]'),
    createSelectorStrategy('user.turn-article', 'article[data-testid="conversation-turn"][data-message-author-role="user"]'),
    createSelectorStrategy('user.turn-div', 'div[data-testid="conversation-turn"][data-message-author-role="user"]'),
    createSelectorStrategy('user.bubble', '[data-testid="message-bubble-user"], [data-testid="user"]')
  ];

  const ASSISTANT_STRATEGIES = [
    createSelectorStrategy('assistant.data-role', '[data-message-author-role="assistant"]'),
    createSelectorStrategy(
      'assistant.turn-article',
      'article[data-testid="conversation-turn"][data-message-author-role="assistant"]'
    ),
    createSelectorStrategy(
      'assistant.turn-div',
      'div[data-testid="conversation-turn"][data-message-author-role="assistant"]'
    ),
    createSelectorStrategy('assistant.bubble', '[data-testid="message-bubble-assistant"], [data-testid="assistant"]')
  ];

  let diagnosticsSettings = { ...DEFAULT_DIAGNOSTICS };
  let settingsReady = false;
  let settingsPromise = null;

  async function ensureDiagnosticsSettings() {
    if (settingsReady) {
      return diagnosticsSettings;
    }
    if (settingsPromise) {
      await settingsPromise;
      return diagnosticsSettings;
    }
    settingsPromise = (async () => {
      try {
        const { settings } = await chrome.storage.local.get(['settings']);
        applyDiagnosticsSettings(settings);
      } catch (error) {
        logWarn(LOG_SCOPE, 'Failed to load diagnostics settings', { error: error?.message });
      } finally {
        settingsReady = true;
        settingsPromise = null;
      }
    })();
    await settingsPromise;
    return diagnosticsSettings;
  }

  function applyDiagnosticsSettings(rawSettings) {
    diagnosticsSettings = {
      ...DEFAULT_DIAGNOSTICS,
      ...(rawSettings || {})
    };
  }

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) {
        return;
      }
      applyDiagnosticsSettings(changes.settings.newValue);
      settingsReady = true;
    });
  }

  let lastExtraction = null;
  let inflightExtraction = null;
  let cacheTimer = null;

  async function ensureExtraction() {
    if (lastExtraction) {
      return lastExtraction;
    }
    if (inflightExtraction) {
      return inflightExtraction;
    }
    inflightExtraction = runExtractorPipeline();
    try {
      lastExtraction = await inflightExtraction;
      scheduleCacheInvalidation();
    } finally {
      inflightExtraction = null;
    }
    return lastExtraction;
  }

  function scheduleCacheInvalidation() {
    if (cacheTimer) {
      clearTimeout(cacheTimer);
    }
    cacheTimer = setTimeout(() => {
      lastExtraction = null;
      cacheTimer = null;
    }, 250);
  }

  async function runExtractorPipeline({ captureDetails = false } = {}) {
    const diag = await ensureDiagnosticsSettings();
    const traceEnabled = Boolean(diag.TRACE_EXTRACTOR);

    const context = {
      strategies: [],
      warnings: [],
      errors: []
    };

    const root = getRoot();

    let userBubble = null;
    let assistantBubble = null;

    try {
      const selection = selectBubbles(root, traceEnabled, context);
      userBubble = selection.userBubble;
      assistantBubble = selection.assistantBubble;
    } catch (error) {
      logError(LOG_SCOPE, 'select_bubbles failed', error, { phase: 'select_bubbles' });
      context.errors.push(buildError('select_bubbles', error));
    }

    let metaResult = buildMetaFallback();
    let timestampsDetected = false;
    try {
      const metaOutcome = extractMeta(root);
      metaResult = metaOutcome.meta;
      timestampsDetected = metaOutcome.timestampsDetected;
    } catch (error) {
      logError(LOG_SCOPE, 'extract_meta failed', error, { phase: 'extract_meta' });
      context.errors.push(buildError('extract_meta', error));
    }

    let qaResult = { questionText: '', answerHTML: '' };
    try {
      qaResult = extractQna(root, { userBubble, assistantBubble });
    } catch (error) {
      logError(LOG_SCOPE, 'extract_qna failed', error, { phase: 'extract_qna' });
      context.errors.push(buildError('extract_qna', error));
    }

    if (!userBubble) {
      context.warnings.push('user-bubble-missing');
    }
    if (!assistantBubble) {
      context.warnings.push('assistant-bubble-missing');
    }
    if (!timestampsDetected) {
      context.warnings.push('timestamp-missing');
    }

    const metaSummary = {
      messageCount: metaResult.messageCount ?? null,
      userMessageCount: metaResult.userMessageCount ?? null,
      lastMessageAgeMin: metaResult.lastMessageAgeMin ?? null,
      titlePresent: Boolean(metaResult.title),
      convoIdPresent: Boolean(metaResult.convoId)
    };

    logDebug(LOG_SCOPE, 'Extractor pipeline complete', {
      found: {
        userBubble: Boolean(userBubble),
        assistantBubble: Boolean(assistantBubble),
        timestamps: timestampsDetected
      },
      meta: metaSummary,
      warnings: context.warnings,
      errors: context.errors.map((item) => item.phase)
    });

    return {
      meta: metaResult,
      qa: qaResult,
      strategies: captureDetails ? context.strategies : [],
      warnings: context.warnings,
      errors: context.errors,
      found: {
        userBubble: Boolean(userBubble),
        assistantBubble: Boolean(assistantBubble),
        timestamps: timestampsDetected
      }
    };
  }

  function selectBubbles(root, traceEnabled, context) {
    const userSelection = applyStrategies('user', USER_STRATEGIES, root, traceEnabled, context);
    const assistantSelection = applyStrategies('assistant', ASSISTANT_STRATEGIES, root, traceEnabled, context);
    return {
      userBubble: userSelection.node,
      assistantBubble: assistantSelection.node
    };
  }

  function applyStrategies(role, strategies, root, traceEnabled, context) {
    for (const strategy of strategies) {
      let nodes = [];
      let visible = [];
      let node = null;
      try {
        nodes = Array.from(strategy.query(root));
        visible = filterVisible(nodes);
        node = visible.length ? visible[visible.length - 1] : null;
      } catch (error) {
        logError(LOG_SCOPE, `${role} strategy exception`, error, {
          phase: 'select_bubbles',
          strategy: strategy.name
        });
        context.errors.push(buildError('select_bubbles', error));
        continue;
      }
      const ok = Boolean(node);
      const details = {
        role,
        name: strategy.name,
        selector: strategy.selector || null,
        matches: nodes.length,
        visible: visible.length,
        ok
      };
      context.strategies.push({
        name: strategy.name,
        ok,
        details
      });
      if (traceEnabled) {
        logTrace(LOG_SCOPE, `Strategy ${strategy.name} (${role}) ${ok ? 'matched' : 'missed'}`, details);
      }
      if (ok) {
        return { node };
      }
    }
    return { node: null };
  }

  function createSelectorStrategy(name, selector) {
    return {
      name,
      selector,
      query(root) {
        return root.querySelectorAll(selector);
      }
    };
  }

  function extractMeta(root) {
    const nodes = Array.from(root.querySelectorAll('[data-message-author-role]'));
    const userNodes = nodes.filter((node) => node.getAttribute('data-message-author-role') === 'user');
    const lastNode = nodes.length ? nodes[nodes.length - 1] : null;
    const lastAge = lastNode ? computeAgeMinutes(lastNode) : null;

    return {
      meta: {
        messageCount: nodes.length || null,
        userMessageCount: userNodes.length || null,
        lastMessageAgeMin: lastAge,
        title: findConversationTitle(),
        convoId: extractConvoId(location.href),
        url: location.href,
        category: null
      },
      timestampsDetected: lastAge !== null
    };
  }

  function extractQna(root, { userBubble, assistantBubble }) {
    const userNode = userBubble || getLastVisible(root, '[data-message-author-role="user"]');
    const assistantNode =
      assistantBubble || getLastVisible(root, '[data-message-author-role="assistant"]');

    const questionText = userNode ? extractPlainText(userNode) : '';
    const answerHTML = assistantNode ? sanitizeHTML(extractAnswerHtml(assistantNode)) : '';

    logDebug(LOG_SCOPE, 'Extracted Q&A lengths', {
      questionTextLength: questionText.length,
      answerHTMLLength: answerHTML.length
    });

    return {
      questionText,
      answerHTML
    };
  }

  function getLastVisible(root, selector) {
    const nodes = Array.from(root.querySelectorAll(selector));
    const visible = filterVisible(nodes);
    return visible.length ? visible[visible.length - 1] : null;
  }

  function filterVisible(nodes) {
    return nodes.filter((node) => {
      const style = window.getComputedStyle(node);
      if (style?.display === 'none' || style?.visibility === 'hidden') {
        return false;
      }
      if (style?.display === 'contents') {
        return true;
      }
      return node.offsetParent !== null || style?.position === 'fixed';
    });
  }

  function extractPlainText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('code').forEach((code) => {
      code.innerHTML = code.textContent || '';
    });
    return clone.textContent?.trim() || '';
  }

  function extractAnswerHtml(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('button, svg, style, script, input, textarea').forEach((el) => el.remove());
    return clone.innerHTML || '';
  }

  function computeAgeMinutes(messageNode) {
    const timeNode =
      messageNode.querySelector('time') || messageNode.querySelector('[data-testid="timestamp"]');
    if (!timeNode) {
      return null;
    }
    const iso = timeNode.getAttribute('datetime') || timeNode.getAttribute('data-timestring');
    if (iso) {
      const parsed = Date.parse(iso);
      if (Number.isFinite(parsed)) {
        return (Date.now() - parsed) / 60000;
      }
    }
    const candidates = [
      timeNode.getAttribute('title'),
      timeNode.getAttribute('aria-label'),
      timeNode.textContent
    ].filter(Boolean);
    for (const raw of candidates) {
      const minutes = parseRelativeMinutes(raw);
      if (minutes !== null) {
        return minutes;
      }
    }
    return null;
  }

  function parseRelativeMinutes(text) {
    if (!text) {
      return null;
    }
    const normalized = text.toLowerCase().trim();
    if (!normalized) {
      return null;
    }
    if (['now', 'just now', 'moments ago'].includes(normalized)) {
      return 0;
    }
    const minuteMatch = normalized.match(/(\d+)\s*(minute|min|minutes|mins)/);
    if (minuteMatch) {
      return Number.parseInt(minuteMatch[1], 10);
    }
    const hourMatch = normalized.match(/(\d+)\s*(hour|hours|hr|hrs)/);
    if (hourMatch) {
      return Number.parseInt(hourMatch[1], 10) * 60;
    }
    const dayMatch = normalized.match(/(\d+)\s*(day|days)/);
    if (dayMatch) {
      return Number.parseInt(dayMatch[1], 10) * 1440;
    }
    if (normalized.startsWith('an hour')) {
      return 60;
    }
    if (normalized.startsWith('a minute')) {
      return 1;
    }
    if (normalized.startsWith('a day')) {
      return 1440;
    }
    return null;
  }

  function findConversationTitle() {
    const selectors = [
      '[data-testid="conversation-name"]',
      'aside h3',
      'header h1'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent?.trim()) {
        return element.textContent.trim();
      }
    }
    return '';
  }

  function extractConvoId(href) {
    const match = href.match(/\/c\/([^/?#]+)/);
    return match ? match[1] : '';
  }

  function buildMetaFallback() {
    return {
      messageCount: null,
      userMessageCount: null,
      lastMessageAgeMin: null,
      title: '',
      convoId: extractConvoId(location.href),
      url: location.href,
      category: null
    };
  }

  function buildError(phase, error) {
    return {
      phase,
      name: error?.name || 'Error',
      message: error?.message || String(error || 'unknown error')
    };
  }

  async function getConversationMeta() {
    const result = await ensureExtraction();
    return result.meta;
  }

  async function getQandA() {
    const result = await ensureExtraction();
    return result.qa;
  }

  async function debugProbe() {
    const diag = await ensureDiagnosticsSettings();
    const pipelineResult = await runExtractorPipeline({ captureDetails: true });
    const metaPreview = {
      messageCount: pipelineResult.meta.messageCount ?? null,
      userMessageCount: pipelineResult.meta.userMessageCount ?? null,
      lastMessageAgeMin: pipelineResult.meta.lastMessageAgeMin ?? null,
      title: redactIfNeeded(pipelineResult.meta.title, diag),
      convoId: pipelineResult.meta.convoId ?? null
    };

    return {
      strategiesTried: pipelineResult.strategies,
      found: pipelineResult.found,
      metaPreview,
      qnaPreview: {
        questionText_len: pipelineResult.qa.questionText.length,
        answerHTML_len: pipelineResult.qa.answerHTML.length
      },
      warnings: pipelineResult.warnings,
      errors: pipelineResult.errors
    };
  }

  function redactIfNeeded(value, diag) {
    if (!value) {
      return value;
    }
    return diag.REDACT_TEXT_IN_DIAGNOSTICS ? '<redacted>' : value;
  }

  function getRoot() {
    return document.querySelector('[data-testid="conversation-main"]') || document.body;
  }

  if (!window.MyChatGPTContent) {
    window.MyChatGPTContent = {};
  }

  window.MyChatGPTContent.getConversationMeta = getConversationMeta;
  window.MyChatGPTContent.getQandA = getQandA;
  window.MyChatGPTContent.debugProbe = debugProbe;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      return undefined;
    }

    if (message.type === 'ENSURE_BRIDGE_READY') {
      ensureBridgeInjected()
        .then((ready) => sendResponse({ ok: Boolean(ready) }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    if (message.type === 'PATCH_VISIBILITY') {
      ensureBridgeInjected()
        .then((ready) => {
          if (!ready) {
            sendResponse({ ok: false, error: 'bridge-not-ready' });
            return;
          }
          postToBridge('PATCH_VISIBILITY', {
            requestId: message.requestId,
            convoId: message.convoId,
            makeVisible: Boolean(message.visible)
          });
          sendResponse({ ok: true });
        })
        .catch((error) => {
          console.warn('MyChatGPT PATCH_VISIBILITY dispatch failed', error);
          sendResponse({ ok: false, error: error?.message || 'dispatch-error' });
        });
      return true;
    }

    if (message.type === 'BRIDGE_CONNECTIVITY') {
      ensureBridgeInjected()
        .then((ready) => {
          if (!ready) {
            sendResponse({ ok: false, error: 'bridge-not-ready' });
            return;
          }
          postToBridge('CONNECTIVITY_PROBE', { requestId: message.requestId });
          sendResponse({ ok: true });
        })
        .catch((error) => {
          console.warn('MyChatGPT bridge connectivity dispatch failed', error);
          sendResponse({ ok: false, error: error?.message || 'dispatch-error' });
        });
      return true;
    }

    if (message.type === 'MYCHATGPT:getConversationMeta') {
      resolveAsync(getConversationMeta, sendResponse);
      return true;
    }
    if (message.type === 'MYCHATGPT:getQandA') {
      resolveAsync(getQandA, sendResponse);
      return true;
    }
    if (message.type === 'MYCHATGPT:runDebugProbe') {
      resolveAsync(debugProbe, sendResponse);
      return true;
    }
    return undefined;
  });

  function resolveAsync(fn, sendResponse) {
    fn()
      .then((result) => sendResponse(result))
      .catch((error) => {
        logError(LOG_SCOPE, 'Message handler failed', error, { action: fn.name || 'anonymous' });
        sendResponse({ ok: false, error: error?.message || 'unexpected-error' });
      });
  }
})();
