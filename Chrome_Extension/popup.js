'use strict';
const state = document.getElementById('state');
const key = document.getElementById('key');
const status = s => { state.textContent = s; };
const backgroundHint = '额度监控：Chrome 保持登录 ChatGPT 即可，无需打开“使用情况”页面；任务监控需保持对应 ChatGPT 标签页打开。';

function renderLast() {
  chrome.storage.local.get({
    pairingCode:'',syncStatus:'尚未采集网页数据',lastSnapshot:null,
    backgroundStatus:'尚未执行后台主动查询',backgroundLastAttempt:0
  },d=>{
    key.value=d.pairingCode;
    const v=d.lastSnapshot;
    if(v && v.at){
      const age=Math.max(0,Math.round((Date.now()-v.at)/1000));
      const vals=[v.fiveHourRemaining==null?'5h —':`5h ${v.fiveHourRemaining}%`,v.weeklyRemaining==null?'周 —':`周 ${v.weeklyRemaining}%`].join(' · ');
      const src=v.mode==='background-direct'?'Chrome 后台主动查询':(v.source==='network'?'页面后台网络':'页面采集');
      document.getElementById('last').textContent=`上次成功同步：${vals} · ${src}（${age} 秒前）。`;
    } else document.getElementById('last').textContent='尚无成功同步的网页读数。';
    const bg = d.backgroundStatus || d.syncStatus;
    status(bg);
  });
}
renderLast();

function requestHealth() {
  status('正在检测 TokenDesk 桌面端…');
  chrome.runtime.sendMessage({type:'TOKEN_DESK_HEALTH'},r=>{
    if(chrome.runtime.lastError) status('浏览器后台未运行，请在 chrome://extensions 中重新加载扩展。');
    else status(r?.message||'连接检查没有返回结果。');
  });
}
document.getElementById('health').addEventListener('click',requestHealth);

document.getElementById('save').addEventListener('click',()=>{
  const value=key.value.trim();
  if(!/^[0-9a-f]{64}$/i.test(value)) {status('配对码必须是从 TokenDesk 桌面端复制的完整 64 位字符。');return;}
  chrome.storage.local.set({pairingCode:value,syncStatus:'配对已保存。'+backgroundHint},()=>{
    status('配对已保存。正在尝试后台主动查询…');
    chrome.runtime.sendMessage({type:'TOKEN_DESK_BACKGROUND_REFRESH'},r=>{
      if(chrome.runtime.lastError) status('配对已保存，但浏览器后台未响应。请重新加载扩展。');
      else status(r?.message||('配对已保存。'+backgroundHint));
      setTimeout(renderLast,400);
    });
  });
});

document.getElementById('scan').addEventListener('click',()=>{
  status('正在从 Chrome 登录会话后台查询额度…');
  chrome.runtime.sendMessage({type:'TOKEN_DESK_BACKGROUND_REFRESH'},r=>{
    if(chrome.runtime.lastError) {
      status('浏览器后台未运行，请在 chrome://extensions 中重新加载扩展。');
      return;
    }
    status(r?.message||'后台查询没有返回结果。');
    setTimeout(renderLast,500);
  });
});

// Check model-picker recognition in the actual browser tabs. Diagnostic
// responses include only whitelisted model/mode labels and selector counts;
// they never include conversation text, page titles, URLs or credentials.
document.getElementById('model-check').addEventListener('click', () => {
  const panel = document.getElementById('model-diagnostic');
  panel.textContent = '正在检查 ChatGPT 网页的模型选择器…';
  chrome.runtime.sendMessage({type:'TOKEN_DESK_DIAGNOSE_MODELS'}, result => {
    if (chrome.runtime.lastError || !result?.ok) {
      panel.textContent = '无法连接扩展后台；请在 chrome://extensions 中重新加载 TokenDesk 扩展。';
      return;
    }
    const lines = ['扩展版本：' + result.version + ' · ChatGPT 网页：' + result.tabCount + ' 个'];
    if (!result.tabCount) {
      lines.push('没有已打开的 ChatGPT 网页；请先打开 chatgpt.com 并刷新页面。');
    }
    for (const item of result.reports || []) {
      const label = '标签页 ' + item.tab + '：';
      if (item.status === 'content-script-missing') {
        lines.push(label + '未收到网页监听脚本，请刷新该 ChatGPT 网页。');
      } else if (item.status === 'recognized') {
        const origin = item.modelSource === 'resolved_model_slug' ? '网络响应' : '网页界面';
        lines.push(label + (item.model || item.lastModel || '已检测到模型按钮') +
          '（来源：' + origin + '；监听脚本 ' + item.scriptVersion + '）');
      } else if (item.status === 'picker-absent') {
        lines.push(label + '页面没有可见的模型选择按钮（常见于 Work 页面）');
      } else if (item.status === 'picker-not-visible') {
        lines.push(label + '存在模型按钮，但当前被隐藏');
      } else {
        lines.push(label + '找到 ' + item.visiblePickerCount + ' 个模型按钮，但按钮未提供可识别的名称');
      }
      if (item.status !== 'recognized' && item.status !== 'content-script-missing') {
        lines.push('  网页监听脚本：' + item.scriptVersion +
          ' · 回复模型属性节点：' + item.taggedAssistantMessages);
      }
    }
    lines.push('如果仍显示未识别，请把此诊断结果截图发来；诊断不包含聊天正文。');
    panel.textContent = lines.join('\n');
    panel.style.whiteSpace = 'pre-line';
  });
});

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local' && (changes.lastSnapshot || changes.backgroundStatus || changes.syncStatus)) renderLast();
});
