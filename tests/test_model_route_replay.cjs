const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(__dirname+'/../Chrome_Extension/network-hook.js','utf8');
const events=[];
const listeners={};
const location={origin:'https://chatgpt.com',href:'https://chatgpt.com/c/a',pathname:'/c/a'};
const window={
  XMLHttpRequest:null,
  async fetch(input,init) {
    const raw = typeof init?.body==='string' ? init.body : await input.clone().text();
    const slug=JSON.parse(raw).model;
    return new Response('data: '+JSON.stringify({
      message:{metadata:{resolved_model_slug:slug},content:{parts:['private answer']}}
    })+'\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
  },
  addEventListener(type,handler){listeners[type]=handler;},
  postMessage(msg){events.push(msg);}
};
const ctx={window,location,URL,Request,Response,TextDecoder,
  setTimeout,clearTimeout,setInterval:()=>{},console,__TOKEN_DESK_TEST__:true};
vm.runInNewContext(code,ctx);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function requestModel(slug,viaRequest=false){
  const endpoint='https://chatgpt.com/backend-api/f/conversation';
  const opts={method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model:slug,prompt:'private prompt'})};
  const input=viaRequest?new Request(endpoint,opts):endpoint;
  const result=await window.fetch(input,viaRequest?undefined:opts);
  await result.text();
  await sleep(45);
}
function ping(){
  const from=events.length;
  listeners.message({source:window,origin:location.origin,
    data:{channel:'TOKEN_DESK_NETWORK_V1',type:'TOKEN_DESK_HOOK_PING'}});
  return events.slice(from).filter(x=>x.type==='MODEL' || x.type==='REQUEST_MODEL');
}
(async()=>{
  await requestModel('gpt-6-thinking');
  location.pathname='/c/b';location.href='https://chatgpt.com/c/b';
  await requestModel('gpt-6-instant',true); // fetch(Request) must preserve route
  assert(events.some(x=>x.type==='REQUEST_MODEL'&&
    x.route==='/c/b'&&x.model==='gpt-6-instant'),'Request-backed model signal should carry route');
  const records=ctx.__TOKEN_DESK_TEST_MODEL_ROUTES__();
  assert.equal(records.length,2,'one record per chat rather than one global last signal');
  assert(records.some(x=>x.route==='/c/a'&&x.model==='gpt-6-thinking'&&x.type==='MODEL'));
  assert(records.some(x=>x.route==='/c/b'&&x.model==='gpt-6-instant'&&x.type==='MODEL'));
  location.pathname='/c/a';location.href='https://chatgpt.com/c/a';
  assert.deepEqual(ping().map(x=>x.model),['gpt-6-thinking'],
    'late listener on chat A must receive A, not the more recent chat B model');
  location.pathname='/c/b';location.href='https://chatgpt.com/c/b';
  assert.deepEqual(ping().map(x=>x.model),['gpt-6-instant']);
  location.pathname='/c/c';location.href='https://chatgpt.com/c/c';
  assert.equal(ping().length,0,'unrelated chat C cannot inherit a known model');
  assert(!JSON.stringify(events).includes('private'));
  console.log('PASS concurrent conversation model caches, Request model route and replay isolation');
})().catch(e=>{console.error(e);process.exitCode=1;});
