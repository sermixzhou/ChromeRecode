const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {startServer}=require('./export-harness.cjs');
const assertMacOSPlayback=require('./macos-media.cjs');
const out=path.resolve(__dirname,'../test-results/quality');
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const source=path.join(out,'detail-lossless.webm');
  // Lossless source with moving detail and fine texture. A flat color fixture
  // would hide compression damage even at very low bitrates.
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=30,noise=alls=8:allf=t+u','-t','3','-c:v','libvpx-vp9','-lossless','1','-deadline','realtime','-cpu-used','8','-threads','4','-pix_fmt','yuv420p','-y',source]);
  const server=await startServer({'/source.webm':source});let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
    const page=await browser.newPage({acceptDownloads:true});await page.goto(server.url+'/editor.html');
    const worker=fs.readFileSync(path.resolve(__dirname,'../extension/video-export-worker.js'),'utf8');
    const assignment='const videoBitrate = globalThis.KeyeMediaQuality.exportBitrate(width, height, message.format);';
    assert(worker.includes(assignment),'Inspect the bitrate override after changing the generated worker layout');
    const outputs={};
    for(const baseline of [true,false]){
      if(baseline)await page.route('**/video-export-worker.js',route=>route.fulfill({contentType:'text/javascript',body:worker.replace(assignment,'const videoBitrate = 3500000;')}));
      const download=page.waitForEvent('download');
      const stats=await page.evaluate(async baseline=>{
        const file=await KeyeVideoExport.run({blob:await(await fetch('/source.webm')).blob(),start:0,end:3,format:'mp4'});
        KeyeVideoExport.download(file,baseline?'old-bitrate.mp4':'footage.mp4');return file.exportStats;
      },baseline);
      const target=path.join(out,baseline?'old-bitrate.mp4':'footage.mp4');await(await download).saveAs(target);outputs[baseline?'old':'footage']={target,...stats};
      await page.unroute('**/video-export-worker.js');
      const info=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height,avg_frame_rate,nb_read_frames,bit_rate:packet=pts_time','-count_frames','-of','json',target],{encoding:'utf8'}));
      const video=info.streams[0];assert.equal(video.width,1920);assert.equal(video.height,1080);assert.equal(video.avg_frame_rate,'30/1');assert.equal(Number(video.nb_read_frames),90);
      for(let i=1;i<info.packets.length;i++)assert(Math.abs(Number(info.packets[i].pts_time)-Number(info.packets[i-1].pts_time)-1/30)<.00001);
      outputs[baseline?'old':'footage'].actualBitrate=Number(video.bit_rate);
      assertMacOSPlayback(target);
    }
    const {spawnSync}=require('node:child_process');
    // WebM rounds packet times to milliseconds. Compare corresponding frame
    // numbers on an exact common clock, and compare YUV codes in one declared
    // color space so FFmpeg does not silently apply a matrix conversion.
    const normalize='settb=1/30,setpts=N,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709';
    for(const item of Object.values(outputs)){
      const comparison=spawnSync('ffmpeg',['-hide_banner','-i',source,'-i',item.target,'-lavfi',`[0:v]${normalize}[ref];[1:v]${normalize}[test];[ref][test]ssim`,'-an','-f','null','-'],{encoding:'utf8',maxBuffer:4*1024*1024});
      assert.equal(comparison.status,0,comparison.stderr);item.ssim=Number(comparison.stderr.match(/All:([0-9.]+)/)?.[1]);
      const signal=spawnSync('ffmpeg',['-hide_banner','-i',source,'-i',item.target,'-lavfi',`[0:v]${normalize}[ref];[1:v]${normalize}[test];[ref][test]psnr`,'-an','-f','null','-'],{encoding:'utf8',maxBuffer:4*1024*1024});
      assert.equal(signal.status,0,signal.stderr);item.psnr=Number(signal.stderr.match(/average:([0-9.]+)/)?.[1]);
    }
    assert.equal(outputs.footage.videoBitrate,20000000);assert.equal(outputs.footage.frameRate,30);
    assert(outputs.footage.psnr>38,JSON.stringify(outputs));
    assert(outputs.footage.psnr>outputs.old.psnr+1.5,'Texture fidelity must improve, not merely output file size');
    assert(outputs.footage.ssim>outputs.old.ssim+.005,'High quality export must preserve more detail than the old 3.5Mbps setting');
    fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify(outputs,null,2)+'\n');
    console.log('PASS: original-size 1080p output is constant 30fps, 90 complete frames; native macOS decoding; measured detail fidelity improves over the old 3.5Mbps setting.',JSON.stringify(outputs));
  }finally{await browser?.close();await server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
