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
let captureVideo = null;
let fixedStream = null;
let frameTimer;
let storageError=null,savedChunks=0,savedBytes=0;

function pickMime(mode) {
  const types = mode === 'audio'
    ? ['audio/webm;codecs=opus','audio/webm']
    : ['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm'];
  return types.find(t=>MediaRecorder.isTypeSupported(t)) || '';
}
function send(type, payload={}) {return chrome.runtime.sendMessage({type,...payload});}
function cleanUp() {
  if (captureVideo) {
    captureVideo.pause();captureVideo.srcObject=null;captureVideo=null;
  }
  clearInterval(frameTimer);frameTimer=undefined;
  fixedStream?.getTracks().forEach(t=>t.stop());fixedStream=null;
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
  storageError=null;savedChunks=0;savedBytes=0;
}
async function finish() {
  if (ending) return;
  ending=true;
  const id=activeSession?.id;
  try {
    await pendingWrites;
    if (id) {
      const duration=Math.max(0,Date.now()-recordingStart-pausedMs-(pauseStart ? Date.now()-pauseStart : 0));
      await dbWrite('sessions',{...activeSession, durationMs:storageError?activeSession.savedDurationMs:duration, status:'ready', completedAt:Date.now(), chunkCount:savedChunks, sizeBytes:savedBytes, incompleteReason:storageError?.message});
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
  const estimate=await navigator.storage.estimate();
  if(Number.isFinite(estimate.quota)&&estimate.quota-estimate.usage<64*1024*1024)throw new Error('本地可用空间不足，请释放空间后再开始录制');
  const audio={mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:streamId}};
  // Cap capture before decoding/drawing, then fix an even-sized 1080p canvas.
  // Keep initial constraints in the legacy mandatory object.
  const video= mode==='video' ? {mandatory:{
    chromeMediaSource:'tab',chromeMediaSourceId:streamId,
    minWidth:2,minHeight:2,maxWidth:1920,maxHeight:1080,maxFrameRate:KeyeMediaQuality.captureFrameRate
  }} : false;
  sourceStream=await navigator.mediaDevices.getUserMedia({audio, video});
  const id=`rec-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  activeSession={id,mode,title:tabTitle||'刻页录制',startedAt:Date.now(),status:'recording',mimeType:pickMime(mode)};
  if (mode==='video') {
    captureVideo=document.createElement('video');
    captureVideo.muted=true;captureVideo.playsInline=true;captureVideo.srcObject=sourceStream;
    // getSettings() can still contain placeholder dimensions before frame one.
    await captureVideo.play();
    // Chrome can deliver a provisional frame before applying display scaling.
    // Let that initial setup settle before fixing the file's dimensions.
    await new Promise(resolve=>setTimeout(resolve,150));
    const {width,height}=KeyeMediaQuality.fitDimensions(captureVideo.videoWidth,captureVideo.videoHeight);
    activeSession.videoWidth=width;activeSession.videoHeight=height;activeSession.videoFrameRate=KeyeMediaQuality.captureFrameRate;
    // Browser tab tracks may still change size despite exact track constraints.
    // This internal canvas keeps one size without modifying the captured page.
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{alpha:false});
    if (!context) throw new Error('无法准备录制画面，请重试');
    canvas.width=width;canvas.height=height;
    const draw=()=>{
      const sourceWidth=captureVideo.videoWidth,sourceHeight=captureVideo.videoHeight;
      if (sourceWidth && sourceHeight) {
        const scale=Math.min(width/sourceWidth,height/sourceHeight);
        const drawnWidth=sourceWidth*scale,drawnHeight=sourceHeight*scale;
        context.fillStyle='#000';context.fillRect(0,0,width,height);
        context.drawImage(captureVideo,(width-drawnWidth)/2,(height-drawnHeight)/2,drawnWidth,drawnHeight);
      }
    };
    draw();
    // Offscreen documents do not receive reliable animation/video-frame callbacks.
    frameTimer=setInterval(draw,1000/KeyeMediaQuality.captureFrameRate);
    fixedStream=canvas.captureStream(KeyeMediaQuality.captureFrameRate);
    for (const track of sourceStream.getAudioTracks()) fixedStream.addTrack(track);
  }
  recordingStart=Date.now();
  pendingWrites=Promise.resolve();
  chunkIndex=0;
  pausedMs=0;
  pauseStart=0;
  ending=false;
  storageError=null;savedChunks=0;savedBytes=0;
  // Capturing a tab stops its regular audio output. Forward to speakers.
  if(sourceStream.getAudioTracks().length) {
    playbackContext=new AudioContext();
    playbackContext.createMediaStreamSource(sourceStream).connect(playbackContext.destination);
    await playbackContext.resume();
  }
  const mime=pickMime(mode);
  if(!mime) throw new Error('当前 Chrome 不支持 WebM 录制。');
  const options={mimeType:mime};
  if(mode==='video'){
    options.videoBitsPerSecond=KeyeMediaQuality.recordingBitrate(activeSession.videoWidth,activeSession.videoHeight);
    options.audioBitsPerSecond=KeyeMediaQuality.audioBitrate;
  }
  mediaRecorder=new MediaRecorder(fixedStream || sourceStream,options);
  if(mode==='video'){
    activeSession.videoBitrate=mediaRecorder.videoBitsPerSecond;
    activeSession.audioBitrate=mediaRecorder.audioBitsPerSecond;
  }
  await dbWrite('sessions',activeSession);
  mediaRecorder.ondataavailable=(event)=>{
    if(event.data?.size) {
      const record={id,index:chunkIndex++,blob:event.data};
      const durationMs=Math.max(0,Date.now()-recordingStart-pausedMs-(pauseStart?Date.now()-pauseStart:0));
      pendingWrites=pendingWrites.then(async()=>{
        if(storageError)return;
        const checkpoint={...activeSession,chunkCount:savedChunks+1,sizeBytes:savedBytes+record.blob.size,savedDurationMs:durationMs,lastSavedAt:Date.now()};
        try{await dbAppendChunk(checkpoint,record);savedChunks++;savedBytes+=record.blob.size;activeSession=checkpoint;}
        catch(error){storageError=error;if(mediaRecorder?.state!=='inactive')mediaRecorder.stop();}
      });
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
