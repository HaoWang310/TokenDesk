const fs = require('fs'), vm = require('vm'), assert = require('assert');
const script = fs.readFileSync(__dirname + '/../Chrome_Extension/extract.js', 'utf8');

function makePage(sendMessage, lastError = null) {
  const listeners = new Map();
  let reads = 0;
  let sends = 0;
  const window = {
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) {
      if (listeners.get(name) === handler) listeners.delete(name);
    },
    postMessage() {}
  };
  const runtime = {
    onMessage: { addListener() {} },
    get lastError() { reads++; return lastError; },
    sendMessage(...args) { sends++; return sendMessage(...args); }
  };
  const context = {
    window, location: { origin: 'https://chatgpt.com', href:'https://chatgpt.com/c/abc', pathname:'/c/abc' },
    document: { documentElement: {}, querySelectorAll:()=>[] },
    chrome: { runtime }, MutationObserver:class { observe() {} disconnect() {} },
    Node: { TEXT_NODE:3 }, Date, setTimeout:()=>1, clearTimeout:()=>{}, addEventListener:()=>{}
  };
  vm.runInNewContext(script, context);
  return {
    sendQuota(remaining) {
      const handler = listeners.get('message');
      if (!handler) return;
      handler({ source:window, origin:'https://chatgpt.com',
        data:{ channel:'TOKEN_DESK_NETWORK_V1',type:'USAGE',
          payload:{fiveHourRemaining:remaining} } });
    },
    get reads() { return reads; },
    get sends() { return sends; },
    get listening() { return listeners.has('message'); }
  };
}

// A successful fire-and-forget submission must still consume lastError,
// otherwise Chrome can report "Unchecked runtime.lastError".
const normal = makePage((payload, reply) => reply({ok:true}));
normal.sendQuota(80);
assert.equal(normal.sends,1);
assert.equal(normal.reads,1);

// Asynchronous delivery errors must be consumed even if no caller requested
// a callback, and old contexts must stop their network listeners.
const rejected = makePage((payload, reply) => reply(undefined),
  {message:'Extension context invalidated.'});
rejected.sendQuota(75);
assert.equal(rejected.reads,1);
assert.equal(rejected.listening,false);
rejected.sendQuota(74);
assert.equal(rejected.sends,1);

// A synchronous invalid-context exception should not throw into ChatGPT and
// must stop sending altogether, rather than repeat once per quota event.
const expired = makePage(() => { throw new Error('Extension context invalidated.'); });
assert.doesNotThrow(() => expired.sendQuota(73));
assert.equal(expired.listening,false);
expired.sendQuota(72);
assert.equal(expired.sends,1);

console.log('PASS: extract.js extension-reload messaging does not repeatedly throw');
