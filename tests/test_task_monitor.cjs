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

// Regression: generic Work-mode/running DOM markers must not be treated as proof
// that a ChatGPT task is actively running.
assert.strictEqual(src.includes('[data-testid*="working"]'), false, 'idle Work-mode UI markers must not trigger working');
assert.strictEqual(src.includes('[data-testid*="running"]'), false, 'generic running testids must not trigger working');
assert.strictEqual(src.includes('button[data-testid*="stop"][aria-label]'), false, 'broad stop selector must stay removed');
console.log('PASS task-monitor');
