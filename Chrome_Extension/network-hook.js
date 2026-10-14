(() => {
  'use strict';
  if (globalThis.__TOKEN_DESK_NETWORK_HOOK__) return;
  globalThis.__TOKEN_DESK_NETWORK_HOOK__ = true;

  const CHANNEL = 'TOKEN_DESK_NETWORK_V1';
  const USAGE_PATHS = ['/backend-api/wham/usage', '/api/codex/usage'];
  const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  const NativeXHR = window.XMLHttpRequest;
  let requestTemplate = null;
  let lastPayload = null;
  let refreshBusy = false;
  const HOOK_VERSION = '1.8.12';
  let lastModelSignal = null;
  let fetchWrapper = null;
  const MAX_REPLAY_AGE_MS = 5 * 60 * 1000;
  function publishModel(type, model, source, route) {
    const record = {
      type, model, source,
      route: typeof route === 'string' ? route.slice(0, 300) : location.pathname,
      at: Date.now()
    };
    if (type === 'MODEL' || !lastModelSignal || lastModelSignal.type !== 'MODEL' ||
        lastModelSignal.route !== record.route) {
      lastModelSignal = record;
    }
    emit(type, { model, source, route:record.route });
  }


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

  // Observe only same-origin ChatGPT conversation event streams. Never
  // transmit, log, save, or parse the answer text outside this page context.
  function isConversationURL(raw) {
    try {
      const u = new URL(String(raw), location.href);
      if (u.origin !== location.origin) return false;
      return u.pathname === '/backend-api/f/conversation' ||
        u.pathname === '/backend-api/conversation';
    } catch { return false; }
  }

  function requestModelFromJSON(text) {
    if (typeof text !== 'string' || text.length > 131072) return null;
    try {
      const req = JSON.parse(text);
      // Request-selected model, NOT proof of the server's resolved model.
      return validResolvedSlug(req?.model) || validResolvedSlug(req?.model_slug) || null;
    } catch { return null; }
  }

  function observeConversationRequest(input, init, route) {
    const requestMethod = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (requestMethod !== 'POST') return;
    const body = init?.body;
    if (typeof body === 'string') {
      const found = requestModelFromJSON(body);
      if (found) publishModel('REQUEST_MODEL',found,'request_body',route);
      return;
    }
    // Support fetch(Request) without changing its response or forwarding
    // any prompt, attachment or header to the desktop app.
    if (input instanceof Request && body == null &&
        /application\/json/i.test(input.headers.get('content-type') || '')) {
      const length = Number(input.headers.get('content-length') || 0);
      if (length > 131072) return;
      input.clone().text().then(text => {
        const found = requestModelFromJSON(text);
        if (found) emit('REQUEST_MODEL', {model:found,source:'request_body'});
      }).catch(()=>{});
    }
  }

  function validResolvedSlug(value) {
    return typeof value === 'string' && value.length <= 64 &&
      /^(?:gpt-[a-z0-9][a-z0-9._-]*|o[1-9][a-z0-9._-]*)$/i.test(value)
      ? value : null;
  }

  // Parse JSON envelopes only. String content from a ChatGPT answer must not
  // be interpreted as model metadata even when it mentions model_slug.
  function resolvedModelFromEvent(envelope) {
    if (!envelope || typeof envelope !== 'object') return null;
    const stack = [{node: envelope, depth: 0}];
    let visited = 0;
    while (stack.length && visited++ < 120) {
      const {node, depth} = stack.pop();
      if (!node || typeof node !== 'object' || depth > 7) continue;
      const found = validResolvedSlug(node.resolved_model_slug);
      if (found) return found;
      // Some ChatGPT SSE variants return a JSON patch instead of a
      // fully materialized message object.
      const patchPath = typeof node.p === 'string' ? node.p :
                        (typeof node.path === 'string' ? node.path : '');
      if (patchPath === 'resolved_model_slug' || patchPath.endsWith('/resolved_model_slug')) {
        const patchModel = validResolvedSlug(node.v ?? node.value);
        if (patchModel) return patchModel;
      }
      // A metadata object may itself be JSON-encoded in patch.value rather
      // than supplied as a nested object. Restrict decoding to metadata paths
      // and never inspect textual content from a conversation.
      const metadataPatch = patchPath === 'metadata' ||
        patchPath.endsWith('/metadata') || patchPath === '/message';
      if (metadataPatch) {
        const value = node.v ?? node.value;
        if (typeof value === 'string' && value.length < 8192 && value[0] === '{') {
          try {
            const parsed = JSON.parse(value);
            const metadata = parsed?.metadata || parsed?.message?.metadata || parsed;
            const slug = validResolvedSlug(metadata?.resolved_model_slug);
            if (slug) return slug;
          } catch {}
        }
      }
      // Keep only metadata-bearing tree paths. Do not inspect user/assistant
      // content, tool arguments, attachment data or message text.
      for (const [key, value] of Object.entries(node)) {
        if (/^(?:content|parts|text|body|arguments|attachments|input|output)$/i.test(key)) continue;
        if (value && typeof value === 'object') {
          if (Array.isArray(value)) {
            for (let i = Math.min(12,value.length) - 1; i >= 0; i--) {
              if (value[i] && typeof value[i] === 'object') stack.push({node:value[i],depth:depth+1});
            }
          } else stack.push({node:value,depth:depth+1});
        }
      }
    }
    return null;
  }

  async function inspectConversationStream(response, url, route) {
    if (!response?.ok || !isConversationURL(url) || !response.body ||
        !String(response.headers?.get?.('content-type') || '').includes('text/event-stream')) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];
    let scannedBytes = 0;
    let found = null;
    let status = 'stream-ended';
    emit('MODEL_TRACE', {status:'stream-observed'});
    // The stream stays open while ChatGPT is generating. Model metadata may
    // appear early; continue draining the clone after identifying it, without
    // buffering or inspecting response text, to track the true task lifetime.
    // Limit observation to 2 hours to avoid pinning a stuck clone forever.
    emit('TASK_STREAM', {status:'open',route});
    let timedOut = false;
    const timeoutId = typeof setTimeout === 'function'
      ? setTimeout(() => { timedOut=true; status='timeout'; reader.cancel().catch(()=>{}); }, 7200000) : null;

    function processEvent() {
      if (!dataLines.length) return null;
      const source = dataLines.join('\n');
      dataLines = [];
      if (source.length > 50000) return null;
      try { return resolvedModelFromEvent(JSON.parse(source)); }
      catch { return null; }
    }

    try {
      while (!timedOut) {
        const {value,done} = await reader.read();
        if (done) break;
        // Once a model is found, or the bounded model inspection budget has
        // been spent, discard subsequent chunks. Only stream completion matters.
        if (found || scannedBytes >= 2097152) continue;
        scannedBytes += value.byteLength;
        buffer += decoder.decode(value, {stream:true});
        if (buffer.length > 65536) {
          buffer = '';
          dataLines = [];
          scannedBytes = 2097152;
          continue;
        }
        let index;
        while ((index=buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0,index);
          if (line.endsWith('\r')) line=line.slice(0,-1);
          buffer=buffer.slice(index+1);
          if (!line) {
            found = processEvent();
            if (found) {
              publishModel('MODEL',found,'resolved_model_slug',route);
              buffer=''; dataLines=[];
              break;
            }
          } else if (line.startsWith('data:')) {
            const data = line.slice(5).trimStart();
            if (dataLines.join('').length + data.length < 50000) dataLines.push(data);
            else dataLines=[];
            // In ChatGPT's streaming transport, model metadata may appear as a
            // standalone JSON data line before an SSE blank-line delimiter.
            // Parse it immediately so prolonged streams cannot hide the value.
            if (!found && data.length < 50000 && data.startsWith('{')) {
              try { found = resolvedModelFromEvent(JSON.parse(data)); } catch {}
              if (found) break;
            }
          }
        }
      }
      if (!found) found=processEvent();
      if (!found) {
        if (scannedBytes >= 2097152) status='byte-limit';
        emit('MODEL_TRACE', {status});
      }
    } catch {
      status='stream-error';
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      try { await reader.cancel(); } catch {}
      emit('TASK_STREAM', {status: status === 'stream-ended' ? 'closed' : 'uncertain',route});
    }
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
    return { kind, remaining: clampPct(100 - used), resetAt: reset && reset > 0 ? Math.round(reset) : null };
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
    if (available !== null && Number.isInteger(available) && available >= 0 && available <= 20) payload.availableResets = available;
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
    } catch {}
  }
  function rememberFetchRequest(input, init) {
    if (!nativeFetch) return;
    try {
      const req = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), location.href).href, init);
      if (req.method === 'GET' && isUsageURL(req.url)) {
        requestTemplate = req.clone();
        emit('READY', { ready: true });
      }
    } catch {}
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
    } catch {}
    finally { refreshBusy = false; }
  }

  if (nativeFetch) {
    fetchWrapper = async function(input, init) {
      let url = '';
      try { url = input instanceof Request ? input.url : String(input); } catch {}
      if (isUsageURL(url)) rememberFetchRequest(input, init);
      const requestRoute = location.pathname;
      if (isConversationURL(url)) observeConversationRequest(input, init, requestRoute);
      const response = await nativeFetch(input, init);
      if (isUsageURL(url)) inspectResponse(response.clone(), url);
      if (isConversationURL(url)) {
        emit('MODEL_TRACE', {status:'conversation-fetch-seen'});
        if (response.ok && String(response.headers?.get?.('content-type') || '').includes('text/event-stream')) {
          inspectConversationStream(response.clone(), url, requestRoute).catch(()=>{});
        } else {
          emit('MODEL_TRACE', {status:'not-event-stream'});
        }
      }
      return response;
    };
    window.fetch = fetchWrapper;
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
    if (m.type === 'TOKEN_DESK_HOOK_PING') {
      emit('HOOK_STATUS', {
        hookVersion:HOOK_VERSION,
        fetchWrapped:!!fetchWrapper && window.fetch === fetchWrapper
      });
      const saved = lastModelSignal;
      if (saved && Date.now()-saved.at < MAX_REPLAY_AGE_MS) {
        publishModel(saved.type, saved.model, saved.source, saved.route);
      }
    }
    else if (m.type === 'REFRESH') replayUsageRequest();
    else if (m.type === 'REPLAY_LAST') {
      emit('READY', { ready: !!requestTemplate });
      if (lastPayload) emit('USAGE', { payload: lastPayload });
    }
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') replayUsageRequest();
  }, 15_000);

  emit('READY', { ready: false });
  if (globalThis.__TOKEN_DESK_TEST__) {
    globalThis.__TOKEN_DESK_TEST_PARSE__ = parseUsageJSON;
    globalThis.__TOKEN_DESK_TEST_MODEL_FROM_EVENT__ = resolvedModelFromEvent;
    globalThis.__TOKEN_DESK_TEST_REQUEST_MODEL__ = requestModelFromJSON;
    globalThis.__TOKEN_DESK_TEST_HOOK_STATUS__ = () => ({
      version:HOOK_VERSION,wrapped:window.fetch===fetchWrapper
    });
  }
})();