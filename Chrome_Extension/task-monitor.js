(() => {
  'use strict';
  if (globalThis.__TOKEN_DESK_TASK_MONITOR__) return;
  globalThis.__TOKEN_DESK_TASK_MONITOR__ = true;

  const clean = s => (s || '').replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim();
  const thinkingStatus = /^(?:thinking|正在思考)(?:[.…!！]*)$/i;
  const workingStatus = /^(?:working|running|researching|searching|coding|generating|processing|正在(?:工作|运行|研究|搜索|编码|生成|处理)|执行中|处理中)(?:[.…!！]*)$/i;
  const exactStatus = /^(?:working|running|thinking|researching|searching|coding|generating|processing|正在(?:工作|运行|思考|研究|搜索|编码|生成|处理)|执行中|处理中)(?:[.…!！]*)$/i;
  const actionText = /^(?:stop(?:\s+(?:generating|responding|response|task|work|thinking|research))?|cancel\s+(?:task|work)|停止(?:生成|回答|响应|任务|工作|思考|研究)?|取消(?:任务|工作))$/i;
  // Only use high-confidence stop controls. Broad "*=stop" selectors caused
  // idle Work-mode tabs to be classified as active.
  const stopSelectors = [
    'button[data-testid="stop-button"]',
    'button[data-testid="stop-generating-button"]'
  ];

  // Current ChatGPT versions place the selected model/mode in a
  // composer-local Radix pill without data-testid or aria-label.
  // Keep the older header switcher selectors for previous UI versions.
  const modelSelectors = [
    'form[data-chatgpt-composer] button.__composer-pill',
    'button.__composer-pill',
    'button[class*="__composer-pill"]',
    'form[data-chatgpt-composer] button[aria-label*="model" i]',
    'button[aria-label="Select ChatGPT model"]',
    'form[data-chatgpt-composer] button[aria-haspopup="menu"][data-tone="neutral"]',
    'button[data-testid="model-switcher-dropdown-button"]',
    '[data-testid="model-switcher-dropdown-button"]',
    'button[data-testid*="model-switcher"]',
    'header button[aria-haspopup="menu"]'
  ];
  const explicitModelHint = /(?:\bGPT[-\s]?\d|\bo[134](?:[-\s]|$)|\bCodex\b)/i;
  const bareModeHint = /^(?:instant|thinking|pro|auto|default|medium|high|extra high|very high|extended|pro extended|fast|balanced|standard|极速|快速|均衡|自动|思考|标准|高|中|极高|最新的|最新|深度思考|高级|扩展|最高)$/i;
  const compactModeHint = /^(?:\d+(?:\.\d+)?)(?:instant|thinking|pro|high|medium|均衡|高|中|极速)$/i;
  const genericModelText = /^(?:ChatGPT|Model|模型|Choose model|Select model|Select ChatGPT model|New chat|新聊天|选择模型|选择 ChatGPT 模型)$/i;

  function normalizeModelLabel(value) {
    const label = clean(value)
      .replace(/^(?:model|模型|模型选择)\s*[:：-]?\s*/i, '')
      .replace(/^(?:ChatGPT)\s+(?=GPT[-\s]?\d)/i, '')
      .replace(/[⌄▾▼]+$/g, '')
      .trim();
    if (!label || label.length > 64 || genericModelText.test(label)) return null;

    // A full GPT or o-series name is a model, not just a mode.
    // Never infer a GPT version from an Instant / Thinking / Pro tier alone.
    if (explicitModelHint.test(label) && label.length <= 45) return label;

    // The closed composer pill sometimes contains only a tier or effort label:
    // 6Pro, Instant, Thinking, High, 均衡, etc.
    if (bareModeHint.test(label) || compactModeHint.test(label)) return '模式：' + label;
    return null;
  }

  function currentModelLabel() {
    let modeOnly = null;

    // Prefer explicitly selected items inside the CURRENT model picker,
    // if it happens to be open. Never scan all options or conversation text.
    const checkedSelectors = [
      '[data-testid="composer-intelligence-picker-content"] [role="menuitemradio"][aria-checked="true"]',
      '[data-testid="modal-intelligence-menu"] [role="radio"][aria-checked="true"]'
    ];
    for (const selector of checkedSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const label = normalizeModelLabel(el.getAttribute('aria-label') || el.textContent);
        if (label && !label.startsWith('模式：')) return label;
        if (label && !modeOnly) modeOnly = label;
      }
    }

    for (const selector of modelSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const candidates = [
          el.getAttribute('data-model'),
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.textContent
        ];
        for (const value of candidates) {
          const label = normalizeModelLabel(value);
          if (!label) continue;
          if (!label.startsWith('模式：')) return label;
          // The generic header popup may be another tool/settings menu.
          if (selector === 'header button[aria-haspopup="menu"]') continue;
          if (!modeOnly) modeOnly = label;
        }
      }
    }

    // Legacy header fallback. Explicit model name only: standalone "Thinking"
    // or "High" in a header may describe something other than model choice.
    for (const el of document.querySelectorAll('header button')) {
      if (!visible(el)) continue;
      const label = normalizeModelLabel(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
      if (label && !label.startsWith('模式：')) return label;
    }
    // The composer may be restructured without a stable class/test-id.
    // Only inspect button labels INSIDE composer forms; never scan chat text.
    for (const el of document.querySelectorAll('form button, [data-testid="chat-composer"] button, [data-testid="composer"] button')) {
      if (!visible(el)) continue;
      const label = normalizeModelLabel(
        el.getAttribute('data-model') || el.getAttribute('aria-label') ||
        el.getAttribute('title') || el.textContent
      );
      if (!label) continue;
      if (!label.startsWith('模式：')) return label;
      if (!modeOnly) modeOnly = label;
    }
    return modeOnly;
  }

  // Diagnostics report only model-picker controls, NEVER conversation content,
  // page titles, messages, account identifiers, or unrecognized button text.
  function modelDiagnostic() {
    const pillNodes = [...document.querySelectorAll(
      'button.__composer-pill, button[class*="__composer-pill"], [data-testid*="model-switcher"]'
    )].slice(0, 12);
    const visiblePills = pillNodes.filter(visible);
    const recognizedPills = visiblePills
      .map(el => normalizeModelLabel(
        el.getAttribute('data-model') || el.getAttribute('aria-label') ||
        el.getAttribute('title') || el.textContent
      ))
      .filter(Boolean).slice(0, 3);
    const model = resolvedModel || currentModelLabel();
    const taggedAssistantMessages = document.querySelectorAll(
      '[data-message-author-role="assistant"][data-message-model-slug]'
    ).length;
    return {
      ok: true, scriptVersion: '1.8.8',
      activeTask: active,
      model: model || '',
      lastModel: lastModel || '',
      modelSource: resolvedModel ? 'resolved_model_slug' : 'page-selector',
      conversationFetchSeen,
      streamSeen,
      lastStreamStatus,
      pickerCount: pillNodes.length,
      visiblePickerCount: visiblePills.length,
      recognizedPills,
      taggedAssistantMessages,
      reason: model ? 'recognized'
        : pillNodes.length === 0 ? 'picker-absent'
        : visiblePills.length === 0 ? 'picker-not-visible'
        : 'picker-has-no-supported-label'
    };
  }

  // When a Chromium extension is reloaded, old ChatGPT pages can keep
  // executing the invalidated content script until the page itself reloads.
  // Consume callback errors and safely retire that outdated script.
  let monitorContextValid = true;
  function sendMonitorMessage(message) {
    if (!monitorContextValid) return;
    try {
      const pending = chrome.runtime.sendMessage(message, () => {
        let error = null;
        try { error = chrome.runtime.lastError; } catch (cause) { error = cause; }
        if (/extension context invalidated|context invalidated/i.test(String(error?.message || error || ''))) {
          monitorContextValid = false;
        }
      });
      if (pending && typeof pending.catch === 'function') {
        pending.catch(cause => {
          if (/extension context invalidated|context invalidated/i.test(String(cause?.message || cause || ''))) {
            monitorContextValid = false;
          }
        });
      }
    } catch (cause) {
      // A thrown sendMessage is possible after extension reload. Never
      // propagate it to ChatGPT or repeatedly retry with the same old script.
      monitorContextValid = false;
    }
  }

  const usageIdleMs = 5 * 60 * 1000;
  let lastInteractionAt = Date.now();
  let usageTickAt = Date.now();
  let usageCarryMs = 0;

  function localDayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function noteInteraction() {
    lastInteractionAt = Date.now();
  }

  function takeActiveUsageSeconds(now) {
    const elapsed = Math.max(0, Math.min(20_000, now - usageTickAt));
    usageTickAt = now;
    const engaged = document.visibilityState === 'visible' &&
      document.hasFocus() &&
      now - lastInteractionAt <= usageIdleMs;
    if (engaged) usageCarryMs += elapsed;
    const seconds = Math.floor(usageCarryMs / 1000);
    usageCarryMs -= seconds * 1000;
    return seconds;
  }

  // Send focused, recently interactive use time on its own heartbeat.
  // This must not depend on whether the UI currently exposes a running task.
  // The background worker persists the seconds before updating Windows/macOS.
  function flushActiveUsage() {
    const now = Date.now();
    const seconds = takeActiveUsageSeconds(now);
    if (seconds <= 0) return;
    sendMonitorMessage({
      type: 'TOKEN_DESK_ACTIVE_USAGE',
      payload: { usageDay: localDayKey(new Date(now)), usageSeconds: seconds }
    });
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    // "Visible" must also mean inside the current viewport. Old response text
    // elsewhere in the scrollback must not count as a live status.
    const vw = globalThis.innerWidth || document.documentElement?.clientWidth || 0;
    const vh = globalThis.innerHeight || document.documentElement?.clientHeight || 0;
    if (vw > 0 && vh > 0) {
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh) return false;
    }
    return true;
  }

  function hasActiveControl() {
    for (const selector of stopSelectors) {
      for (const el of document.querySelectorAll(selector)) if (visible(el)) return true;
    }
    for (const el of document.querySelectorAll('button,[role="button"]')) {
      if (!visible(el)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.closest('nav,aside,[role="navigation"],[role="menu"],[data-testid*="sidebar"],[data-testid*="menu"]')) continue;
      const label = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
      if (label.length <= 48 && actionText.test(label)) return true;
    }
    return false;
  }

  function phaseFromText(text) {
    const value = clean(text);
    if (thinkingStatus.test(value)) return 'thinking';
    if (workingStatus.test(value)) return 'working';
    return null;
  }

  function activePhase() {
    // A visible enabled Stop control is positive evidence that a response is
    // still executing. The model or Work mode selected in a toolbar is NOT.
    if (hasActiveControl()) return 'working';

    // Live progress can also be text-only, but it must belong to the CURRENT
    // assistant message rather than navigation, a mode picker or scrollback.
    const assistantMessages = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const latest = assistantMessages[assistantMessages.length - 1];
    if (latest) {
      for (const el of latest.querySelectorAll('[role="status"],[aria-live="polite"],[aria-live="assertive"]')) {
        if (!visible(el) || el.closest('[role="menu"],button,[role="button"]')) continue;
        const phase = phaseFromText(el.textContent);
        if (phase) return phase;
      }
    }
    // Do not scan every div/span/p for words like "Working" or "正在工作".
    // These often describe the selected mode long after a task finished.
    return null;
  }

  function conversationID() {
    const m = location.pathname.match(/\/c\/([^/?#]+)/i);
    if (m) return 'c:' + m[1].slice(0, 120);
    const project = location.pathname.match(/\/g\/[^/]+\/c\/([^/?#]+)/i);
    if (project) return 'c:' + project[1].slice(0, 120);
    return 'url:' + (location.origin + location.pathname).slice(0, 150);
  }

  function safeTitle() {
    let title = clean(document.title);
    title = title.replace(/\s*[|–—-]\s*ChatGPT(?:\s.*)?$/i, '').trim();
    if (!title || /^(?:ChatGPT|New chat|新聊天|新对话)$/i.test(title)) title = 'ChatGPT 任务';
    return title.slice(0, 100);
  }

  let active = false;
  let phase = null;
  let startedAt = null;
  let lastSent = 0;
  let pending = false;
  let lastModel = null;
  let resolvedModel = null;
  let modelRoute = location.pathname;
  let resolvedModelReceivedAt = 0;
  let conversationFetchSeen = 0;
  let streamSeen = 0;
  let lastStreamStatus = 'not-observed';
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const detail = event.data;
    if (detail?.channel !== 'TOKEN_DESK_NETWORK_V1') return;
    if (detail.type === 'MODEL_TRACE') {
      const status = String(detail.status || '');
      const allowed = ['conversation-fetch-seen','stream-observed','not-event-stream',
                       'stream-ended','timeout','byte-limit'];
      if (!allowed.includes(status)) return;
      if (status === 'conversation-fetch-seen') conversationFetchSeen++;
      if (status === 'stream-observed') streamSeen++;
      lastStreamStatus = status;
      return;
    }
    if (detail.type !== 'MODEL') return;
    const candidate = detail.model;
    if (detail.source !== 'resolved_model_slug' || typeof candidate !== 'string' ||
        candidate.length > 64 ||
        !/^(?:gpt-[a-z0-9][a-z0-9._-]*|o[1-9][a-z0-9._-]*)$/i.test(candidate)) return;
    resolvedModel = candidate;
    modelRoute = location.pathname;
    resolvedModelReceivedAt = Date.now();
    lastStreamStatus = 'model-found';
    sendState(true);
  });

  function sendState(force = false) {
    const now = Date.now();
    const nextPhase = activePhase();
    const next = nextPhase !== null;
    // Keep the last confirmed UI label while a transient picker redraws.
    if (location.pathname !== modelRoute) {
      // ChatGPT can begin a new conversation on / and navigate to /c/<id>
      // only AFTER the SSE model metadata has arrived. Keep that fresh
      // confirmed model through this one-time creation redirect.
      const formerIsNewChat = modelRoute === '/' || modelRoute === '';
      const newChatCreated = /^\/c\/[^/]+/.test(location.pathname);
      const freshStream = resolvedModel && Date.now() - resolvedModelReceivedAt < 90_000;
      if (!(formerIsNewChat && newChatCreated && freshStream)) {
        resolvedModel = null;
        resolvedModelReceivedAt = 0;
        lastModel = null;
      }
      modelRoute = location.pathname;
    }
    const model = resolvedModel || currentModelLabel() || lastModel;
    const usageSeconds = 0; // Activity is sent by flushActiveUsage, not task updates.
    if (next && !active) startedAt = now;
    if (!next) startedAt = null;
    const changed = next !== active || nextPhase !== phase || model !== lastModel;
    active = next;
    phase = nextPhase;
    lastModel = model;
    if (!force && !changed && usageSeconds === 0 && (!active || now - lastSent < 5000)) return;
    lastSent = now;
    sendMonitorMessage({
      type: 'TOKEN_DESK_TASK_STATE',
      payload: {
        id: conversationID(),
        active,
        phase: phase || 'working',
        model: model || '',
        title: safeTitle(),
        pageURL: location.href.slice(0, 500),
        startedAt: Math.floor((startedAt || now) / 1000),
        lastSeenAt: Math.floor(now / 1000),
        usageDay: localDayKey(new Date(now)),
        usageSeconds
      }
    });
  }

  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; sendState(false); }, 250);
  });

  function start() {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, {childList:true,subtree:true,attributes:true,attributeFilter:['aria-label','data-state','data-status','data-testid','disabled']});
    // Count normal ChatGPT browsing and writing, even with no live task.
    setInterval(flushActiveUsage, 10_000);
    for (const type of ['pointerdown','keydown','wheel','scroll','touchstart']) {
      addEventListener(type, noteInteraction, {passive:true, capture:true});
    }
    addEventListener('focus', noteInteraction, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') noteInteraction();
      sendState(true);
    });
    sendState(true);
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === 'TOKEN_DESK_MODEL_DIAGNOSTIC') {
      sendState(true);
      reply?.(modelDiagnostic());
      return false;
    }
    if (msg?.type !== 'TOKEN_DESK_TASK_REFRESH') return false;
    sendState(true);
    reply?.({ok:true,active});
    return false;
  });

  addEventListener('pagehide', () => {
    flushActiveUsage();
    const now = Date.now();
    const usageSeconds = 0;
    const wasActive = active;
    active = false;
    sendMonitorMessage({
      type:'TOKEN_DESK_TASK_STATE',
      payload:{
        id:conversationID(),
        active:false,
        unverified:wasActive,
        phase:phase || 'working',
        model:lastModel || currentModelLabel() || '',
        title:safeTitle(),
        pageURL:location.href.slice(0,500),
        startedAt:wasActive ? Math.floor((startedAt || now)/1000) : 0,
        lastSeenAt:Math.floor(now/1000),
        usageDay:localDayKey(new Date(now)),
        usageSeconds
      }
    });
  });

  if (document.documentElement) start();
  else addEventListener('DOMContentLoaded', start, {once:true});

  // Dynamic heartbeat: active tasks report more often, idle tabs less often.
  function scheduleHeartbeat() {
    setTimeout(() => {
      if (!monitorContextValid) return;
      sendState(false);
      scheduleHeartbeat();
    }, active ? 5000 : 15000);
  }
  scheduleHeartbeat();

  if (globalThis.__TOKEN_DESK_TASK_TEST__) {
    globalThis.__TOKEN_DESK_TASK_TEST_STATUS__ = text => exactStatus.test(clean(text));
    globalThis.__TOKEN_DESK_TASK_TEST_PHASE__ = text => phaseFromText(text);
    globalThis.__TOKEN_DESK_TASK_TEST_ACTION__ = text => actionText.test(clean(text));
    globalThis.__TOKEN_DESK_TASK_TEST_MODEL__ = text => normalizeModelLabel(text);
    globalThis.__TOKEN_DESK_TASK_TEST_CURRENT_MODEL__ = currentModelLabel;
    globalThis.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__ = modelDiagnostic;
    globalThis.__TOKEN_DESK_TASK_TEST_ACTIVE_PHASE__ = activePhase;
    globalThis.__TOKEN_DESK_TASK_TEST_SEND__ = sendState;
  }
})();