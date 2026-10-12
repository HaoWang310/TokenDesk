(() => {
  'use strict';
  if (globalThis.__TOKEN_DESK_TASK_MONITOR__) return;
  globalThis.__TOKEN_DESK_TASK_MONITOR__ = true;

  const clean = s => (s || '').replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim();
  const thinkingStatus = /^(?:thinking|正在思考)(?:[.…!！]*)$/i;
  const workingStatus = /^(?:working|running|researching|searching|coding|generating|processing|正在(?:工作|运行|研究|搜索|编码|生成|处理)|执行中|处理中)(?:[.…!！]*)$/i;
  const exactStatus = /^(?:working|running|thinking|researching|searching|coding|generating|processing|正在(?:工作|运行|思考|研究|搜索|编码|生成|处理)|执行中|处理中)(?:[.…!！]*)$/i;
  const actionText = /^(?:stop(?:\s+(?:generating|responding|response|task|work|thinking|research))?|cancel\s+(?:task|work)|停止(?:生成|回答|响应|任务|工作|思考|研究)?|取消(?:任务|工作))$/i;
  const stopSelectors = [
    'button[data-testid="stop-button"]',
    'button[data-testid="stop-generating-button"]',
    'button[data-testid*="stop"][aria-label]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop responding" i]',
    'button[aria-label*="Stop response" i]',
    'button[aria-label*="Stop task" i]',
    'button[aria-label*="Stop work" i]',
    'button[aria-label*="停止生成"]',
    'button[aria-label*="停止回答"]',
    'button[aria-label*="停止任务"]',
    'button[title*="Stop generating" i]'
  ];

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function hasActiveControl() {
    for (const selector of stopSelectors) {
      for (const el of document.querySelectorAll(selector)) if (visible(el)) return true;
    }
    for (const el of document.querySelectorAll('button,[role="button"]')) {
      if (!visible(el)) continue;
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

    for (const el of document.querySelectorAll('button,span,p,div')) {
      if (!visible(el)) continue;
      if (el.closest('textarea,[contenteditable="true"],[data-message-author-role="user"]')) continue;
      if (el.children.length > 3) continue;
      const text = clean(el.textContent);
      if (text.length === 0 || text.length > 40) continue;
      const phase = phaseFromText(text);
      if (phase) return phase;
    }

    // Structural running markers and Stop controls prove the task is active but
    // do not tell us that it is specifically thinking, so classify them as work.
    for (const el of document.querySelectorAll('[data-state="running"],[data-status="running"],[data-testid*="running"],[data-testid*="working"]')) {
      if (visible(el)) return 'working';
    }
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

  function sendState(force = false) {
    const now = Date.now();
    const nextPhase = activePhase();
    const next = nextPhase !== null;
    if (next && !active) startedAt = now;
    if (!next) startedAt = null;
    const changed = next !== active || nextPhase !== phase;
    active = next;
    phase = nextPhase;
    if (!force && !changed && (!active || now - lastSent < 5000)) return;
    lastSent = now;
    chrome.runtime.sendMessage({
      type: 'TOKEN_DESK_TASK_STATE',
      payload: {
        id: conversationID(),
        active,
        phase: phase || 'working',
        title: safeTitle(),
        pageURL: location.href.slice(0, 500),
        startedAt: Math.floor((startedAt || now) / 1000),
        lastSeenAt: Math.floor(now / 1000)
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
    sendState(true);
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type !== 'TOKEN_DESK_TASK_REFRESH') return false;
    sendState(true);
    reply?.({ok:true,active});
    return false;
  });

  addEventListener('pagehide', () => {
    if (!active) return;
    active = false;
    chrome.runtime.sendMessage({
      type:'TOKEN_DESK_TASK_STATE',
      payload:{id:conversationID(),active:false,phase:phase || 'working',title:safeTitle(),pageURL:location.href.slice(0,500),startedAt:0,lastSeenAt:Math.floor(Date.now()/1000)}
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
  }
})();