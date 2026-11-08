import {build} from 'esbuild';
import {parse} from 'acorn';
import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const vendor=path.join(root,'extension/vendor/mediabunny');
mkdirSync(vendor,{recursive:true});
await build({
  entryPoints:[path.join(root,'scripts/video-export-worker.mjs')],
  outfile:path.join(root,'extension/video-export-worker.js'),
  bundle:true,format:'iife',platform:'browser',target:'chrome116',minify:false,
  legalComments:'eof',
  plugins:[{name:'packaged-aac-worker',setup(builder){
    builder.onLoad({filter:/mediabunny\/dist\/modules\/src\/conversion\.js$/},({path:filename})=>{
      let text=readFileSync(filename,'utf8');
      const pumpStart="const sink = new VideoSampleSink(track, { hardwareAcceleration: trackOptions.hardwareAcceleration });\n                for await";
      const sampleTiming='sample.setDuration(clampedEndTimestamp - clampedStartTimestamp);';
      const pumpEnd="                source.close();\n                this._closeTrack(outputTrackId);";
      const start=text.indexOf(pumpStart),end=text.indexOf(pumpEnd,start);
      if(start<0||end<0||!text.slice(start,end).includes(sampleTiming))throw new Error('Video conversion pump changed; inspect final-frame handling.');
      let pump=text.slice(start,end);
      pump=pump.replace('                for await','                let keyeLastVideoEnd = this._startTimestamp;\n                for await');
      pump=pump.replace(sampleTiming,sampleTiming+'\n                        keyeLastVideoEnd = Math.max(keyeLastVideoEnd, clampedEndTimestamp);');
      pump+=`                if (this._state !== 'canceled' && this.output.format instanceof Mp4OutputFormat) {
                    const padded = await padMp4VideoTail({source, sink, track, start:this._startTimestamp, end:this._endTimestamp, offset:this._timestampOffset, frameRate:trackOptions.frameRate, lastVideoEnd:keyeLastVideoEnd});
                    if (padded) this._updateProgress(outputTrackId, this._endTimestamp + this._timestampOffset);
                }
`;
      text=text.slice(0,start)+pump+text.slice(end);
      text=`import {padMp4VideoTail} from ${JSON.stringify(path.join(root,'scripts/pad-mp4-video-tail.mjs'))};\n`+text;
      return {contents:text,loader:'js'};
    });
    builder.onLoad({filter:/mediabunny\/dist\/modules\/src\/(media-sink|media-source|misc)\.js$/},({path:filename})=>{
      let text=readFileSync(filename,'utf8');
      const alpha=filename.endsWith('media-sink.js'),splitter=filename.endsWith('media-source.js');
      const functionName=alpha?'colorAlphaMergerWorkerCode':splitter?'colorAlphaSplitterWorkerCode':'unthrottledTimerWorkerMain';
      const ast=parse(text,{ecmaVersion:'latest',sourceType:'module'});
      const declarations=ast.body.flatMap(node=>{const declaration=node.type==='ExportNamedDeclaration'?node.declaration:node;return declaration?.type==='VariableDeclaration'?declaration.declarations:[];});
      const fn=declarations.find(node=>node.id.name===functionName)?.init;
      if(!fn)throw new Error(`Packaged worker ${functionName} not found`);
      const workerName=alpha?'color-alpha-worker.js':splitter?'color-alpha-splitter-worker.js':'media-timer-worker.js';
      writeFileSync(path.join(root,'extension',workerName),`/* Mediabunny 1.65.2, MPL-2.0; unmodified worker function. */\n(${text.slice(fn.start,fn.end)})();\n`);
      if(alpha||splitter){
        const original="const blob = new Blob([`(${colorAlphaMergerWorkerCode.toString()})()`], { type: 'application/javascript' });\n                mergerWorkerUrl = URL.createObjectURL(blob);";
        const loader=splitter?original.replaceAll('colorAlphaMerger','colorAlphaSplitter').replaceAll('mergerWorkerUrl','splitterWorkerUrl'):original;
        if(!text.includes(loader))throw new Error('Alpha worker loader changed');
        text=text.replace(loader,`${splitter?'splitterWorkerUrl':'mergerWorkerUrl'} = new URL('${workerName}', self.location.href).href;`);
      }else{
        const start=text.indexOf('    const workerSource = `(${unthrottledTimerWorkerMain.toString()})();`;');
        const end=text.indexOf('    unthrottledTimerWorker.onmessage',start);
        if(start<0||end<0)throw new Error('Timer worker loader changed');
        text=text.slice(0,start)+"    unthrottledTimerWorker = new Worker(new URL('media-timer-worker.js', self.location.href));\n"+text.slice(end);
      }
      return {contents:text,loader:'js'};
    });
    builder.onLoad({filter:/mediabunny-aac-encoder\.mjs$/},({path:filename})=>{
      const text=readFileSync(filename,'utf8');
      const ast=parse(text,{ecmaVersion:'latest',sourceType:'module'});
      const factory=ast.body.find(node=>node.type==='FunctionDeclaration'&&node.id.name==='Worker2');
      const literal=factory?.body.body[0]?.argument?.arguments?.[0];
      if(literal?.type!=='TemplateLiteral'||literal.expressions.length)throw new Error('AAC worker layout changed; inspect the pinned dependency.');
      writeFileSync(path.join(root,'extension/aac-encoder-worker.js'),literal.quasis[0].value.cooked);
      // MV3: ship executable worker code as a separate local file, never as a
      // generated blob, eval, remote script, or downloaded encoder.
      const replacement="function Worker2(){return new Worker(new URL('aac-encoder-worker.js',self.location.href));}";
      return {contents:text.slice(0,factory.start)+replacement+text.slice(factory.end),loader:'js'};
    });
  }}]
});
for(const name of ['mediabunny','@mediabunny/aac-encoder']){
  const source=path.join(root,'node_modules',name),target=path.join(vendor,name.replace('@','').replace('/','-'));
  mkdirSync(target,{recursive:true});
  for(const file of ['LICENSE','README.md','package.json','src'])cpSync(path.join(source,file),path.join(target,file),{recursive:true});
  if(name.includes('aac-encoder'))cpSync(path.join(source,'licenses'),path.join(target,'licenses'),{recursive:true});
}
writeFileSync(path.join(vendor,'README.md'),`# Media export dependencies\n\nPinned to Mediabunny and @mediabunny/aac-encoder 1.65.2 (MPL-2.0).\nUpstream: https://github.com/Vanilagy/mediabunny/tree/173f6b70765fa3a6ffc1c82737514416fa559ef5\n\nThe AAC fallback contains FFmpeg AAC code (LGPL-2.1-or-later); upstream notices are included.\nThe AAC, color/alpha merger/splitter and timer worker loaders are adapted by scripts/build-video-export.mjs to load separately packaged local worker files. Their worker bodies are unmodified. The video conversion pump also invokes scripts/pad-mp4-video-tail.mjs before closing MP4 video, to hold a final captured frame across a short audio/video end-time difference. Missing decoded source frames still raise an encoding error. No code or media is fetched from the network at runtime.\n\nReadable upstream sources are included here. Rebuild the local workers with npm ci and npm run build:export.\n`);
console.log('Built local WebCodecs export and AAC workers.');
