const fs=require('fs'), vm=require('vm'), assert=require('assert');
function test(text5,textWeek,expected) {
  const sends=[]; const elements=[]; const windowListeners={}; let runtimeListener=null;
  function card(label, body){
    const container={children:[],childNodes:[],textContent:body,innerText:body,parentElement:null};
    const leaf={children:[],childNodes:[{nodeType:3,textContent:label}],textContent:label,
      querySelector:()=>null,closest:()=>null,innerText:label,parentElement:container};
    container.children=[leaf]; elements.push(leaf);
  }
  card('5 小时',text5);card('1 周',textWeek);
  const doc={ querySelectorAll:()=>elements,documentElement:{} };
  const location={href:'https://chatgpt.com/settings/usage',pathname:'/settings/usage',origin:'https://chatgpt.com'};
  const window={addEventListener:(n,fn)=>{windowListeners[n]=fn;},postMessage:()=>{}};
  class MO { observe(){} disconnect(){} }
  const context={document:doc,window,location,
    chrome:{runtime:{sendMessage:(d,cb)=>{sends.push(d.payload);cb?.({ok:true})},lastError:null,onMessage:{addListener:fn=>{runtimeListener=fn}}}},
    MutationObserver:MO,Node:{TEXT_NODE:3},Date,
    setTimeout:(cb)=>{cb(); return 1;}, clearTimeout:()=>{}, addEventListener:()=>{}, console};
  vm.runInNewContext(fs.readFileSync(__dirname+'/../Chrome_Extension/extract.js','utf8'),context);
  assert.strictEqual(sends.length,0,'DOM fallback should be idle before explicit fallback request');
  assert.strictEqual(typeof runtimeListener,'function');
  runtimeListener({type:'TOKEN_DESK_FALLBACK_REFRESH'}, {}, ()=>{});
  assert.strictEqual(sends.length,1,'fallback request should sample DOM once');
  const got=JSON.parse(JSON.stringify(sends[0]));
  assert.strictEqual(got.source,'dom');
  delete got.source;
  assert.deepStrictEqual(got,expected);
}
test('5 小时 67% 剩余 已用 33%','1 周 95% 剩余 已用 5%',{
  pageURL:'https://chatgpt.com/settings/usage',fiveHourRemaining:67,weeklyRemaining:95});
test('5 小时 66% 18:16','1 周 95% 10月18日',{
  pageURL:'https://chatgpt.com/settings/usage',fiveHourRemaining:66,weeklyRemaining:95});
console.log('PASS: Lazy DOM fallback quota parsing');
