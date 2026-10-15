const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/../Chrome_Extension/network-hook.js','utf8');
const events=[];
let releaseFetch;
const location={origin:'https://chatgpt.com',pathname:'/c/fast-task',href:'https://chatgpt.com/c/fast-task'};
const window={XMLHttpRequest:null,addEventListener(){},postMessage(message){events.push(message);},
  fetch(){return new Promise(resolve=>{releaseFetch=resolve;});}};
const ctx={window,location,URL,Request,Response,TextDecoder,console,
  setInterval:()=>{},setTimeout,clearTimeout,__TOKEN_DESK_TEST__:true};
vm.runInNewContext(source,ctx);
(async()=>{
  const call=window.fetch('https://chatgpt.com/backend-api/f/conversation',{
    method:'POST',body:JSON.stringify({model:'gpt-6-thinking',content:'private prompt'})});
  assert(events.some(e=>e.type==='TASK_REQUEST'&&e.status==='started'&&e.route==='/c/fast-task'),
    'start must be emitted synchronously before fetch response headers');
  assert(!JSON.stringify(events).includes('private prompt'),'no prompt may leak to bridge');

  const sse='data: '+JSON.stringify({message:{metadata:{resolved_model_slug:'gpt-6-thinking'}}})+'\n\n';
  releaseFetch(new Response(sse,{status:200,headers:{'content-type':'text/event-stream'}}));
  const response=await call;
  await response.text();
  await new Promise(resolve=>setTimeout(resolve,55));
  assert(events.some(e=>e.type==='TASK_STREAM'&&e.status==='open'));
  assert(events.some(e=>e.type==='TASK_STREAM'&&e.status==='closed'));
  assert(events.some(e=>e.type==='MODEL'&&e.model==='gpt-6-thinking'));
  assert(!JSON.stringify(events).includes('private prompt'));
  // A non-generation conversation GET must not start a task.
  const originalCount=events.filter(e=>e.type==='TASK_REQUEST'&&e.status==='started').length;
  const getCall=window.fetch('https://chatgpt.com/backend-api/conversation?limit=10',{method:'GET'});
  releaseFetch(new Response('{}',{status:200}));
  await getCall;
  assert.strictEqual(events.filter(e=>e.type==='TASK_REQUEST'&&e.status==='started').length,originalCount);
  console.log('PASS task request starts before server headers, completes on SSE close, GET is ignored');
})().catch(e=>{console.error(e);process.exitCode=1;});
