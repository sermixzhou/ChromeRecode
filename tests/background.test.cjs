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
    tabs:{create:async args=>calls.push(['editor',args])},
    tabCapture:{getMediaStreamId:async()=>{calls.push(['capture']);return 'test-stream';}},
    offscreen:{createDocument:async()=>{}},
    runtime:{getContexts:async()=>[{}],getURL:file=>'chrome-extension://fixture/'+file,sendMessage:async()=>options.startError?{ok:false,error:'Recorder failed'}:{ok:true},onMessage:{addListener:fn=>listeners.push(fn)},onInstalled:{addListener:()=>{}}}
  };
  const context=vm.createContext({chrome,URL,console:{warn:()=>{}},Date});vm.runInContext(source,context);
  return {calls,storage,start:mode=>vm.runInContext(`start(7,'Test',${JSON.stringify(mode)})`,context),message:type=>new Promise(resolve=>listeners[0]({type,id:'recording'},{url:'chrome-extension://fixture/offscreen.html'},resolve))};
}
(async()=>{
  const h=harness();assert.equal((await h.start('video')).ok,true);
  assert.deepEqual(h.calls.map(c=>c[0]),['capture']);
  assert.equal((await h.start('video')).ok,false);assert.equal(h.storage.recState.phase,'recording');
  // Recording completion still works after the service worker restarts.
  const restarted=harness({},h.storage);await restarted.message('OFFSCREEN_FINISHED');
  assert.deepEqual(restarted.calls.map(c=>c[0]),['editor']);
  assert.equal(restarted.calls[0][1].url,'chrome-extension://fixture/editor.html?id=recording');
  assert.equal(h.storage.recState.phase,'idle');
  const audio=harness();assert.equal((await audio.start('audio')).ok,true);assert.deepEqual(audio.calls.map(c=>c[0]),['capture']);
  const failed=harness({startError:true});assert.equal((await failed.start('video')).ok,false);assert.equal(failed.storage.recState.phase,'idle');
  const error=harness();await error.start('video');await error.message('OFFSCREEN_ERROR');assert.equal(error.storage.recState.phase,'idle');
  console.log('PASS: video/audio recording without page modification APIs, duplicate-start rejection, completion across worker restart, editor opening, and start/recording error recovery.');
})().catch(error=>{console.error(error);process.exitCode=1;});
