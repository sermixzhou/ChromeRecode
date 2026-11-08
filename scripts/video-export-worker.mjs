import {
  Input,Output,BlobSource,CustomSource,StreamTarget,Mp4OutputFormat,WebMOutputFormat,
  MP4,WEBM,Conversion,Quality,canEncodeAudio,canEncodeVideo,VideoSampleSink
} from 'mediabunny';
import {registerAacEncoder} from '@mediabunny/aac-encoder';
import './timestamped-opus-decoder.mjs';
import '../extension/video-quality.js';

const READ_SIZE=256*1024,CACHE_SIZE=8*1024*1024;
let activeConversion;
let aacRegistered=false;
const tell=(type,data={})=>self.postMessage({type,...data});
const failure=(message,name='ExportError')=>Object.assign(new Error(message),{name});
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});

async function databaseSource(sessionId,stats){
  const db=await request(indexedDB.open('tab-recorder-zh-v1'));
  let lastReadHeartbeat=0;
  try{
    const session=await request(db.transaction('sessions').objectStore('sessions').get(sessionId));
    if(!session||session.status!=='ready')throw failure('原始录制尚未保存完成，请结束录制后重试');
    const parts=[];let size=0;
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('chunks'),cursor=tx.objectStore('chunks').openCursor(IDBKeyRange.bound([sessionId,0],[sessionId,Number.MAX_SAFE_INTEGER]));
      cursor.onsuccess=()=>{
        const item=cursor.result;if(!item)return;
        const value=item.value;
        if(value.index!==parts.length){tx.abort();return reject(failure('原始录制分片缺失，已保留现有数据，请勿删除这条录制'));}
        parts.push({index:value.index,offset:size,size:value.blob.size});size+=value.blob.size;item.continue();
      };
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||failure('读取原始录制失败'));
    });
    if(!size||(session.chunkCount!=null&&session.chunkCount!==parts.length))throw failure('原始录制分片不完整，已保留现有数据');
    const source=new CustomSource({
      getSize:()=>size,maxCacheSize:CACHE_SIZE,prefetchProfile:'fileSystem',
      read(start,end){
        let low=0,high=parts.length-1;
        while(low<high){const mid=(low+high+1)>>1;if(parts[mid].offset<=start)low=mid;else high=mid-1;}
        let index=low,position=start,blob;
        return new ReadableStream({async pull(controller){
          try{
            if(position>=end)return controller.close();
            const part=parts[index];
            if(!blob){const value=await request(db.transaction('chunks').objectStore('chunks').get([sessionId,part.index]));if(!value)throw failure('原始录制分片已被删除');blob=value.blob;}
            const count=Math.min(READ_SIZE,end-position,part.offset+part.size-position);
            const bytes=new Uint8Array(await blob.slice(position-part.offset,position-part.offset+count).arrayBuffer());
            stats.bytesRead+=bytes.length;stats.maxReadBytes=Math.max(stats.maxReadBytes,bytes.length);
            // Building the index of a large MediaRecorder file can take time on
            // slow disks. Report actual I/O activity to the client's watchdog.
            if(performance.now()-lastReadHeartbeat>1000){lastReadHeartbeat=performance.now();tell('heartbeat');}
            if(bytes.length!==count)throw failure('原始录制读取不完整');
            position+=count;controller.enqueue(bytes);
            if(position===part.offset+part.size){index++;blob=null;}
          }catch(error){controller.error(error);}
        }});
      },dispose:()=>db.close()
    });
    return {source,size,session};
  }catch(error){db.close();throw error;}
}

async function exportDirectory(){
  if(!navigator.storage?.getDirectory)throw failure('当前浏览器不支持本地文件导出，请更新 Chrome');
  return (await navigator.storage.getDirectory()).getDirectoryHandle('keye-exports',{create:true});
}

async function checkOutput(file,format,expected,hasAudio){
  const input=new Input({source:new BlobSource(file,{maxCacheSize:CACHE_SIZE}),formats:[MP4,WEBM]});
  try{
    const video=await input.getPrimaryVideoTrack(),audio=await input.getPrimaryAudioTrack();
    if(!video||(hasAudio&&!audio))throw failure('导出文件缺少画面或音轨，未保存不完整文件');
    if(format==='mp4'&&await video.getCodec()!=='avc')throw failure('MP4 视频编码不正确');
    if(format==='mp4'&&audio&&await audio.getCodec()!=='aac')throw failure('MP4 音频编码不正确');
    const vDuration=await video.computeDuration(),aDuration=audio?await audio.computeDuration():null;
    const tolerance=Math.max(.3,Math.min(1,expected*.01));
    if(Math.abs(vDuration-expected)>tolerance||(aDuration!=null&&Math.abs(aDuration-expected)>tolerance))throw failure(`导出时长不完整（目标 ${expected.toFixed(2)} 秒，画面 ${vDuration.toFixed(2)} 秒${aDuration==null?'':`，声音 ${aDuration.toFixed(2)} 秒`}），原始录制仍保留`);
    const sink=new VideoSampleSink(video);
    for(const time of [0,Math.max(0,vDuration/2),Math.max(0,vDuration-.15)]){
      const sample=await sink.getSample(time);
      if(!sample)throw failure('导出画面未能完整解码，原始录制仍保留');
      sample.close();
    }
    return {videoDuration:vDuration,audioDuration:aDuration,width:await video.getDisplayWidth(),height:await video.getDisplayHeight()};
  }finally{input.dispose();}
}

async function convert(message){
  const began=performance.now(),stats={bytesRead:0,maxReadBytes:0,writes:0,maxWriteBytes:0,engine:'WebCodecs',storage:'OPFS'};
  let input,output,writer,dir,name;
  try{
    if(!['mp4','webm'].includes(message.format))throw failure('导出格式无效');
    let source,session={};
    if(message.sessionId){({source,session}=await databaseSource(message.sessionId,stats));}
    else if(message.blob instanceof Blob)source=new BlobSource(message.blob,{maxCacheSize:CACHE_SIZE});
    else throw failure('未找到原始录制');
    input=new Input({source,formats:[WEBM,MP4]});
    const video=await input.getPrimaryVideoTrack(),audio=await input.getPrimaryAudioTrack();
    if(!video)throw failure('原始录制没有视频轨道');
    // MediaRecorder WebM files can omit duration/cues. Scanning packets builds
    // the index without decoding every frame or loading the file into memory.
    const sourceDuration=await input.computeDuration();
    const start=Math.max(0,message.start),end=Math.min(message.end,sourceDuration);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw failure('所选区间没有可导出的画面');
    const expected=end-start;
    const originalWidth=message.width||session.videoWidth||await video.getDisplayWidth();
    const originalHeight=message.height||session.videoHeight||await video.getDisplayHeight();
    const {width,height}=globalThis.KeyeMediaQuality.fitDimensions(originalWidth,originalHeight);
    const codec=message.format==='mp4'?'avc':'vp8';
    const {audioBitrate}=globalThis.KeyeMediaQuality;
    const videoBitrate=globalThis.KeyeMediaQuality.exportBitrate(width,height,message.format);
    const quality=new Quality({bitrate:videoBitrate,bitrateMode:'variable'});
    Object.assign(stats,{frameRateMode:'source',videoBitrate,audioBitrate:audio?audioBitrate:0,qualityPreset:'1080p'});
    if(!await canEncodeVideo(codec,{width,height,quality}))throw failure('当前设备不支持该尺寸的视频编码','EncodingError');
    if(message.format==='mp4'&&audio&&(!await canEncodeAudio('aac',{sampleRate:48000,numberOfChannels:2})||message.forceSoftwareAudio)){
      if(!aacRegistered){registerAacEncoder();aacRegistered=true;}
      stats.softwareAudio=true;
    }
    const estimate=await navigator.storage.estimate();
    const required=Math.ceil(expected*(videoBitrate+(audio?audioBitrate:0))/8*1.1)+16*1024*1024;
    if(Number.isFinite(estimate.quota)&&estimate.quota-estimate.usage<required)throw failure('本地可用空间不足，请释放空间后重试；原始录制仍保留','QuotaExceededError');
    dir=await exportDirectory();name=`${Date.now()}-${crypto.randomUUID()}.${message.format}`;
    const handle=await dir.getFileHandle(name,{create:true});writer=await handle.createWritable();
    const target=new StreamTarget(new WritableStream({
      async write(chunk){await writer.write(chunk);stats.writes++;stats.maxWriteBytes=Math.max(stats.maxWriteBytes,chunk.data.byteLength);}
    }),{chunked:true,chunkSize:1024*1024});
    output=new Output({format:message.format==='mp4'?new Mp4OutputFormat({fastStart:'fragmented',minimumFragmentDuration:2}):new WebMOutputFormat(),target});
    const conversion=activeConversion=await Conversion.init({
      input,output,trim:{start,end},copy:false,
      // Omit frameRate so conversion keeps source timestamps without CFR resampling.
      video:{codec,width,height,fit:'contain',quality,hardwareAcceleration:message.compatible?'prefer-software':'no-preference',keyFrameInterval:1},
      audio:{codec:message.format==='mp4'?'aac':'opus',sampleRate:48000,numberOfChannels:2,quality:new Quality({bitrate:audioBitrate})}
    });
    if(!conversion.isValid||conversion.discardedTracks.length)throw failure('当前设备无法完整转换这条录制的画面和音轨','EncodingError');
    let lastProgress=0;
    conversion.onProgress=value=>{if(performance.now()-lastProgress>100){lastProgress=performance.now();tell('progress',{progress:Math.min(.96,value*.96),phase:message.compatible?'正在兼容导出':'正在编码并写入文件'});}};
    await conversion.execute();activeConversion=null;
    await writer.close();writer=null;
    const file=await handle.getFile();
    tell('progress',{progress:.97,phase:'正在检查导出完整性'});
    const validation=await checkOutput(file,message.format,expected,!!audio);
    stats.elapsedMs=performance.now()-began;stats.inputDuration=sourceDuration;stats.outputDuration=expected;
    tell('done',{file,name,stats,validation});
  }catch(error){
    await activeConversion?.cancel().catch(()=>{});activeConversion=null;
    await output?.cancel().catch(()=>{});
    await writer?.abort().catch(()=>{});
    if(name)await dir?.removeEntry(name).catch(()=>{});
    const message=error.name==='QuotaExceededError'?'本地存储空间不足，已清理本次未完成的导出；原始录制仍保留，请释放磁盘空间后重试':error.message||String(error);
    tell('error',{error:{name:error.name,message}});
  }finally{input?.dispose();}
}

self.onmessage=event=>{
  const message=event.data;
  if(message.type==='export')convert(message);
  else if(message.type==='cancel')activeConversion?.cancel();
};
