(() => {
  const BRIDGE_SOURCE = 'MYCHATGPT';
  const BRIDGE_REPLY_SOURCE = 'MYCHATGPT_BRIDGE';
  const BRIDGE_ALLOWED_ORIGIN = 'https://chatgpt.com';
  const BRIDGE_READY_EVENT = 'BRIDGE_READY';
  const BRIDGE_PATCH_RESULT = 'PATCH_RESULT';
  const BRIDGE_CONNECTIVITY_RESULT = 'CONNECTIVITY_RESULT';
  const PATCH_ENDPOINT_PREFIX = '/backend-api/conversation/';
  const LEGACY_PATCH_ENDPOINT_PREFIX = '/conversation/';

  if (window.__MYCHATGPT_PAGE_BRIDGE__) {
    return;
  }
  window.__MYCHATGPT_PAGE_BRIDGE__ = true;

  function post(type, payload) {
    window.postMessage({ source: BRIDGE_REPLY_SOURCE, type, payload }, '*');
  }

  function allowedOrigin() {
    return window.location.origin === BRIDGE_ALLOWED_ORIGIN;
  }

  function buildEndpointCandidates(convoId) {
    if (typeof convoId !== 'string') {
      return [];
    }
    const trimmed = convoId.trim();
    if (!trimmed) {
      return [];
    }
    const encoded = encodeURIComponent(trimmed);
    return [`${PATCH_ENDPOINT_PREFIX}${encoded}`, `${LEGACY_PATCH_ENDPOINT_PREFIX}${encoded}`];
  }

  async function handlePatchVisibility(payload) {
    const { convoId, makeVisible, requestId } = payload || {};
    const result = {
      requestId,
      convoId: typeof convoId === 'string' ? convoId : '',
      ok: false
    };
    if (!allowedOrigin()) {
      result.error = 'origin-blocked';
      post(BRIDGE_PATCH_RESULT, result);
      return;
    }
    if (!result.convoId) {
      result.error = 'invalid-convo';
      post(BRIDGE_PATCH_RESULT, result);
      return;
    }
    const candidates = buildEndpointCandidates(result.convoId);
    const desiredVisibility = Boolean(makeVisible);
    const body = JSON.stringify({ is_visible: desiredVisibility });
    for (const candidate of candidates) {
      if (!candidate || /\s/.test(candidate)) {
        continue;
      }
      let endpointUrl;
      try {
        endpointUrl = new URL(candidate, window.location.origin);
      } catch (_error) {
        continue;
      }
      if (endpointUrl.origin !== window.location.origin) {
        continue;
      }
      try {
        const response = await fetch(endpointUrl.toString(), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body
        });
        const text = await response.text();
        let parsed = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch (_parseError) {
            parsed = text;
          }
        }
        result.status = response.status;
        result.body = parsed;
        result.ok = response.ok;
        if (!response.ok) {
          result.error = `http-${response.status}`;
          continue;
        }
        break;
      } catch (error) {
        result.error = error?.message || 'fetch-error';
      }
    }
    post(BRIDGE_PATCH_RESULT, result);
  }

  async function handleConnectivityProbe(payload) {
    const { requestId } = payload || {};
    const result = { requestId, ok: false };
    if (!allowedOrigin()) {
      result.error = 'origin-blocked';
      post(BRIDGE_CONNECTIVITY_RESULT, result);
      return;
    }
    const started = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    try {
      const response = await fetch('/', { method: 'HEAD', credentials: 'include' });
      result.ok = response.ok;
      result.status = response.status;
    } catch (error) {
      result.error = error?.message || 'fetch-error';
    }
    const ended = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    result.elapsedMs = ended - started;
    post(BRIDGE_CONNECTIVITY_RESULT, result);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE) {
      return;
    }
    if (!allowedOrigin()) {
      return;
    }
    try {
      if (data.type === 'PATCH_VISIBILITY') {
        handlePatchVisibility(data.payload).catch((error) => {
          post(BRIDGE_PATCH_RESULT, {
            requestId: data?.payload?.requestId,
            convoId: data?.payload?.convoId || '',
            ok: false,
            error: error?.message || 'bridge-error'
          });
        });
      } else if (data.type === 'CONNECTIVITY_PROBE') {
        handleConnectivityProbe(data.payload).catch((error) => {
          post(BRIDGE_CONNECTIVITY_RESULT, {
            requestId: data?.payload?.requestId,
            ok: false,
            error: error?.message || 'bridge-error'
          });
        });
      }
    } catch (error) {
      console.error('MyChatGPT bridge handling failed', error);
    }
  });

  post(BRIDGE_READY_EVENT, { ts: Date.now() });
})();
