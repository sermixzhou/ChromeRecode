// Based on the Chrome team's tabCapture + offscreen pattern.
// Only the extension's own popup can request a new recording.
const DEFAULT_STATE = { phase: 'idle', mode: null, startedAt: 0, pausedAt: 0, pausedTotal: 0, tabTitle: '' };
let busy = false;
let makingOffscreen;
// Hide Bilibili's thin progress layer during capture independently of the normal
// fullscreen controls. Restore the exact stylesheet afterwards; never crop.
const CAPTURE_OVERLAY_CSS = '.bpx-player-shadow-progress-area,.bpx-player-mini-progress{visibility:hidden!important;opacity:0!important}';
async function restoreCaptureOverlay() {
  const {captureOverlayTabId} = await chrome.storage.session.get('captureOverlayTabId');
  if (!Number.isInteger(captureOverlayTabId)) return;
  try { await chrome.scripting.removeCSS({target:{tabId:captureOverlayTabId}, css:CAPTURE_OVERLAY_CSS, origin:'USER'}); }
  catch (error) { console.warn('录制页面样式恢复失败（页签可能已关闭）：', error); }
  await chrome.storage.session.remove('captureOverlayTabId');
}
async function prepareCaptureOverlay(tabId, mode) {
  if (mode !== 'video') return;
  try {
    const tab = await chrome.tabs.get(tabId), hostname = new URL(tab.url).hostname;
    if (hostname !== 'bilibili.com' && !hostname.endsWith('.bilibili.com')) return;
    await chrome.storage.session.set({captureOverlayTabId:tabId});
    await chrome.scripting.insertCSS({target:{tabId}, css:CAPTURE_OVERLAY_CSS, origin:'USER'});
  } catch (error) {
    // Cosmetic cleanup must never prevent the actual recording from starting.
    console.warn('录制页面底部进度层未隐藏：', error);
    await restoreCaptureOverlay();
  }
}

async function readState() {
  const value = await chrome.storage.session.get('recState');
  return value.recState || DEFAULT_STATE;
}
async function saveState(state) {
  await chrome.storage.session.set({recState: state});
  await chrome.action.setBadgeText({text: state.phase === 'recording' ? 'REC' : state.phase === 'paused' ? '||' : ''});
  if (state.phase === 'recording' || state.phase === 'paused') {
    await chrome.action.setBadgeBackgroundColor({ color: state.phase === 'paused' ? '#f0b078' : '#f46a66' });
  }
}
async function ensureOffscreen() {
  if (makingOffscreen) return makingOffscreen;
  makingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'], documentUrls:[chrome.runtime.getURL('offscreen.html')]});
    if (!contexts.length) {
      await chrome.offscreen.createDocument({url: 'offscreen.html', reasons:['USER_MEDIA'], justification:'录制用户主动选择的当前页签的声音和画面'});
    }
  })();
  try { await makingOffscreen; } finally { makingOffscreen = null; }
}
async function start(tabId, tabTitle, mode) {
  if (busy) throw new Error('正在切换录制状态，请稍后重试。');
  busy = true;
  let starting = false;
  try {
    const state = await readState();
    if (state.phase !== 'idle') throw new Error('已有录制任务，请先结束当前录制。');
    if (!Number.isInteger(tabId)) throw new Error('无法识别当前页签。');
    if (mode !== 'audio' && mode !== 'video') throw new Error('录制模式无效。');
    starting = true;
    await saveState({...DEFAULT_STATE, phase:'starting', mode, tabTitle});
    await restoreCaptureOverlay();
    await prepareCaptureOverlay(tabId, mode);
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const reply = await chrome.runtime.sendMessage({target:'offscreen', type:'START', streamId, mode, tabTitle});
    if (!reply?.ok) throw new Error(reply?.error || '录制启动失败。');
    await saveState({...DEFAULT_STATE, phase:'recording', mode, tabTitle, startedAt: Date.now()});
    return {ok:true};
  } catch (e) {
    if (starting) {
      await restoreCaptureOverlay();
      await saveState(DEFAULT_STATE);
    }
    return {ok:false, error: e.message || String(e)};
  } finally { busy = false; }
}
async function control(cmd) {
  if (busy) return {ok:false, error:'正在处理，请稍后。'};
  busy = true;
  try {
    let state = await readState();
    if (!['recording','paused'].includes(state.phase)) throw new Error('当前没有正在进行的录制。');
    const next = {...state};
    if (cmd === 'STOP') next.phase = 'stopping';
    else if (cmd === 'PAUSE' && state.phase === 'recording') { next.phase = 'paused'; next.pausedAt = Date.now(); }
    else if (cmd === 'RESUME' && state.phase === 'paused') { next.phase = 'recording'; next.pausedTotal += Date.now() - next.pausedAt; next.pausedAt=0; }
    else throw new Error('当前状态不能执行此操作。');
    const reply = await chrome.runtime.sendMessage({target:'offscreen', type:cmd});
    if (!reply?.ok) throw new Error(reply?.error || '操作失败。');
    await saveState(next);
    return {ok:true};
  } catch (e) { return {ok:false,error:e.message||String(e)}; }
  finally { busy=false; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'GET_STATE') {
    readState().then(state=>sendResponse({ok:true,state}));
    return true;
  }
  if (msg.type === 'REQUEST_START' && sender.url?.includes('popup.html')) {
    start(msg.tabId, msg.tabTitle || '刻页录制', msg.mode).then(sendResponse);
    return true;
  }
  if (['REQUEST_STOP','REQUEST_PAUSE','REQUEST_RESUME'].includes(msg.type) && sender.url?.includes('popup.html')) {
    control(msg.type.replace('REQUEST_','')).then(sendResponse);
    return true;
  }
  if (msg.type === 'OFFSCREEN_FINISHED' && sender.url?.includes('offscreen.html')) {
    restoreCaptureOverlay().then(() => saveState(DEFAULT_STATE)).then(async () => {
      if (msg.id) await chrome.tabs.create({url: chrome.runtime.getURL('editor.html') + '?id=' + encodeURIComponent(msg.id)});
      sendResponse({ok:true});
    }).catch(e=>sendResponse({ok:false,error:String(e)}));
    return true;
  }
  if (msg.type === 'OFFSCREEN_ERROR' && sender.url?.includes('offscreen.html')) {
    restoreCaptureOverlay().then(() => saveState(DEFAULT_STATE)).then(()=>sendResponse({ok:true}));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await saveState(DEFAULT_STATE);
});
