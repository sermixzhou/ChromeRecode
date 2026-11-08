const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const assertMacOSPlayback=require('./macos-media.cjs');
const extensionRoot=path.resolve(__dirname,'../extension');
const out=path.resolve(__dirname,'../test-results/capture');

function testBrowser(){
  if(process.env.CHROME_TEST_PATH)return process.env.CHROME_TEST_PATH;
  const cache=process.platform==='darwin'?path.join(os.homedir(),'Library/Caches/ms-playwright'):path.join(os.homedir(),'.cache/ms-playwright');
  if(fs.existsSync(cache)){
    const revisions=fs.readdirSync(cache).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]));
    for(const revision of revisions){
      for(const relative of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','chrome-linux64/chrome','chrome-linux/chrome']){
        const candidate=path.join(cache,revision,relative);if(fs.existsSync(candidate))return candidate;
      }
    }
  }
  throw new Error('Real extension recording tests require Chrome for Testing; set CHROME_TEST_PATH to its executable.');
}
function probeVideo(filename){
  const result=spawnSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','frame=width,height,best_effort_timestamp_time','-of','json',filename],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr.trim(),'','Every recorded frame must decode without errors');
  return JSON.parse(result.stdout).frames;
}
function checkFixedSize(frames,width,height){
  assert(frames.length>30,'Recording must contain actual video frames');
  assert(frames.every(frame=>frame.width===width && frame.height===height),`Every frame must remain ${width}×${height}`);
}
function checkContent(filename,frames){
  // Sample throughout the recording so resizing/fullscreen cannot leave a blank
  // or undecodable frame. Padding is allowed when the page's aspect ratio changes.
  for(const fraction of [.1,.4,.65,.9]){
    const frame=frames[Math.floor((frames.length-1)*fraction)];
    const result=spawnSync('ffmpeg',['-v','error','-ss',frame.best_effort_timestamp_time,'-i',filename,'-frames:v','1','-vf','scale=16:16','-pix_fmt','rgb24','-f','rawvideo','-'],{maxBuffer:1024*1024});
    assert.equal(result.status,0,result.stderr.toString());assert.equal(result.stdout.length,16*16*3);
    const offset=(8*16+8)*3,pixel=[...result.stdout.subarray(offset,offset+3)];
    assert(pixel.reduce((a,b)=>a+b,0)>160,`Missing page content at ${frame.best_effort_timestamp_time}: ${pixel}`);
  }
}

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'keye-recording-test-'));
  const extension=path.join(scratch,'extension');fs.cpSync(extensionRoot,extension,{recursive:true});
  // The test-only public key makes the isolated extension ID known before launch.
  // Chrome's allowlist flag simulates the toolbar grant for this local fixture;
  // the product manifest and the user's everyday Chrome profile are untouched.
  const publicKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
  const id=[...crypto.createHash('sha256').update(publicKey).digest().subarray(0,16)].map(byte=>String.fromCharCode(97+(byte>>4),97+(byte&15))).join('');
  const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
  manifest.key=publicKey.toString('base64');
  fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  const server=http.createServer((request,response)=>{
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>刻页录制尺寸测试</title><style>html,body{margin:0;width:100%;height:100%;background:#31b6b0}body{box-sizing:border-box;border:16px solid #f4a251}main{width:100%;height:100%;background:#31b6b0;display:grid;place-items:center}button{font-size:24px;padding:20px}output{position:absolute;top:30px;left:30px;color:#20423d}</style></head><body><main id="scene"><button onclick="document.getElementById('scene').requestFullscreen()">全屏测试</button><output id="tick"></output></main><script>let frame=0;function tick(){document.getElementById('tick').textContent=++frame;requestAnimationFrame(tick)}tick()</script></body></html>`);
  });
  let context;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    context=await chromium.launchPersistentContext(path.join(scratch,'profile'),{
      executablePath:testBrowser(),headless:true,viewport:null,acceptDownloads:true,downloadsPath:path.join(scratch,'downloads'),
      args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--allowlisted-extension-id=${id}`,'--autoplay-policy=no-user-gesture-required','--window-size=960,650']
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const url=`http://127.0.0.1:${server.address().port}/`;
    const newTarget=context.waitForEvent('page');
    const tab=await worker.evaluate(url=>chrome.tabs.create({url}),url);
    const target=await newTarget;await target.waitForURL(url);await target.waitForLoadState();
    await target.evaluate(()=>{
      const bar=document.createElement('div');bar.id='fixture-progress';
      bar.style.cssText='position:fixed;bottom:0;left:0;width:40px;height:2px;background:#00aeec';document.body.append(bar);
    });
    const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(()=>typeof currentState!=='undefined'&&currentState?.phase==='idle');
    await popup.evaluate(tab=>{currentTab={id:tab.id,title:'尺寸自适应测试'};window.close=()=>{};},tab);
    await popup.locator('#recordVideo').click();
    await popup.waitForFunction(()=>!sending&&(currentState?.phase==='recording'||!document.querySelector('#error').hidden));
    assert(await popup.locator('#error').isHidden(),await popup.locator('#error').textContent());
    assert.equal(await target.locator('#fixture-progress').evaluate(el=>getComputedStyle(el).visibility),'visible');
    await target.bringToFront();
    const sizes=[];
    async function sampleSize(){
      await target.waitForTimeout(1000);
      sizes.push(await target.evaluate(()=>({width:innerWidth,height:innerHeight,scale:devicePixelRatio})));
    }
    await sampleSize();
    const devtools=await context.newCDPSession(target);
    const {windowId}=await devtools.send('Browser.getWindowForTarget');
    await devtools.send('Browser.setWindowBounds',{windowId,bounds:{width:700,height:900}});
    await target.waitForFunction(()=>innerWidth===700);await sampleSize();
    await target.getByRole('button',{name:'全屏测试',exact:true}).click();
    await target.waitForFunction(()=>!!document.fullscreenElement);await sampleSize();
    await target.evaluate(()=>document.exitFullscreen());
    await target.waitForFunction(()=>!document.fullscreenElement);await sampleSize();
    assert(sizes[0].width/sizes[0].height>1.5 && sizes[1].width/sizes[1].height<1,'Test must cover both wide and tall windows');
    assert.notEqual(sizes[1].height,sizes[2].height,'Fullscreen must change the captured viewport');
    await popup.bringToFront();await popup.locator('#stop').click();
    await popup.waitForFunction(()=>!sending&&currentState?.phase==='idle');
    const editor=await context.newPage();await editor.goto(`chrome-extension://${id}/editor.html`);
    await editor.waitForFunction(()=>typeof current!=='undefined'&&current?.mode==='video'&&player().readyState>=2);
    assert.equal(await target.locator('#fixture-progress').evaluate(el=>getComputedStyle(el).visibility),'visible');
    const metadata=await editor.evaluate(()=>({variableResolution:current.variableResolution,width:current.videoWidth,height:current.videoHeight,frameRate:current.videoFrameRate,videoBitrate:current.videoBitrate}));
    assert(!metadata.variableResolution,'New recordings must use a fixed resolution');
    assert.equal(metadata.frameRate,30);assert(metadata.videoBitrate>=20000000,'Capture must keep detail before exporting');
    assert(Math.abs(metadata.width-sizes[0].width*sizes[0].scale)<=2,JSON.stringify({metadata,sizes}));
    assert(Math.abs(metadata.height-sizes[0].height*sizes[0].scale)<=2,JSON.stringify({metadata,sizes}));
    const source=await editor.evaluate(async()=>[...new Uint8Array(await sourceBlob.arrayBuffer())]);
    const sourceFile=path.join(out,'adaptive-recording.webm');fs.writeFileSync(sourceFile,Buffer.from(source));
    const sourceFrames=probeVideo(sourceFile);checkFixedSize(sourceFrames,metadata.width,metadata.height);checkContent(sourceFile,sourceFrames);
    // Older variable-size session metadata must never select avc3 again.
    const fallback=await editor.evaluate(()=>{
      const supported=MediaRecorder.isTypeSupported;
      try{
        current.variableResolution=true;
        MediaRecorder.isTypeSupported=type=>!type.includes('avc3')&&supported.call(MediaRecorder,type);
        configureExportFormats();return {selected:document.querySelector('#exportFormat').value,mp4Disabled:document.querySelector('option[value=mp4]').disabled};
      }finally{delete current.variableResolution;MediaRecorder.isTypeSupported=supported;configureExportFormats();}
    });
    assert.equal(fallback.selected,'mp4');assert.equal(fallback.mp4Disabled,false);
    assert(await editor.evaluate(()=>videoMime('mp4')?.includes('avc1')),'MP4 must use QuickTime-compatible avc1');
    const mp4=await editor.evaluate(async()=>[...new Uint8Array(await (await createVideoClip(sourceURL,.1,duration-.1,'mp4')).arrayBuffer())]);
    const mp4File=path.join(out,'adaptive-trim.mp4');fs.writeFileSync(mp4File,Buffer.from(mp4));
    const mp4Frames=probeVideo(mp4File);checkFixedSize(mp4Frames,metadata.width,metadata.height);checkContent(mp4File,mp4Frames);
    assertMacOSPlayback(mp4File);
    for(let i=1;i<mp4Frames.length;i++)assert(Math.abs(Number(mp4Frames[i].best_effort_timestamp_time)-Number(mp4Frames[i-1].best_effort_timestamp_time)-1/30)<.0001,'MP4 frames must follow a steady 30fps clock');
    // The explicit compatible path also uses the disk-backed WebCodecs worker.
    const compatible=await editor.evaluate(async()=>{
      const blob=window.compatibleExport=await encodeVideoClip(sourceURL,.1,duration-.1,videoMime('mp4'),true);
      return {bytes:[...new Uint8Array(await blob.arrayBuffer())],stats:blob.exportStats};
    });
    assert.equal(compatible.stats.frameRate,30);assert.equal(compatible.stats.qualityPreset,'footage');
    assert.equal(compatible.stats.engine,'WebCodecs');assert.equal(compatible.stats.storage,'OPFS');
    assert(compatible.stats.maxReadBytes<=256*1024);assert(compatible.stats.maxWriteBytes<=1024*1024);
    const compatibleFile=path.join(out,'adaptive-compatible.mp4');fs.writeFileSync(compatibleFile,Buffer.from(compatible.bytes));
    const compatibleFrames=probeVideo(compatibleFile);
    const scale=Math.min(1,1920/Math.max(metadata.width,metadata.height),1080/Math.min(metadata.width,metadata.height));
    checkFixedSize(compatibleFrames,Math.floor(metadata.width*scale/2)*2,Math.floor(metadata.height*scale/2)*2);checkContent(compatibleFile,compatibleFrames);
    assertMacOSPlayback(compatibleFile);
    const download=editor.waitForEvent('download');
    await editor.evaluate(()=>KeyeVideoExport.download(window.compatibleExport,'keye-test-download.mp4'));
    const downloaded=await download;
    const downloadedFile=path.join(out,'actual-extension-download.mp4');await downloaded.saveAs(downloadedFile);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(downloadedFile)).digest('hex'),crypto.createHash('sha256').update(fs.readFileSync(compatibleFile)).digest('hex'));
    await editor.waitForFunction(async()=>Object.keys(await chrome.storage.local.get(null)).every(key=>!key.startsWith('keyeExportDownload:')));
    await editor.evaluate(()=>KeyeVideoExport.release(window.compatibleExport));
    console.log('PASS: real tabCapture + offscreen recording; page progress stays visible; recording and avc1 MP4 keep their initial dimensions through wide/portrait/fullscreen/restored windows; compatible retry stays fixed and decodes.',JSON.stringify(sizes));
  }finally{
    await context?.close();server.close();fs.rmSync(scratch,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
