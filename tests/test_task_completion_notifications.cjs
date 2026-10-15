const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/../Chrome_Extension/background.js','utf8');
const storage={pairingCode:'a'.repeat(64)};
const notificationEvents={}; const notifications=[];
const activated=[]; const opened=[];
let taskReceiver, tabRemoved;
const event={addListener(){}};
const chrome={
  runtime:{onMessage:{addListener(fn){taskReceiver=fn;}},onInstalled:event,onStartup:event},
  storage:{local:{
    async get(defaults){return {...defaults,...storage};},
    async set(data){Object.assign(storage,data);}
  }},
  alarms:{create(){},onAlarm:event},
  notifications:{
    onClicked:{addListener(fn){notificationEvents.click=fn;}},
    async create(id,opts){notifications.push({id,opts});return id;},
    async clear(){return true;}
  },
  tabs:{
    query:async()=>[],sendMessage:async()=>({}),
    get:async id=>({id,url:'https://chatgpt.com/c/test',windowId:1}),
    update:async(id,opts)=>{activated.push({id,opts});},
    create:async opts=>{opened.push(opts);},
    onRemoved:{addListener(fn){tabRemoved=fn;}},onUpdated:event
  },
  windows:{update:async()=>{}},
  scripting:{executeScript:async()=>{}}
};
const fetch=async(url,opts={})=>{
  if(String(url)==='http://127.0.0.1:18743/tasks')return {ok:true,status:200};
  if(String(url).endsWith('/api/auth/session'))return {ok:false,status:401,text:async()=>''};
  if(String(url).includes('/usage'))return {ok:false,status:401,text:async()=>''};
  throw Error(String(url));
};
const context={chrome,fetch,AbortController,Date,
  setTimeout(fn,delay,...args){return setTimeout(fn,delay===900?50:delay,...args);},
  clearTimeout,Response,console};
vm.runInNewContext(source,context);
const startedAt=Math.floor(Date.now()/1000)-15;
function send(active,verified=false,overrides={}){
  let answer;
  const payload={id:'c:test',active,completionVerified:verified,
    phase:'thinking',title:'Private research topic',model:'gpt-6-thinking',
    pageURL:'https://chatgpt.com/c/test',
    startedAt,lastSeenAt:Math.floor(Date.now()/1000),
    ...overrides};
  taskReceiver({type:'TOKEN_DESK_TASK_STATE',payload},
    {url:'https://chatgpt.com/c/test',tab:{id:7}},r=>{answer=r;});
  assert(answer?.ok);
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  send(false,true); await wait(90);
  assert.equal(notifications.length,0,'idle first sighting must not notify');
  send(true);send(false,false);
  await wait(90);assert.equal(notifications.length,0,'missing positive completion must not notify');
  send(true);send(false,true);
  await wait(110);
  assert.equal(notifications.length,1,'confirmed completion should notify once');
  assert.equal(notifications[0].opts.title,'ChatGPT 任务已完成');
  assert.equal(notifications[0].opts.message,'任务已完成，注意查看。点击打开对应对话。');
  assert(notifications[0].opts.iconUrl.startsWith('data:image/png;base64,'));
  assert(!JSON.stringify(notifications).includes('Private research topic'),
    'notification must not leak task title');
  send(true);send(false,true);await wait(110);
  assert.equal(notifications.length,1,'same run must not notify twice');
  await notificationEvents.click(notifications[0].id);
  assert.equal(activated.length,1,'click should activate the original tab');
  assert.equal(opened.length,0);
  // A new run is allowed to notify, but continuing work before the delay
  // expires must cancel the pending completion.
  const secondRun={startedAt:startedAt+20};
  send(true,false,secondRun);send(false,true,secondRun);
  send(true,false,secondRun);
  await wait(100);
  assert.equal(notifications.length,1,'resume / handoff cancels pending notice');
  // A closed tab is not a completed task.
  send(false,true,secondRun);tabRemoved(7);
  await wait(110);assert.equal(notifications.length,1,'tab close cancels pending notice');
  // Setting off should prevent the notification even after confirmation.
  storage.tokendeskTaskCompletionNoticeEnabledV1=false;
  const thirdRun={startedAt:startedAt+40};
  send(true,false,thirdRun);send(false,true,thirdRun);
  await wait(110);assert.equal(notifications.length,1,'user can disable reminders');
  storage.tokendeskTaskCompletionNoticeEnabledV1=true;
  const fourthRun={startedAt:startedAt+60};
  send(true,false,fourthRun);send(false,true,fourthRun);
  await wait(110);assert.equal(notifications.length,2,'a different run notifies once');
  console.log('PASS completion notifications: confirmed-only, no duplicates, canceled on resume/close, opt-out and deep-link click');
})().catch(err=>{console.error(err);process.exitCode=1;});
