const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync(__dirname+'/../Chrome_Extension/network-hook.js','utf8');
const captured=[];
const encoder=new TextEncoder();
let streamController;
const stream = new ReadableStream({
  start(controller) {
    streamController=controller;
    controller.enqueue(encoder.encode('data: '+JSON.stringify({
      message:{metadata:{resolved_model_slug:'gpt-6-thinking'},
      content:{parts:['private answer text should not be forwarded']}}
    })+'\n\n'));
  }
});
const location={origin:'https://chatgpt.com',href:'https://chatgpt.com/c/long',pathname:'/c/long'};
const window={
  fetch:async()=>new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}}),
  XMLHttpRequest:null,addEventListener(){},postMessage(data){captured.push(data);}
};
vm.runInNewContext(code,{
  window,location,URL,Request,Response,TextDecoder,
  setTimeout,clearTimeout,setInterval:()=>{},console,__TOKEN_DESK_TEST__:true
});
(async()=>{
  const response=await window.fetch('https://chatgpt.com/backend-api/f/conversation',
    {method:'POST',body:JSON.stringify({model:'gpt-6-thinking'})});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert(captured.some(x=>x.type==='TASK_STREAM'&&x.status==='open'));
  assert(captured.some(x=>x.type==='MODEL'&&x.model==='gpt-6-thinking'));
  assert(!captured.some(x=>x.type==='TASK_STREAM'&&x.status==='closed'),
    'active stream remains active after model metadata has been detected');
  assert(!JSON.stringify(captured).includes('private answer'));
  // The listener should continue to drain without parsing or forwarding
  // long, private response content after the model metadata.
  streamController.enqueue(encoder.encode('data: '+JSON.stringify({
    message:{content:{parts:['private trailing answer']}}
  })+'\n\n'));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert(!captured.some(x=>x.type==='TASK_STREAM'&&x.status==='closed'));
  streamController.close();
  await response.text();
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.strictEqual(captured.filter(x=>x.type==='TASK_STREAM'&&x.status==='closed').length,1);
  assert.strictEqual(captured.filter(x=>x.type==='MODEL').length,1);
  assert(!JSON.stringify(captured).includes('private'));
  console.log('PASS long-running Thinking stream stays active until real SSE completion');
})().catch(e=>{console.error(e);process.exitCode=1;});
