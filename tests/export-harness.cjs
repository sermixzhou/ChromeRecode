const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const root=path.resolve(__dirname,'../extension');
exports.startServer=async function(fixtures={}){
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const target=fixtures[pathname]||path.resolve(root,'.'+pathname);
    if(!fixtures[pathname]&&!target.startsWith(root+'/'))return res.writeHead(403).end();
    try{
      const stat=fs.statSync(target);
      res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.webm')?'video/webm':target.endsWith('.mp4')?'video/mp4':'text/html');
      res.setHeader('Content-Length',stat.size);
      res.setHeader('Content-Security-Policy',"script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
      fs.createReadStream(target).pipe(res);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
};
exports.seedRecording=async function(page,url,session){
  return page.evaluate(async({url,session})=>{
    const response=await fetch(url);if(!response.ok)throw new Error('Fixture unavailable');
    const reader=response.body.getReader();let parts=[],size=0,index=0,total=0;
    async function save(){if(!size)return;const blob=new Blob(parts,{type:'video/webm'});await dbWrite('chunks',{id:session.id,index:index++,blob});total+=size;parts=[];size=0;}
    while(true){const {value,done}=await reader.read();if(done)break;parts.push(value);size+=value.byteLength;if(size>=1024*1024)await save();}
    await save();
    await dbWrite('sessions',{...session,mode:'video',status:'ready',mimeType:'video/webm',startedAt:Date.now(),chunkCount:index,sizeBytes:total});
    return {chunkCount:index,sizeBytes:total};
  },{url,session});
};
