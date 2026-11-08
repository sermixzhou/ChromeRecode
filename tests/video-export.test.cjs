const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync,spawnSync}=require('node:child_process');
const {startServer}=require('./export-harness.cjs');
const assertMacOSPlayback=require('./macos-media.cjs');
const out=path.resolve(__dirname,'../test-results/capture');
function probe(file){
  const result=spawnSync('ffprobe',['-v','error','-show_entries','frame=width,height:stream=codec_name,codec_tag_string:format=duration','-of','json',file],{encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');return JSON.parse(result.stdout);
}
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const fixture=path.join(out,'5k.webm');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0x31b6b0:s=5120x2880:r=12,drawbox=x=0:y=0:w=iw:h=ih:color=0xf4a251:t=40','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libvpx','-b:v','300k','-deadline','realtime','-cpu-used','8','-threads','4','-c:a','libopus','-y',fixture]);
  const server=await startServer();let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
    const page=await browser.newPage(),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));page.context().on('request',r=>requests.push(r.url()));
    await page.goto(server.url+'/editor.html');
    await page.waitForFunction(()=>document.querySelector('#historyCount').textContent==='0');
    const result=await page.evaluate(async bytes=>{
      current={mode:'video'};const attempts=[],run=KeyeVideoExport.run;
      KeyeVideoExport.run=options=>{attempts.push(!!options.compatible);return run(options);};
      const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'video/webm'}));
      try{
        const blob=await createVideoClip(url,.5,2.5,'mp4');
        return {bytes:[...new Uint8Array(await blob.arrayBuffer())],compatible:compatibleVideoExport,attempts,stats:blob.exportStats,videos:document.querySelectorAll('video').length};
      }finally{KeyeVideoExport.run=run;URL.revokeObjectURL(url);}
    },[...fs.readFileSync(fixture)]);
    assert.equal(result.videos,1);assert.deepEqual(result.attempts,result.compatible?[false,true]:[false]);
    assert.equal(result.stats.engine,'WebCodecs');assert.equal(result.stats.storage,'OPFS');assert(result.stats.maxWriteBytes<=1024*1024);
    const filename=path.join(out,'5k-compatible.mp4');fs.writeFileSync(filename,Buffer.from(result.bytes));
    const info=probe(filename);assert(info.streams.some(s=>s.codec_name==='h264'));assert(info.streams.some(s=>s.codec_name==='aac'));
    assert(info.streams.some(s=>s.codec_tag_string==='avc1'));assertMacOSPlayback(filename);
    assert(Math.abs(Number(info.format.duration)-2)<.4);
    if(result.compatible)assert(info.frames.filter(f=>f.width).every(f=>f.width===1920&&f.height===1080));
    const pcm=execFileSync('ffmpeg',['-v','error','-i',filename,'-ac','1','-ar','16000','-f','f32le','-']);let power=0;for(let i=0;i<pcm.length;i+=4)power+=pcm.readFloatLE(i)**2;assert(Math.sqrt(power/(pcm.length/4))>.02);
    const rgb=execFileSync('ffmpeg',['-v','error','-ss','0.5','-i',filename,'-frames:v','1','-vf','scale=16:16','-pix_fmt','rgb24','-f','rawvideo','-']);
    for(const [x,y]of [[0,0],[15,0],[0,15],[15,15]])assert([...rgb.subarray((y*16+x)*3,(y*16+x)*3+3)].reduce((a,b)=>a+b,0)>160,'Compatibility export added black padding');
    // Preserve old variable-size recordings, but normalize their MP4 exports.
    const legacy=await page.evaluate(async()=>{
      const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
      canvas.width=640;canvas.height=360;
      const stream=canvas.captureStream(15),chunks=[];
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
      recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      const stopped=new Promise(resolve=>{recorder.onstop=resolve;});
      let tick=0;
      const draw=()=>{
        context.fillStyle='#31b6b0';context.fillRect(0,0,canvas.width,canvas.height);
        context.strokeStyle='#f4a251';context.lineWidth=16;context.strokeRect(8,8,canvas.width-16,canvas.height-16);
        context.fillStyle='#fff';context.fillRect(32+(tick++%20),32,30,30);
      };
      draw();recorder.start(100);
      const timer=setInterval(draw,50);
      try{
        for(const [width,height]of [[640,360],[360,640],[640,360]]){
          canvas.width=width;canvas.height=height;draw();
          await new Promise(resolve=>setTimeout(resolve,650));
        }
        recorder.stop();await stopped;
      }finally{clearInterval(timer);stream.getTracks().forEach(track=>track.stop());}
      const source=new Blob(chunks,{type:'video/webm'}),url=URL.createObjectURL(source),previous=current;
      current={mode:'video',videoWidth:640,videoHeight:360,variableResolution:true};
      try{
        const blob=await createVideoClip(url,.05,1.8,'mp4');
        return {source:[...new Uint8Array(await source.arrayBuffer())],exported:[...new Uint8Array(await blob.arrayBuffer())]};
      }finally{current=previous;URL.revokeObjectURL(url);}
    });
    const legacySource=path.join(out,'legacy-variable.webm'),legacyExport=path.join(out,'legacy-fixed.mp4');
    fs.writeFileSync(legacySource,Buffer.from(legacy.source));fs.writeFileSync(legacyExport,Buffer.from(legacy.exported));
    assert(new Set(probe(legacySource).frames.filter(f=>f.width).map(f=>`${f.width}x${f.height}`)).size>1,'Legacy fixture must change resolution');
    const legacyInfo=probe(legacyExport);
    assert(legacyInfo.frames.filter(f=>f.width).every(f=>f.width===640&&f.height===360));
    assert(legacyInfo.streams.some(s=>s.codec_tag_string==='avc1'));assertMacOSPlayback(legacyExport);
    // Exercise the packaged software AAC path under the real MV3 CSP.
    const software=await page.evaluate(async bytes=>{
      const file=await KeyeVideoExport.run({blob:new Blob([new Uint8Array(bytes)],{type:'video/webm'}),start:0,end:1,format:'mp4',compatible:true,forceSoftwareAudio:true});
      return {bytes:[...new Uint8Array(await file.arrayBuffer())],stats:file.exportStats};
    },[...fs.readFileSync(fixture)]);
    assert(software.stats.softwareAudio);const softwareFile=path.join(out,'software-aac.mp4');fs.writeFileSync(softwareFile,Buffer.from(software.bytes));
    assertMacOSPlayback(softwareFile);assert(probe(softwareFile).streams.some(s=>s.codec_name==='aac'));
    assert(requests.some(url=>url.endsWith('/aac-encoder-worker.js')),'AAC fallback must load the packaged local worker');
    assert(requests.every(url=>url.startsWith(server.url)||url.startsWith('blob:')),'Export must stay entirely local');
    // Unreadable input must fail cleanly and leave no partial export on disk.
    const failure=await page.evaluate(async()=>{
      const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('keye-exports');
      const before=[];for await(const name of dir.keys())before.push(name);
      let message;try{await KeyeVideoExport.run({blob:new Blob(['broken media']),start:0,end:1,format:'mp4'});}catch(e){message=e.message;}
      const after=[];for await(const name of dir.keys())after.push(name);
      return {message,before:before.sort(),after:after.sort(),videos:document.querySelectorAll('video').length};
    });
    assert(failure.message);assert.deepEqual(failure.before,failure.after);assert.equal(failure.videos,1);
    assert.deepEqual(errors,[]);
    console.log('PASS: offline WebCodecs 5K export and compatible retry; avc1/AAC, selected duration, audible audio, no added padding; legacy resize input; streamed disk output; local software AAC under MV3 CSP; invalid input leaves no partial file.',JSON.stringify({attempts:result.attempts,compatible:result.compatible,elapsedMs:result.stats.elapsedMs}));
  }finally{await browser?.close();await server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
