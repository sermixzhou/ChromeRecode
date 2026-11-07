const {chromium}=require('playwright');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../extension');
const out=path.resolve(__dirname,'../test-results');
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  // Generate real decodable media so export checks exercise the actual browser codecs.
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=960x540:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','6','-c:v','libvpx','-b:v','900k','-c:a','libopus','-y',path.join(out,'video.webm')]);
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=220:sample_rate=48000','-af','tremolo=f=2:d=0.8,pan=stereo|c0=c0|c1=0.5*c0','-t','8','-c:a','libopus','-y',path.join(out,'audio.webm')]);
  const server=http.createServer((req,res)=>{
    const target=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!target.startsWith(root+'/')){res.writeHead(403).end();return;}
    try{const data=fs.readFileSync(target);res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.svg')?'image/svg+xml':target.endsWith('.png')?'image/png':'text/html');res.setHeader('Content-Security-Policy',"script-src 'self'; object-src 'self'");res.end(data);}catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  server.unref();
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),channel:process.env.CHROME_PATH || process.platform==='darwin'?undefined:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:1440,height:960},acceptDownloads:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.previewWork={decodes:0,seeks:0,sampleRates:[]};
    const decode=AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData=function(...args){window.previewWork.decodes++;window.previewWork.sampleRates.push(this.sampleRate);return decode.apply(this,args);};
    const time=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
    Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{...time,set(value){if(!this.id)window.previewWork.seeks++;time.set.call(this,value);}});
  });
  async function checkResponsiveLayout(mode) {
    for (const [width,height] of [[1920,1080],[1440,900],[1366,768],[1280,720],[1024,600],[800,600],[768,600],[1024,480],[640,720],[390,844],[320,640]]) {
      await page.setViewportSize({width,height});
      await page.evaluate(()=>window.scrollTo(0,0));
      const layout=await page.evaluate(()=>({
        pageWidth:document.documentElement.scrollWidth,
        pageHeight:document.documentElement.scrollHeight,
        controls:['cut','preview','delete','startInput','endInput','timeline','mediaFrame','volume','speed','markStart','markEnd','reset','exportFormat'].map(id=>{
          const el=document.getElementById(id),r=el.getBoundingClientRect();
          return {id,x:r.x,y:r.y,width:r.width,height:r.height,display:getComputedStyle(el).display};
        })
      }));
      assert(layout.pageWidth<=width,`${mode}: horizontal overflow at ${width}×${height}`);
      if (width>760) {
        assert(layout.pageHeight<=height,`${mode}: page requires vertical scrolling at ${width}×${height}`);
        for (const r of layout.controls) {
          assert(r.width>0 && r.height>0 && r.display!=='none',`${mode}: ${r.id} hidden at ${width}×${height}`);
          assert(r.x>=0 && r.y>=0 && r.x+r.width<=width+1 && r.y+r.height<=height+1,`${mode}: ${r.id} outside viewport at ${width}×${height}`);
        }
      }
      if ((width===1024 && height===600) || (width===1920 && height===1080)) {
        await page.waitForTimeout(250);
        await page.screenshot({path:path.join(out,`${mode}-${width}x${height}.png`)});
      }
    }
    await page.setViewportSize({width:1440,height:960});
    await page.waitForTimeout(250);
  }
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}/editor.html`);
    await page.waitForFunction(()=>document.querySelector('#historyCount').textContent==='0');
    assert.equal(await page.title(),'刻页 · 录制工作台');assert.equal(await page.locator('.studio-brand strong').textContent(),'刻页');await page.locator('.studio-logo').evaluate(image=>image.decode());
    assert(await page.locator('#empty').isVisible());assert(await page.locator('#cut').isDisabled());
    await page.screenshot({path:path.join(out,'empty.png')});
    assert.equal(await page.locator('#original').count(),0);
    assert.equal(await page.locator('.library-heading svg').count(),0);
    const fixtures=['video','audio'].map(mode=>({mode,bytes:[...fs.readFileSync(path.join(out,`${mode}.webm`))]}));
    // Upgrade a real v1 database, preserving the pre-existing recordings and chunks.
    await page.evaluate(async fixtures=>{
      await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase('tab-recorder-zh-v1');request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Database still in use'));});
      const db=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('tab-recorder-zh-v1',1);
        request.onupgradeneeded=()=>{request.result.createObjectStore('sessions',{keyPath:'id'});request.result.createObjectStore('chunks',{keyPath:['id','index']});};
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(['sessions','chunks'],'readwrite');
        for(const {mode,bytes} of fixtures){
          tx.objectStore('sessions').put({id:mode,mode,title:mode==='video'?'周末的灵感 · 网页录制':'午后电台 · 声音备忘',startedAt:Date.now()-(mode==='video'?0:60000),durationMs:mode==='video'?6000:8000,status:'ready',mimeType:mode==='video'?'video/webm':'audio/webm'});
          tx.objectStore('chunks').put({id:mode,index:0,blob:new Blob([new Uint8Array(bytes)],{type:mode==='video'?'video/webm':'audio/webm'})});
        }
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
      });db.close();
    },fixtures);
    const coldStart=Date.now();
    await page.reload();await page.waitForSelector('#workArea:not([hidden])');
    await page.waitForSelector('#filmstrip img');
    const firstFrameMs=Date.now()-coldStart;
    await page.waitForFunction(()=>document.querySelector('#filmstrip').getAttribute('aria-busy')==='false');
    await page.waitForFunction(()=>document.querySelector('#waveformLabel').hidden);
    const coldPreviewMs=Date.now()-coldStart;
    const work=await page.evaluate(()=>window.previewWork);
    assert.equal(work.decodes,1);assert.deepEqual(work.sampleRates,[12000]);
    assert.equal(await page.locator('.recording-item').count(),2);
    const thumbnails=await page.locator('#filmstrip img').count();assert(thumbnails>=4 && thumbnails<=12);
    assert(await page.locator('#filmstrip img').evaluateAll(images=>new Set(images.map(image=>image.src)).size>1));
    await page.waitForFunction(async()=>{const cache=await dbRead('previews','video');return cache?.peaks?.length && cache.thumbnails?.length;});
    const warmStart=Date.now();await page.reload();
    await page.waitForSelector('#filmstrip[aria-busy="false"] img');
    await page.waitForFunction(()=>document.querySelector('#waveformLabel').hidden);
    const cachedPreviewMs=Date.now()-warmStart;
    assert.deepEqual(await page.evaluate(()=>window.previewWork),{decodes:0,seeks:0,sampleRates:[]});
    // Rapid switching must not publish stale analysis into another recording.
    await page.evaluate(()=>Promise.all([loadSession('audio'),loadSession('video'),loadSession('audio'),loadSession('video')]));
    assert.equal(await page.evaluate(()=>current.id),'video');
    assert.equal(await page.locator('#filmstrip img').count(),thumbnails);
    assert.deepEqual(await page.evaluate(()=>window.previewWork),{decodes:0,seeks:0,sampleRates:[]});
    console.log('Preview timings (6s fixture):',JSON.stringify({firstFrameMs,coldPreviewMs,cachedPreviewMs}));
    await page.locator('#markStart').hover();await page.waitForSelector('#uiTooltip:not([hidden])');
    assert.equal(await page.locator('#uiTooltip').textContent(),'设为起点（I）');
    const tip=await page.locator('#uiTooltip').boundingBox();assert(tip.x>=0 && tip.y>=0);
    await page.keyboard.press('Escape');assert(await page.locator('#uiTooltip').isHidden());
    await checkResponsiveLayout('video');
    await page.screenshot({path:path.join(out,'video-desktop.png'),fullPage:true});
    const timeline=await page.locator('#timeline').boundingBox();
    const handle=await page.locator('#startHandle').boundingBox();
    await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(timeline.x+timeline.width*.2,handle.y+handle.height/2,{steps:8});await page.mouse.up();
    let start=await page.locator('#startRange').inputValue();assert(Number(start)>1 && Number(start)<1.4);
    await page.locator('#undo').click();assert.equal(Number(await page.locator('#startRange').inputValue()),0);
    await page.locator('#redo').click();assert(Number(await page.locator('#startRange').inputValue())>1);
    await page.locator('#startInput').fill('00:01.00');await page.locator('#startInput').press('Enter');
    await page.locator('#endInput').fill('4');await page.locator('#endInput').press('Enter');
    assert.equal(Number(await page.locator('#startRange').inputValue()),1);assert.equal(Number(await page.locator('#endRange').inputValue()),4);
    await page.locator('#endInput').fill('0');await page.locator('#endInput').press('Enter');assert.equal(Number(await page.locator('#endRange').inputValue()),1.5);
    await page.locator('#undo').click();assert.equal(Number(await page.locator('#endRange').inputValue()),4);
    await page.locator('#endHandle').focus();await page.keyboard.press('Shift+ArrowLeft');assert.equal(Number(await page.locator('#endRange').inputValue()),3);
    await page.locator('#undo').click();
    await page.locator('#startInput').fill('invalid');await page.locator('#startInput').press('Enter');assert.equal(await page.locator('#startInput').getAttribute('aria-invalid'),'true');assert(await page.locator('#cut').isDisabled());
    await page.locator('#startInput').fill('1');await page.locator('#startInput').press('Enter');
    await page.locator('#preview').click();await page.waitForFunction(()=>!document.querySelector('#player').paused);
    await page.waitForFunction(()=>document.querySelector('#player').paused,{},{timeout:6000});
    assert(Math.abs(await page.locator('#player').evaluate(m=>m.currentTime)-4)<.2);
    assert.equal(await page.locator('#exportFormat').inputValue(),'mp4');
    // A browser without H.264/AAC must offer WebM rather than relabeling WebM as MP4.
    const fallback=await page.evaluate(()=>{
      const supported=MediaRecorder.isTypeSupported;
      try {
        MediaRecorder.isTypeSupported=type=>!type.startsWith('video/mp4') && supported.call(MediaRecorder,type);
        configureExportFormats();
        return {format:$('exportFormat').value,disabled:$('exportFormat').querySelector('[value=mp4]').disabled};
      } finally {MediaRecorder.isTypeSupported=supported;configureExportFormats();}
    });
    assert.deepEqual(fallback,{format:'webm',disabled:true});
    const videoDownload=page.waitForEvent('download');await page.locator('#cut').click();
    await page.waitForFunction(()=>document.body.classList.contains('exporting'));
    assert(await page.locator('.recording-item').first().isDisabled());assert(await page.locator('#startInput').isDisabled());assert(await page.locator('#exportFormat').isDisabled());
    const vd=await videoDownload;assert(vd.suggestedFilename().endsWith('.mp4'));await vd.saveAs(path.join(out,'clip.mp4'));await page.waitForFunction(()=>!document.body.classList.contains('exporting'));
    const videoInfo=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration,format_name:stream=codec_type,codec_name:packet=pts_time,duration_time','-of','json',path.join(out,'clip.mp4')],{encoding:'utf8'}));
    const actualDuration=Math.max(...videoInfo.packets.map(p=>Number(p.pts_time)+Number(p.duration_time||0))); assert(Math.abs(actualDuration-3)<.4,`Video duration: ${actualDuration}`);delete videoInfo.packets;videoInfo.actualDuration=actualDuration;
    assert(videoInfo.streams.some(s=>s.codec_name==='h264'));assert(videoInfo.streams.some(s=>s.codec_name==='aac'));
    assert(videoInfo.format.format_name.includes('mp4'));
    assert.equal(fs.readFileSync(path.join(out,'clip.mp4')).subarray(4,8).toString(),'ftyp');
    const repeated=page.waitForEvent('download');await page.locator('#saveClip').click();assert((await repeated).suggestedFilename().endsWith('.mp4'));
    // Full-range MP4 must still be encoded, even though the original source is WebM.
    await page.locator('#reset').click();
    const fullDownload=page.waitForEvent('download');await page.locator('#cut').click();await (await fullDownload).saveAs(path.join(out,'full.mp4'));
    const fullInfo=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name','-of','json',path.join(out,'full.mp4')],{encoding:'utf8'}));
    assert(fullInfo.streams.some(s=>s.codec_name==='h264'));assert(fullInfo.streams.some(s=>s.codec_name==='aac'));assert(Math.abs(Number(fullInfo.format.duration)-6)<.4);
    await page.locator('#startInput').fill('1');await page.locator('#startInput').press('Enter');await page.locator('#endInput').fill('4');await page.locator('#endInput').press('Enter');
    await page.locator('#exportFormat').selectOption('webm');assert(await page.locator('#saveClip').isHidden());
    const webmDownload=page.waitForEvent('download');await page.locator('#cut').click();const webm=await webmDownload;assert(webm.suggestedFilename().endsWith('.webm'));await webm.saveAs(path.join(out,'clip.webm'));
    const webmInfo=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=format_name:stream=codec_name','-of','json',path.join(out,'clip.webm')],{encoding:'utf8'}));
    assert(webmInfo.format.format_name.includes('webm'));assert(webmInfo.streams.some(s=>s.codec_name==='vp8'));assert(webmInfo.streams.some(s=>s.codec_name==='opus'));
    // Browser recordings can omit WebM duration / seek metadata, unlike ffmpeg fixtures.
    const browserPreviewStart=Date.now();
    await page.evaluate(async bytes=>{
      await dbWrite('sessions',{id:'browser-recorded',mode:'video',title:'浏览器录制测试',startedAt:Date.now(),durationMs:3000,status:'ready',mimeType:'video/webm'});
      await dbWrite('chunks',{id:'browser-recorded',index:0,blob:new Blob([new Uint8Array(bytes)],{type:'video/webm'})});
      await loadSession('browser-recorded');
    },[...fs.readFileSync(path.join(out,'clip.webm'))]);
    await page.waitForFunction(()=>document.querySelector('#filmstrip').getAttribute('aria-busy')==='false');
    await page.waitForFunction(async()=>{const cached=await dbRead('previews','browser-recorded');return cached?.peaks?.length && cached.thumbnails?.length;},{},{timeout:20000});
    assert(await page.locator('#filmstrip img').evaluateAll(images=>new Set(images.map(image=>image.src)).size>1));
    console.log('Browser-produced WebM preview:',Date.now()-browserPreviewStart,'ms');
    await page.evaluate(async()=>{await previewWrites;await dbDelete('browser-recorded');previewMemory.delete('browser-recorded');await loadSession('video');});
    await page.locator('.recording-item').filter({hasText:'声音备忘'}).click();await page.waitForFunction(()=>document.body.classList.contains('audio-mode'));
    await page.waitForFunction(()=>document.querySelector('#waveformLabel').hidden);
    await page.waitForFunction(async()=>!!(await dbRead('previews','audio'))?.peaks?.length);
    const beforeSwitch=await page.evaluate(()=>window.previewWork.decodes);
    await page.locator('.recording-item').filter({hasText:'网页录制'}).click();await page.waitForFunction(()=>current?.id==='video');
    await page.locator('.recording-item').filter({hasText:'声音备忘'}).click();await page.waitForFunction(()=>current?.id==='audio');
    assert.equal(await page.evaluate(()=>window.previewWork.decodes),beforeSwitch);
    await checkResponsiveLayout('audio');
    // Inspect real canvas pixels: both caps taper, and seeking while paused still
    // renders intermediate colours before settling without an idle animation loop.
    const waveAppearance=await page.evaluate(async()=>{
      const media=document.querySelector('#audioPlayer'),canvas=document.querySelector('#audioWave');
      await seekMedia(media,0);
      await new Promise(resolve=>setTimeout(resolve,400));
      const ctx=canvas.getContext('2d'),x=52,y=Math.floor(canvas.height/2);
      const pixel=()=>Array.from(ctx.getImageData(x,y,1,1).data);
      const dark=pixel();
      await seekMedia(media,4);
      const samples=[];
      const started=performance.now();
      await new Promise(resolve=>{
        function sample(){samples.push(pixel());if(performance.now()-started<420)requestAnimationFrame(sample);else resolve();}
        requestAnimationFrame(sample);
      });
      const light=pixel(),image=ctx.getImageData(0,0,canvas.width,canvas.height);
      const alpha=(px,py)=>image.data[(py*canvas.width+px)*4+3];
      let left=x,right=x,top=y,bottom=y;
      while(left>0 && alpha(left-1,y))left--;
      while(right<canvas.width-1 && alpha(right+1,y))right++;
      while(top>0 && alpha(x,top-1))top--;
      while(bottom<canvas.height-1 && alpha(x,bottom+1))bottom++;
      const row=py=>{let sum=0;for(let px=left;px<=right;px++)sum+=alpha(px,py);return sum;};
      const caps={top:row(top),bottom:row(bottom),middle:row(y)};
      await seekMedia(media,0);
      await new Promise(resolve=>setTimeout(resolve,400));
      return {dark,light,samples,caps,reset:pixel(),idle:audioWaveFrame===0};
    });
    assert.deepEqual(waveAppearance.dark,[83,110,82,255]);
    assert.deepEqual(waveAppearance.light,[178,239,131,255]);
    assert(waveAppearance.samples.some(p=>p[0]>83 && p[0]<178),'Wave bars must render intermediate brightness');
    for(let i=1;i<waveAppearance.samples.length;i++)assert(waveAppearance.samples[i][0]>=waveAppearance.samples[i-1][0],'Highlight must fade in smoothly');
    assert(waveAppearance.caps.top<waveAppearance.caps.middle && waveAppearance.caps.bottom<waveAppearance.caps.middle,'Both bar ends must be rounded');
    assert.deepEqual(waveAppearance.reset,waveAppearance.dark);assert(waveAppearance.idle,'Paused, settled wave must stop requesting animation frames');
    await page.screenshot({path:path.join(out,'audio-desktop.png'),fullPage:true});
    await page.locator('#startInput').fill('2');await page.locator('#startInput').press('Enter');await page.locator('#endInput').fill('5');await page.locator('#endInput').press('Enter');
    assert.equal(await page.locator('#exportFormat').inputValue(),'mp3');
    // Mono and stereo use different encoder paths; exercise both with real files.
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=330:sample_rate=44100','-t','1','-c:a','libopus','-y',path.join(out,'mono.webm')]);
    const monoBytes=[...fs.readFileSync(path.join(out,'mono.webm'))];
    const monoMp3=await page.evaluate(async bytes=>[...new Uint8Array(await (await createMP3(new Blob([new Uint8Array(bytes)],{type:'audio/webm'}),0,1)).arrayBuffer())],monoBytes);
    fs.writeFileSync(path.join(out,'mono.mp3'),Buffer.from(monoMp3));
    const monoInfo=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_name,channels','-of','json',path.join(out,'mono.mp3')],{encoding:'utf8'}));
    assert.equal(monoInfo.streams[0].codec_name,'mp3');assert.equal(monoInfo.streams[0].channels,1);assert(Math.abs(Number(monoInfo.format.duration)-1)<.15);
    // The error and retry state uses both a semantic label and the danger styling.
    await page.route('**/mp3-worker.js',route=>route.abort());await page.locator('#cut').click();
    await page.waitForFunction(()=>document.querySelector('#cut').dataset.state==='error' && !document.body.classList.contains('exporting'));
    assert.equal(await page.locator('#exportLabel').textContent(),'重试导出');assert.equal(await page.locator('#status').getAttribute('data-state'),'error');
    await page.unroute('**/mp3-worker.js');
    const mp3Download=page.waitForEvent('download');await page.locator('#cut').click();const mp3=await mp3Download;assert(mp3.suggestedFilename().endsWith('.mp3'));await mp3.saveAs(path.join(out,'clip.mp3'));
    const mp3Info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration,format_name:stream=codec_name,sample_rate,channels,bit_rate','-of','json',path.join(out,'clip.mp3')],{encoding:'utf8'}));
    assert.equal(mp3Info.streams[0].codec_name,'mp3');assert.equal(mp3Info.streams[0].channels,2);assert.equal(Number(mp3Info.streams[0].bit_rate),192000);assert(Math.abs(Number(mp3Info.format.duration)-3)<.15);
    const pcm=execFileSync('ffmpeg',['-v','error','-i',path.join(out,'clip.mp3'),'-ac','1','-ar','16000','-f','f32le','-']);let power=0;for(let i=0;i<pcm.length;i+=4)power+=pcm.readFloatLE(i)**2;assert(Math.sqrt(power/(pcm.length/4))>.02,'MP3 must contain audible audio');
    await page.locator('#exportFormat').selectOption('wav');assert(await page.locator('#saveClip').isHidden());
    const audioDownload=page.waitForEvent('download');await page.locator('#cut').click();const ad=await audioDownload;assert(ad.suggestedFilename().endsWith('.wav'));await ad.saveAs(path.join(out,'clip.wav'));
    const wav=fs.readFileSync(path.join(out,'clip.wav'));assert.equal(wav.subarray(0,4).toString(),'RIFF');const sr=wav.readUInt32LE(24),channels=wav.readUInt16LE(22);assert(Math.abs((wav.length-44)/2/channels/sr-3)<.01);
    assert.equal(await page.locator('#progressPercent').textContent(),'100%');assert.equal(await page.locator('#status').getAttribute('data-state'),'success');
    await page.locator('#reset').click();assert.equal(Number(await page.locator('#startRange').inputValue()),0);
    await page.locator('#timeline').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('#audioPlayer').paused);await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('#audioPlayer').paused);
    await page.locator('#timeline').click({position:{x:timeline.width*.4,y:40}});await page.keyboard.press('i');assert(Number(await page.locator('#startRange').inputValue())>2);
    await page.keyboard.press('ControlOrMeta+z');assert.equal(Number(await page.locator('#startRange').inputValue()),0);
    for(const width of [1024,768,390]){
      await page.setViewportSize({width,height:900});await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(250);await page.screenshot({path:path.join(out,`audio-${width}.png`),fullPage:true});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`horizontal overflow at ${width}`);
    }
    await page.setViewportSize({width:1440,height:960});
    page.once('dialog',dialog=>dialog.accept());await page.locator('#delete').click();await page.waitForFunction(()=>document.querySelectorAll('.recording-item').length===1);
    await page.waitForFunction(()=>!document.body.classList.contains('audio-mode'));
    page.once('dialog',dialog=>dialog.accept());await page.locator('#delete').click();await page.waitForFunction(()=>!document.querySelector('#empty').hidden);
    assert(await page.locator('#cut').isDisabled());assert.equal(await page.locator('.recording-item').count(),0);assert.equal(await page.evaluate(async()=>{const db=await openDatabase();const count=await new Promise((resolve,reject)=>{const req=db.transaction('chunks').objectStore('chunks').count();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});db.close();return count;}),0);
    assert.equal(await page.evaluate(async()=>{const db=await openDatabase();const count=await new Promise((resolve,reject)=>{const req=db.transaction('previews').objectStore('previews').count();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});db.close();return count;}),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: empty state, saved recordings, progressive thumbnails, low-rate waveform, v1 database upgrade, persistent and memory preview cache (no repeated decoding), rapid switching, trim drag, undo/redo, time input, selected preview, MP4 H.264/AAC (trim + full), WebM, MP3 192kbps and WAV exports, format fallback, keyboard, 11 viewport sizes in both media modes, deletion.');
    console.log('MP4 export:',JSON.stringify(videoInfo));console.log('MP3 export:',JSON.stringify(mp3Info));
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
