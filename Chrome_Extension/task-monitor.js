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

  const modelSelectors = [
    'button[data-testid="model-switcher-dropdown-button"]',
    '[data-testid="model-switcher-dropdown-button"]',
    'button[data-testid*="model-switcher"]',
    'header button[aria-haspopup="menu"]'
  ];
  const modelHint = /(?:\bGPT[-\s]?\d|\bGPT\b|\bo[134](?:[-\s]|$)|\bCodex\b|\bThinking\b|\bInstant\b|\bPro\b|\bAuto\b)/i;
  const genericModelText = /^(?:ChatGPT|Model|模型|Choose model|Select model|New chat|新聊天)$/i;

  function normalizeModelLabel(value) {
    const text = clean(value)
      .replace(/^(?:model|模型)\s*[:：-]?\s*/i, '')
      .replace(/[⌄▾▼]+$/g, '')
      .trim();
    if (!text || text.length > 64 || genericModelText.test(text)) return null;
    return modelHint.test(text) ? text : null;
  }

  function currentModelLabel() {
    for (const selector of modelSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const candidates = [
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.textContent
        ];
        for (const value of candidates) {
          const label = normalizeModelLabel(value);
          if (label) return label;
        }
      }
    }

    // Conservative fallback: only inspect buttons in the page header.
    for (const el of document.querySelectorAll('header button')) {
      if (!visible(el)) continue;
      const label = normalizeModelLabel(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent);
      if (label) return label;
    }
    return null;
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
    // Prefer explicit visible status text so “正在思考” is distinguished from “正在工作”.
    for (const el of document.querySelectorAll('[role="status"],[aria-live="polite"],[aria-live="assertive"]')) {
      if (!visible(el)) continue;
      const phase = phaseFromText(el.textContent);
      if (phase) return phase;
    }

    for (const el of document.querySelectorAll('span,p,div')) {
      if (!visible(el)) continue;
      if (el.closest('textarea,[contenteditable="true"],[data-message-author-role="user"],nav,aside,[role="navigation"],[role="menu"],[data-testid*="sidebar"],[data-testid*="menu"]')) continue;
      if (el.children.length > 3) continue;
      const text = clean(el.textContent);
      if (text.length === 0 || text.length > 40) continue;
      const phase = phaseFromText(text);
      if (phase) return phase;
    }

    // A real Stop control is still a strong active-task signal, but generic
    // data-testid/data-state "working/running" markers are intentionally ignored:
    // ChatGPT can keep those markers on idle Work-mode UI.
    if (hasActiveControl()) return 'working';
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

  function sendState(force = false) {
    const now = Date.now();
    const nextPhase = activePhase();
    const next = nextPhase !== null;
    const model = currentModelLabel();
    const usageSeconds = takeActiveUsageSeconds(now);
    if (next && !active) startedAt = now;
    if (!next) startedAt = null;
    const changed = next !== active || nextPhase !== phase || model !== lastModel;
    active = next;
    phase = nextPhase;
    lastModel = model;
    if (!force && !changed && usageSeconds === 0 && (!active || now - lastSent < 5000)) return;
    lastSent = now;
    chrome.runtime.sendMessage({
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
    }).catch(() => {});
  }

  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; sendState(false); }, 250);
  });

  function start() {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, {childList:true,subtree:true,attributes:true,attributeFilter:['aria-label','data-state','data-status','data-testid','disabled']});
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
    if (msg?.type !== 'TOKEN_DESK_TASK_REFRESH') return false;
    sendState(true);
    reply?.({ok:true,active});
    return false;
  });

  addEventListener('pagehide', () => {
    const now = Date.now();
    const usageSeconds = takeActiveUsageSeconds(now);
    const wasActive = active;
    active = false;
    chrome.runtime.sendMessage({
      type:'TOKEN_DESK_TASK_STATE',
      payload:{
        id:conversationID(),
        active:false,
        phase:phase || 'working',
        model:lastModel || currentModelLabel() || '',
        title:safeTitle(),
        pageURL:location.href.slice(0,500),
        startedAt:wasActive ? Math.floor((startedAt || now)/1000) : 0,
        lastSeenAt:Math.floor(now/1000),
        usageDay:localDayKey(new Date(now)),
        usageSeconds
      }
    }).catch(()=>{});
  });

  if (document.documentElement) start();
  else addEventListener('DOMContentLoaded', start, {once:true});

  // Dynamic heartbeat: active tasks report more often, idle tabs less often.
  function scheduleHeartbeat() {
    setTimeout(() => {
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
  }
})();