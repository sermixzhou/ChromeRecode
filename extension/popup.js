const $=id=>document.getElementById(id);
let currentTab=null;
let currentState=null;
let sending=false;
let tick=null;
function fmt(ms) {const sec=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;}
function err(message){$('error').textContent=message;$('error').hidden=!message;}
function render(state) {
  currentState=state;
  const active=['recording','paused','stopping','starting'].includes(state.phase);
  $('idlePanel').hidden=active;
  $('activePanel').hidden=!active;
  $('recordVideo').disabled=sending;
  $('recordAudio').disabled=sending;
  if(!active)return;
  $('recordStatus').className=`record-status ${state.phase}`;
  $('statusLabel').textContent={recording:state.mode==='video'?'正在录制视频':'正在录制声音',paused:'录制已暂停',stopping:'正在保存…',starting:'正在启动…'}[state.phase]||'录制中';
  $('pauseLabel').textContent=state.phase==='paused'?'继续':'暂停';
  $('pauseIcon').setAttribute('href',state.phase==='paused'?'#p-play':'#p-pause');
  $('pause').disabled=sending || !['paused','recording'].includes(state.phase);
  $('stop').disabled=sending || !['paused','recording'].includes(state.phase);
  updateClock();
}
function updateClock(){
  if(!currentState)return;
  const s=currentState;
  if(!s.startedAt)return $('clock').textContent='00:00';
  const end=s.phase==='paused'?s.pausedAt:Date.now();
  $('clock').textContent=fmt(end-s.startedAt-s.pausedTotal);
}
async function state(){try{const r=await chrome.runtime.sendMessage({type:'GET_STATE'}); if(r?.ok)render(r.state);}catch(e){err(e.message);}}
async function send(msg){if(sending)return;sending=true;err('');if(currentState)render(currentState);try {
  const result=await chrome.runtime.sendMessage(msg);
  if(!result?.ok)throw new Error(result?.error||'操作失败');
  await state();
  if(msg.type==='REQUEST_STOP') window.close();
} catch(e){err(e.message);await state();} finally {sending=false;if(currentState)render(currentState);}}
async function init(){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  currentTab=tab;
  $('tabTitle').textContent=tab?.title||'当前网页';
  $('recordVideo').onclick=()=>send({type:'REQUEST_START',mode:'video',tabId:currentTab?.id,tabTitle:currentTab?.title});
  $('recordAudio').onclick=()=>send({type:'REQUEST_START',mode:'audio',tabId:currentTab?.id,tabTitle:currentTab?.title});
  $('stop').onclick=()=>send({type:'REQUEST_STOP'});
  $('pause').onclick=()=>send({type:currentState?.phase==='paused'?'REQUEST_RESUME':'REQUEST_PAUSE'});
  $('openEditor').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('editor.html')});
  await state();
  tick=setInterval(()=>{updateClock();},350);
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='session'&&changes.recState)render(changes.recState.newValue);});
}
init().catch(e=>err(e.message));
