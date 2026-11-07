const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const siteURL=process.env.KEYE_SITE_URL || 'http://127.0.0.1:4173/';
const out=path.resolve(__dirname,'../test-results/website');
const release=require('../website/lib/release.json');

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage();
    async function assertDialogCentered(){
      const geometry=await page.getByRole('dialog').evaluate(el=>{
        const box=el.getBoundingClientRect();
        return {x:box.x,y:box.y,width:box.width,height:box.height,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollable:el.scrollHeight>el.clientHeight};
      });
      assert(Math.abs(geometry.x+geometry.width/2-geometry.viewportWidth/2)<=1,'Dialog must be horizontally centered');
      assert(Math.abs(geometry.y+geometry.height/2-geometry.viewportHeight/2)<=1,'Dialog must be vertically centered');
      assert(geometry.x>=0 && geometry.y>=0 && geometry.x+geometry.width<=geometry.viewportWidth && geometry.y+geometry.height<=geometry.viewportHeight,'Dialog must stay inside the viewport');
      return geometry;
    }
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const response=await page.goto(siteURL,{waitUntil:'networkidle'});
    assert.equal(response.status(),200);
    assert.equal(await page.title(),'刻页 · 记录此刻，留住每一页');
    assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
    assert.equal(await page.locator('h1').count(),1);
    assert.equal(await page.locator('input[type=email],input[type=password],form').count(),0);
    assert(await page.locator('img').evaluateAll(images=>images.every(image=>image.complete&&image.naturalWidth>0)),'All images must load');
    for(const [width,height] of [[320,740],[390,844],[640,900],[768,1024],[1024,768],[1440,1000],[1920,1080]]){
      await page.setViewportSize({width,height});
      await page.evaluate(()=>scrollTo(0,0));
      const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert(layout.scroll<=layout.width,`Horizontal overflow at ${width}: ${layout.scroll}`);
      assert(await page.locator('.hero-actions .button').first().isVisible());
      if(width===390 || width===1440){
        await page.screenshot({path:path.join(out,width===390?'mobile.png':'desktop.png'),fullPage:true});
        await page.screenshot({path:path.join(out,width===390?'mobile-top.png':'desktop-top.png')});
      }
    }
    await page.setViewportSize({width:1440,height:1000});
    const seek=page.getByRole('slider',{name:'演示播放位置'});
    const initial=Number(await seek.inputValue());
    await page.getByRole('button',{name:'播放演示',exact:true}).click();
    await page.waitForFunction(initial=>Number(document.querySelector('.demo-seek').value)>initial+.2,initial);
    await page.getByRole('button',{name:'暂停演示',exact:true}).click();
    const paused=await seek.inputValue();
    await page.waitForTimeout(160);assert.equal(await seek.inputValue(),paused);
    await page.getByRole('tab',{name:'音频',exact:true}).click();
    assert.equal(await page.getByRole('tab',{name:'音频',exact:true}).getAttribute('aria-selected'),'true');
    assert(await page.locator('.audio-scene .waveform').isVisible());
    assert.deepEqual(await page.getByLabel('演示导出格式').locator('option').allTextContents(),['MP3','WAV']);
    await page.getByLabel('演示导出格式').selectOption('wav');
    assert.equal(await page.getByLabel('演示导出格式').inputValue(),'wav');
    await page.getByRole('tab',{name:'音频',exact:true}).focus();await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getByRole('tab',{name:'视频',exact:true}).getAttribute('aria-selected'),'true');
    assert.deepEqual(await page.getByLabel('演示导出格式').locator('option').allTextContents(),['MP4','WEBM']);
    const handle=page.getByRole('slider',{name:'裁剪起点'});
    await page.locator('#demo').evaluate(el=>el.scrollIntoView({behavior:'instant',block:'center'}));
    const before=Number(await handle.getAttribute('aria-valuenow'));
    await handle.focus();await page.keyboard.press('ArrowRight');
    assert.equal(Number(await handle.getAttribute('aria-valuenow')),Math.round((before+.1)*10)/10);
    const trackBox=await page.locator('.demo-track').boundingBox(),handleBox=await handle.boundingBox();
    await page.mouse.move(handleBox.x+handleBox.width/2,handleBox.y+handleBox.height/2);await page.mouse.down();
    await page.mouse.move(trackBox.x+trackBox.width*.3,handleBox.y+handleBox.height/2,{steps:6});await page.mouse.up();
    assert(Math.abs(Number(await handle.getAttribute('aria-valuenow'))-5.4)<.2);
    for(const details of await page.locator('.faq-list details').all()){
      await details.locator('summary').click();assert(await details.locator('p').isVisible());await details.locator('summary').click();
    }
    await page.locator('.site-footer').getByRole('button',{name:'隐私说明',exact:true}).click();
    assert(await page.getByRole('dialog').isVisible());
    await assertDialogCentered();
    assert.equal(await page.getByRole('dialog').getByRole('heading',{level:2}).textContent(),'隐私说明');
    await page.keyboard.press('Escape');assert(await page.getByRole('dialog').isHidden());
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'隐私说明');
    await page.locator('.site-footer').getByRole('button',{name:'更新日志',exact:true}).click();
    assert.equal(await page.getByRole('dialog').getByRole('heading',{level:2}).textContent(),`刻页 v${release.version}`);
    await assertDialogCentered();
    await page.getByRole('button',{name:'关闭弹窗'}).click();
    await page.getByRole('button',{name:'复制扩展管理地址',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'chrome://extensions/');
    assert(await page.getByRole('button',{name:'已复制扩展管理地址',exact:true}).isVisible());
    const downloadPromise=page.waitForEvent('download');await page.locator('.hero-actions a[download]').click();
    const download=await downloadPromise;assert.equal(download.suggestedFilename(),release.filename);
    const target=path.join(out,release.filename);await download.saveAs(target);
    assert.equal(createHash('sha256').update(fs.readFileSync(target)).digest('hex'),release.sha256);
    const files=execFileSync('unzip',['-Z1',target],{encoding:'utf8'});
    assert(files.includes('extension/manifest.json'));assert(files.includes('extension/vendor/lamejs/LICENSE'));
    assert(files.includes('extension/vendor/lamejs/source.tar.gz'));assert(!files.includes('.DS_Store'));
    const manifest=JSON.parse(execFileSync('unzip',['-p',target,'extension/manifest.json'],{encoding:'utf8'}));
    assert.equal(manifest.name,'刻页');assert.equal(manifest.version,release.version);
    for(const anchor of await page.locator('a[href^="#"]').all()){
      const href=await anchor.getAttribute('href');if(href.length>1)assert.equal(await page.locator(href).count(),1,`Broken anchor ${href}`);
    }
    await page.setViewportSize({width:390,height:844});
    const menu=page.getByRole('button',{name:'打开菜单',exact:true});await menu.click();
    assert.equal(await page.locator('#mobile-menu-toggle').getAttribute('aria-expanded'),'true');
    await page.locator('#main-nav').getByRole('link',{name:'常见问题',exact:true}).click();
    assert.equal(await page.locator('#mobile-menu-toggle').getAttribute('aria-expanded'),'false');
    await page.getByRole('button',{name:'打开菜单',exact:true}).click();await page.keyboard.press('Escape');
    assert.equal(await page.locator('#mobile-menu-toggle').getAttribute('aria-expanded'),'false');
    for(const [width,height] of [[390,844],[844,390],[320,568]]){
      await page.setViewportSize({width,height});
      for(const name of ['隐私说明','更新日志']){
        await page.locator('.site-footer').getByRole('button',{name,exact:true}).click();
        const geometry=await assertDialogCentered();
        if(height===390)assert(geometry.scrollable,'Long dialog content must scroll inside the short viewport');
        if(width===390 && name==='隐私说明')await page.screenshot({path:path.join(out,'privacy-dialog-mobile.png')});
        await page.keyboard.press('Escape');
      }
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await page.locator('.waveform i').first().evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
    assert.deepEqual(errors,[]);
    console.log('PASS: 刻页 website; 7 responsive widths without overflow, video/audio demo, playback/pause, trim dragging and keyboard control, format switching, FAQs, dialogs/focus, clipboard, mobile navigation, reduced motion, actual ZIP download/hash/manifest and bundled third-party license/source.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
