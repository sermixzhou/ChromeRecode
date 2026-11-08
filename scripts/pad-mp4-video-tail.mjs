// MediaRecorder's audio can end slightly after its final video frame. Keep
// that actual final image visible to the trim boundary, before encoder flush.
// Never conceal a converter that failed to decode frames present in the file.
export async function padMp4VideoTail({source,sink,track,start,end,offset,frameRate,lastVideoEnd}){
  if(!Number.isFinite(end))return false;
  // A tolerance only: VFR exports do not specify or resample a frame rate.
  const frameDuration=1/(frameRate||30),epsilon=frameDuration+.002;
  if(end-lastVideoEnd<=frameDuration+.000001)return false;
  const availableEnd=Math.min(end,await track.computeDuration());
  if(availableEnd-lastVideoEnd>epsilon){
    throw Object.assign(new Error('视频末尾未完整解码，请使用兼容编码重试；原始录制仍保留'),{name:'EncodingError'});
  }
  // Only compensate a short capture shutdown tail. A larger missing interval
  // must still fail the normal completeness check, rather than become a freeze.
  if(end-lastVideoEnd>1)return false;
  const sample=await sink.getSample(end-.000001);
  if(!sample)return false;
  try{
    const sampleEnd=sample.timestamp+sample.duration;
    if(sample.timestamp>=end||end-sampleEnd>1+epsilon)return false;
    const tailStart=Math.max(start,lastVideoEnd,sample.timestamp);
    if(tailStart>=end)return false;
    sample.setTimestamp(tailStart+offset);
    sample.setDuration(end-tailStart);
    await source.add(sample);
    return true;
  }finally{sample.close();}
}
