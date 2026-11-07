'use strict';
// Shipped locally and replaceable independently of the application; see vendor/lamejs/README.md.
importScripts('vendor/lamejs/lame.min.js');

self.onmessage = event => {
  try {
    const {planes, sampleRate} = event.data;
    if (!planes?.length || planes.length > 2 || !planes[0].length) throw new Error('没有可编码的音频');
    const encoder = new lamejs.Mp3Encoder(planes.length, sampleRate, 192);
    const chunks = [], blockSize = 1152;
    for (let offset = 0, block = 0; offset < planes[0].length; offset += blockSize, block++) {
      const pcm = planes.map(plane => {
        const samples = plane.subarray(offset, offset + blockSize), data = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          const sample = Math.max(-1, Math.min(1, samples[i]));
          data[i] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
        }
        return data;
      });
      const encoded = encoder.encodeBuffer(pcm[0], pcm[1]);
      // lamejs reuses its output storage; retain our own copy for the final file.
      if (encoded.length) chunks.push(new Uint8Array(encoded));
      if (block % 64 === 0) self.postMessage({type:'progress', progress:offset / planes[0].length});
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    const blob = new Blob(chunks, {type:'audio/mpeg'});
    if (!blob.size) throw new Error('导出的 MP3 为空');
    self.postMessage({type:'done', blob});
  } catch (error) {
    self.postMessage({type:'error', error:error.message || String(error)});
  }
};
