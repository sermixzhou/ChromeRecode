let mediaRecorder = null;
let sourceStream = null;
let playbackContext = null;
let activeSession = null;
let pendingWrites = Promise.resolve();
let chunkIndex = 0;
let recordingStart = 0;
let pauseStart = 0;
let pausedMs = 0;
let ending = false;
let dimensionMonitor = null;

function pickMime(mode) {
  const types = mode === 'audio'
    ? ['audio/webm;codecs=opus','audio/webm']
    : ['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm'];
  return types.find(t=>MediaRecorder.isTypeSupported(t)) || '';
}
function send(type, payload={}) {return chrome.runtime.sendMessage({type,...payload});}
function cleanUp() {
  if (dimensionMonitor) {
    dimensionMonitor.onresize=null;
    dimensionMonitor.onloadedmetadata=null;
    dimensionMonitor.pause();
    dimensionMonitor.srcObject=null;
    dimensionMonitor=null;
  }
  sourceStream?.getTracks().forEach(t=>t.stop());
  sourceStream=null;
  playbackContext?.close().catch(()=>{});
  playbackContext=null;
  mediaRecorder=null;
  activeSession=null;
  chunkIndex=0;
  recordingStart=0;
  pauseStart=0;
  pausedMs=0;
  ending=false;
}
async function finish() {
  if (ending) return;
  ending=true;
  const id=activeSession?.id;
  try {
    await pendingWrites;
    if (id) {
      const duration=Math.max(0,Date.now()-recordingStart-pausedMs-(pauseStart ? Date.now()-pauseStart : 0));
      await dbWrite('sessions',{...activeSession, durationMs:duration, status:'ready', completedAt:Date.now(), chunkCount:chunkIndex});
    }
    cleanUp();
    await send('OFFSCREEN_FINISHED',{id});
  } catch(e) {
    console.error('录制保存失败:',e);
    cleanUp();
    await send('OFFSCREEN_ERROR',{error:String(e)});
  }
}
async function start(message) {
  if(mediaRecorder) throw new Error('已有录音任务');
  const {streamId,mode,tabTitle} = message;
  const audio={mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:streamId}};
  // Tab capture defaults to a fixed-size frame, which letterboxes other page ratios.
  // Explicit, flexible bounds let Chrome follow the page through resize/fullscreen.
  // Keep every constraint in the legacy mandatory object; mixing standard keys fails.
  const video= mode==='video' ? {mandatory:{
    chromeMediaSource:'tab',chromeMediaSourceId:streamId,
    minWidth:2,minHeight:2,maxWidth:7680,maxHeight:4320,maxFrameRate:30
  }} : false;
  sourceStream=await navigator.mediaDevices.getUserMedia({audio, video});
  const id=`rec-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  activeSession={id,mode,title:tabTitle||'刻页录制',startedAt:Date.now(),status:'recording',mimeType:pickMime(mode)};
  if (mode==='video') {
    // Record dimension changes for the exporter: avc1 cannot represent them safely.
    dimensionMonitor=document.createElement('video');
    dimensionMonitor.muted=true;dimensionMonitor.playsInline=true;
    const rememberSize=()=>{
      const width=dimensionMonitor?.videoWidth,height=dimensionMonitor?.videoHeight;
      if (!width || !height || !activeSession) return;
      if (!activeSession.videoWidth) {
        activeSession.videoWidth=width;activeSession.videoHeight=height;
      } else if (width!==activeSession.videoWidth || height!==activeSession.videoHeight) {
        activeSession.variableResolution=true;
      }
    };
    dimensionMonitor.onloadedmetadata=rememberSize;
    dimensionMonitor.onresize=rememberSize;
    dimensionMonitor.srcObject=sourceStream;
    await dimensionMonitor.play();rememberSize();
  }
  recordingStart=Date.now();
  pendingWrites=Promise.resolve();
  chunkIndex=0;
  pausedMs=0;
  pauseStart=0;
  ending=false;
  await dbWrite('sessions',activeSession);
  // Capturing a tab stops its regular audio output. Forward to speakers.
  if(sourceStream.getAudioTracks().length) {
    playbackContext=new AudioContext();
    playbackContext.createMediaStreamSource(sourceStream).connect(playbackContext.destination);
    await playbackContext.resume();
  }
  const mime=pickMime(mode);
  if(!mime) throw new Error('当前 Chrome 不支持 WebM 录制。');
  mediaRecorder=new MediaRecorder(sourceStream,{mimeType:mime});
  mediaRecorder.ondataavailable=(event)=>{
    if(event.data?.size) {
      const record={id,index:chunkIndex++,blob:event.data};
      pendingWrites=pendingWrites.then(()=>dbWrite('chunks',record));
    }
  };
  mediaRecorder.onstop=()=>{finish();};
  mediaRecorder.onerror=(event)=>{
    console.error('MediaRecorder error:',event);
    if(mediaRecorder && mediaRecorder.state!=='inactive') mediaRecorder.stop();
  };
  sourceStream.getTracks().forEach(track=>track.addEventListener('ended',()=>{
    if(mediaRecorder?.state!=='inactive') mediaRecorder?.stop();
  }));
  mediaRecorder.start(1000);
  return id;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse)=>{
  if(message.target!=='offscreen') return;
  (async()=>{
    try {
      if(message.type==='START') {const id=await start(message);return {ok:true,id};}
      if(!mediaRecorder) throw new Error('录制任务不存在');
      if(message.type==='STOP') {
        if(mediaRecorder.state!=='inactive') mediaRecorder.stop();
      } else if(message.type==='PAUSE') {
        if(mediaRecorder.state!=='recording') throw new Error('录制当前无法暂停');
        mediaRecorder.pause(); pauseStart=Date.now();
      } else if(message.type==='RESUME') {
        if(mediaRecorder.state!=='paused') throw new Error('录制当前无法继续');
        mediaRecorder.resume();pausedMs+=Date.now()-pauseStart;pauseStart=0;
      }
      return {ok:true};
    } catch (err) {
      console.error('Offscreen operation failed:',err);
      if(message.type==='START') {
        cleanUp();
      }
      return {ok:false,error:err.message||String(err)};
    }
  })().then(sendResponse);
  return true;
});
