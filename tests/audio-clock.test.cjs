const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {startServer}=require('./export-harness.cjs');
const out=path.resolve(__dirname,'../test-results/audio-clock');
(async()=>{
  fs.mkdirSync(out,{recursive:true});const source=path.join(out,'clock-gaps.webm');
  // 20 seconds of PCM spread over 21 seconds of packet timestamps. A decoder
  // that concatenates PCM clocks will advance the last pulse by ~one second.
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=12','-f','lavfi','-i','aevalsrc=0.4*sin(2*PI*440*t)*lt(mod(t\\,1)\\,0.1):s=48000:d=20','-af','asetpts=1.05*PTS','-t','22','-c:v','libvpx','-b:v','300k','-deadline','realtime','-cpu-used','8','-c:a','libopus','-y',source]);
  const server=await startServer({'/source.webm':source});let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
    const page=await browser.newPage();await page.goto(server.url+'/editor.html');
    const cases=[{format:'mp4'},{format:'mp4',forceSoftwareAudio:true},{format:'webm'}];
    for(const options of cases){
      const result=await page.evaluate(async options=>{
        const file=await KeyeVideoExport.run({blob:await(await fetch('/source.webm')).blob(),start:0,end:20.9,...options});
        const bytes=[...new Uint8Array(await file.arrayBuffer())];await KeyeVideoExport.release(file);return {bytes,stats:file.exportStats};
      },options);
      assert(Math.abs(result.stats.audioDuration-20.9)<.12,JSON.stringify(result.stats));
      const filename=path.join(out,`${options.format}${options.forceSoftwareAudio?'-software':''}.${options.format}`);fs.writeFileSync(filename,Buffer.from(result.bytes));
      const pcm=execFileSync('ffmpeg',['-v','error','-i',filename,'-vn','-ac','1','-ar','16000','-f','f32le','-'],{maxBuffer:4*1024*1024});
      const rms=(a,b)=>{let sum=0,n=0;for(let i=Math.round(a*16000);i<Math.round(b*16000);i++){sum+=pcm.readFloatLE(i*4)**2;n++;}return Math.sqrt(sum/n);};
      for(const second of [1,5,10,15,19]){
        const at=second*1.05;
        assert(rms(at+.025,at+.075)>.12,`Audio pulse moved away from its source clock at ${at} (${options.format})`);
        assert(rms(at-.25,at-.15)<.04,`Silent gap was compressed at ${at} (${options.format})`);
      }
    }
    console.log('PASS: native AAC, software AAC and WebM retain packet-clock gaps; pulse timing stays aligned at start/middle/end instead of advancing over time.');
  }finally{await browser?.close();await server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
