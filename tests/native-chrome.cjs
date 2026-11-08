const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

// Playwright normally forces every document to stay visible, including when
// background-throttling flags are removed. Attach without those overrides so a
// background export test exercises the browser behavior users actually get.
module.exports=async function launchNativeChrome(){
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'keye-native-chrome-'));
  const executable=process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':chromium.executablePath());
  const child=spawn(executable,[`--user-data-dir=${profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--disable-sync','--disable-background-networking','--autoplay-policy=no-user-gesture-required',...(process.env.KEYE_HEADLESS==='1'?['--headless=new']:[])],{stdio:'ignore'});
  const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  let browser;
  async function close(){
    await browser?.close().catch(()=>{});
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    let timer;
    await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);})]);
    clearTimeout(timer);await exited;
    fs.rmSync(profile,{recursive:true,force:true});
  }
  try{
    const portFile=path.join(profile,'DevToolsActivePort'),deadline=Date.now()+15000;
    let port;
    while(!port){
      if(child.exitCode!==null||child.signalCode!==null||Date.now()>deadline)throw new Error('Chrome did not start');
      if(fs.existsSync(portFile)){
        const value=fs.readFileSync(portFile,'utf8').split('\n')[0];
        if(/^\d+$/.test(value)&&Number(value)>0)port=value;
      }
      if(port)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});
    return {context:browser.contexts()[0],close};
  }catch(error){await close();throw error;}
};
