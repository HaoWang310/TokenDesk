(() => {
  'use strict';
  if (globalThis.__TOKEN_DESK_EXTRACT_ACTIVE__) return;
  globalThis.__TOKEN_DESK_EXTRACT_ACTIVE__ = true;

  const CHANNEL = 'TOKEN_DESK_NETWORK_V1';
  let networkReady = false;
  let networkAuthExpired = false;
  let lastSignature = '';
  let lastSubmittedAt = 0;

  const isFive = s => /^5\s*(?:小时|小時|h(?:ours?)?)(?:\s*(?:用量|额度|額度|usage|limit))?$/i.test(s);
  const isWeek = s => /^(?:1\s*(?:周|週|星期|w(?:eeks?)?)(?:\s*(?:用量|额度|額度|usage|limit))?|weekly(?:\s*(?:usage|limit))?)$/i.test(s);
  const clean = s => (s || '').replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim();
  const goodPct = n => Number.isInteger(n) && n >= 0 && n <= 100;
  const goodStamp = n => Number.isInteger(n) && n > 0 && n < 9_999_999_999;

  function submitPayload(raw, done = null) {
    const payload = { pageURL: location.href, source: raw?.source === 'network' ? 'network' : 'dom' };
    if (goodPct(raw?.fiveHourRemaining)) payload.fiveHourRemaining = raw.fiveHourRemaining;
    if (goodPct(raw?.weeklyRemaining)) payload.weeklyRemaining = raw.weeklyRemaining;
    if (goodStamp(raw?.fiveHourResetsAt)) payload.fiveHourResetsAt = raw.fiveHourResetsAt;
    if (goodStamp(raw?.weeklyResetsAt)) payload.weeklyResetsAt = raw.weeklyResetsAt;
    if (Number.isInteger(raw?.availableResets) && raw.availableResets >= 0 && raw.availableResets <= 20) {
      payload.availableResets = raw.availableResets;
    }
    if (!('fiveHourRemaining' in payload) && !('weeklyRemaining' in payload)) {
      const r={ok:false,code:'NO_QUOTA',message:'没有可提交的额度数据。'};
      if(done) done(r); return r;
    }
    const now=Date.now();
    const signature=JSON.stringify([
      payload.source,payload.fiveHourRemaining ?? null,payload.weeklyRemaining ?? null,
      payload.fiveHourResetsAt ?? null,payload.weeklyResetsAt ?? null,payload.availableResets ?? null
    ]);
    if (!done && signature===lastSignature && now-lastSubmittedAt<15_000) return {ok:true,message:'额度未变化'};
    lastSignature=signature; lastSubmittedAt=now;
    chrome.runtime.sendMessage({type:'TOKEN_DESK_WEB_USAGE',payload},response=>{
      if (!done) return;
      if (chrome.runtime.lastError) done({ok:false,message:'浏览器后台未响应，请重新加载扩展。'});
      else done({ok:!!response?.ok,message:response?.message || '没有收到 Mac 接收端确认。'});
    });
    return {ok:true};
  }

  // MAIN-world network hook sends ONLY sanitized quota fields through postMessage.
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const m=event.data;
    if (!m || m.channel!==CHANNEL) return;
    if (m.type==='READY') {
      networkReady=!!m.ready;
      networkAuthExpired=!!m.authExpired;
      return;
    }
    if (m.type==='USAGE' && m.payload && typeof m.payload==='object') {
      networkReady=true; networkAuthExpired=false;
      stopDOMFallback();
      submitPayload({...m.payload, source:'network'});
    }
  });

  function requestNetworkRefresh() {
    window.postMessage({channel:CHANNEL,type:'REFRESH'}, location.origin);
  }
  function requestNetworkReplay() {
    window.postMessage({channel:CHANNEL,type:'REPLAY_LAST'}, location.origin);
  }

  // ----- DOM fallback -----
  // This remains as a fallback only. Chrome service-worker background query is preferred in v1.6.2.
  function percentFromCard(card) {
    const t = clean(card);
    const labeled = [
      /(\d{1,3})\s*%\s*(?:剩余|剩餘|remaining|left|available)/i,
      /(?:剩余|剩餘|remaining|left|available)\s*:?\s*(\d{1,3})\s*%/i
    ];
    for (const rx of labeled) {
      const hit = t.match(rx);
      if (hit && Number(hit[1]) >= 0 && Number(hit[1]) <= 100) return Number(hit[1]);
    }
    const values = [...t.matchAll(/(\d{1,3})\s*%/g)];
    if (values.length !== 1) return null;
    const hit = values[0], n = Number(hit[1]);
    if (!goodPct(n)) return null;
    const before = t.slice(Math.max(0, hit.index - 24), hit.index);
    const after = t.slice(hit.index + hit[0].length, hit.index + hit[0].length + 16);
    if (/(?:已用|已使用|消耗|used|spent)\s*:?\s*$/i.test(before) ||
        /^\s*(?:已用|已使用|消耗|used|spent)\b/i.test(after)) return null;
    return n;
  }

  function labelText(node) {
    if (!node || node.children.length > 4) return null;
    if (node.querySelector('input, textarea, [contenteditable="true"]')) return null;
    if (node.children.length === 0) return clean(node.textContent);
    return clean(Array.from(node.childNodes).filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent).join(' ')) || (node.children.length === 1 ? clean(node.textContent) : null);
  }

  function readPanel(kind) {
    const matcher = kind === 'five' ? isFive : isWeek;
    const labels = [];
    for (const node of document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p,strong')) {
      if (node.closest('textarea,[contenteditable="true"],[data-message-author-role]')) continue;
      if (node.closest('nav,aside,[role="navigation"]') &&
          !node.closest('[role="menu"],[role="dialog"],[data-state="open"]')) continue;
      const label = labelText(node);
      if (label && matcher(label)) labels.push(node);
      if (labels.length > 120) break;
    }
    for (const label of labels) {
      let ancestor = label;
      for (let depth = 0; depth < 7 && ancestor; depth++, ancestor = ancestor.parentElement) {
        const text = clean(ancestor.innerText || ancestor.textContent);
        if (text.length > 420) break;
        if (depth > 1 && text.length > 180) break;
        const value = percentFromCard(text);
        if (value !== null) return value;
      }
    }
    const isUsagePage = /^\/settings\/usage(?:\/|$)/.test(location.pathname || '');
    const fivePattern = /(?:^|\s)5\s*(?:小时|小時|h(?:ours?)?)\s*(?:用量|额度|額度|usage|limit)?/i;
    const weekPattern = /(?:^|\s)(?:1\s*(?:周|週|星期|w(?:eeks?)?)|weekly)\s*(?:用量|额度|額度|usage|limit)?/i;
    for (const element of document.querySelectorAll('div,span,p,li')) {
      if (!isUsagePage && !element.closest('[role="menu"],[role="dialog"],[data-radix-menu-content]')) continue;
      if (element.closest('textarea,[contenteditable="true"]')) continue;
      const text = clean(element.innerText || element.textContent);
      if (text.length > 120 || text.length < 6) continue;
      if (!(kind === 'five' ? fivePattern : weekPattern).test(text)) continue;
      if ((kind === 'five' ? weekPattern : fivePattern).test(text)) continue;
      const value = percentFromCard(text);
      if (value !== null) return value;
    }
    return null;
  }

  function readResets() {
    const onUsagePage = /^\/settings\/usage(?:\/|$)/.test(location.pathname || '');
    for (const el of document.querySelectorAll('div,span,p,li')) {
      if (!onUsagePage && !el.closest('[role="menu"],[role="dialog"],[data-radix-menu-content]')) continue;
      const text = clean(el.innerText || el.textContent);
      if (text.length > 110) continue;
      const match = text.match(/(\d{1,2})\s*次\s*(?:可用重置|重置可用)/) ||
          text.match(/(?:可用重置|重置可用)\s*[:：]?\s*(\d{1,2})/) ||
          text.match(/(\d{1,2})\s*(?:resets?\s*available|available\s*resets?)/i);
      if (match) {
        const n=Number(match[1]); if (Number.isInteger(n) && n>=0 && n<=20) return n;
      }
    }
    return null;
  }

  function sampleDOM(force = false, done = null) {
    if (!/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/.test(location.href)) {
      const r={ok:false,code:'WRONG_PAGE',message:'当前网页不是 ChatGPT'}; if(done) done(r); return r;
    }
    const five = readPanel('five'), week = readPanel('week'), resets = readResets();
    if (five === null && week === null) {
      const r={ok:false,code:'NO_QUOTA',message:'后台网络请求尚未捕获；页面上也没有可识别额度。'};
      if(done) done(r); return r;
    }
    const payload={source:'dom'};
    if(five!==null) payload.fiveHourRemaining=five;
    if(week!==null) payload.weeklyRemaining=week;
    if(resets!==null) payload.availableResets=resets;
    return submitPayload(payload, done);
  }

  let scanPending = false;
  let fallbackActive = false;
  let fallbackStopTimer = null;
  const observer = new MutationObserver(() => {
    if (!fallbackActive || scanPending) return;
    scanPending = true;
    setTimeout(() => {
      scanPending = false;
      if (fallbackActive) sampleDOM(false);
    }, 300);
  });

  function stopDOMFallback() {
    fallbackActive = false;
    observer.disconnect();
    if (fallbackStopTimer) clearTimeout(fallbackStopTimer);
    fallbackStopTimer = null;
  }

  function activateDOMFallback(durationMs = 120_000) {
    fallbackActive = true;
    const attach = () => {
      if (!fallbackActive || !document.documentElement) return;
      observer.disconnect();
      observer.observe(document.documentElement, {childList:true,subtree:true,characterData:true});
      sampleDOM(false);
    };
    if (document.documentElement) attach();
    else addEventListener('DOMContentLoaded', attach, {once:true});
    if (fallbackStopTimer) clearTimeout(fallbackStopTimer);
    fallbackStopTimer = setTimeout(stopDOMFallback, durationMs);
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === 'TOKEN_DESK_NETWORK_REFRESH') {
      requestNetworkRefresh();
      reply?.({ok:true,networkReady});
      return false;
    }
    if (msg?.type === 'TOKEN_DESK_FALLBACK_REFRESH') {
      activateDOMFallback();
      requestNetworkRefresh();
      reply?.({ok:true,networkReady,fallbackActive:true});
      return false;
    }
    if (msg?.type === 'TOKEN_DESK_SCAN') {
      if (networkReady) {
        requestNetworkRefresh();
        reply({ok:true,code:'NETWORK_REFRESH',message:'已请求页面网络备用刷新。'});
        return false;
      }
      activateDOMFallback();
      sampleDOM(true, r=>{
        if (r?.ok) reply(r);
        else reply({
          ok:false,
          code: networkAuthExpired ? 'NETWORK_AUTH_EXPIRED' : 'NETWORK_NOT_READY',
          message: networkAuthExpired
            ? '页面网络备用凭据已失效；请优先使用扩展的“立即后台查询”。如仍失败，可打开一次 ChatGPT 用量页面恢复备用读取。'
            : '页面备用读取尚未捕获额度；Chrome 后台主动查询仍是首选，不需要打开用量页面。'
        });
      });
      return true;
    }
  });

  requestNetworkReplay();
})();