const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
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
function checkSizes(frames,expected){
  let cursor=0;
  for(const size of expected){
    const next=frames.findIndex((frame,index)=>index>=cursor && Math.abs(frame.width-size.width*size.scale)<=2 && Math.abs(frame.height-size.height*size.scale)<=2);
    assert(next>=0,`Missing captured dimensions ${size.width}×${size.height} @${size.scale}×`);cursor=next+1;
  }
}
function checkCorners(filename,frames){
  const groups=[];
  for(const frame of frames){
    const last=groups.at(-1);
    if(!last || last[0].width!==frame.width || last[0].height!==frame.height)groups.push([frame]);
    else last.push(frame);
  }
  for(const group of groups){
    const frame=group[Math.floor(group.length/2)];
    const result=spawnSync('ffmpeg',['-v','error','-ss',frame.best_effort_timestamp_time,'-i',filename,'-frames:v','1','-vf','scale=16:16','-pix_fmt','rgb24','-f','rawvideo','-'],{maxBuffer:1024*1024});
    assert.equal(result.status,0,result.stderr.toString());assert.equal(result.stdout.length,16*16*3);
    for(const [x,y] of [[0,0],[15,0],[0,15],[15,15]]){
      const offset=(y*16+x)*3,pixel=[...result.stdout.subarray(offset,offset+3)];
      assert(pixel.reduce((a,b)=>a+b,0)>160,`Unexpected black padding at ${frame.width}×${frame.height}: ${pixel}`);
    }
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
  // Grant only the local fixture in this disposable test copy so real CSS
  // injection can be checked without an interactive toolbar gesture.
  manifest.host_permissions=['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  const server=http.createServer((request,response)=>{
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>刻页录制尺寸测试</title><style>html,body{margin:0;width:100%;height:100%;background:#31b6b0}body{box-sizing:border-box;border:16px solid #f4a251}main{width:100%;height:100%;background:#31b6b0;display:grid;place-items:center}button{font-size:24px;padding:20px}output{position:absolute;top:30px;left:30px;color:#20423d}</style></head><body><main id="scene"><button onclick="document.getElementById('scene').requestFullscreen()">全屏测试</button><output id="tick"></output></main><script>let frame=0;function tick(){document.getElementById('tick').textContent=++frame;requestAnimationFrame(tick)}tick()</script></body></html>`);
  });
  let context;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    context=await chromium.launchPersistentContext(path.join(scratch,'profile'),{
      executablePath:testBrowser(),headless:true,viewport:null,
      args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--allowlisted-extension-id=${id}`,'--autoplay-policy=no-user-gesture-required','--window-size=960,650']
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const url=`http://127.0.0.1:${server.address().port}/`;
    const newTarget=context.waitForEvent('page');
    const tab=await worker.evaluate(url=>chrome.tabs.create({url}),url);
    const target=await newTarget;await target.waitForURL(url);await target.waitForLoadState();
    await target.evaluate(()=>{
      const bar=document.createElement('div');bar.className='bpx-player-shadow-progress-area';
      bar.style.cssText='position:fixed;bottom:0;left:0;width:40px;height:2px;background:#00aeec';document.body.append(bar);
    });
    // Only spoof the fixture's hostname for product routing; the page and
    // capture remain on localhost. No real Bilibili page is opened or modified.
    await worker.evaluate(tabId=>{
      const get=chrome.tabs.get.bind(chrome.tabs);
      chrome.tabs.get=async id=>{const tab=await get(id);return id===tabId?{...tab,url:'https://www.bilibili.com/video/fixture'}:tab;};
    },tab.id);
    const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(()=>typeof currentState!=='undefined'&&currentState?.phase==='idle');
    await popup.evaluate(tab=>{currentTab={id:tab.id,title:'尺寸自适应测试'};window.close=()=>{};},tab);
    await popup.locator('#recordVideo').click();
    await popup.waitForFunction(()=>!sending&&(currentState?.phase==='recording'||!document.querySelector('#error').hidden));
    assert(await popup.locator('#error').isHidden(),await popup.locator('#error').textContent());
    assert.equal(await target.locator('.bpx-player-shadow-progress-area').evaluate(el=>getComputedStyle(el).visibility),'hidden');
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
    assert.equal(await target.locator('.bpx-player-shadow-progress-area').evaluate(el=>getComputedStyle(el).visibility),'visible');
    const metadata=await editor.evaluate(()=>({variableResolution:current.variableResolution,width:current.videoWidth,height:current.videoHeight}));
    assert.equal(metadata.variableResolution,true,'Actual resize events must be retained for safe MP4 export');
    const source=await editor.evaluate(async()=>[...new Uint8Array(await sourceBlob.arrayBuffer())]);
    const sourceFile=path.join(out,'adaptive-recording.webm');fs.writeFileSync(sourceFile,Buffer.from(source));
    const sourceFrames=probeVideo(sourceFile);checkSizes(sourceFrames,sizes);checkCorners(sourceFile,sourceFrames);
    // An old browser must offer WebM rather than silently creating broken avc1 MP4.
    const fallback=await editor.evaluate(()=>{
      const supported=MediaRecorder.isTypeSupported;
      try{
        MediaRecorder.isTypeSupported=type=>!type.includes('avc3')&&supported.call(MediaRecorder,type);
        configureExportFormats();return {selected:document.querySelector('#exportFormat').value,mp4Disabled:document.querySelector('option[value=mp4]').disabled};
      }finally{MediaRecorder.isTypeSupported=supported;configureExportFormats();}
    });
    assert.equal(fallback.selected,'webm');assert.equal(fallback.mp4Disabled,true);
    assert(await editor.evaluate(()=>videoMime('mp4')?.includes('avc3')),'Test browser must support variable-resolution MP4');
    const mp4=await editor.evaluate(async()=>[...new Uint8Array(await (await createVideoClip(sourceURL,.1,duration-.1,'mp4')).arrayBuffer())]);
    const mp4File=path.join(out,'adaptive-trim.mp4');fs.writeFileSync(mp4File,Buffer.from(mp4));
    const mp4Frames=probeVideo(mp4File);checkSizes(mp4Frames,sizes);checkCorners(mp4File,mp4Frames);
    // An encoder failure must restart the same selection in compatibility mode,
    // including aspect-ratio changes in both directions, without black padding.
    const compatible=await editor.evaluate(async()=>{
      const NativeRecorder=MediaRecorder;let attempts=0;const streams=[];
      window.MediaRecorder=class extends NativeRecorder{
        constructor(stream,options){super(stream,options);streams.push(stream);}
        start(...args){if(++attempts===1)throw new DOMException('Unsupported native dimensions','NotSupportedError');return super.start(...args);}
      };
      try{
        const blob=await createVideoClip(sourceURL,.1,duration-.1,'mp4');
        return {bytes:[...new Uint8Array(await blob.arrayBuffer())],attempts,compatible:compatibleVideoExport,stopped:streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))};
      }finally{window.MediaRecorder=NativeRecorder;}
    });
    assert.equal(compatible.attempts,2);assert(compatible.compatible);assert(compatible.stopped);
    const compatibleFile=path.join(out,'adaptive-compatible.mp4');fs.writeFileSync(compatibleFile,Buffer.from(compatible.bytes));
    const compatibleFrames=probeVideo(compatibleFile);
    const compatibleSizes=sizes.map(size=>{
      const width=size.width*size.scale,height=size.height*size.scale;
      const scale=Math.min(1,1920/Math.max(width,height),1080/Math.min(width,height));
      return {width:Math.floor(width*scale/2)*2,height:Math.floor(height*scale/2)*2,scale:1};
    });
    checkSizes(compatibleFrames,compatibleSizes);checkCorners(compatibleFile,compatibleFrames);
    console.log('PASS: real tabCapture + offscreen recording; progress-layer CSS injection/restoration; native wide/portrait/fullscreen/restored dimensions; no black padding; native and compatibility H.264 MP4 decode without errors; unsupported avc3 falls back to WebM.',JSON.stringify(sizes));
  }finally{
    await context?.close();server.close();fs.rmSync(scratch,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
