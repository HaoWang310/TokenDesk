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

const ACTIVE_USAGE_KEY = 'tokendeskDailyActiveUsageV1';
const SESSION_INTERVAL_KEY = 'tokendeskSessionIntervalsV1';
const SESSION_MIGRATION_KEY = 'tokendeskSessionMigrationV1';
const WEEKLY_USAGE_KEY = 'tokendeskDailyWeeklyQuotaUsedV1';
const WEEKLY_BASELINE_KEY = 'tokendeskWeeklyQuotaBaselineV1';
let statsWriteChain = Promise.resolve();
let lastPrunedWeek = null;

function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// The browser's local calendar week: Monday through Sunday.
function currentWeekDayKeys(now = new Date()) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const keys = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    keys.push(localDayKey(day));
  }
  return keys;
}

function weekStartKey(date = new Date()) {
  return currentWeekDayKeys(date)[0];
}

// Keep this week only. Old-week values never carry into a new Monday.
function pruneDayMap(input, now = new Date()) {
  const allowed = new Set(currentWeekDayKeys(now));
  const today = localDayKey(now);
  const out = {};
  for (const key of Object.keys(input || {})) {
    if (!allowed.has(key) || key > today) continue;
    const value = Number(input[key]);
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

// New active-session tracker: union of intervals for foreground engagement
// and verified background model work. It is monotonic and deduplicated across
// multiple ChatGPT tabs. Legacy foreground readings remain as historical
// baseline so upgrading never erases already collected usage.
function pruneSessionIntervals(input, now = new Date()) {
  const allowed = new Set(currentWeekDayKeys(now));
  const result = {};
  for (const [day, ranges] of Object.entries(input || {})) {
    if (!allowed.has(day) || day > localDayKey(now) || !Array.isArray(ranges)) continue;
    result[day] = ranges.filter(r => Array.isArray(r) && r.length === 2 &&
      Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]);
  }
  return result;
}

function mergeUsageRange(ranges, start, end) {
  const sorted = [...ranges, [start,end]].sort((a,b)=>a[0]-b[0]);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length-1];
    if (last && last[1] >= interval[0]) {
      last[1] = Math.max(last[1],interval[1]);
    } else merged.push([...interval]);
  }
  return merged;
}

function queueSessionInterval(startAt, endAt) {
  statsWriteChain = statsWriteChain.then(async () => {
    const stored = await chrome.storage.local.get({
      [SESSION_INTERVAL_KEY]:{},
      [SESSION_MIGRATION_KEY]:null,
      [ACTIVE_USAGE_KEY]:{}
    });
    // The first interval defines the switch from legacy accumulated seconds
    // to timestamped wall-clock intervals. Freeze the old totals at this
    // point, otherwise mixed v1.8.8 / v1.8.9 scripts double-count time.
    const existing = stored[SESSION_MIGRATION_KEY];
    const migrationAt = existing && Number.isFinite(existing.at)
      ? existing.at : startAt;
    const baseline = existing && existing.legacy && typeof existing.legacy === 'object'
      ? existing.legacy : pruneDayMap(stored[ACTIVE_USAGE_KEY]);
    const map = pruneSessionIntervals(stored[SESSION_INTERVAL_KEY]);
    let start = Math.max(startAt,migrationAt);
    const currentWeek = new Set(currentWeekDayKeys());
    while (start < endAt) {
      const date = new Date(start);
      const nextMidnight = new Date(date.getFullYear(),date.getMonth(),date.getDate()+1).getTime();
      const end = Math.min(endAt,nextMidnight);
      const day = localDayKey(date);
      if (currentWeek.has(day) && day <= localDayKey()) {
        map[day] = mergeUsageRange(map[day] || [],start,end);
      }
      start = end;
    }
    await chrome.storage.local.set({
      [SESSION_INTERVAL_KEY]:pruneSessionIntervals(map),
      [SESSION_MIGRATION_KEY]:{at:migrationAt,legacy:pruneDayMap(baseline)}
    });
  }).catch(()=>{});
  return statsWriteChain;
}

function queueActiveUsage(dayKey, seconds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey || '') ||
      !Number.isInteger(seconds) || seconds <= 0 || seconds > 30) {
    return statsWriteChain;
  }
  statsWriteChain = statsWriteChain.then(async () => {
    const stored = await chrome.storage.local.get({
      [ACTIVE_USAGE_KEY]:{},
      [SESSION_MIGRATION_KEY]:null
    });
    // Ignore legacy heartbeats after the interval tracker has taken over;
    // keep the snapshot captured during migration rather than counting twice.
    if (stored[SESSION_MIGRATION_KEY]) return;
    const map = pruneDayMap(stored[ACTIVE_USAGE_KEY]);
    // Ignore delayed previous-week heartbeats after Monday's reset.
    if (!currentWeekDayKeys().includes(dayKey) || dayKey > localDayKey()) return;
    map[dayKey] = Math.min(24 * 60 * 60, Math.max(0, Math.round((map[dayKey] || 0) + seconds)));
    await chrome.storage.local.set({[ACTIVE_USAGE_KEY]:pruneDayMap(map)});
  }).catch(() => {});
  return statsWriteChain;
}

function queueWeeklyQuotaSample(payload) {
  if (!good(payload?.weeklyRemaining)) return statsWriteChain;
  const remaining = payload.weeklyRemaining;
  const resetAt = goodStamp(payload.weeklyResetsAt) ? payload.weeklyResetsAt : null;
  const dayKey = localDayKey();

  statsWriteChain = statsWriteChain.then(async () => {
    const stored = await chrome.storage.local.get({
      [WEEKLY_USAGE_KEY]:{},
      [WEEKLY_BASELINE_KEY]:null
    });
    const map = pruneDayMap(stored[WEEKLY_USAGE_KEY]);
    const previous = stored[WEEKLY_BASELINE_KEY];
    // A Monday reporting-week boundary starts a new baseline even if the
    // underlying ChatGPT weekly quota itself resets on a different day.
    const sameReportingWeek = previous && Number.isFinite(Number(previous.at)) &&
      weekStartKey(new Date(Number(previous.at))) === weekStartKey();
    if (previous && good(previous.remaining) && sameReportingWeek) {
      const sameCycle = previous.resetAt && resetAt
        ? Number(previous.resetAt) === Number(resetAt)
        : true;
      if (sameCycle && remaining < previous.remaining) {
        const delta = previous.remaining - remaining;
        map[dayKey] = Math.min(500, Math.max(0, Math.round((map[dayKey] || 0) + delta)));
      }
    }
    await chrome.storage.local.set({
      [WEEKLY_USAGE_KEY]:pruneDayMap(map),
      [WEEKLY_BASELINE_KEY]:{remaining,resetAt,at:Date.now()}
    });
  }).catch(() => {});
  return statsWriteChain;
}

async function usageDaysSnapshot() {
  const week = weekStartKey();

  // At the start of a new local reporting week, physically discard last
  // week's stored daily totals. Serialization prevents a simultaneous usage
  // heartbeat from being overwritten by this housekeeping operation.
  if (lastPrunedWeek !== week) {
    statsWriteChain = statsWriteChain.then(async () => {
      const old = await chrome.storage.local.get({
        [ACTIVE_USAGE_KEY]:{},
        [WEEKLY_USAGE_KEY]:{},
        [SESSION_INTERVAL_KEY]:{},
        [SESSION_MIGRATION_KEY]:null
      });
      const migrated = old[SESSION_MIGRATION_KEY];
      await chrome.storage.local.set({
        [ACTIVE_USAGE_KEY]:pruneDayMap(old[ACTIVE_USAGE_KEY]),
        [WEEKLY_USAGE_KEY]:pruneDayMap(old[WEEKLY_USAGE_KEY]),
        [SESSION_INTERVAL_KEY]:pruneSessionIntervals(old[SESSION_INTERVAL_KEY]),
        [SESSION_MIGRATION_KEY]:migrated && Number.isFinite(migrated.at)
          ? {at:migrated.at,legacy:pruneDayMap(migrated.legacy)}
          : null
      });
    }).catch(() => {});
    lastPrunedWeek = week;
  }

  await statsWriteChain.catch(() => {});
  const stored = await chrome.storage.local.get({
    [ACTIVE_USAGE_KEY]:{},
    [WEEKLY_USAGE_KEY]:{},
    [SESSION_INTERVAL_KEY]:{},
    [SESSION_MIGRATION_KEY]:null
  });
  const migration = stored[SESSION_MIGRATION_KEY];
  const active = migration?.legacy ? pruneDayMap(migration.legacy) :
    pruneDayMap(stored[ACTIVE_USAGE_KEY]);
  const quota = pruneDayMap(stored[WEEKLY_USAGE_KEY]);
  const intervals = pruneSessionIntervals(stored[SESSION_INTERVAL_KEY]);
  return currentWeekDayKeys().map(day => ({
    day,
    activeSeconds: Math.max(0, Math.min(86_400, Math.round(
      (active[day] || 0) + (intervals[day] || [])
        .reduce((seconds, r) => seconds + (r[1]-r[0])/1000, 0)
    ))),
    weeklyQuotaUsed: Math.max(0, Math.min(500, Math.round(quota[day] || 0)))
  }));
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
  await queueWeeklyQuotaSample(payload);
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
const COMPLETED_NOTICE_SETTING = 'tokendeskTaskCompletionNoticeEnabledV1';
const COMPLETED_NOTICE_HISTORY = 'tokendeskTaskCompletionNoticeHistoryV1';
const COMPLETED_NOTICE_LINKS = 'tokendeskTaskCompletionNoticeLinksV1';
const COMPLETED_NOTICE_PREFIX = 'tokendesk-complete-';
const COMPLETED_NOTICE_DELAY_MS = 2500;
const completionPending = new Map();
const COMPLETION_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAB10lEQVR42u2bu3HDMAxAZZxnSJcJkhmiKktkCVWZIpWX8BKq7Blcp8tljKTSHU9HiQBIQCAJVi4sHd8jQIq/09Pzy9/QcYGh8+ICXEDn5Zzz8NvtywTEffxkP3uijgJWoEvJgJbgOXVER0DsxY+Piwno1+vEjgSUgDW8FfCUCIwEaAU+VjdMOkAr8FwJ0BI8RwJwXlijBP8SpAgIQ6bG1o/VfSsNPAJcgM8GbXy6HtXnnC1Ab/1PQwZYgi/1nCkBuRDSEsAyvIYEsA4/j5OoBKgBfh6nYR4nEQlgFX5LyO/Pdx8fQkvrr8v77dK+gC14831AifDfg19av2SaVTMXKB36JgVo5b26AExOa+a9qoBwLM/J+yoFrMGorSwNLy4gBoCVogFfXEBs/r4ngZv3JdcJVDpBTCQc0fqqwyAWShNeRMBeeKbgMPCll8lEIiBHgia8aApgJSy/U2KkFkhF+4CUhKPhVTrB3MpLL42rjAJcCI19AbWNkRCmy52hIyGbWBBxAZoCwvN1GvtzUiWs+9aZQY8AqskaW58lYB0yNUmgHJndjYAaJVDPCydToCYJnMPSflyecmOkhgsTFHjyMJhzN8ciPDkCrEaE6qUpnwu4ABfgAloq/yec3yrH8jTrAAAAAElFTkSuQmCC';

function completionRunKey(task) {
  return task.id + ':' + task.startedAt;
}

function cancelPendingCompletion(taskId) {
  const pending = completionPending.get(taskId);
  if (!pending) return;
  clearTimeout(pending.timer);
  completionPending.delete(taskId);
}

function scheduleCompletionNotice(task, previous) {
  if (!task.completionVerified || !previous?.active ||
      previous.id !== task.id || !validChatGPTURL(previous.pageURL) ||
      !chrome.notifications?.create) return;
  const key = completionRunKey(previous);
  if (completionPending.has(task.id)) return;
  // Wait for a stable idle state; a new running heartbeat, navigation or
  // tab closure cancels the notification. Avoid transient Work handoffs.
  const timer = setTimeout(() => {
    completionPending.delete(task.id);
    showCompletionNotice(key,previous).catch(()=>{});
  },COMPLETED_NOTICE_DELAY_MS);
  completionPending.set(task.id,{timer, tabId:task.tabId, key});
}

async function showCompletionNotice(runKey, task) {
  const keys = await chrome.storage.local.get({
    [COMPLETED_NOTICE_SETTING]:true,
    [COMPLETED_NOTICE_HISTORY]:{},
    [COMPLETED_NOTICE_LINKS]:{}
  });
  if (keys[COMPLETED_NOTICE_SETTING] === false) return;
  const current = taskStates.get(task.tabId);
  if (current?.active && current.id === task.id) return;
  const now = Date.now();
  const oldHistory = keys[COMPLETED_NOTICE_HISTORY] || {};
  const history = Object.fromEntries(Object.entries(oldHistory)
    .filter(([,time]) => Number.isFinite(time) && now-time < 2*24*60*60*1000));
  if (history[runKey]) return;
  const noticeId = COMPLETED_NOTICE_PREFIX + now + '-' +
    Math.random().toString(36).slice(2,10);
  // Use generic text: task titles and answer content must not leak to
  // operating system lock-screen notifications.
  await chrome.notifications.create(noticeId,{
    type:'basic',iconUrl:COMPLETION_ICON,
    title:'ChatGPT 任务已完成',
    message:'任务已完成，注意查看。点击打开对应对话。',
    priority:1
  });
  const oldLinks = keys[COMPLETED_NOTICE_LINKS] || {};
  const links = Object.fromEntries(Object.entries(oldLinks)
    .filter(([,entry]) => entry && Number.isFinite(entry.at) &&
      now-entry.at < 2*24*60*60*1000 && validChatGPTURL(entry.url)));
  links[noticeId] = {url:task.pageURL,at:now,tabId:task.tabId};
  history[runKey] = now;
  await chrome.storage.local.set({
    [COMPLETED_NOTICE_HISTORY]:history,
    [COMPLETED_NOTICE_LINKS]:links
  });
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener(async noticeId => {
    if (!noticeId.startsWith(COMPLETED_NOTICE_PREFIX)) return;
    const data = await chrome.storage.local.get({[COMPLETED_NOTICE_LINKS]:{}});
    const entry = data[COMPLETED_NOTICE_LINKS]?.[noticeId];
    if (!entry || !validChatGPTURL(entry.url)) return;
    try {
      const tab = await chrome.tabs.get(entry.tabId);
      if (tab && validChatGPTURL(tab.url) && tab.url === entry.url) {
        await chrome.tabs.update(tab.id,{active:true});
        if (Number.isInteger(tab.windowId)) await chrome.windows.update(tab.windowId,{focused:true});
      } else await chrome.tabs.create({url:entry.url});
    } catch {
      await chrome.tabs.create({url:entry.url});
    }
    chrome.notifications.clear(noticeId).catch(()=>{});
  });
}


const observedModels = new Map();
const MODEL_OBSERVATION_TTL_MS = 2 * 60 * 60 * 1000;
const TASK_HEARTBEAT_GRACE_MS = 150_000; // Chrome throttles hidden tabs; 45s was too strict.

// A conversation's confirmed model can arrive before its run state or before
// a DOM redraw. Preserve that nonempty observation so subsequent empty UI
// updates cannot erase a model actually seen in the network response.
function preserveTaskModel(task) {
  const now = Date.now();
  for (const [id, observed] of observedModels) {
    if (now-observed.at > MODEL_OBSERVATION_TTL_MS) observedModels.delete(id);
  }
  const existing = observedModels.get(task.id);
  const confirmed = /^(?:gpt-[a-z0-9][a-z0-9._-]*|o[1-9][a-z0-9._-]*)$/i.test(task.model);
  const selected = /^请求模型：(gpt-[a-z0-9][a-z0-9._-]*|o[1-9][a-z0-9._-]*)$/i.test(task.model);
  if (confirmed) observedModels.set(task.id,{model:task.model,rank:2,at:now});
  else if (selected && (!existing || existing.rank < 2)) {
    observedModels.set(task.id,{model:task.model,rank:1,at:now});
  } else if ((!task.model || task.model.startsWith('模式：')) &&
             existing && now-existing.at < MODEL_OBSERVATION_TTL_MS) {
    task.model = existing.model;
  } else if (selected && existing?.rank === 2) task.model = existing.model;
  return task;
}

const unverifiedTasks = new Map();
// Retain the last known task for up to two hours after its page disappears.
// This is a *pending verification* entry, NEVER a claim of live cloud work.
const UNVERIFIED_RETENTION_MS = 2 * 60 * 60 * 1000;
const UNVERIFIED_STORAGE_KEY = 'tokenDeskUnverifiedTasks_v1';
let unverifiedHydrated = false;
let unverifiedWriteQueue = Promise.resolve();

async function hydrateUnverifiedTasks() {
  if (unverifiedHydrated) return;
  const stored = await chrome.storage.local.get({[UNVERIFIED_STORAGE_KEY]:[]});
  const now = Date.now();
  const saved = stored[UNVERIFIED_STORAGE_KEY];
  for (const task of Array.isArray(saved) ? saved.slice(0, 32) : []) {
    if (!task || typeof task.id !== 'string' || !task.id ||
        typeof task.pageURL !== 'string' || !validChatGPTURL(task.pageURL) ||
        task.phase !== 'unverified' || !Number.isFinite(task.verificationExpiresAt) ||
        task.verificationExpiresAt <= now) continue;
    if (!unverifiedTasks.has(task.id)) unverifiedTasks.set(task.id, task);
  }
  unverifiedHydrated = true;
}

function saveUnverifiedTasks() {
  unverifiedWriteQueue = unverifiedWriteQueue
    .then(async () => {
      await hydrateUnverifiedTasks();
      await chrome.storage.local.set({
        [UNVERIFIED_STORAGE_KEY]: [...unverifiedTasks.values()]
          .filter(task => task.verificationExpiresAt > Date.now()).slice(0, 32)
      });
    }).catch(()=>{});
}


function detachTask(tabId) {
  const task = taskStates.get(tabId);
  if (!task) return false;
  taskStates.delete(tabId);
  unverifiedTasks.set(task.id, {
    ...task, phase:'unverified', lastSeenAt:Date.now(),
    verificationExpiresAt:Date.now()+UNVERIFIED_RETENTION_MS
  });
  saveUnverifiedTasks();
  return true;
}

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
  const model = typeof p.model === 'string' ? p.model.replace(/\s+/g,' ').trim().slice(0,64) : '';
  const usageDay = typeof p.usageDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.usageDay) ? p.usageDay : '';
  const usageSeconds = Number.isInteger(p.usageSeconds) && p.usageSeconds >= 0 && p.usageSeconds <= 30 ? p.usageSeconds : 0;
  return {
    tabId: sender.tab.id,
    id: p.id,
    active: p.active,
    unverified: p.unverified === true,
    completionVerified: p.completionVerified === true,
    phase: p.phase === 'thinking' ? 'thinking' : 'working',
    model,
    usageDay,
    usageSeconds,
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
    if (!task.active || now-task.lastSeenAt > TASK_HEARTBEAT_GRACE_MS) {
      detachTask(tabId);
      continue;
    }
    const previous = dedup.get(task.id);
    if (!previous || task.lastSeenAt > previous.lastSeenAt) dedup.set(task.id, task);
  }
  for (const [id, task] of unverifiedTasks) {
    if (now > task.verificationExpiresAt) {
      unverifiedTasks.delete(id);
      saveUnverifiedTasks();
      continue;
    }
    if (!dedup.has(id)) dedup.set(id, task);
  }
  return [...dedup.values()].sort((a,b)=>a.startedAt-b.startedAt).slice(0,20);
}

async function sendTasksSnapshot() {
  await hydrateUnverifiedTasks();
  const {pairingCode} = await chrome.storage.local.get({pairingCode:''});
  if (!/^[0-9a-f]{64}$/i.test(pairingCode)) return {ok:false,message:'任务监控等待配对。'};
  const tasks = currentTasks();
  const usageDays = await usageDaysSnapshot();
  const payload = {
    observedAt: Math.floor(Date.now()/1000),
    usageDays,
    tasks: tasks.map(t=>({
      id:t.id,phase:t.phase === 'unverified' ? 'unverified' : (t.phase === 'thinking' ? 'thinking' : 'working'),
      // Keep the true model source unchanged in taskStates. Use a UI-only
      // placeholder so existing macOS clients never silently hide this row.
      // Unknown is NOT a model inference and never enters the model cache.
      model:t.model || '未识别（未收到模型标识）',
      title:t.title || 'ChatGPT 任务',pageURL:t.pageURL,
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

// Read strictly sanitized model-picker diagnostic status from open ChatGPT
// tabs. Do not access chat messages or export titles, URLs or account details.
async function diagnoseOpenModelPickers() {
  const version = typeof chrome.runtime.getManifest === 'function'
    ? chrome.runtime.getManifest().version : 'unknown';
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
  });
  const reports = await Promise.all(tabs.slice(0, 12).map(async (tab, index) => {
    const entry = { tab: index + 1, status: 'content-script-missing' };
    if (!Number.isInteger(tab.id)) return entry;
    try {
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'TOKEN_DESK_MODEL_DIAGNOSTIC'
      });
      if (!result || result.ok !== true) return entry;
      return {
        tab: index + 1,
        status: result.reason || 'unknown',
        scriptVersion: String(result.scriptVersion || 'old'),
        activeTask: result.activeTask === true,
        model: String(result.model || '').slice(0, 64),
        lastModel: String(result.lastModel || '').slice(0, 64),
        modelSource: result.modelSource === 'resolved_model_slug' ? 'resolved_model_slug'
          : result.modelSource === 'request_body' ? 'request_body' : 'page-selector',
        conversationFetchSeen: Math.max(0, Math.min(1000, Number(result.conversationFetchSeen) || 0)),
        streamSeen: Math.max(0, Math.min(1000, Number(result.streamSeen) || 0)),
        lastStreamStatus: typeof result.lastStreamStatus === 'string'
          ? result.lastStreamStatus.slice(0, 32) : 'not-observed',
        hookStatus: result.hookStatus === 'connected' ? 'connected' : 'not-connected',
        hookVersion: typeof result.hookVersion === 'string' ?
          result.hookVersion.slice(0,20) : '',
        hookFetchActive: result.hookFetchActive === true,
        streamOpen: result.streamOpen === true,
        streamTerminalSeen: result.streamTerminalSeen === true,
        pickerCount: Math.max(0, Math.min(12, Number(result.pickerCount) || 0)),
        visiblePickerCount: Math.max(0, Math.min(12, Number(result.visiblePickerCount) || 0)),
        recognizedPills: Array.isArray(result.recognizedPills)
          ? result.recognizedPills.filter(v => typeof v === 'string').slice(0, 3).map(s => s.slice(0, 64))
          : [],
        taggedAssistantMessages: Math.max(0, Math.min(100, Number(result.taggedAssistantMessages) || 0))
      };
    } catch {
      return entry;
    }
  }));
  return { ok: true, version, tabCount: tabs.length, reports };
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
  if(message?.type==='TOKEN_DESK_DIAGNOSE_MODELS') {
    diagnoseOpenModelPickers()
      .then(sendResponse)
      .catch(()=>sendResponse({ok:false,message:'模型诊断无法读取已打开的 ChatGPT 标签页。'}));
    return true;
  }
  // Active-use time is reported independently of the running-task detector:
  // an ordinary focused ChatGPT conversation should count even when no
  // Thinking / Working task is active.
  if(message?.type==='TOKEN_DESK_SESSION_INTERVAL') {
    if (!Number.isInteger(sender?.tab?.id) || !validChatGPTURL(sender?.url || '')) return false;
    const p = message.payload || {};
    const startAt = Number(p.startAt), endAt = Number(p.endAt);
    const now = Date.now();
    if (!Number.isInteger(startAt) || !Number.isInteger(endAt) ||
        endAt <= startAt || endAt-startAt > 60_000 ||
        startAt < now-90_000 || endAt > now+5000 ||
        !['foreground','task'].includes(p.reason)) return false;
    queueSessionInterval(startAt,endAt).finally(() => scheduleTaskPublish());
    sendResponse({ok:true});
    return false;
  }
  if(message?.type==='TOKEN_DESK_ACTIVE_USAGE') {
    if (!Number.isInteger(sender?.tab?.id) || !validChatGPTURL(sender?.url || '')) return false;
    const p = message.payload || {};
    const dayKey = typeof p.usageDay === 'string' ? p.usageDay : '';
    const seconds = p.usageSeconds;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) ||
        !Number.isInteger(seconds) || seconds < 1 || seconds > 30) return false;
    queueActiveUsage(dayKey, seconds).finally(() => scheduleTaskPublish());
    sendResponse({ok:true});
    return false;
  }
  if(message?.type==='TOKEN_DESK_TASK_STATE') {
    const task = sanitizeTaskMessage(message, sender);
    if (!task) return false;
    preserveTaskModel(task);
    const previous = taskStates.get(task.tabId);
    if (task.active) {
      cancelPendingCompletion(task.id);
      taskStates.set(task.tabId, task);
      if (unverifiedTasks.delete(task.id)) saveUnverifiedTasks();
    } else if (task.unverified) {
      cancelPendingCompletion(task.id);
      detachTask(task.tabId);
    } else {
      if (task.completionVerified) scheduleCompletionNotice(task,previous);
      else cancelPendingCompletion(task.id);
      taskStates.delete(task.tabId);
      if (unverifiedTasks.delete(task.id)) saveUnverifiedTasks();
    }
    queueActiveUsage(task.usageDay, task.usageSeconds)
      .finally(() => scheduleTaskPublish());
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
    for (const [taskId,entry] of completionPending) {
      if (entry.tabId === tabId) cancelPendingCompletion(taskId);
    }
    if (detachTask(tabId)) scheduleTaskPublish();
  });
}
if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
    if (changeInfo.status==='loading' || changeInfo.url) {
      for (const [taskId,entry] of completionPending) {
        if (entry.tabId === tabId) cancelPendingCompletion(taskId);
      }
      if (detachTask(tabId)) scheduleTaskPublish();
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
  globalThis.__TOKEN_DESK_TEST_WEEK__ = { currentWeekDayKeys, weekStartKey, pruneDayMap };
  globalThis.__TOKEN_DESK_TEST_SESSION__ = {pruneSessionIntervals,mergeUsageRange,queueSessionInterval,usageDaysSnapshot};
}
