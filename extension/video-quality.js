'use strict';
// Shared by capture, the editor and the bundled file-conversion worker.
// Capture retains its original 30fps ceiling; exports preserve source timing.
globalThis.KeyeMediaQuality = Object.freeze({
  captureFrameRate:30,
  audioBitrate:320000,
  fitDimensions(width,height){
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('无法读取有效的视频尺寸');
    const scale=Math.min(1,1920/width,1080/height);
    return {width:Math.max(2,Math.floor(width*scale/2)*2),height:Math.max(2,Math.floor(height*scale/2)*2)};
  },
  recordingBitrate(width,height){return Math.min(25000000,Math.max(10000000,Math.round(width*height*30*.4/1000000)*1000000));},
  exportBitrate(width,height,format='mp4'){
    const perPixel=format==='webm'?.4:.32,max=format==='webm'?25000000:20000000;
    return Math.min(max,Math.max(8000000,Math.round(width*height*30*perPixel/1000000)*1000000));
  }
});
