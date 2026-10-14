const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/../Chrome_Extension/task-monitor.js','utf8');
const noop=()=>{};
const messages=[];
const windowListeners={};
const pageWindow={addEventListener:(name,fn)=>{windowListeners[name]=fn;}};
const sandbox={
  globalThis:{__TOKEN_DESK_TASK_TEST__:true},window:pageWindow,
  document:{documentElement:null,addEventListener:noop},
  location:{pathname:'/c/test',origin:'https://chatgpt.com',href:'https://chatgpt.com/c/test'},
  chrome:{runtime:{onMessage:{addListener:noop},sendMessage:(m)=>{messages.push(m);return Promise.resolve();},lastError:null}},
  MutationObserver:function(){this.observe=noop;},
  addEventListener:noop,setInterval:noop,setTimeout:noop,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
  console
};
sandbox.__TOKEN_DESK_TASK_TEST__=true; sandbox.globalThis=sandbox;
vm.createContext(sandbox); vm.runInContext(src,sandbox);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_STATUS__('Working…'),true);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_STATUS__('正在思考…'),true);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_PHASE__('正在思考…'),'thinking');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_PHASE__('Thinking'),'thinking');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_PHASE__('正在工作'),'working');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_PHASE__('Working'),'working');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_STATUS__('finished'),false);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_ACTION__('Stop generating'),true);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_ACTION__('停止任务'),true);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_ACTION__('Cancel'),false);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('GPT-5.6 Sol'),'GPT-5.6 Sol');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('Model: GPT-5.6 Thinking'),'GPT-5.6 Thinking');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('ChatGPT'),null);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('GPT-6 Thinking'),'GPT-6 Thinking');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('6Pro'),'模式：6Pro');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('Instant'),'模式：Instant');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('Thinking'),'模式：Thinking');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('均衡'),'模式：均衡');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('最新的'),'模式：最新的');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_MODEL__('Select ChatGPT model'),null);
// Simulate the Sept 2026 ChatGPT composer: picker has no data-testid or
// aria-label; only the __composer-pill class and text "6Pro".
let pill=null;
let checked=null;
function fakeNode(text, attrs={}) {
  return {
    isConnected:true,
    textContent:text,
    getAttribute:key=>attrs[key] ?? null,
    getBoundingClientRect:()=>({left:100,right:200,top:100,bottom:125,width:100,height:25})
  };
}
sandbox.innerWidth=1200;
sandbox.innerHeight=800;
sandbox.document.querySelectorAll = selector => {
  if (selector.includes('composer-intelligence-picker-content') && selector.includes('menuitemradio')) return checked?[checked]:[];
  if (selector.includes('__composer-pill')) return pill?[pill]:[];
  return [];
};
pill=fakeNode('6Pro');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_CURRENT_MODEL__(),'模式：6Pro');
pill=fakeNode('GPT-6 Thinking');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_CURRENT_MODEL__(),'GPT-6 Thinking');
pill=fakeNode('6Pro');
checked=fakeNode('GPT-6 Pro');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_CURRENT_MODEL__(),'GPT-6 Pro');
const report=sandbox.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__();
assert.strictEqual(report.scriptVersion,'1.8.8');
assert.strictEqual(report.reason,'recognized');
assert.strictEqual(report.model,'GPT-6 Pro');
assert.strictEqual(report.pickerCount,1);
assert.strictEqual(report.visiblePickerCount,1);
assert.strictEqual(report.taggedAssistantMessages,0);
assert.ok(!('title' in report) && !('url' in report),'diagnostics must exclude URLs and chat titles');
pill=null;checked=null;
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__().reason,'picker-absent');

// Page toolbars and old message text saying "Working" are never evidence of
// a currently running ChatGPT generation.
sandbox.document.querySelectorAll = selector => {
  if (selector === 'span,p,div') return [fakeNode('Working')];
  return [];
};
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_ACTIVE_PHASE__(),null);
const stopControl=fakeNode('Stop generating',{'aria-label':'Stop generating'});
stopControl.closest=()=>null;
stopControl.disabled=false;
sandbox.document.querySelectorAll = selector => {
  if (selector === 'button,[role="button"]') return [stopControl];
  return [];
};
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_ACTIVE_PHASE__(),'working');
sandbox.document.querySelectorAll=()=>[];

assert.strictEqual(typeof windowListeners.message,'function');
windowListeners.message({source:pageWindow,origin:'https://chatgpt.com',
  data:{channel:'TOKEN_DESK_NETWORK_V1',type:'MODEL_TRACE',status:'conversation-fetch-seen'}});
windowListeners.message({source:pageWindow,origin:'https://chatgpt.com',
  data:{channel:'TOKEN_DESK_NETWORK_V1',type:'MODEL_TRACE',status:'stream-observed'}});
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__().conversationFetchSeen,1);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__().streamSeen,1);
windowListeners.message({
  source:pageWindow,origin:'https://chatgpt.com',
  data:{channel:'TOKEN_DESK_NETWORK_V1',type:'MODEL',source:'resolved_model_slug',model:'gpt-6-thinking'}
});
const latest=messages.filter(m=>m.type==='TOKEN_DESK_TASK_STATE').at(-1);
assert(latest && latest.payload.model==='gpt-6-thinking','stream model must reach task snapshot');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__().modelSource,'resolved_model_slug');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__().model,'gpt-6-thinking');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__().lastStreamStatus,'model-found');
sandbox.location.pathname='/';
sandbox.location.href='https://chatgpt.com/';
sandbox.__TOKEN_DESK_TASK_TEST_SEND__(true);
windowListeners.message({source:pageWindow,origin:'https://chatgpt.com',
  data:{channel:'TOKEN_DESK_NETWORK_V1',type:'MODEL',source:'resolved_model_slug',model:'gpt-6-thinking'}});
sandbox.location.pathname='/c/new-chat-id';
sandbox.location.href='https://chatgpt.com/c/new-chat-id';
sandbox.__TOKEN_DESK_TASK_TEST_SEND__(true);
assert.strictEqual(messages.filter(m=>m.type==='TOKEN_DESK_TASK_STATE').at(-1).payload.model,
  'gpt-6-thinking','new-chat redirect must preserve fresh stream model');
sandbox.location.pathname='/g/g-p-example-project';
sandbox.location.href='https://chatgpt.com/g/g-p-example-project';
sandbox.__TOKEN_DESK_TASK_TEST_SEND__(true);
windowListeners.message({source:pageWindow,origin:'https://chatgpt.com',
  data:{channel:'TOKEN_DESK_NETWORK_V1',type:'MODEL',source:'resolved_model_slug',model:'gpt-6-thinking'}});
sandbox.location.pathname='/g/g-p-example-project/c/new-project-chat';
sandbox.location.href='https://chatgpt.com/g/g-p-example-project/c/new-project-chat';
sandbox.__TOKEN_DESK_TASK_TEST_SEND__(true);
assert.strictEqual(messages.filter(m=>m.type==='TOKEN_DESK_TASK_STATE').at(-1).payload.model,
  'gpt-6-thinking','project new-chat redirect must preserve network model');

sandbox.location.pathname='/c/unrelated-conversation';
sandbox.location.href='https://chatgpt.com/c/unrelated-conversation';
sandbox.__TOKEN_DESK_TASK_TEST_SEND__(true);
assert.strictEqual(messages.filter(m=>m.type==='TOKEN_DESK_TASK_STATE').at(-1).payload.model,
  '','navigating to a different existing chat must clear the previous model');

// A different SPA conversation must not inherit the prior model.
sandbox.location.pathname='/c/another';
sandbox.location.href='https://chatgpt.com/c/another';
// Test hook receives only the stream value in the previous conversation.
windowListeners.message({source:pageWindow,origin:'https://evil.example',
  data:{channel:'TOKEN_DESK_NETWORK_V1',type:'MODEL',source:'resolved_model_slug',model:'gpt-9-evil'}});
assert.strictEqual(messages.filter(m=>m.type==='TOKEN_DESK_TASK_STATE').at(-1).payload.model,'');




// Total ChatGPT usage includes focused browsing and confirmed hidden work,
// but excludes an idle hidden tab. Timing is reported as wall-clock intervals.
sandbox.document.visibilityState='visible';
sandbox.document.hasFocus=()=>true;
const t0=Date.now();
const foreground=sandbox.__TOKEN_DESK_TASK_TEST_USAGE_INTERVAL__(t0+10000);
assert(foreground && foreground.reason==='foreground', 'focused chat should count');
sandbox.document.visibilityState='hidden';
sandbox.document.hasFocus=()=>false;
const onBlur=sandbox.__TOKEN_DESK_TASK_TEST_USAGE_INTERVAL__(t0+20000);
assert(onBlur && onBlur.reason==='foreground','last focused interval must flush on blur');
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_USAGE_INTERVAL__(t0+30000),null,
  'idle hidden tab must not earn session time');
sandbox.document.querySelectorAll = selector =>
  selector==='button,[role="button"]'?[stopControl]:[];
sandbox.__TOKEN_DESK_TASK_TEST_SEND__(true);
const background=sandbox.__TOKEN_DESK_TASK_TEST_USAGE_INTERVAL__(t0+40000);
assert(background && background.reason==='task',
  'confirmed Working task must count while browser tab is hidden');
sandbox.document.querySelectorAll=()=>[];
sandbox.__TOKEN_DESK_TASK_TEST_SEND__(true);
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_USAGE_INTERVAL__(t0+50000),null,
  'completed hidden task must stop counting');

// Regression: generic Work-mode/running DOM markers must not be treated as proof
// that a ChatGPT task is actively running.
assert.strictEqual(src.includes('[data-testid*="working"]'), false, 'idle Work-mode UI markers must not trigger working');
assert.strictEqual(src.includes('[data-testid*="running"]'), false, 'generic running testids must not trigger working');
assert.strictEqual(src.includes('button[data-testid*="stop"][aria-label]'), false, 'broad stop selector must stay removed');
console.log('PASS task-monitor');
