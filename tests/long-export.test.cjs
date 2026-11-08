const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {startServer,seedRecording}=require('./export-harness.cjs');
const assertMacOSPlayback=require('./macos-media.cjs');
const out=path.resolve(__dirname,'../test-results/long');
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const source=path.join(out,'hour.webm');
  if(!fs.existsSync(source)){
    const base=path.join(out,'base.webm');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','10','-c:v','libvpx','-b:v','900k','-deadline','realtime','-cpu-used','8','-threads','4','-c:a','libopus','-y',base]);
    execFileSync('ffmpeg',['-v','error','-stream_loop','359','-i',base,'-t','3600','-c','copy','-y',source]);
  }
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=width,height,r_frame_rate','-of','json',source],{encoding:'utf8'}));
  assert(Number(info.format.duration)>=3599.9,'Fixture must actually contain one hour');
  const server=await startServer({'/hour.webm':source});let browser,timer;
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'keye-long-'));
  try{
    browser=await chromium.launchPersistentContext(profile,{acceptDownloads:true,executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
    const page=await browser.newPage();
    await page.goto(server.url+'/editor.html');
    await page.waitForFunction(()=>typeof KeyeVideoExport!=='undefined');
    const video=info.streams.find(s=>s.width),session={id:'hour',videoWidth:video.width,videoHeight:video.height,durationMs:3600000};
    console.log('Seeding one-hour source into chunked IndexedDB…');
    const stored=await seedRecording(page,server.url+'/hour.webm',session);console.log('Source:',stored,'Storage:',await page.evaluate(()=>navigator.storage.estimate()));
    const download=page.waitForEvent('download',{timeout:30*60*1000});
    download.catch(()=>{});
    const began=Date.now();
    timer=setInterval(async()=>{try{console.log('Long export:',await page.evaluate(()=>window.longExportProgress||'initializing'));}catch{}},15000);
    const result=await page.evaluate(async session=>{
      const file=await KeyeVideoExport.run({sessionId:session.id,start:0,end:3600,format:'mp4',width:session.videoWidth,height:session.videoHeight,onProgress:(value,phase)=>{window.longExportProgress={percent:Math.round(value*100),phase};}});
      KeyeVideoExport.download(file,'hour.mp4');return file.exportStats;
    },session);
    const target=path.join(out,'hour.mp4');await (await download).saveAs(target);
    clearInterval(timer);timer=null;
    assert.equal(result.engine,'WebCodecs');assert.equal(result.storage,'OPFS');assert(result.bytesRead>0);
    assert(result.maxReadBytes<=256*1024);assert(result.maxWriteBytes<=1024*1024);
    assert(Math.abs(result.videoDuration-3600)<.3);assert(Math.abs(result.audioDuration-3600)<.3);
    const packets=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','packet=pts_time,duration_time','-of','json',target],{encoding:'utf8',maxBuffer:32*1024*1024})).packets;
    assert.equal(result.frameRate,30);assert.equal(result.videoBitrate,20000000);
    assert.equal(packets.length,108000,'One-hour export must contain 30fps throughout');
    const times=packets.map(p=>Number(p.pts_time));assert(times.at(-1)>3599.8);
    for(let i=1;i<times.length;i++)assert(Math.abs(times[i]-times[i-1]-1/30)<.00001,`Video cadence changed at ${times[i]}`);
    for(const second of [0,600,1800,3000,3598]){
      const rgb=execFileSync('ffmpeg',['-v','error','-ss',String(second),'-i',target,'-t','1.1','-vf','fps=2,scale=64:36','-pix_fmt','rgb24','-f','rawvideo','-']);
      assert(rgb.length>=2*64*36*3);const a=rgb.subarray(0,64*36*3),b=rgb.subarray(64*36*3,2*64*36*3);
      assert(a.reduce((n,x)=>n+x,0)/a.length>25);assert(!a.equals(b),`Frozen picture at ${second}`);
    }
    assertMacOSPlayback(target,{sampled:true});
    const metrics={...result,wallSeconds:(Date.now()-began)/1000,outputBytes:fs.statSync(target).size,frames:packets.length,source:stored};
    fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
    console.log('PASS: one-hour 1080p input → high-quality 30fps/20Mbps IndexedDB → WebCodecs → streamed MP4; bounded reads/writes; full audio/video tails, packet continuity, moving pictures at start/middle/end, native macOS samples.',JSON.stringify(metrics));
  }catch(error){console.error('Long-export failure:',error);throw error;}
  finally{clearInterval(timer);await browser?.close();await server.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
