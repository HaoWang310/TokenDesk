const fs = require('fs'), vm = require('vm'), assert = require('assert');
const code = fs.readFileSync(__dirname+'/../Chrome_Extension/network-hook.js','utf8');
const messages = [];
const location={origin:'https://chatgpt.com',href:'https://chatgpt.com/c/test',pathname:'/c/test'};
const window={
  fetch: async () => new Response([
    'data: '+JSON.stringify({message:{content:{parts:['assistant text mentioning resolved_model_slug:gpt-9-fake']}}})+'\n\n',
    'data: '+JSON.stringify({message:{metadata:{resolved_model_slug:'gpt-6-thinking'}}})+'\n\n'
  ].join(''),{status:200,headers:{'content-type':'text/event-stream'}}),
  XMLHttpRequest:null,
  addEventListener(){},
  postMessage(value){messages.push(value)}
};
const context={window,location,URL,Request,Response,TextDecoder,setInterval:()=>{},setTimeout,clearTimeout,console,__TOKEN_DESK_TEST__:true};
vm.runInNewContext(code,context);
const parse=context.__TOKEN_DESK_TEST_MODEL_FROM_EVENT__;
assert.equal(parse({resolved_model_slug:'gpt-6-thinking'}),'gpt-6-thinking');
assert.equal(parse({message:{metadata:{resolved_model_slug:'gpt-6-thinking'}}}),'gpt-6-thinking');
assert.equal(parse({message:{content:{parts:[{resolved_model_slug:'gpt-9-fake'}]}}}),null);
assert.equal(parse({resolved_model_slug:'secret-bearer-token'}),null);
assert.equal(parse({resolved_model_slug:'gpt-6-thinking',content:'should not be included'}),'gpt-6-thinking');
(async()=>{
  const response=await window.fetch('https://chatgpt.com/backend-api/f/conversation',{method:'POST'});
  await response.text();
  await new Promise(resolve=>setTimeout(resolve,80));
  const observed=messages.filter(m=>m.type==='MODEL');
  assert.equal(observed.length,1,JSON.stringify(messages));
  assert.equal(observed[0].model,'gpt-6-thinking');
  assert.equal(observed[0].source,'resolved_model_slug');
  assert.deepEqual(Object.keys(observed[0]).sort(),['channel','model','source','type']);
  assert(!JSON.stringify(observed).includes('assistant text'));
  const before=observed.length;
  await window.fetch('https://chatgpt.com/api/other',{method:'POST'});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(messages.filter(m=>m.type==='MODEL').length,before);
  console.log('PASS resolved_model_slug stream extraction and model-only forwarding');
})().catch(error=>{console.error(error);process.exitCode=1;});
