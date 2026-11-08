'use strict';
// Local worker + on-disk output. The editor never receives a full encoded
// ArrayBuffer, and playback/visibility are independent of the conversion.
const KeyeVideoExport = (() => {
  const leases = new Map();
  const downloads = new Map();
  async function directory() {return (await navigator.storage.getDirectory()).getDirectoryHandle('keye-exports', {create:true});}
  async function remove(name) {try {await (await directory()).removeEntry(name);} catch (error) {if(error.name!=='NotFoundError')console.warn('导出临时文件清理失败:', error);}}
  async function release(file) {
    const lease=leases.get(file);if(!lease)return;
    lease.retired=true;
    if(!lease.pending){leases.delete(file);await remove(lease.name);}
  }
  function download(file,filename){
    const url=URL.createObjectURL(file),lease=leases.get(file);
    if(lease)lease.pending++;
    const finish=error=>{
      URL.revokeObjectURL(url);
      if(lease){lease.pending--;if(lease.retired)release(file);}
      if(error)window.dispatchEvent(new CustomEvent('keye-download-error',{detail:error}));
    };
    if(typeof chrome!=='undefined'&&chrome.downloads?.download){
      chrome.downloads.download({url,filename},id=>{
        if(chrome.runtime.lastError||id==null)return finish('文件下载未能开始，请点击再次下载重试');
        downloads.set(id,finish);
        if(lease)chrome.storage.local.set({[`keyeExportDownload:${id}`]:lease.name});
        chrome.downloads.search({id},items=>{const state=items?.[0]?.state;if(state==='complete'||state==='interrupted')finishDownload(id,state);});
      });
    }else{
      const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;document.body.append(anchor);anchor.click();anchor.remove();
      // Browser-page previews cannot observe native download completion.
      setTimeout(()=>finish(),5*60*1000);
    }
  }
  function finishDownload(id,state){
    const finish=downloads.get(id);if(!finish)return;
    downloads.delete(id);chrome.storage.local.remove(`keyeExportDownload:${id}`);
    finish(state==='interrupted'?'文件下载被中断，原始录制仍保留，请点击再次下载重试':null);
  }
  if(typeof chrome!=='undefined'&&chrome.downloads?.onChanged)chrome.downloads.onChanged.addListener(change=>{if(['complete','interrupted'].includes(change.state?.current))finishDownload(change.id,change.state.current);});
  async function cleanOldFiles() {
    try {
      const dir=await directory();
      const protectedNames=new Set();
      if(typeof chrome!=='undefined'&&chrome.downloads?.search){
        const records=await chrome.storage.local.get(null);
        for(const [key,name]of Object.entries(records))if(key.startsWith('keyeExportDownload:')){
          const items=await chrome.downloads.search({id:Number(key.split(':')[1])});
          if(items[0]?.state==='in_progress')protectedNames.add(name);else await chrome.storage.local.remove(key);
        }
      }
      for await (const [name,handle] of dir.entries()) {
        if(!protectedNames.has(name)&&handle.kind==='file'&&/^\d+-[a-f\d-]+\.(mp4|webm)$/.test(name)&&Date.now()-Number(name.split('-')[0])>24*60*60*1000)await dir.removeEntry(name);
      }
    } catch (error) {console.warn('导出缓存检查失败:',error);}
  }
  async function run(options) {
    let blob=options.blob;
    if(!options.sessionId&&!blob){
      const response=await fetch(options.url);if(!response.ok)throw new Error('无法读取原始录制');blob=await response.blob();
    }
    const worker=new Worker('video-export-worker.js');
    let timer;
    try {
      return await new Promise((resolve,reject)=>{
        const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>{worker.terminate();reject(new Error('导出处理长时间无响应，原始录制仍保留，请重试'));},120000);};
        worker.onmessage=event=>{
          touch();const data=event.data;
          if(data.type==='progress')options.onProgress?.(data.progress,data.phase);
          else if(data.type==='done'){
            Object.defineProperty(data.file,'exportStats',{value:{...data.stats,...data.validation}});
            leases.set(data.file,{name:data.name,retired:false,pending:0});resolve(data.file);
          }else if(data.type==='error')reject(Object.assign(new Error(data.error.message),{name:data.error.name}));
        };
        worker.onerror=event=>{event.preventDefault();reject(new Error(`导出引擎运行失败${event.message?'：'+event.message:''}，请重新加载插件后重试`));};
        worker.onmessageerror=()=>reject(new Error('无法读取导出结果，原始录制仍保留'));
        touch();
        worker.postMessage({type:'export',blob,sessionId:options.sessionId,start:options.start,end:options.end,format:options.format,width:options.width,height:options.height,compatible:options.compatible,forceSoftwareAudio:options.forceSoftwareAudio});
      });
    } finally {clearTimeout(timer);worker.terminate();}
  }
  return {run,release,download,cleanOldFiles};
})();
