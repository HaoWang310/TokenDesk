const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/../Chrome_Extension/task-monitor.js','utf8');
const noop=()=>{};
const sandbox={
  globalThis:{__TOKEN_DESK_TASK_TEST__:true},
  document:{documentElement:null,addEventListener:noop},
  location:{pathname:'/c/test',origin:'https://chatgpt.com',href:'https://chatgpt.com/c/test'},
  chrome:{runtime:{onMessage:{addListener:noop},sendMessage:()=>Promise.resolve()}},
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
assert.strictEqual(report.scriptVersion,'1.8.4');
assert.strictEqual(report.reason,'recognized');
assert.strictEqual(report.model,'GPT-6 Pro');
assert.strictEqual(report.pickerCount,1);
assert.strictEqual(report.visiblePickerCount,1);
assert.strictEqual(report.taggedAssistantMessages,0);
assert.ok(!('title' in report) && !('url' in report),'diagnostics must exclude URLs and chat titles');
pill=null;checked=null;
assert.strictEqual(sandbox.__TOKEN_DESK_TASK_TEST_DIAGNOSTIC__().reason,'picker-absent');



// Regression: generic Work-mode/running DOM markers must not be treated as proof
// that a ChatGPT task is actively running.
assert.strictEqual(src.includes('[data-testid*="working"]'), false, 'idle Work-mode UI markers must not trigger working');
assert.strictEqual(src.includes('[data-testid*="running"]'), false, 'generic running testids must not trigger working');
assert.strictEqual(src.includes('button[data-testid*="stop"][aria-label]'), false, 'broad stop selector must stay removed');
console.log('PASS task-monitor');
