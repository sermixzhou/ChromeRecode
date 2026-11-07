const {chromium}=require('playwright');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../extension');
const out=path.resolve(__dirname,'../test-results');
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const server=http.createServer((req,res)=>{
    const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    try{
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
      res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
      res.setHeader('Content-Security-Policy',"script-src 'self'; object-src 'self'");res.end(fs.readFileSync(file));
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));server.unref();
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),channel:process.env.CHROME_PATH||process.platform==='darwin'?undefined:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:340,height:400}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    // Mock only the extension bridge: exercise the real popup DOM, state rendering and events.
    await page.addInitScript(()=>{
      const listeners=[];let recording={phase:'idle',mode:null,startedAt:0,pausedAt:0,pausedTotal:0};
      window.popupRequests=[];window.popupClosed=false;window.popupError='';window.openedEditor='';window.close=()=>{window.popupClosed=true;};
      window.chrome={
        runtime:{getURL:file=>new URL(file,location.href).href,sendMessage:async message=>{
          if(message.type==='GET_STATE')return {ok:true,state:structuredClone(recording)};
          window.popupRequests.push(message);await new Promise(resolve=>setTimeout(resolve,150));
          if(window.popupError){const error=window.popupError;window.popupError='';return {ok:false,error};}
          if(message.type==='REQUEST_START')recording={phase:'recording',mode:message.mode,startedAt:Date.now()-13000,pausedAt:0,pausedTotal:0};
          if(message.type==='REQUEST_PAUSE')recording={...recording,phase:'paused',pausedAt:Date.now()};
          if(message.type==='REQUEST_RESUME')recording={...recording,phase:'recording',pausedTotal:recording.pausedTotal+Date.now()-recording.pausedAt,pausedAt:0};
          if(message.type==='REQUEST_STOP')recording={phase:'idle',mode:null,startedAt:0,pausedAt:0,pausedTotal:0};
          listeners.forEach(listener=>listener({recState:{newValue:structuredClone(recording)}},'session'));
          return {ok:true};
        }},
        tabs:{query:async()=>[{id:7,title:'刻页录制示例 · 当前网页'}],create:async({url})=>{window.openedEditor=url;}},
        storage:{onChanged:{addListener:listener=>listeners.push(listener)}}
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
    await page.waitForFunction(()=>typeof currentState!=='undefined'&&currentState?.phase==='idle');
    assert.equal(await page.title(),'刻页 · 网页录制');assert.equal(await page.locator('.brand strong').textContent(),'刻页');
    await page.locator('.brand-mark').evaluate(image=>image.decode());
    assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(21, 23, 25)');
    await page.screenshot({path:path.join(out,'popup-idle.png')});
    await page.locator('#recordVideo').click();assert(await page.locator('#recordVideo').isDisabled());
    await page.waitForFunction(()=>!sending&&currentState.phase==='recording');
    assert.equal(await page.locator('#statusLabel').textContent(),'正在录制视频');assert(!(await page.locator('#pause').isDisabled()));
    assert.equal(await page.locator('#clock').textContent(),'00:13');
    await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'popup-recording.png')});
    await page.locator('#pause').click();await page.waitForFunction(()=>!sending&&currentState.phase==='paused');
    assert.equal(await page.locator('#pauseLabel').textContent(),'继续');assert.equal(await page.locator('#pauseIcon').getAttribute('href'),'#p-play');
    assert((await page.locator('#recordStatus').getAttribute('class')).includes('paused'));
    assert(!(await page.locator('#pause').isDisabled()));assert(!(await page.locator('#stop').isDisabled()));
    await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'popup-paused.png')});
    await page.locator('#pause').click();await page.waitForFunction(()=>!sending&&currentState.phase==='recording');
    assert.equal(await page.locator('#pauseLabel').textContent(),'暂停');assert(!(await page.locator('#stop').isDisabled()));
    await page.locator('#stop').click();await page.waitForFunction(()=>window.popupClosed&&!sending);assert(await page.locator('#idlePanel').isVisible());
    await page.evaluate(()=>{window.popupError='当前页面无法录制，请切换到普通网页。';});
    await page.locator('#recordAudio').click();await page.waitForFunction(()=>!sending&&!document.querySelector('#error').hidden);
    assert((await page.locator('#error').textContent()).includes('当前页面无法录制'));assert(!(await page.locator('#recordAudio').isDisabled()));
    await page.screenshot({path:path.join(out,'popup-error.png')});
    await page.locator('#recordAudio').click();await page.waitForFunction(()=>!sending&&currentState.mode==='audio');assert(await page.locator('#error').isHidden());
    assert.equal(await page.locator('#statusLabel').textContent(),'正在录制声音');
    await page.locator('#openEditor').click();assert((await page.evaluate(()=>window.openedEditor)).endsWith('/editor.html'));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));assert.equal(manifest.name,'刻页');assert.equal(manifest.short_name,'刻页');
    for(const size of [16,32,48,128]){
      const bytes=fs.readFileSync(path.join(root,'icons',`icon${size}.png`));assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
    }
    console.log('PASS: 刻页 branding, dark popup, pending/recording/paused/resumed/stopped/error states, retry, audio recording, editor link, and four icon sizes.');
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
