'use strict';

const ORIGIN = 'http://127.0.0.1:18743';
const SERVER = ORIGIN + '/ingest';
const TASK_SERVER = ORIGIN + '/tasks';
const CHATGPT_ORIGIN = 'https://chatgpt.com';
const SESSION_URL = CHATGPT_ORIGIN + '/api/auth/session';
const USAGE_URLS = [
  CHATGPT_ORIGIN + '/backend-api/wham/usage',
  CHATGPT_ORIGIN + '/api/codex/usage'
];

const good = n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 100;
const goodStamp = n => typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 9_999_999_999;
const finiteNumber = v => typeof v === 'number' && Number.isFinite(v) ? v :
  (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const pick = (obj, ...names) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const name of names) if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
  return undefined;
};
const clampPct = n => Math.max(0, Math.min(100, Math.round(n)));

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

function parseUsageJSON(root) {
  if (!root || typeof root !== 'object') return null;
  const group = pick(root, 'rate_limit', 'rateLimit', 'rateLimits') || root;
  const candidates = [
    pick(group, 'primary_window', 'primaryWindow', 'primary'),
    pick(group, 'secondary_window', 'secondaryWindow', 'secondary')
  ];

  // Some server variants expose windows as arrays or nested fields.
  for (const key of ['windows', 'rate_limit_windows', 'rateLimitWindows']) {
    const v = pick(group, key);
    if (Array.isArray(v)) candidates.push(...v);
  }

  const windows = candidates.map(classifyWindow).filter(Boolean);
  const payload = {
    pageURL: CHATGPT_ORIGIN + '/',
    source: 'network',
    backgroundDirect: true
  };
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

async function probe() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(ORIGIN + '/health', { cache: 'no-store', signal: controller.signal });
    const j = await r.json();
    return (r.ok && j.ok === true && j.app === 'TokenDesk')
      ? {ok:true, message:'Mac TokenDesk 已启动，本机网页连接正常。'}
      : {ok:false, message:`本机端口响应异常：HTTP ${r.status}。`};
  } catch (e) {
    return {ok:false, message:'无法连接 Mac TokenDesk。请确保菜单栏 App 正在运行。'};
  } finally { clearTimeout(t); }
}

async function sendUsage(payload) {
  const {pairingCode} = await chrome.storage.local.get({pairingCode:''});
  if (!/^[0-9a-f]{64}$/i.test(pairingCode)) {
    const status = '尚未配对：请复制 Mac TokenDesk 的完整配对码并保存。';
    await chrome.storage.local.set({syncStatus:status});
    return {ok:false,message:status};
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(SERVER, {
      method:'POST', cache:'no-store',
      headers:{'Content-Type':'application/json','X-TokenDesk-Key':pairingCode},
      body:JSON.stringify(payload),signal:controller.signal
    });
    let message;
    if(response.ok) {
      const fmt = n => Number.isInteger(n) ? `${n}%` : '—';
      const source = payload.backgroundDirect ? 'Chrome 后台主动查询' :
        (payload.source === 'network' ? '后台网络' : '页面采集');
      message=`${source}已同步：5h ${fmt(payload.fiveHourRemaining)} · 周 ${fmt(payload.weeklyRemaining)}（${new Date().toLocaleTimeString()}）`;
    } else if(response.status===401) message='配对码不匹配（HTTP 401）。请从 Mac TokenDesk 重新复制配对码。';
    else message=`传输失败：HTTP ${response.status}。`;
    const changes = {syncStatus:message};
    if(response.ok) changes.lastSnapshot = {
      fiveHourRemaining: Number.isInteger(payload.fiveHourRemaining) ? payload.fiveHourRemaining : null,
      weeklyRemaining: Number.isInteger(payload.weeklyRemaining) ? payload.weeklyRemaining : null,
      source: payload.source === 'network' ? 'network' : 'dom',
      mode: payload.backgroundDirect ? 'background-direct' : 'page',
      at: Date.now()
    };
    await chrome.storage.local.set(changes);
    return {ok:response.ok,message};
  } catch(e) {
    const message='无法将额度发送给 Mac。请确认 TokenDesk 菜单栏 App 正在运行。';
    await chrome.storage.local.set({syncStatus:message});
    return {ok:false,message};
  } finally {clearTimeout(t);}
}


const taskStates = new Map();
let taskPublishTimer = null;

function validChatGPTURL(value) {
  return typeof value === 'string' && value.length <= 600 && /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/.test(value);
}

function sanitizeTaskMessage(message, sender) {
  if (!Number.isInteger(sender?.tab?.id) || !validChatGPTURL(sender?.url || '')) return null;
  const p = message?.payload || {};
  if (typeof p.active !== 'boolean' || typeof p.id !== 'string' || !p.id || p.id.length > 180) return null;
  if (!validChatGPTURL(p.pageURL || sender.url || '')) return null;
  const now = Date.now();
  const started = Number.isFinite(Number(p.startedAt)) ? Number(p.startedAt) * 1000 : now;
  const seen = Number.isFinite(Number(p.lastSeenAt)) ? Number(p.lastSeenAt) * 1000 : now;
  return {
    tabId: sender.tab.id,
    id: p.id,
    active: p.active,
    title: typeof p.title === 'string' ? p.title.replace(/\s+/g,' ').trim().slice(0,100) : 'ChatGPT 任务',
    pageURL: (p.pageURL || sender.url).slice(0,500),
    startedAt: Math.min(now, Math.max(now - 7 * 24 * 60 * 60 * 1000, started)),
    lastSeenAt: Math.min(now + 5000, Math.max(now - 5 * 60 * 1000, seen))
  };
}

function currentTasks() {
  const now = Date.now();
  const dedup = new Map();
  for (const [tabId, task] of taskStates) {
    if (!task.active || now - task.lastSeenAt > 90_000) { taskStates.delete(tabId); continue; }
    const existing = dedup.get(task.id);
    if (!existing || task.lastSeenAt > existing.lastSeenAt) dedup.set(task.id, task);
  }
  return [...dedup.values()].sort((a,b)=>a.startedAt-b.startedAt).slice(0,20);
}

async function sendTasksSnapshot() {
  const {pairingCode} = await chrome.storage.local.get({pairingCode:''});
  if (!/^[0-9a-f]{64}$/i.test(pairingCode)) return {ok:false,message:'任务监控等待配对。'};
  const tasks = currentTasks();
  const payload = {
    observedAt: Math.floor(Date.now()/1000),
    tasks: tasks.map(t=>({
      id:t.id,title:t.title || 'ChatGPT 任务',pageURL:t.pageURL,
      startedAt:Math.floor(t.startedAt/1000),lastSeenAt:Math.floor(t.lastSeenAt/1000)
    }))
  };
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),5000);
  try {
    const response = await fetch(TASK_SERVER,{
      method:'POST',cache:'no-store',
      headers:{'Content-Type':'application/json','X-TokenDesk-Key':pairingCode},
      body:JSON.stringify(payload),signal:controller.signal
    });
    const message = response.ok ? `运行任务已同步：${tasks.length} 个` : `任务同步失败：HTTP ${response.status}`;
    await chrome.storage.local.set({taskSyncStatus:message, runningTaskCount:tasks.length, taskLastSync:Date.now()});
    return {ok:response.ok,message,count:tasks.length};
  } catch {
    return {ok:false,message:'无法将运行任务发送给 Mac。'};
  } finally { clearTimeout(timer); }
}

function scheduleTaskPublish() {
  if (taskPublishTimer) clearTimeout(taskPublishTimer);
  taskPublishTimer = setTimeout(()=>{ taskPublishTimer=null; sendTasksSnapshot().catch(()=>{}); },120);
}

async function refreshTaskTabs(inject = false) {
  try {
    const tabs = await chrome.tabs.query({url:['https://chatgpt.com/*','https://chat.openai.com/*']});
    for (const tab of tabs) {
      if (!tab.id) continue;
      if (inject && chrome.scripting?.executeScript) {
        await chrome.scripting.executeScript({target:{tabId:tab.id},files:['task-monitor.js']}).catch(()=>{});
      }
      chrome.tabs.sendMessage(tab.id,{type:'TOKEN_DESK_TASK_REFRESH'}).catch(()=>{});
    }
  } catch {}
  setTimeout(()=>sendTasksSnapshot().catch(()=>{}),500);
}

function sanitizeMessage(message, sender) {
  if (!/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/.test(sender?.url||'')) return null;
  const p=message.payload||{};
  if(typeof p.pageURL!=='string' || p.pageURL.length>500 ||
     !/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/.test(p.pageURL)) return null;
  const data={pageURL:p.pageURL, source:p.source === 'network' ? 'network' : 'dom'};
  if(good(p.fiveHourRemaining)) data.fiveHourRemaining=p.fiveHourRemaining;
  if(good(p.weeklyRemaining)) data.weeklyRemaining=p.weeklyRemaining;
  if(goodStamp(p.fiveHourResetsAt)) data.fiveHourResetsAt=p.fiveHourResetsAt;
  if(goodStamp(p.weeklyResetsAt)) data.weeklyResetsAt=p.weeklyResetsAt;
  if(Number.isInteger(p.availableResets) && p.availableResets>=0 && p.availableResets<=20) data.availableResets=p.availableResets;
  if(!('fiveHourRemaining' in data) && !('weeklyRemaining' in data)) return null;
  return data;
}

async function fetchJSON(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      headers: { 'Accept': 'application/json', ...headers },
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    if (text && text.length <= 1_000_000) {
      try { json = JSON.parse(text); } catch {}
    }
    return {ok:response.ok,status:response.status,json};
  } finally { clearTimeout(timer); }
}

async function readAccessTokenFromSession() {
  try {
    const result = await fetchJSON(SESSION_URL);
    if (!result.ok || !result.json || typeof result.json !== 'object') {
      return {ok:false,status:result.status,token:null};
    }
    const token = typeof result.json.accessToken === 'string' ? result.json.accessToken :
      (typeof result.json.access_token === 'string' ? result.json.access_token : null);
    return token ? {ok:true,status:result.status,token} : {ok:false,status:result.status,token:null};
  } catch {
    return {ok:false,status:0,token:null};
  }
}

let backgroundBusy = false;
let lastBackgroundAttempt = 0;

async function fetchQuotaFromChatGPT() {
  let lastStatus = 0;

  // Fast path: Chrome host permission + credentials may be enough to send the
  // existing ChatGPT login session without needing any page to be open.
  for (const url of USAGE_URLS) {
    try {
      const result = await fetchJSON(url);
      lastStatus = result.status;
      if (result.ok) {
        const payload = parseUsageJSON(result.json);
        if (payload) return {ok:true,payload,authMode:'session-cookie'};
      }
      if (![401,403,404].includes(result.status)) break;
    } catch {}
  }

  // Some ChatGPT builds protect the usage endpoint with the same short-lived
  // bearer token used by the web app. Obtain it from ChatGPT's own session
  // endpoint, keep it only in this service-worker invocation, then discard it.
  const session = await readAccessTokenFromSession();
  if (session.ok && session.token) {
    for (const url of USAGE_URLS) {
      try {
        const result = await fetchJSON(url, {'Authorization': `Bearer ${session.token}`});
        lastStatus = result.status;
        if (result.ok) {
          const payload = parseUsageJSON(result.json);
          if (payload) return {ok:true,payload,authMode:'session-access-token'};
        }
        if (result.status !== 404) break;
      } catch {}
    }
  }

  return {ok:false,status:lastStatus || session.status || 0};
}

async function backgroundQuotaRefresh(reason='alarm') {
  if (backgroundBusy) return {ok:false,message:'后台查询正在进行中。'};
  backgroundBusy = true;
  lastBackgroundAttempt = Date.now();
  try {
    const quota = await fetchQuotaFromChatGPT();
    if (!quota.ok) {
      const message = quota.status === 401 || quota.status === 403
        ? 'Chrome 后台无法取得 ChatGPT 登录授权。请确认 Chrome 中仍已登录 ChatGPT；无需打开用量页面。'
        : quota.status === 404
          ? 'ChatGPT 用量接口路径已变化，后台查询暂时不可用。页面监听备用模式仍会继续工作。'
          : 'Chrome 后台暂未读取到额度。请确认网络正常且 Chrome 中仍登录 ChatGPT。';
      await chrome.storage.local.set({backgroundStatus:message, backgroundLastAttempt:lastBackgroundAttempt});
      return {ok:false,message,status:quota.status};
    }

    const sent = await sendUsage(quota.payload);
    const message = sent.ok
      ? `后台主动查询成功（${new Date().toLocaleTimeString()}）。无需打开 ChatGPT 页面。`
      : sent.message;
    await chrome.storage.local.set({
      backgroundStatus:message,
      backgroundLastAttempt:lastBackgroundAttempt,
      backgroundAuthMode:quota.authMode
    });
    return {ok:sent.ok,message,status:200};
  } catch (e) {
    const message = 'Chrome 后台查询发生异常，页面监听备用模式仍可使用。';
    await chrome.storage.local.set({backgroundStatus:message, backgroundLastAttempt:lastBackgroundAttempt});
    return {ok:false,message,status:0};
  } finally {
    backgroundBusy = false;
  }
}

async function refreshChatGPTTabs() {
  // Fallback only. v1.6.2 does not require a ChatGPT tab to exist.
  try {
    const tabs = await chrome.tabs.query({url:['https://chatgpt.com/*','https://chat.openai.com/*']});
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id,{type:'TOKEN_DESK_FALLBACK_REFRESH'}).catch(()=>{});
    }
  } catch {}
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.type==='TOKEN_DESK_HEALTH') {
    probe().then(sendResponse).catch(e=>sendResponse({ok:false,message:String(e)}));
    return true;
  }
  if(message?.type==='TOKEN_DESK_BACKGROUND_REFRESH') {
    backgroundQuotaRefresh('manual').then(sendResponse).catch(e=>sendResponse({ok:false,message:String(e)}));
    return true;
  }
  if(message?.type==='TOKEN_DESK_TASK_STATE') {
    const task = sanitizeTaskMessage(message, sender);
    if (!task) return false;
    if (task.active) taskStates.set(task.tabId, task);
    else taskStates.delete(task.tabId);
    scheduleTaskPublish();
    sendResponse({ok:true,count:currentTasks().length});
    return false;
  }
  if(message?.type!=='TOKEN_DESK_WEB_USAGE') return false;
  const data = sanitizeMessage(message, sender);
  if (!data) return false;
  sendUsage(data).then(sendResponse).catch(e=>sendResponse({ok:false,message:String(e)}));
  return true;
});

function installAlarm() {
  chrome.alarms.create('tokendesk-quota-refresh',{periodInMinutes:0.5});
}

chrome.runtime.onInstalled.addListener(()=>{
  installAlarm();
  backgroundQuotaRefresh('installed').catch(()=>{});
  refreshTaskTabs(true).catch(()=>{});
});
chrome.runtime.onStartup.addListener(()=>{
  installAlarm();
  backgroundQuotaRefresh('startup').catch(()=>{});
  refreshTaskTabs(true).catch(()=>{});
});
if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener(tabId=>{
    if (taskStates.delete(tabId)) scheduleTaskPublish();
  });
}
if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
    if (changeInfo.status==='loading' || changeInfo.url) {
      if (taskStates.delete(tabId)) scheduleTaskPublish();
    }
  });
}
chrome.alarms.onAlarm.addListener(async alarm=>{
  if(alarm.name!=='tokendesk-quota-refresh') return;
  const result = await backgroundQuotaRefresh('alarm');
  if (!result.ok) await refreshChatGPTTabs();
  await refreshTaskTabs(false);
});

// Ensure an unpacked extension reloaded during development also has an alarm.
installAlarm();
backgroundQuotaRefresh('service-worker-load').catch(()=>{});
refreshTaskTabs(true).catch(()=>{});

// Test hooks used only by the bundled Node test; harmless in Chrome.
if (globalThis.__TOKEN_DESK_TEST__) {
  globalThis.__TOKEN_DESK_TEST_PARSE__ = parseUsageJSON;
}
