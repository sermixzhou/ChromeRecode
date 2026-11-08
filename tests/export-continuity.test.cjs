const fs=require('node:fs');
const path=require('node:path');
const {startServer,seedRecording}=require('./export-harness.cjs');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const assertMacOSPlayback=require('./macos-media.cjs');
const launchNativeChrome=require('./native-chrome.cjs');
const root=path.resolve(__dirname,'../extension');
const out=path.resolve(__dirname,'../test-results/continuity');

function checkContinuity(filename){
  const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_tag_string,duration:frame=width,height,best_effort_timestamp_time','-of','json',filename],{encoding:'utf8'}));
  const video=info.streams.find(s=>s.codec_type==='video'),audio=info.streams.find(s=>s.codec_type==='audio');
  assert.equal(video.codec_tag_string,'avc1');
  assert(Math.abs(Number(video.duration)-35)<.4,`Video duration ${video.duration}`);
  assert(Math.abs(Number(audio.duration)-35)<.4,`Audio duration ${audio.duration}`);
  assert(Math.abs(Number(video.duration)-Number(audio.duration))<.3,'Audio and video must cover the same interval');
  const frames=info.frames.filter(f=>f.width);
  assert(frames.length>35*15,'Export must retain moving video throughout');
  assert(frames.every(f=>f.width===640&&f.height===360));
  const times=frames.map(f=>Number(f.best_effort_timestamp_time));
  assert(times.at(-1)>34.6,'Video tail is missing');
  for(let i=1;i<times.length;i++)assert(times[i]-times[i-1]<.3,`Video gap at ${times[i-1]} → ${times[i]}`);
  const rgb=execFileSync('ffmpeg',['-v','error','-i',filename,'-vf','fps=1,scale=64:36','-pix_fmt','rgb24','-f','rawvideo','-']);
  const size=64*36*3;let previous;
  assert(rgb.length>=34*size,'Decoded video must reach the last second');
  for(let offset=0;offset+size<=rgb.length;offset+=size){
    const frame=rgb.subarray(offset,offset+size),hash=createHash('sha256').update(frame).digest('hex');
    assert(frame.reduce((sum,value)=>sum+value,0)/size>25,`Black frame at second ${offset/size}`);
    assert.notEqual(hash,previous,`Frozen frame at second ${offset/size}`);previous=hash;
  }
  assertMacOSPlayback(filename);
}

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const fixture=path.join(out,'continuity-source.webm');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','38','-c:v','libvpx','-b:v','600k','-deadline','realtime','-cpu-used','8','-c:a','libopus','-y',fixture]);
  const server=await startServer({'/source.webm':fixture});
  const browsers=[];
  try{
    async function runCase(compatible){
      const browser=await launchNativeChrome();browsers.push(browser);
      const {context}=browser;
      try{
        const page=await context.newPage(),errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        await page.goto(server.url+'/editor.html');
        await page.waitForFunction(()=>document.querySelector('#historyCount').textContent==='0');
        await seedRecording(page,server.url+'/source.webm',{id:'continuity',videoWidth:640,videoHeight:360,durationMs:38000});
        const cover=await context.newPage();await cover.bringToFront();
        await page.waitForFunction(()=>document.hidden);
        const result=await page.evaluate(async compatible=>{
          // A file conversion must never drive any HTML player or MediaRecorder.
          const forbidden=()=>{throw new Error('Realtime export path must not be used');};
          HTMLMediaElement.prototype.play=forbidden;
          HTMLMediaElement.prototype.captureStream=forbidden;
          HTMLVideoElement.prototype.requestVideoFrameCallback=forbidden;
          window.MediaRecorder=class{constructor(){forbidden();}};
          const file=await KeyeVideoExport.run({sessionId:'continuity',start:.1,end:35.1,format:'mp4',width:640,height:360,compatible,forceSoftwareAudio:compatible});
          return {bytes:[...new Uint8Array(await file.arrayBuffer())],stats:file.exportStats,hidden:document.hidden};
        },compatible);
        assert(result.hidden,'Exporter must remain in a genuinely background tab');
        assert.equal(result.stats.engine,'WebCodecs');assert.equal(result.stats.storage,'OPFS');
        assert(result.stats.maxReadBytes<=256*1024);assert(result.stats.maxWriteBytes<=1024*1024);
        if(compatible)assert(result.stats.softwareAudio);
        assert.deepEqual(errors,[]);
        const filename=path.join(out,compatible?'background-compatible.mp4':'background-normal.mp4');
        fs.writeFileSync(filename,Buffer.from(result.bytes));checkContinuity(filename);
      }finally{await browser.close();}
    }
    await runCase(false);await runCase(true);
    console.log('PASS: 35-second file conversions in genuine background tabs, normal and software-AAC compatible paths; HTML playback, capture, compositor callbacks and MediaRecorder forbidden; matching A/V tails; no gaps, frozen/black seconds; fixed avc1 dimensions; native macOS decoding.');
  }finally{await Promise.allSettled(browsers.map(browser=>browser.close()));await server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
