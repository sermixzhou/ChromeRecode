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
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=220:sample_rate=48000','-af','tremolo=f=2:d=0.8','-t','8','-c:a','libopus','-y',path.join(out,'audio.webm')]);
  const server=http.createServer((req,res)=>{
    const target=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!target.startsWith(root+'/')){res.writeHead(403).end();return;}
    try{const data=fs.readFileSync(target);res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'text/html');res.setHeader('Content-Security-Policy',"script-src 'self'; object-src 'self'");res.end(data);}catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  server.unref();
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),channel:process.env.CHROME_PATH || process.platform==='darwin'?undefined:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:1440,height:960},acceptDownloads:true});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}/editor.html`);
    await page.waitForFunction(()=>document.querySelector('#historyCount').textContent==='0');
    assert(await page.locator('#empty').isVisible());assert(await page.locator('#cut').isDisabled());
    await page.screenshot({path:path.join(out,'empty.png')});
    for(const [id,mode] of [['video','video'],['audio','audio']]){
      const bytes=[...fs.readFileSync(path.join(out,`${id}.webm`))];
      await page.evaluate(async({id,mode,bytes})=>{
        await dbWrite('sessions',{id,mode,title:mode==='video'?'周末的灵感 · 网页录制':'午后电台 · 声音备忘',startedAt:Date.now()-(mode==='video'?0:60000),durationMs:mode==='video'?6000:8000,status:'ready',mimeType:mode==='video'?'video/webm':'audio/webm'});
        await dbWrite('chunks',{id,index:0,blob:new Blob([new Uint8Array(bytes)],{type:mode==='video'?'video/webm':'audio/webm'})});
      },{id,mode,bytes});
    }
    await page.reload();await page.waitForSelector('#workArea:not([hidden])');
    await page.waitForFunction(()=>document.querySelectorAll('#filmstrip img').length===10,{},{timeout:20000});
    await page.waitForFunction(()=>document.querySelector('#waveformLabel').hidden);
    assert.equal(await page.locator('.recording-item').count(),2);
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
    const videoDownload=page.waitForEvent('download');await page.locator('#cut').click();
    await page.waitForFunction(()=>document.body.classList.contains('exporting'));
    assert(await page.locator('.recording-item').first().isDisabled());assert(await page.locator('#startInput').isDisabled());
    const vd=await videoDownload;await vd.saveAs(path.join(out,'clip.webm'));await page.waitForFunction(()=>!document.body.classList.contains('exporting'));
    const videoInfo=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type:packet=pts_time,duration_time','-of','json',path.join(out,'clip.webm')],{encoding:'utf8'}));
    const actualDuration=Math.max(...videoInfo.packets.map(p=>Number(p.pts_time)+Number(p.duration_time||0))); assert(Math.abs(actualDuration-3)<.4,`Video duration: ${actualDuration}`);delete videoInfo.packets;videoInfo.actualDuration=actualDuration;
    assert(videoInfo.streams.some(s=>s.codec_type==='video'));assert(videoInfo.streams.some(s=>s.codec_type==='audio'));
    await page.locator('.recording-item').filter({hasText:'声音备忘'}).click();await page.waitForFunction(()=>document.body.classList.contains('audio-mode'));
    await page.waitForFunction(()=>document.querySelector('#waveformLabel').hidden);
    await page.screenshot({path:path.join(out,'audio-desktop.png'),fullPage:true});
    await page.locator('#startInput').fill('2');await page.locator('#startInput').press('Enter');await page.locator('#endInput').fill('5');await page.locator('#endInput').press('Enter');
    const audioDownload=page.waitForEvent('download');await page.locator('#cut').click();const ad=await audioDownload;await ad.saveAs(path.join(out,'clip.wav'));
    const wav=fs.readFileSync(path.join(out,'clip.wav'));assert.equal(wav.subarray(0,4).toString(),'RIFF');const sr=wav.readUInt32LE(24),channels=wav.readUInt16LE(22);assert(Math.abs((wav.length-44)/2/channels/sr-3)<.01);
    assert.equal(await page.locator('#progressPercent').textContent(),'100%');
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
    assert.deepEqual(errors,[]);
    console.log('PASS: empty state, saved recordings, 10 thumbnails, waveform, trim drag, undo/redo, time input, selected preview, 3s video + audio export, 3s WAV export, keyboard, 3 responsive sizes, deletion.');
    console.log('Video export:',JSON.stringify(videoInfo));
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
