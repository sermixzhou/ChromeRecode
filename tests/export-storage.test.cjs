const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {startServer,seedRecording}=require('./export-harness.cjs');
const out=path.resolve(__dirname,'../test-results/storage');
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const fixture=path.join(out,'source.webm');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','5','-c:v','libvpx','-b:v','600k','-deadline','realtime','-cpu-used','8','-c:a','libopus','-y',fixture]);
  const server=await startServer({'/source.webm':fixture});let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
    const page=await browser.newPage();
    await page.addInitScript(()=>{
      window.downloadState='in_progress';window.downloadListeners=[];window.downloadRecords={};
      window.chrome={runtime:{},storage:{local:{async get(){return window.downloadRecords;},async set(items){Object.assign(window.downloadRecords,items);},async remove(key){delete window.downloadRecords[key];}}},downloads:{
        onChanged:{addListener(callback){window.downloadListeners.push(callback);}},
        download(options,callback){window.downloadURL=options.url;callback(7);},
        search(query,callback){const result=[{id:7,state:window.downloadState}];if(callback)callback(result);else return Promise.resolve(result);}
      }};
    });
    await page.goto(server.url+'/editor.html');
    await page.waitForFunction(()=>typeof KeyeVideoExport!=='undefined');
    await seedRecording(page,server.url+'/source.webm',{id:'recoverable',videoWidth:640,videoHeight:360,durationMs:5000});
    const recovery=await page.evaluate(async()=>{
      const session=await dbRead('sessions','recoverable');
      await dbAppendChunk({...session,status:'recording',savedDurationMs:4999,lastSavedAt:12345},(await dbChunks(session.id))[0]);
      await dbRecoverRecordings();return dbRead('sessions',session.id);
    });
    assert.equal(recovery.status,'ready');assert.equal(recovery.durationMs,4999);assert(recovery.recovered);
    // A missing committed source chunk must be rejected, never hidden by exporting a prefix.
    await page.evaluate(async()=>{const session=await dbRead('sessions','recoverable');await dbWrite('sessions',{...session,id:'missing',chunkCount:2});const chunk=(await dbChunks(session.id))[0];await dbWrite('chunks',{...chunk,id:'missing',index:0});});
    const missing=await page.evaluate(async()=>{
      try{await KeyeVideoExport.run({sessionId:'missing',start:0,end:3,format:'mp4'});}catch(error){return {message:error.message,chunks:(await dbChunks('missing')).length};}
    });
    assert.match(missing.message,/不完整/);assert.equal(missing.chunks,1);
    const worker=fs.readFileSync(path.resolve(__dirname,'../extension/video-export-worker.js'),'utf8');
    for(const mode of ['quota-preflight','write-failure']){
      const injection=mode==='quota-preflight'
        ? "navigator.storage.estimate=async()=>({quota:1,usage:1});\n"
        : "const nativeCreate=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(...args){const writer=await nativeCreate.apply(this,args);let count=0;return {write:async chunk=>{await writer.write(chunk);if(++count===1)throw new DOMException('Injected disk full','QuotaExceededError');},close:()=>writer.close(),abort:()=>writer.abort()};};\n";
      await page.route('**/video-export-worker.js',route=>route.fulfill({status:200,contentType:'text/javascript',body:injection+worker}));
      const failure=await page.evaluate(async()=>{
        const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('keye-exports',{create:true});
        const before=[];for await(const name of dir.keys())before.push(name);
        let error;try{await KeyeVideoExport.run({sessionId:'recoverable',start:0,end:4,format:'mp4'});}catch(e){error={name:e.name,message:e.message};}
        const after=[];for await(const name of dir.keys())after.push(name);
        return {before:before.sort(),after:after.sort(),error,source:(await dbRead('sessions','recoverable')).chunkCount,chunks:(await dbChunks('recoverable')).length};
      });
      assert.equal(failure.error.name,'QuotaExceededError',mode);assert.match(failure.error.message,/原始录制仍保留/);
      assert.deepEqual(failure.after,failure.before,`${mode}: partial file must be removed`);assert.equal(failure.source,failure.chunks);
      await page.unroute('**/video-export-worker.js');
    }
    // Do not invalidate a disk-backed File while Chrome is saving its download.
    const lease=await page.evaluate(async()=>{
      window.exportFile=await KeyeVideoExport.run({sessionId:'recoverable',start:0,end:3,format:'mp4'});
      KeyeVideoExport.download(window.exportFile,'test.mp4');await KeyeVideoExport.release(window.exportFile);
      return {readable:(await window.exportFile.slice(0,64).arrayBuffer()).byteLength,records:Object.keys(window.downloadRecords).length};
    });
    assert.equal(lease.readable,64);assert.equal(lease.records,1);
    await page.evaluate(()=>{window.downloadState='complete';window.downloadListeners.forEach(listener=>listener({id:7,state:{current:'complete'}}));});
    await page.waitForFunction(async()=>{try{await window.exportFile.arrayBuffer();return false;}catch(error){return error.name==='NotFoundError';}},{},{polling:100});
    const retry=await page.evaluate(async()=>{
      const file=await KeyeVideoExport.run({sessionId:'recoverable',start:0,end:3,format:'mp4'});
      let error;window.addEventListener('keye-download-error',event=>{error=event.detail;},{once:true});
      window.downloadState='in_progress';KeyeVideoExport.download(file,'retry.mp4');
      window.downloadListeners.forEach(listener=>listener({id:7,state:{current:'interrupted'}}));
      const readable=(await file.slice(0,64).arrayBuffer()).byteLength;
      window.downloadState='complete';KeyeVideoExport.download(file,'retry.mp4');await KeyeVideoExport.release(file);
      return {error,readable,source:(await dbChunks('recoverable')).length};
    });
    assert.match(retry.error,/中断/);assert.equal(retry.readable,64);assert(retry.source>0);
    console.log('PASS: interrupted recording recovery; missing chunks rejected; preflight quota and mid-write failures preserve originals and clean partials; OPFS files retained until download completion; interrupted downloads remain retryable.');
  }finally{await browser?.close();await server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
