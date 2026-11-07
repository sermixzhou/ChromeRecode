const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../extension/background.js'),'utf8');
function harness(options={},storage={}){
  const calls=[],listeners=[];
  const chrome={
    storage:{session:{get:async key=>({[key]:storage[key]}),set:async value=>Object.assign(storage,value),remove:async key=>{delete storage[key];}}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},
    tabs:{get:async id=>({id,url:options.url||'https://www.bilibili.com/video/fixture'}),create:async args=>calls.push(['editor',args])},
    scripting:{insertCSS:async args=>{calls.push(['insert',args]);if(options.insertError)throw new Error('No page grant');},removeCSS:async args=>{calls.push(['remove',args]);if(options.closedTab)throw new Error('Tab closed');}},
    tabCapture:{getMediaStreamId:async()=>{calls.push(['capture']);return 'test-stream';}},
    offscreen:{createDocument:async()=>{}},
    runtime:{getContexts:async()=>[{}],getURL:file=>'chrome-extension://fixture/'+file,sendMessage:async()=>options.startError?{ok:false,error:'Recorder failed'}:{ok:true},onMessage:{addListener:fn=>listeners.push(fn)},onInstalled:{addListener:()=>{}}}
  };
  const context=vm.createContext({chrome,URL,console:{warn:()=>{}},Date});vm.runInContext(source,context);
  return {calls,storage,start:mode=>vm.runInContext(`start(7,'Test',${JSON.stringify(mode)})`,context),message:type=>new Promise(resolve=>listeners[0]({type,id:'recording'},{url:'chrome-extension://fixture/offscreen.html'},resolve))};
}
(async()=>{
  const h=harness();assert.equal((await h.start('video')).ok,true);
  assert.deepEqual(h.calls.map(c=>c[0]),['insert','capture']);assert.equal(h.storage.captureOverlayTabId,7);
  assert.equal((await h.start('video')).ok,false);assert.equal(h.storage.recState.phase,'recording');assert.equal(h.storage.captureOverlayTabId,7);
  const style=h.calls[0][1];assert.equal(style.origin,'USER');assert.deepEqual(Object.keys(style.target),['tabId']);
  assert(style.css.includes('.bpx-player-shadow-progress-area'));assert(style.css.includes('.bpx-player-mini-progress'));
  // A new service worker instance still restores the exact injected stylesheet.
  const restarted=harness({},h.storage);await restarted.message('OFFSCREEN_FINISHED');
  assert.deepEqual(restarted.calls.map(c=>c[0]),['remove','editor']);
  assert.equal(restarted.calls[0][1].css,style.css);assert.equal(h.storage.captureOverlayTabId,undefined);
  for(const options of [{url:'https://example.com/'},{url:'https://bilibili.com.evil.example/'}]){
    const other=harness(options);assert.equal((await other.start('video')).ok,true);assert.deepEqual(other.calls.map(c=>c[0]),['capture']);
  }
  const audio=harness();assert.equal((await audio.start('audio')).ok,true);assert.deepEqual(audio.calls.map(c=>c[0]),['capture']);
  const denied=harness({insertError:true});assert.equal((await denied.start('video')).ok,true);assert.equal(denied.storage.captureOverlayTabId,undefined);assert.deepEqual(denied.calls.map(c=>c[0]),['insert','remove','capture']);
  const failed=harness({startError:true});assert.equal((await failed.start('video')).ok,false);assert.equal(failed.storage.captureOverlayTabId,undefined);assert.equal(failed.storage.recState.phase,'idle');
  const closed=harness({closedTab:true});await closed.start('video');await closed.message('OFFSCREEN_ERROR');assert.equal(closed.storage.captureOverlayTabId,undefined);
  console.log('PASS: Bilibili capture progress-layer cleanup, exact CSS restoration across worker restart, start/error/closed-tab cleanup, denied styling does not block recording, other sites and audio untouched.');
})().catch(error=>{console.error(error);process.exitCode=1;});
