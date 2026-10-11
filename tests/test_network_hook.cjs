const fs=require('fs'), vm=require('vm'), assert=require('assert');
const code=fs.readFileSync(__dirname+'/../Chrome_Extension/network-hook.js','utf8');
const messages=[];
const window={fetch:null,XMLHttpRequest:null,addEventListener(){},postMessage(m){messages.push(m)}};
const context={
  __TOKEN_DESK_TEST__:true, window, location:{href:'https://chatgpt.com/settings/usage',origin:'https://chatgpt.com'},
  document:{visibilityState:'hidden'}, URL, Request, setInterval:()=>{}, console
};
vm.runInNewContext(code,context);
const parse=context.__TOKEN_DESK_TEST_PARSE__;
assert.strictEqual(typeof parse,'function');
const payload=parse({
  rate_limit:{
    primary_window:{used_percent:34,limit_window_seconds:18000,reset_at:1790000000},
    secondary_window:{used_percent:5,limit_window_seconds:604800,reset_at:1790500000}
  },
  rate_limit_reset_credits:{available_count:3}
},'/backend-api/wham/usage');
assert.strictEqual(payload.fiveHourRemaining,66);
assert.strictEqual(payload.weeklyRemaining,95);
assert.strictEqual(payload.availableResets,3);
assert.strictEqual(payload.fiveHourResetsAt,1790000000);
assert.strictEqual(payload.weeklyResetsAt,1790500000);
assert.strictEqual(payload.source,'network');
const weeklyOnly=parse({rate_limit:{primary_window:{used_percent:12,limit_window_seconds:604800}}},'/backend-api/wham/usage');
assert.strictEqual(weeklyOnly.weeklyRemaining,88); assert.strictEqual(weeklyOnly.fiveHourRemaining,undefined);
const wrong=parse({rate_limit:{primary_window:{used_percent:12,limit_window_seconds:3600}}},'/backend-api/wham/usage');
assert.strictEqual(wrong,null);
console.log('PASS: Network usage JSON parser (5h, weekly, reset times, credits, missing windows)');
