const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname + '/../Chrome_Extension/background.js','utf8');
const bridge = fs.readFileSync(__dirname + '/../BrowserBridge.swift','utf8');
assert(bridge.includes('OPTIONS /ingest HTTP/1.1'),'OPTIONS preflight supported');
assert(bridge.includes('Access-Control-Allow-Headers: Content-Type, X-TokenDesk-Key'),'CORS allow headers');
assert(bridge.includes('GET /health HTTP/1.1'),'health route present');
async function run(){
  let receiver; const storage = {pairingCode:'a'.repeat(64)}, requests=[];
  const noopEvent={addListener:()=>{}};
  const chrome = {
    runtime:{onMessage:{addListener:x=>{receiver=x}},onInstalled:noopEvent,onStartup:noopEvent},
    storage:{local:{async get(defaults){return {...defaults,...storage}},async set(props){Object.assign(storage,props)}}},
    alarms:{create:()=>{},onAlarm:noopEvent},
    tabs:{query:async()=>[],sendMessage:async()=>({})}
  };
  const fetch = async (url,args)=>{
    requests.push({url,args});
    if (url.endsWith('/health')) return {ok:true,status:200,json:async()=>({ok:true,app:'TokenDesk'})};
    return {ok:true,status:200};
  };
  vm.runInNewContext(code, {chrome,fetch,AbortController,Date,setTimeout,clearTimeout});
  async function msg(m,sender={url:'https://chatgpt.com/settings/usage'}){
    return await new Promise((resolve,reject)=>{
      if(!receiver(m,sender,resolve)) reject(new Error('message ignored'));
      setTimeout(()=>reject(new Error('response timeout')),1500);
    });
  }
  let a=await msg({type:'TOKEN_DESK_HEALTH'}); assert.strictEqual(a.ok,true);
  a=await msg({type:'TOKEN_DESK_WEB_USAGE',payload:{
    pageURL:'https://chatgpt.com/settings/usage',source:'network',fiveHourRemaining:66,weeklyRemaining:95,
    fiveHourResetsAt:1790000000,weeklyResetsAt:1790500000,availableResets:3
  }});
  assert.strictEqual(a.ok,true);
  const p=JSON.parse(requests.at(-1).args.body);
  assert.strictEqual(p.source,'network'); assert.strictEqual(p.availableResets,3);
  assert.strictEqual(p.fiveHourRemaining,66); assert.strictEqual(p.weeklyResetsAt,1790500000);
  assert.strictEqual(requests.at(-1).args.headers['X-TokenDesk-Key'],'a'.repeat(64));
  delete storage.pairingCode;
  a=await msg({type:'TOKEN_DESK_WEB_USAGE',payload:{pageURL:'https://chatgpt.com/',fiveHourRemaining:65}});
  assert.strictEqual(a.ok,false); assert(a.message.includes('尚未配对'));
  console.log('PASS: Chrome bridge (health, network submit, reset times, pairing)');
}
run().catch(e=>{console.error(e);process.exit(1)});
