(() => {
  'use strict';
  if (globalThis.__TOKEN_DESK_NETWORK_HOOK__) return;
  globalThis.__TOKEN_DESK_NETWORK_HOOK__ = true;

  // Runs in ChatGPT's MAIN world. It only inspects the JSON response body of
  // the first-party usage endpoint. It never reads cookies or header values,
  // and never forwards an Authorization header outside the page.
  const CHANNEL = 'TOKEN_DESK_NETWORK_V1';
  const USAGE_PATHS = ['/backend-api/wham/usage', '/api/codex/usage'];
  const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  const NativeXHR = window.XMLHttpRequest;
  let requestTemplate = null; // opaque Request clone; header values are never inspected
  let lastPayload = null;
  let refreshBusy = false;

  const finiteNumber = v => typeof v === 'number' && Number.isFinite(v) ? v :
    (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const pick = (obj, ...names) => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const name of names) if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
    return undefined;
  };
  const clampPct = n => Math.max(0, Math.min(100, Math.round(n)));

  function isUsageURL(raw) {
    try {
      const u = new URL(String(raw), location.href);
      if (!['chatgpt.com', 'chat.openai.com'].includes(u.hostname.toLowerCase())) return false;
      return USAGE_PATHS.some(path => u.pathname === path || u.pathname.endsWith(path));
    } catch { return false; }
  }

  function classifyWindow(w) {
    if (!w || typeof w !== 'object') return null;
    const used = finiteNumber(pick(w, 'used_percent', 'usedPercent'));
    if (used === null || used < 0 || used > 100) return null;
    let seconds = finiteNumber(pick(w, 'limit_window_seconds', 'limitWindowSeconds'));
    if (seconds === null) {
      const mins = finiteNumber(pick(w, 'windowDurationMins', 'window_duration_mins'));
      if (mins !== null) seconds = mins * 60;
    }
    if (seconds === null || seconds <= 0) return null;
    const reset = finiteNumber(pick(w, 'reset_at', 'resetsAt', 'resetAt'));
    let kind = null;
    if (Math.abs(seconds - 18_000) <= 1_800) kind = 'five';
    if (Math.abs(seconds - 604_800) <= 60_480) kind = 'week';
    if (!kind) return null;
    return {
      kind,
      remaining: clampPct(100 - used),
      resetAt: reset && reset > 0 ? Math.round(reset) : null
    };
  }

  function parseUsageJSON(root, endpoint) {
    if (!root || typeof root !== 'object') return null;
    const group = pick(root, 'rate_limit', 'rateLimit', 'rateLimits') || root;
    const windows = [
      pick(group, 'primary_window', 'primaryWindow', 'primary'),
      pick(group, 'secondary_window', 'secondaryWindow', 'secondary')
    ].map(classifyWindow).filter(Boolean);

    const payload = { source: 'network', networkEndpoint: endpoint };
    for (const w of windows) {
      if (w.kind === 'five') {
        payload.fiveHourRemaining = w.remaining;
        if (w.resetAt) payload.fiveHourResetsAt = w.resetAt;
      } else if (w.kind === 'week') {
        payload.weeklyRemaining = w.remaining;
        if (w.resetAt) payload.weeklyResetsAt = w.resetAt;
      }
    }
    const credits = pick(root, 'rate_limit_reset_credits', 'rateLimitResetCredits') ||
      pick(group, 'rate_limit_reset_credits', 'rateLimitResetCredits');
    const available = finiteNumber(pick(credits, 'available_count', 'availableCount'));
    if (available !== null && Number.isInteger(available) && available >= 0 && available <= 20) {
      payload.availableResets = available;
    }
    if (!Number.isInteger(payload.fiveHourRemaining) && !Number.isInteger(payload.weeklyRemaining)) return null;
    return payload;
  }

  function emit(type, extra = {}) {
    window.postMessage({ channel: CHANNEL, type, ...extra }, location.origin);
  }

  function publish(payload) {
    if (!payload) return;
    lastPayload = payload;
    emit('USAGE', { payload });
  }

  async function inspectResponse(response, url) {
    try {
      if (!response || !response.ok || !isUsageURL(url)) return;
      const text = await response.text();
      if (!text || text.length > 512_000) return;
      const payload = parseUsageJSON(JSON.parse(text), new URL(String(url), location.href).pathname);
      publish(payload);
    } catch { /* quota capture must never affect ChatGPT */ }
  }

  function rememberFetchRequest(input, init) {
    if (!nativeFetch) return;
    try {
      const req = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), location.href).href, init);
      if (req.method === 'GET' && isUsageURL(req.url)) {
        requestTemplate = req.clone();
        emit('READY', { ready: true });
      }
    } catch { /* no-op */ }
  }

  async function replayUsageRequest() {
    if (!nativeFetch || !requestTemplate || refreshBusy) {
      emit('READY', { ready: !!requestTemplate });
      return;
    }
    refreshBusy = true;
    try {
      const response = await nativeFetch(requestTemplate.clone());
      await inspectResponse(response.clone(), requestTemplate.url);
      if (response.status === 401 || response.status === 403) {
        requestTemplate = null;
        emit('READY', { ready: false, authExpired: true });
      }
    } catch { }
    finally { refreshBusy = false; }
  }

  if (nativeFetch) {
    window.fetch = async function(input, init) {
      let url = '';
      try { url = input instanceof Request ? input.url : String(input); } catch {}
      if (isUsageURL(url)) rememberFetchRequest(input, init);
      const response = await nativeFetch(input, init);
      if (isUsageURL(url)) inspectResponse(response.clone(), url);
      return response;
    };
  }

  if (NativeXHR) {
    const nativeOpen = NativeXHR.prototype.open;
    NativeXHR.prototype.open = function(method, url, ...rest) {
      this.__tokenDeskUsageURL = String(url || '');
      this.__tokenDeskUsageMethod = String(method || 'GET').toUpperCase();
      return nativeOpen.call(this, method, url, ...rest);
    };
    const nativeSend = NativeXHR.prototype.send;
    NativeXHR.prototype.send = function(...args) {
      if (isUsageURL(this.__tokenDeskUsageURL)) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const body = this.responseType === 'json' ? this.response : JSON.parse(this.responseText || '{}');
            publish(parseUsageJSON(body, new URL(this.__tokenDeskUsageURL, location.href).pathname));
          } catch {}
        }, { once: true });
      }
      return nativeSend.apply(this, args);
    };
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const m = event.data;
    if (!m || m.channel !== CHANNEL) return;
    if (m.type === 'REFRESH') replayUsageRequest();
    else if (m.type === 'REPLAY_LAST') {
      emit('READY', { ready: !!requestTemplate });
      if (lastPayload) emit('USAGE', { payload: lastPayload });
    }
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') replayUsageRequest();
  }, 15_000);

  emit('READY', { ready: false });
  if (globalThis.__TOKEN_DESK_TEST__) globalThis.__TOKEN_DESK_TEST_PARSE__ = parseUsageJSON;
})();
