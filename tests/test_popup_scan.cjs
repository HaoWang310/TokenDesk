const fs = require('fs'), vm = require('vm'), assert = require('assert');
const handlers={}; let printed='';
const state={set textContent(v){printed=v;},get textContent(){return printed;}};
const key={value:''};const last={textContent:''};
const diagnostic={textContent:'',style:{}};
const dom={state,key,last,'model-diagnostic':diagnostic,
  'model-check':{addEventListener(e,fn){handlers.modelCheck=fn;}},
  save:{addEventListener(e,fn){handlers.save=fn;}},
  health:{addEventListener(e,fn){handlers.health=fn;}},
  scan:{addEventListener(e,fn){handlers.scan=fn;}}};
const store={pairingCode:'a'.repeat(64),syncStatus:'Mac 已连接',backgroundStatus:'尚未执行后台主动查询',lastSnapshot:null};
let backgroundReply={ok:false,message:'Chrome 后台暂未读取到额度。请确认网络正常且 Chrome 中仍登录 ChatGPT。'};
const chrome={
  runtime:{lastError:null,sendMessage(m,cb){
    if(m.type==='TOKEN_DESK_HEALTH') cb?.({ok:true,message:'Mac 已连接'});
    else if(m.type==='TOKEN_DESK_BACKGROUND_REFRESH') { store.backgroundStatus=backgroundReply.message; cb?.(backgroundReply); }
    else if(m.type==='TOKEN_DESK_DIAGNOSE_MODELS') cb?.({ok:true,version:'1.8.4',tabCount:1,reports:[{tab:1,status:'picker-absent',scriptVersion:'1.8.4',taggedAssistantMessages:0}]});
  }},
  storage:{local:{get(o,cb){cb({...o,...store});},set(v,cb){Object.assign(store,v);cb?.();}},onChanged:{addListener(){}}}
};
vm.runInNewContext(fs.readFileSync(__dirname+'/../Chrome_Extension/popup.js','utf8'),{
  document:{getElementById:(k)=>dom[k]},chrome, Date, setTimeout:(cb)=>cb()
});
handlers.scan();
assert(printed.includes('仍登录 ChatGPT'),`Expected background-login instruction, got: ${printed}`);
backgroundReply={ok:true,message:'后台主动查询成功。无需打开 ChatGPT 页面。'};
store.lastSnapshot={fiveHourRemaining:66,weeklyRemaining:95,source:'network',mode:'background-direct',at:Date.now()};
handlers.scan();
assert(last.textContent.includes('66%')&&last.textContent.includes('95%')&&last.textContent.includes('Chrome 后台主动查询'));
handlers.modelCheck();
assert(diagnostic.textContent.includes('扩展版本：1.8.4'));
assert(diagnostic.textContent.includes('页面没有可见的模型选择按钮'));
console.log('PASS: Popup background-direct refresh status and snapshot rendering');
