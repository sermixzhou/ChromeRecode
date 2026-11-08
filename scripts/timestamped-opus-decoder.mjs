import {AudioSample,CustomAudioDecoder,registerDecoder} from 'mediabunny';

// Chromium's Opus decoder may concatenate PCM timestamps across small packet
// gaps. Over a long capture this can advance audio by seconds. Restore the
// source packet clock before Mediabunny resamples, fills gaps and encodes it.
// Packet frame counts: RFC 6716 §3.1/3.2; OpusHead pre-skip: RFC 7845 §5.1.
class TimestampedOpusDecoder extends CustomAudioDecoder {
  static supports(codec,config){return codec==='opus'&&config.sampleRate===48000&&typeof AudioDecoder!=='undefined';}
  init(){
    const description=this.config.description;
    const header=description?new Uint8Array(description.buffer||description,description.byteOffset||0,description.byteLength):null;
    this.skip=header?.length>=12?header[10]+header[11]*256:0;
    this.queue=[];this.waiters=new Set();this.failure=null;
    this.decoder=new AudioDecoder({
      output:data=>{try{this.emit(data);}catch(error){this.fail(error);}},
      error:error=>this.fail(error)
    });
    this.decoder.configure(this.config);
  }
  fail(error){this.failure=error;for(const resolve of this.waiters)resolve();this.waiters.clear();this.onError(error);}
  emit(data){
    const sample=new AudioSample(data);
    try{
      let position=0;
      while(position<sample.numberOfFrames){
        const packet=this.queue[0];
        if(!packet)throw new Error('音频解码与原始分片不一致，原始录制仍保留');
        const count=Math.min(sample.numberOfFrames-position,packet.frames-packet.used);
        const part=sample.trim(position,position+count);
        part.setTimestamp(packet.timestamp+packet.used/48000);
        packet.used+=count;position+=count;
        if(packet.used===packet.frames)this.queue.shift();
        try{this.onSample(part);}catch(error){part.close();throw error;}
      }
    }finally{sample.close();}
  }
  async decode(packet){
    if(this.failure)throw this.failure;
    const bytes=packet.data,config=bytes[0]>>3,code=bytes[0]&3;
    const frameSize=config>=16?120*2**(config&3):config>=12?480*2**(config&1):[480,960,1920,2880][config&3];
    const frames=frameSize*(code===0?1:code===3?(bytes[1]&63):2);
    if(!bytes.length||!frames||frames>5760)throw new Error('原始 Opus 音频分片无效');
    const skip=Math.min(this.skip,frames);this.skip-=skip;
    if(frames>skip)this.queue.push({timestamp:packet.timestamp+skip/48000,frames:frames-skip,used:0});
    this.decoder.decode(packet.toEncodedAudioChunk());
    if(this.decoder.decodeQueueSize>=4)await new Promise(resolve=>{
      const done=()=>{this.decoder.removeEventListener('dequeue',done);this.waiters.delete(done);resolve();};
      this.waiters.add(done);this.decoder.addEventListener('dequeue',done,{once:true});
    });
    if(this.failure)throw this.failure;
  }
  async flush(){await this.decoder.flush();if(this.failure)throw this.failure;if(this.queue.length)throw new Error('音频解码未能到达录制末尾，原始录制仍保留');}
  close(){if(this.decoder&&this.decoder.state!=='closed')this.decoder.close();for(const resolve of this.waiters)resolve();this.waiters.clear();}
}
registerDecoder(TimestampedOpusDecoder);
