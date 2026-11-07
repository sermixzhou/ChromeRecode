const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../extension');
const out=path.resolve(__dirname,'../test-results/capture');
function probe(file){
  const result=spawnSync('ffprobe',['-v','error','-show_entries','frame=width,height:stream=codec_name:format=duration','-of','json',file],{encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');return JSON.parse(result.stdout);
}
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const fixture=path.join(out,'5k.webm');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0x31b6b0:s=5120x2880:r=12,drawbox=x=0:y=0:w=iw:h=ih:color=0xf4a251:t=40','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3','-c:v','libvpx','-b:v','300k','-deadline','realtime','-cpu-used','8','-threads','4','-c:a','libopus','-y',fixture]);
  const server=http.createServer((req,res)=>{
    const target=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!target.startsWith(root+'/'))return res.writeHead(403).end();
    try{res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(target));}catch{res.writeHead(404).end();}
  });
  let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true,args:['--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/editor.html`);
    await page.waitForFunction(()=>document.querySelector('#historyCount').textContent==='0');
    const result=await page.evaluate(async bytes=>{
      current={mode:'video'};
      const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'video/webm'}));
      const streams=[], NativeRecorder=MediaRecorder;
      window.MediaRecorder=class extends NativeRecorder{constructor(stream,options){super(stream,options);streams.push(stream);}};
      try{
        const blob=await createVideoClip(url,.5,2.5,'mp4');
        return {bytes:[...new Uint8Array(await blob.arrayBuffer())],compatible:compatibleVideoExport,attempts:streams.length,tracksStopped:streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')),videos:document.querySelectorAll('video').length};
      }finally{window.MediaRecorder=NativeRecorder;URL.revokeObjectURL(url);}
    },[...fs.readFileSync(fixture)]);
    assert(result.tracksStopped);assert.equal(result.videos,1);
    assert.equal(result.attempts,result.compatible?2:1);
    const filename=path.join(out,'5k-compatible.mp4');fs.writeFileSync(filename,Buffer.from(result.bytes));
    const info=probe(filename);assert(info.streams.some(s=>s.codec_name==='h264'));assert(info.streams.some(s=>s.codec_name==='aac'));
    assert(Math.abs(Number(info.format.duration)-2)<.4);
    if(result.compatible)assert(info.frames.filter(f=>f.width).every(f=>f.width===1920&&f.height===1080));
    const pcm=execFileSync('ffmpeg',['-v','error','-i',filename,'-ac','1','-ar','16000','-f','f32le','-']);let power=0;for(let i=0;i<pcm.length;i+=4)power+=pcm.readFloatLE(i)**2;assert(Math.sqrt(power/(pcm.length/4))>.02);
    const rgb=execFileSync('ffmpeg',['-v','error','-ss','0.5','-i',filename,'-frames:v','1','-vf','scale=16:16','-pix_fmt','rgb24','-f','rawvideo','-']);
    for(const [x,y]of [[0,0],[15,0],[0,15],[15,15]])assert([...rgb.subarray((y*16+x)*3,(y*16+x)*3+3)].reduce((a,b)=>a+b,0)>160,'Compatibility export added black padding');
    // A failed retry must expose the encoder's cause and release all resources.
    const failure=await page.evaluate(async bytes=>{
      const NativeRecorder=MediaRecorder,streams=[];
      window.MediaRecorder=class extends NativeRecorder{constructor(stream,options){super(stream,options);streams.push(stream);}start(){throw new DOMException('test encoder failure','NotSupportedError');}};
      const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'video/webm'}));
      try{
        await createVideoClip(url,0,1,'mp4');return {unexpected:true};
      }catch(e){return {name:e.name,message:e.message,attempts:streams.length,stopped:streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')),videos:document.querySelectorAll('video').length};}
      finally{window.MediaRecorder=NativeRecorder;URL.revokeObjectURL(url);}
    },[...fs.readFileSync(fixture)]);
    assert.equal(failure.name,'EncodingError');assert(failure.message.includes('test encoder failure'));
    assert.equal(failure.attempts,2);assert(failure.stopped);assert.equal(failure.videos,1);
    assert.deepEqual(errors,[]);
    console.log('PASS: real 5K MP4 export; original-resolution attempt, automatic compatible retry when needed; H.264/AAC, selected duration, audible audio, no added black padding, stopped tracks.',JSON.stringify({attempts:result.attempts,compatible:result.compatible}));
  }finally{await browser?.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
