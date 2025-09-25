(() => {
  const BRIDGE_SOURCE = 'MYCHATGPT';
  const BRIDGE_REPLY_SOURCE = 'MYCHATGPT_BRIDGE';
  const BRIDGE_ALLOWED_ORIGIN = 'https://chatgpt.com';
  const BRIDGE_READY_EVENT = 'BRIDGE_READY';
  const BRIDGE_PATCH_RESULT = 'PATCH_RESULT';
  const BRIDGE_PATCH_PROBE_RESULT = 'PATCH_PROBE_RESULT';
  const BRIDGE_CONNECTIVITY_RESULT = 'CONNECTIVITY_RESULT';
  const BRIDGE_PATCH_DIAG = 'PATCH_DIAG';
  const PATCH_ENDPOINT_PREFIX = '/backend-api/conversation/';
  const LEGACY_PATCH_ENDPOINT_PREFIX = '/conversation/';

  const PATCH_METHOD = 'PATCH';
  const POST_METHOD = 'POST';

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

  function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  async function getAccessTokenSafe() {
    try {
      const token = window.localStorage?.getItem?.('accessToken');
      if (token) {
        return token;
      }
      const response = await fetch('/backend-api/auth/session', {
        credentials: 'include'
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        return body?.accessToken || null;
      }
    } catch (_error) {}
    return null;
  }

  function buildHeaders({ token }) {
    const headers = {
      'content-type': 'application/json',
      'X-Same-Domain': '1'
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  function getPatchEndpointCandidates(convoId) {
    if (typeof convoId !== 'string') {
      return [];
    }
    const trimmed = convoId.trim();
    if (!trimmed) {
      return [];
    }
    const encoded = encodeURIComponent(trimmed);
    return [
      { method: PATCH_METHOD, url: `${PATCH_ENDPOINT_PREFIX}${encoded}` },
      { method: PATCH_METHOD, url: `/backend-api/conversations/${encoded}` },
      { method: POST_METHOD, url: `/backend-api/conversations/${encoded}` },
      { method: POST_METHOD, url: `${PATCH_ENDPOINT_PREFIX}${encoded}` }
    ];
  }

  function normalizeCandidate(raw) {
    if (!raw) {
      return null;
    }
    if (typeof raw === 'string') {
      return { method: PATCH_METHOD, url: raw.trim() };
    }
    const method = typeof raw.method === 'string' ? raw.method.trim().toUpperCase() : PATCH_METHOD;
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!url) {
      return null;
    }
    if (method !== PATCH_METHOD && method !== POST_METHOD) {
      return null;
    }
    return { method, url };
  }

  function buildCandidateList({ convoId, hints = [] }) {
    const seen = new Set();
    const candidates = [];
    const pushCandidate = (candidate) => {
      const normalized = normalizeCandidate(candidate);
      if (!normalized) {
        return;
      }
      let resolved;
      try {
        resolved = new URL(normalized.url, window.location.origin);
      } catch (_error) {
        return;
      }
      if (resolved.origin !== window.location.origin) {
        return;
      }
      const key = `${normalized.method}:${resolved.toString()}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push({ method: normalized.method, url: resolved.toString() });
    };
    hints.forEach(pushCandidate);
    getPatchEndpointCandidates(convoId).forEach(pushCandidate);
    return candidates;
  }

  function emitPatchDiag(requestId, result) {
    if (!requestId) {
      return;
    }
    const payload = {
      requestId,
      ok: result?.ok === true,
      usedAuth: Boolean(result?.usedAuth),
      endpoint: typeof result?.endpoint === 'string' ? result.endpoint : null,
      method: typeof result?.method === 'string' ? result.method : null,
      status: Number.isFinite(result?.status) ? result.status : result?.status ?? null,
      reason: typeof result?.reasonCode === 'string' ? result.reasonCode : result?.reason || null
    };
    if (!payload.ok && Array.isArray(result?.tried) && result.tried.length) {
      payload.tried = result.tried.slice(0, 3).map((attempt) => ({
        method: attempt?.method || null,
        url: attempt?.url || null,
        status: Number.isFinite(attempt?.status) ? attempt.status : attempt?.status ?? null
      }));
    }
    post(BRIDGE_PATCH_DIAG, payload);
  }

  async function toggleVisibility({ convoId, visible, hints = [] }) {
    const token = await getAccessTokenSafe();
    const usedAuth = Boolean(token);
    const candidates = buildCandidateList({ convoId, hints });
    if (!candidates.length) {
      return {
        ok: false,
        reasonCode: 'endpoint_not_supported',
        tried: [],
        usedAuth
      };
    }
    const attempts = [];
    let lastStatus = null;
    const body = JSON.stringify({ is_visible: Boolean(visible) });
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate.url, {
          method: candidate.method,
          headers: buildHeaders({ token }),
          credentials: 'include',
          body
        });
        lastStatus = Number.isFinite(response.status) ? response.status : null;
        const text = await response.text().catch(() => '');
        let parsedBody = null;
        if (text) {
          try {
            parsedBody = JSON.parse(text);
          } catch (_error) {
            parsedBody = text;
          }
        }
        if (response.ok) {
          return {
            ok: true,
            status: response.status,
            endpoint: candidate.url,
            method: candidate.method,
            usedAuth,
            body: parsedBody
          };
        }
        attempts.push({ status: response.status, method: candidate.method, url: candidate.url });
        if (!response.status) {
          return {
            ok: false,
            reasonCode: 'patch_bridge_error',
            error: 'empty-status',
            tried: attempts,
            usedAuth,
            status: lastStatus
          };
        }
      } catch (error) {
        attempts.push({ status: null, method: candidate.method, url: candidate.url, error: error?.message || 'fetch-error' });
        lastStatus = null;
        return {
          ok: false,
          reasonCode: 'patch_bridge_error',
          error: error?.message || 'fetch-error',
          tried: attempts,
          usedAuth,
          status: lastStatus
        };
      }
    }
    return {
      ok: false,
      reasonCode: 'endpoint_not_supported',
      tried: attempts,
      usedAuth,
      status: lastStatus
    };
  }

  async function handlePatchVisibilityProbe(payload) {
    const { convoId, requestId, dryRun = true, endpoint } = payload || {};
    const responsePayload = {
      requestId,
      convoId: typeof convoId === 'string' ? convoId : '',
      ok: false
    };
    if (!allowedOrigin()) {
      responsePayload.error = 'origin-blocked';
      post(BRIDGE_PATCH_PROBE_RESULT, responsePayload);
      return;
    }
    if (!responsePayload.convoId) {
      responsePayload.error = 'invalid-convo';
      post(BRIDGE_PATCH_PROBE_RESULT, responsePayload);
      return;
    }
    const hints = [];
    if (typeof endpoint === 'string' && endpoint.trim()) {
      hints.push({ method: PATCH_METHOD, url: endpoint.trim() });
    }
    const start = nowMs();
    const attempts = [];
    let usedAuth = false;
    let firstOk = null;
    try {
      if (dryRun) {
        const token = await getAccessTokenSafe();
        usedAuth = Boolean(token);
        const headers = buildHeaders({ token });
        const candidates = buildCandidateList({ convoId: responsePayload.convoId, hints });
        for (const candidate of candidates) {
          for (const probeMethod of ['OPTIONS', 'HEAD']) {
            try {
              const res = await fetch(candidate.url, {
                method: probeMethod,
                headers,
                credentials: 'include'
              });
              attempts.push({
                url: candidate.url,
                method: probeMethod,
                status: res.status,
                ok: res.ok
              });
              if (!firstOk && res.ok) {
                firstOk = {
                  url: candidate.url,
                  method: probeMethod,
                  status: res.status
                };
              }
              if (res.ok) {
                break;
              }
            } catch (error) {
              attempts.push({
                url: candidate.url,
                method: probeMethod,
                status: null,
                error: error?.message || 'fetch-error'
              });
              break;
            }
          }
          if (firstOk) {
            break;
          }
        }
      } else {
        let wasVisible = true;
        try {
          const infoResponse = await fetch(
            `/backend-api/conversation/${encodeURIComponent(responsePayload.convoId)}`,
            {
              method: 'GET',
              credentials: 'include',
              headers: { Accept: 'application/json' }
            }
          );
          if (infoResponse.ok) {
            const data = await infoResponse.json().catch(() => null);
            if (data) {
              if (typeof data?.conversation?.is_visible === 'boolean') {
                wasVisible = data.conversation.is_visible;
              } else if (typeof data?.is_visible === 'boolean') {
                wasVisible = data.is_visible;
              }
            }
          }
        } catch (_error) {}
        let toggleResult;
        try {
          toggleResult = await toggleVisibility({
            convoId: responsePayload.convoId,
            visible: wasVisible,
            hints
          });
        } catch (error) {
          toggleResult = {
            ok: false,
            reasonCode: 'patch_bridge_error',
            error: error?.message || 'probe-toggle-failed',
            tried: [],
            usedAuth: false
          };
        }
        usedAuth = Boolean(toggleResult?.usedAuth);
        if (Array.isArray(toggleResult?.tried) && toggleResult.tried.length) {
          attempts.push(...toggleResult.tried);
        }
        if (toggleResult?.ok) {
          firstOk = {
            url: toggleResult.endpoint || null,
            method: toggleResult.method || null,
            status: toggleResult.status ?? null
          };
          attempts.push({
            url: toggleResult.endpoint || null,
            method: toggleResult.method || null,
            status: toggleResult.status ?? null,
            ok: true
          });
        } else if (Number.isFinite(toggleResult?.status)) {
          attempts.push({
            url: toggleResult?.endpoint || null,
            method: toggleResult?.method || null,
            status: toggleResult.status
          });
        }
        if (!toggleResult?.ok && toggleResult?.error) {
          responsePayload.error = toggleResult.error;
        }
        if (!toggleResult?.ok && toggleResult?.reasonCode) {
          responsePayload.reasonCode = toggleResult.reasonCode;
        }
      }
    } catch (error) {
      responsePayload.error = error?.message || 'probe-failed';
    }
    responsePayload.elapsedMs = nowMs() - start;
    responsePayload.usedAuth = usedAuth;
    responsePayload.tried = attempts;
    if (firstOk) {
      responsePayload.ok = true;
      responsePayload.firstOk = firstOk;
    } else {
      responsePayload.firstOk = null;
    }
    post(BRIDGE_PATCH_PROBE_RESULT, responsePayload);
  }

  async function handlePatchVisibility(payload) {
    const { convoId, makeVisible, visible, requestId, endpoint } = payload || {};
    const result = {
      requestId,
      convoId: typeof convoId === 'string' ? convoId : '',
      ok: false
    };
    if (!allowedOrigin()) {
      result.error = 'origin-blocked';
      result.reasonCode = 'origin_blocked';
      emitPatchDiag(requestId, { ok: false, reasonCode: 'origin_blocked', usedAuth: false });
      post(BRIDGE_PATCH_RESULT, result);
      return;
    }
    if (!result.convoId) {
      result.error = 'invalid-convo';
      result.reasonCode = 'invalid_convo';
      emitPatchDiag(requestId, { ok: false, reasonCode: 'invalid_convo', usedAuth: false });
      post(BRIDGE_PATCH_RESULT, result);
      return;
    }
    const desiredVisibility = typeof visible === 'boolean' ? visible : Boolean(makeVisible);
    const hints = [];
    if (typeof endpoint === 'string' && endpoint.trim()) {
      hints.push({ method: PATCH_METHOD, url: endpoint.trim() });
    }
    let toggleResult;
    try {
      toggleResult = await toggleVisibility({ convoId: result.convoId, visible: desiredVisibility, hints });
    } catch (error) {
      toggleResult = {
        ok: false,
        reasonCode: 'patch_bridge_error',
        error: error?.message || 'toggle-failed',
        usedAuth: false
      };
    }
    emitPatchDiag(requestId, toggleResult);
    result.ok = toggleResult.ok === true;
    if (Number.isFinite(toggleResult?.status)) {
      result.status = toggleResult.status;
    }
    if (Object.prototype.hasOwnProperty.call(toggleResult, 'body')) {
      result.body = toggleResult.body;
    }
    if (typeof toggleResult?.endpoint === 'string') {
      result.endpoint = toggleResult.endpoint;
    }
    if (typeof toggleResult?.method === 'string') {
      result.method = toggleResult.method;
    }
    if (typeof toggleResult?.reasonCode === 'string') {
      result.reasonCode = toggleResult.reasonCode;
    }
    if (toggleResult?.error) {
      result.error = toggleResult.error;
    }
    result.usedAuth = Boolean(toggleResult?.usedAuth);
    if (!result.ok && Array.isArray(toggleResult?.tried)) {
      result.tried = toggleResult.tried;
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
      } else if (data.type === 'PATCH_ENDPOINT_PROBE') {
        handlePatchVisibilityProbe(data.payload).catch((error) => {
          post(BRIDGE_PATCH_PROBE_RESULT, {
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
