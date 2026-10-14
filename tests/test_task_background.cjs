const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(__dirname+'/../Chrome_Extension/background.js','utf8');
let receiver; let lastTaskBody=null; const storage={pairingCode:'a'.repeat(64)};
const evt={addListener:()=>{}};
const chrome={
  runtime:{onMessage:{addListener:x=>receiver=x},onInstalled:evt,onStartup:evt},
  storage:{local:{async get(d){return {...d,...storage}},async set(v){Object.assign(storage,v)}}},
  alarms:{create:()=>{},onAlarm:evt},
  tabs:{query:async()=>[],sendMessage:async()=>({}),onRemoved:evt,onUpdated:evt},
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
  sendTask(false); await new Promise(r=>setTimeout(r,250));
  assert.strictEqual(lastTaskBody.tasks.length,0);
  console.log('PASS task background aggregation');
})().catch(e=>{console.error(e);process.exit(1)});
