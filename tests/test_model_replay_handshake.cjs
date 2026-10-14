const fs=require('fs'),vm=require('vm'),assert=require('assert');
const mainSrc=fs.readFileSync(__dirname+'/../Chrome_Extension/network-hook.js','utf8');
const taskSrc=fs.readFileSync(__dirname+'/../Chrome_Extension/task-monitor.js','utf8');
const seen=[];
const bridge=[];
const location={origin:'https://chatgpt.com',href:'https://chatgpt.com/c/model-test',pathname:'/c/model-test'};
const window={
  XMLHttpRequest:null,
  fetch:async()=>new Response('data: '+JSON.stringify({
    message:{metadata:{resolved_model_slug:'gpt-6-thinking'},content:{parts:['private conversation']}}
  })+'\n\n',{status:200,headers:{'content-type':'text/event-stream'}}),
  addEventListener(type,handler){if(type==='message')seen.push(handler);},
  postMessage(data,origin){
    queueMicrotask(()=>{
      for(const handler of [...seen]) handler({source:window,origin,data});
    });
  }
};
const common={
  window,location,URL,Request,Response,TextDecoder,
  setTimeout,clearTimeout,setInterval:()=>0,clearInterval:()=>{},console
};
const main={...common,document:{visibilityState:'visible'},__TOKEN_DESK_TEST__:true};
vm.runInNewContext(mainSrc,main);
// Simulate the network response arriving BEFORE the isolated content script
// has attached its listener.
(async()=>{
  const response=await window.fetch('https://chatgpt.com/backend-api/f/conversation',
    {method:'POST',body:JSON.stringify({model:'gpt-6-thinking',prompt:'secret'})});
  await response.text();
  await new Promise(resolve=>setTimeout(resolve,70));
  const output={
    ...common,
    document:{documentElement:null,title:'Model probe - ChatGPT',
      querySelectorAll:()=>[],addEventListener(){}},
    chrome:{runtime:{lastError:null,onMessage:{addListener(){}},
      sendMessage(msg,reply){bridge.push(msg);reply?.({ok:true});return Promise.resolve();}}},
    MutationObserver:class{observe(){}},addEventListener(){},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    __TOKEN_DESK_TASK_TEST__:true
  };
  vm.runInNewContext(taskSrc,output);
  window.postMessage({channel:'TOKEN_DESK_NETWORK_V1',type:'TOKEN_DESK_HOOK_PING'},location.origin);
  await new Promise(resolve=>setTimeout(resolve,70));
  const report=output.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__();
  assert.strictEqual(report.hookStatus,'connected');
  assert.strictEqual(report.hookFetchActive,true);
  assert.strictEqual(report.model,'gpt-6-thinking','early model must replay');
  assert.strictEqual(report.modelSource,'resolved_model_slug');
  assert(bridge.some(x=>x.type==='TOKEN_DESK_TASK_STATE' &&
    x.payload.model==='gpt-6-thinking'));
  assert(!JSON.stringify(bridge).includes('secret'));
  assert(!JSON.stringify(bridge).includes('private conversation'));
  // Model events must be rejected when associated with another chat.
  window.postMessage({channel:'TOKEN_DESK_NETWORK_V1',type:'MODEL',
    source:'resolved_model_slug',model:'gpt-9-incorrect',route:'/c/old-chat'},location.origin);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.strictEqual(output.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__().model,'gpt-6-thinking');
  // A later replacement of fetch is visible to diagnostics without
  // silently calling the replacement an official model source.
  window.fetch=async()=>null;
  window.postMessage({channel:'TOKEN_DESK_NETWORK_V1',type:'TOKEN_DESK_HOOK_PING'},location.origin);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.strictEqual(output.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__().hookFetchActive,false);
  console.log('PASS main/isolated hook handshake, replay, provenance and cross-chat isolation');
})().catch(error=>{console.error(error);process.exitCode=1;});
