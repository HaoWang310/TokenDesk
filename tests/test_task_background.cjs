const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(__dirname+'/../Chrome_Extension/background.js','utf8');
let receiver; let lastTaskBody=null; const storage={pairingCode:'a'.repeat(64)};
const evt={addListener:()=>{}};let onTabRemoved=null;
const chrome={
  runtime:{onMessage:{addListener:x=>receiver=x},onInstalled:evt,onStartup:evt},
  storage:{local:{async get(d){return {...d,...storage}},async set(v){Object.assign(storage,v)}}},
  alarms:{create:()=>{},onAlarm:evt},
  tabs:{query:async()=>[],sendMessage:async()=>({}),onRemoved:{addListener:handler=>{onTabRemoved=handler;}},onUpdated:evt},
  scripting:{executeScript:async()=>{}}
};
const fetch=async(url,opts={})=>{
  url=String(url);
  if(url==='http://127.0.0.1:18743/tasks') { lastTaskBody=JSON.parse(opts.body); return {ok:true,status:200}; }
  if(url==='http://127.0.0.1:18743/health') return {ok:true,status:200,json:async()=>({ok:true,app:'TokenDesk'})};
  if(url.endsWith('/api/auth/session')) return {ok:false,status:401,text:async()=>'{"detail":"no"}'};
  if(url.includes('/usage')) return {ok:false,status:401,text:async()=>'{"detail":"no"}'};
  throw new Error('unexpected '+url);
};
vm.runInNewContext(code,{chrome,fetch,AbortController,Date,setTimeout,clearTimeout,Response,console});
function sendTask(active){
  let response=null;
  const ret=receiver({type:'TOKEN_DESK_TASK_STATE',payload:{
    id:'c:test',active,phase:'thinking',title:'Long analysis',pageURL:'https://chatgpt.com/c/test',
    startedAt:Math.floor(Date.now()/1000)-10,lastSeenAt:Math.floor(Date.now()/1000)
  }},{url:'https://chatgpt.com/c/test',tab:{id:7}},r=>response=r);
  assert.strictEqual(ret,false); assert(response && response.ok);
}
(async()=>{
  sendTask(true); await new Promise(r=>setTimeout(r,250));
  assert(lastTaskBody); assert.strictEqual(lastTaskBody.tasks.length,1); assert.strictEqual(lastTaskBody.tasks[0].title,'Long analysis'); assert.strictEqual(lastTaskBody.tasks[0].phase,'thinking');
  // Normal focused ChatGPT time must count even when no task is running.
  const today=new Date();
  const day=[today.getFullYear(),String(today.getMonth()+1).padStart(2,'0'),String(today.getDate()).padStart(2,'0')].join('-');
  let activityResponse=null;
  const activityRet=receiver({type:'TOKEN_DESK_ACTIVE_USAGE',payload:{
    usageDay:day,usageSeconds:10
  }},{url:'https://chatgpt.com/c/test',tab:{id:7}},r=>activityResponse=r);
  assert.strictEqual(activityRet,false);
  assert(activityResponse && activityResponse.ok);
  await new Promise(r=>setTimeout(r,300));
  const recorded=lastTaskBody.usageDays.find(d=>d.day===day);
  assert(recorded,'today should be present in the 7-day snapshot');
  assert.strictEqual(recorded.activeSeconds,10,'10 seconds of independent activity must reach Windows');
  // A malformed/forged active-usage packet must not be counted.
  const badRet=receiver({type:'TOKEN_DESK_ACTIVE_USAGE',payload:{
    usageDay:day,usageSeconds:300
  }},{url:'https://chatgpt.com/c/test',tab:{id:7}},()=>{});
  assert.strictEqual(badRet,false);
  await new Promise(r=>setTimeout(r,250));
  assert.strictEqual(lastTaskBody.usageDays.find(d=>d.day===day).activeSeconds,10);
  // Foreground use and background Thinking/Working describe wall-clock
  // intervals. Two tabs reporting the same interval must count ONCE.
  const endAt = Date.now()-15000, startAt=endAt-10000;
  const sendInterval=(tabId,start,end,reason)=>{
    let answer=null;
    const returned=receiver({type:'TOKEN_DESK_SESSION_INTERVAL',payload:{
      startAt:start,endAt:end,reason
    }},{url:'https://chatgpt.com/c/test',tab:{id:tabId}},r=>answer=r);
    assert.strictEqual(returned,false); assert(answer&&answer.ok);
  };
  sendInterval(7,startAt,endAt,'foreground');
  sendInterval(8,startAt,endAt,'task');
  await new Promise(r=>setTimeout(r,300));
  const afterOverlap=lastTaskBody.usageDays.find(d=>d.day===day).activeSeconds;
  assert(afterOverlap>=19 && afterOverlap<=21,
    'overlapping foreground and task time must only add one 10s interval');
  sendInterval(7,endAt,endAt+10000,'task');
  await new Promise(r=>setTimeout(r,300));
  const afterAdjacent=lastTaskBody.usageDays.find(d=>d.day===day).activeSeconds;
  assert(afterAdjacent>=29 && afterAdjacent<=31,
    'a nonoverlapping 10s task interval must add 10s to the daily total');
  // After migration, old-format heartbeats from an unrefreshed tab must not
  // add another ten seconds on top of already timestamped session coverage.
  assert(storage.tokendeskSessionMigrationV1 &&
    Number.isFinite(storage.tokendeskSessionMigrationV1.at));
  receiver({type:'TOKEN_DESK_ACTIVE_USAGE',
    payload:{usageDay:day,usageSeconds:10}
  },{url:'https://chatgpt.com/c/test',tab:{id:7}},()=>{});
  await new Promise(r=>setTimeout(r,300));
  const afterLegacyHeartbeat=lastTaskBody.usageDays.find(d=>d.day===day).activeSeconds;
  assert(afterLegacyHeartbeat>=29 && afterLegacyHeartbeat<=31,
    'legacy messages after migration must not double-count time');
  // Replaying exactly the same interval on another tab cannot add time.
  sendInterval(9,startAt,endAt,'task');
  await new Promise(r=>setTimeout(r,300));
  assert.strictEqual(lastTaskBody.usageDays.find(d=>d.day===day).activeSeconds,
    afterLegacyHeartbeat,'duplicate time intervals are idempotent');


  let diagnostics=null;
  const ret=receiver({type:'TOKEN_DESK_DIAGNOSE_MODELS'},{},r=>diagnostics=r);
  assert.strictEqual(ret,true);
  await new Promise(r=>setTimeout(r,100));
  assert(diagnostics && diagnostics.ok);
  assert.strictEqual(diagnostics.tabCount,0);
  assert(Array.isArray(diagnostics.reports) && diagnostics.reports.length === 0);
  // Closing the ChatGPT tab must NOT claim that cloud work stopped,
  // nor should the detached task be counted as confirmed live execution.
  assert.strictEqual(typeof onTabRemoved,'function');
  onTabRemoved(7);
  await new Promise(r=>setTimeout(r,250));
  assert.strictEqual(lastTaskBody.tasks.length,1);
  assert.strictEqual(lastTaskBody.tasks[0].phase,'unverified');
  assert(Array.isArray(storage.tokenDeskUnverifiedTasks_v1) &&
    storage.tokenDeskUnverifiedTasks_v1.some(t => t.id==='c:test'),
    'pending work must survive a Chrome service-worker restart');
  assert.strictEqual(lastTaskBody.tasks[0].title,'Long analysis');
  // Reopening the conversation and observing completion removes it.
  sendTask(false); await new Promise(r=>setTimeout(r,250));
  assert.strictEqual(lastTaskBody.tasks.length,0);
  assert(Array.isArray(storage.tokenDeskUnverifiedTasks_v1) &&
    storage.tokenDeskUnverifiedTasks_v1.length===0,
    'verified completion must remove persisted pending work');
  console.log('PASS task background aggregation');
})().catch(e=>{console.error(e);process.exit(1)});
