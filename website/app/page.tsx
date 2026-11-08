"use client";

import {useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent} from "react";
import {ArrowDown, ArrowDownToLine, ArrowRight, Check, ChevronDown, ChevronRight, CircleHelp, Copy, Download, FileAudio, FileVideo, HardDrive, Headphones, Menu, Monitor, MousePointer2, Pause, Play, RotateCcw, Scissors, ShieldCheck, Volume2, Waves, X} from "lucide-react";
import release from "../lib/release.json";

const waveHeights = Array.from({length:94}, (_, i) => Math.round(14 + Math.abs(Math.sin(i * 1.71) * Math.cos(i * .29)) * 66 + Math.abs(Math.sin(i * .43)) * 20));
const formatTime = (seconds:number) => {
  const tenths=Math.max(0,Math.round(seconds*10));
  return `00:${Math.floor(tenths/10).toString().padStart(2,"0")}.${tenths%10}`;
};
type Mode = "video" | "audio";

function Chrome() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="M12 8h9.2M8.55 14l-4.6-8M15.45 14l-4.6 8"/></svg>;
}

function Brand({compact=false}:{compact?:boolean}) {
  return <span className={`brand ${compact ? "brand-compact" : ""}`}><img src="/brand/mark.svg" width="34" height="28" alt=""/><strong>刻页</strong></span>;
}

function Waveform({progress=0, className=""}:{progress?:number; className?:string}) {
  return <div className={`waveform ${className}`} aria-hidden="true">{waveHeights.map((height,i)=><i key={i} style={{height:`${height}%`}} className={i / waveHeights.length < progress ? "lit" : ""}/>)}</div>;
}

function ProductDemo() {
  const [mode,setMode] = useState<Mode>("video");
  const [playing,setPlaying] = useState(false);
  const [position,setPosition] = useState(5.6);
  const [start,setStart] = useState(2);
  const [end,setEnd] = useState(16);
  const [format,setFormat] = useState("mp4");
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"start" | "end" | null>(null);
  const duration = 18;
  useEffect(()=>{
    if (!playing) return;
    let frame:number, last:number | undefined;
    const tick=(now:number)=>{
      if (last !== undefined) {
        const elapsed=Math.min((now-last)/1000,.1);
        setPosition(time => Math.min(time+elapsed,end));
      }
      last=now; frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);
    return ()=>cancelAnimationFrame(frame);
  },[playing,end]);
  useEffect(()=>{if(position>=end) setPlaying(false);},[position,end]);
  useEffect(()=>{
    const stop=()=>{if(document.hidden)setPlaying(false);};
    document.addEventListener("visibilitychange",stop);
    return ()=>document.removeEventListener("visibilitychange",stop);
  },[]);
  const switchMode=(next:Mode)=>{setMode(next);setPlaying(false);setPosition(5.6);setFormat(next==="video"?"mp4":"mp3");};
  const toggle=()=>{if(!playing && (position>=end || position<start))setPosition(start);setPlaying(!playing);};
  const trim=(which:"start"|"end",value:number)=>{
    setPlaying(false);
    if(which==="start")setStart(Math.max(0,Math.min(end-.5,value)));
    else setEnd(Math.min(duration,Math.max(start+.5,value)));
  };
  const moveHandle=(event:ReactPointerEvent<HTMLButtonElement>)=>{
    if(!dragRef.current || !trackRef.current)return;
    const box=trackRef.current.getBoundingClientRect();
    trim(dragRef.current,Math.round((event.clientX-box.left)/box.width*duration*10)/10);
  };
  return <section className="demo-section container" id="demo" aria-labelledby="demo-title">
    <div className="demo-caption"><span><span className="status-dot"/>一个轻巧的录制工作台</span><span className="demo-disclaimer">交互演示 · 示例内容</span></div>
    <div className="demo-shell">
      <div className="demo-topbar"><Brand compact/><span className="demo-workspace-name">录制工作台</span><span className="demo-window-dots" aria-hidden="true"><i/><i/><i/></span></div>
      <div className="demo-body">
        <aside className="demo-library"><div className="demo-library-heading">我的录制 <span>2</span></div>
          <button type="button" className={`demo-file ${mode==="video"?"selected":""}`} onClick={()=>switchMode("video")} aria-pressed={mode==="video"}><span className="file-icon"><FileVideo/></span><span><strong>灵感放映室</strong><small>视频 · 00:18</small></span>{mode==="video"&&<Check className="file-check"/>}</button>
          <button type="button" className={`demo-file ${mode==="audio"?"selected":""}`} onClick={()=>switchMode("audio")} aria-pressed={mode==="audio"}><span className="file-icon audio"><Waves/></span><span><strong>午后的声音</strong><small>音频 · 00:18</small></span>{mode==="audio"&&<Check className="file-check"/>}</button>
          <div className="library-local"><HardDrive/><span>好内容，存在本地。</span></div>
        </aside>
        <div className="demo-main">
          <div className="demo-main-heading"><h2 id="demo-title">{mode==="video"?"灵感放映室 · 网页录制":"午后的声音 · 音频录制"}</h2><div className="demo-tabs" role="tablist" aria-label="演示模式">{(["video","audio"] as const).map(item=><button type="button" role="tab" id={`tab-${item}`} aria-controls="demo-panel" aria-selected={mode===item} tabIndex={mode===item?0:-1} key={item} onClick={()=>switchMode(item)} onKeyDown={event=>{if(["ArrowLeft","ArrowRight"].includes(event.key)){event.preventDefault();const next=mode==="video"?"audio":"video";switchMode(next);document.getElementById(`tab-${next}`)?.focus();}}}>{item==="video"?<Monitor/>:<Headphones/>}{item==="video"?"视频":"音频"}</button>)}</div></div>
          <div className={`demo-stage ${mode}`} id="demo-panel" role="tabpanel" aria-labelledby={`tab-${mode}`}>
            {mode==="video"?<><div className="mini-browser-bar"><span className="mini-browser-dots">● ● ●</span><span>灵感放映室 / 第 01 页</span><span>示例画面</span></div><img className="demo-poster" src="/inspiration.svg" alt="示例网页画面：灵感，就在此刻。浅绿色底上的抽象植物插画。" width="1200" height="640"/><div className="poster-play-label"><span className="small-record-dot"/>{playing?"正在播放示例":"一个值得留下的瞬间"}</div></>:<div className="audio-scene"><img src="/brand/mark.svg" width="54" height="42" alt=""/><span>午后的声音</span><Waveform progress={position/duration}/><small>每一个细节，都听得见。</small></div>}
          </div>
          <div className="demo-transport"><span className="demo-time"><strong>{formatTime(position)}</strong><span>/ 00:18.0</span></span><div className="demo-play-buttons"><button type="button" aria-label="回到选区起点" onClick={()=>{setPlaying(false);setPosition(start);}}><RotateCcw/></button><button type="button" className="demo-play" onClick={toggle} aria-label={playing?"暂停演示":"播放演示"}>{playing?<Pause/>:<Play/>}</button></div><span className="demo-volume"><Volume2/><span/></span></div>
          <div className="demo-timeline">
            <div className="demo-timeline-heading"><span><Scissors/>保留喜欢的那一段</span><span>已选 {formatTime(end-start)}</span></div>
            <div className="timeline-ruler"><span>00:00</span><span>00:06</span><span>00:12</span><span>00:18</span></div>
            <div className={`demo-track ${mode}`} ref={trackRef}>
              {mode==="video"&&<div className="demo-filmstrip" aria-hidden="true">{Array.from({length:8},(_,i)=><img key={i} src="/inspiration.svg" alt=""/>)}</div>}
              <Waveform progress={1}/>
              <div className="demo-shade before" style={{width:`${start/duration*100}%`}}/><div className="demo-shade after" style={{left:`${end/duration*100}%`}}/>
              <div className="demo-selection" style={{left:`${start/duration*100}%`,right:`${(duration-end)/duration*100}%`}}>
                {(["start","end"] as const).map(which=><button key={which} type="button" className={`demo-handle ${which}`} role="slider" aria-label={which==="start"?"裁剪起点":"裁剪终点"} aria-valuemin={which==="start"?0:start+.5} aria-valuemax={which==="start"?end-.5:duration} aria-valuenow={which==="start"?start:end} aria-valuetext={formatTime(which==="start"?start:end)} onPointerDown={event=>{dragRef.current=which;event.currentTarget.setPointerCapture(event.pointerId);setPlaying(false);}} onPointerMove={moveHandle} onPointerUp={()=>{dragRef.current=null;}} onLostPointerCapture={()=>{dragRef.current=null;}} onKeyDown={event=>{const value=which==="start"?start:end;if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();trim(which,Math.round((value+(event.key==="ArrowLeft"?-.1:.1))*10)/10);}if(event.key==="Home"||event.key==="End"){event.preventDefault();trim(which,event.key==="Home"?0:duration);}}}><span/></button>)}
              </div>
              <span className="demo-playhead" style={{left:`${position/duration*100}%`}}><i/></span>
            </div>
            <input className="demo-seek" type="range" aria-label="演示播放位置" min="0" max={duration} step="0.1" value={position} onChange={event=>{setPosition(Number(event.target.value));setPlaying(false);}}/>
          </div>
        </div>
        <aside className="demo-inspector"><h3>片段设置</h3><div className="demo-field"><span>开始时间</span><strong><i/>{formatTime(start)}</strong></div><div className="demo-field"><span>结束时间</span><strong><i/>{formatTime(end)}</strong></div><div className="demo-duration"><span>片段时长</span><strong>{formatTime(end-start)}</strong><i/></div><label className="demo-format">导出格式<select aria-label="演示导出格式" value={format} onChange={event=>setFormat(event.target.value)}>{(mode==="video"?["mp4","webm"]:["mp3","wav"]).map(value=><option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label><a className="demo-export" href="#download"><ArrowDownToLine/>安装后导出</a><p>拖动绿色手柄，<br/>试着留下一小段。</p></aside>
      </div>
    </div>
    <div className="demo-under"><span><MousePointer2/>点一下播放，或拖动绿色手柄试试</span><span>为浏览器而生，让记录更轻。</span></div>
  </section>;
}

const faqs=[
  ["刻页免费吗？需要注册吗？","当前版本的录制、预览、基础裁剪和格式导出全部免费，无需注册。未来如果推出增值功能，会在官网和产品内明确说明。"],
  ["安装后，需要额外配置环境吗？","不需要安装 Node.js、Python、FFmpeg 或其他运行工具。解压安装包并在 Chrome 中加载扩展即可使用。建议使用最新版桌面 Chrome；当前最低版本为 Chrome 116。"],
  ["我的录制文件会上传到哪里？","当前扩展不上传录制内容。原始录制和预览缓存保存在当前浏览器环境的本地扩展存储中，导出的文件由浏览器下载到你选择的位置。清除扩展存储或卸载可能导致历史录制丢失，重要内容请及时导出。"],
  ["可以录制什么内容？","刻页录制当前 Chrome 页签的画面与网页声音，也可以只录网页声音。当前不录制整个桌面、系统声音或麦克风。Chrome 内部页面及受 DRM 保护的内容可能无法录制，请仅录制自己有权保存的内容。"],
  ["支持哪些剪辑和导出功能？","可以拖动选区、精确设置起止时间、预览选中片段，并撤销或重做裁剪操作。当前保留一个连续片段，不包含多段拼接或多轨混音。视频支持 MP4 / WebM，音频支持 MP3 / WAV；MP4 取决于浏览器与系统的 H.264 编码支持，不支持时可以使用 WebM。视频录制和导出最高 1080p，保持画面比例；导出保留源视频帧率。在本地独立线程中转换，无需按原速播放，速度取决于设备；处理和下载完成前请保持编辑器打开。"],
  ["为什么现在需要用开发者模式安装？","刻页目前为 v0.1.0 测试版，暂未提供商店安装入口。本页提供 ZIP 安装包和对应说明。未来商店版上线后，官网将更新安装入口；请通过本页列出的官方入口获取版本，避免来源不明的二次打包。"],
];

export default function Home() {
  const [menuOpen,setMenuOpen]=useState(false);
  const [copied,setCopied]=useState(false);
  const [copyError,setCopyError]=useState(false);
  const [dialog,setDialog]=useState<"privacy"|"release"|null>(null);
  const dialogRef=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(dialog && !dialogRef.current?.open)dialogRef.current?.showModal();},[dialog]);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2400);return()=>clearTimeout(timer);},[copied]);
  useEffect(()=>{if(!menuOpen)return;const close=(event:KeyboardEvent)=>{if(event.key==="Escape"){setMenuOpen(false);document.getElementById("mobile-menu-toggle")?.focus();}};document.addEventListener("keydown",close);return()=>document.removeEventListener("keydown",close);},[menuOpen]);
  const copyAddress=async()=>{try{await navigator.clipboard.writeText("chrome://extensions/");setCopied(true);setCopyError(false);}catch{setCopyError(true);}};
  const closeDialog=()=>dialogRef.current?.close();
  return <>
    <a href="#main" className="skip-link">跳到主要内容</a>
    <header className="site-header"><div className="container nav-inner"><a href="#" className="brand-link" aria-label="刻页首页"><Brand/><span className="official-label">官网</span></a><nav id="main-nav" aria-label="主导航" className={menuOpen?"open":""}><a href="#features" onClick={()=>setMenuOpen(false)}>功能</a><a href="#how-it-works" onClick={()=>setMenuOpen(false)}>如何使用</a><a href="#faq" onClick={()=>setMenuOpen(false)}>常见问题</a><button type="button" onClick={()=>{setDialog("release");setMenuOpen(false);}}>更新日志<span className="nav-new-dot"/></button></nav><a className="button button-small header-download" href="#download"><Download/>免费下载</a><button id="mobile-menu-toggle" className="mobile-menu-toggle" type="button" aria-label={menuOpen?"关闭菜单":"打开菜单"} aria-expanded={menuOpen} aria-controls="main-nav" onClick={()=>setMenuOpen(!menuOpen)}>{menuOpen?<X/>:<Menu/>}</button></div></header>
    <main id="main">
      <section className="hero container" aria-labelledby="hero-title"><div className="hero-ambient" aria-hidden="true">{[32,66,100,66,32].map((h,i)=><span key={i} style={{height:`${h}%`}}/>)}</div><a className="release-badge" href="#download"><span className="status-dot"/><span>刻页 {release.version}，现在就能用</span><ArrowRight/></a><h1 id="hero-title">记录此刻，<br className="mobile-break"/><span>留住每一页。</span></h1><p className="hero-description">把网页里的声音与画面录下来。<br/>剪掉多余，留下刚刚好的那一段。</p><div className="hero-actions"><a className="button" href={`/downloads/${release.filename}`} download><Chrome/>免费下载刻页<ArrowDownToLine className="button-trailing"/></a><a href="#demo" className="button button-ghost"><span className="tiny-play"><Play/></span>看看它怎么用</a></div><div className="hero-notes"><span><Check/>基础功能免费</span><span><Check/>无需注册</span><span><Check/>录制保存在本地</span></div><p className="hero-install-note">适用于桌面 Chrome · 测试版需手动安装 <a href="#download">查看安装步骤 <ArrowRight/></a></p></section>
      <ProductDemo/>
      <section className="quick-facts container" aria-label="产品特点"><div><Monitor/><span>网页画面与声音<strong>一个页签，轻松记录</strong></span></div><div><HardDrive/><span>文件留在你的电脑<strong>本地处理，安心保存</strong></span></div><div><FileAudio/><span>MP4 / WebM / MP3 / WAV<strong>四种格式，按需带走</strong></span></div></section>
      <section className="features-section container section-space" id="features" aria-labelledby="features-title"><div className="section-heading"><div><span className="eyebrow">少一点操作，多一点专注</span><h2 id="features-title">够轻巧，也够好用。</h2></div><p>从一次录制，到一段值得收藏的内容。<br/>常用的功能，放在刚刚好的位置。</p></div><div className="feature-grid">
        <article className="feature-card sound-feature"><div className="feature-copy"><span className="feature-icon"><Waves/></span><h3>声音，值得被认真留下。</h3><p>只想收下网页里的声音？切换音频录制，<br/>在真实波形里找到想保留的那一段。</p></div><div className="sound-illustration" aria-hidden="true"><span className="sound-caption"><span className="status-dot"/>一段喜欢的声音</span><Waveform progress={.56}/><div className="sound-bottom"><span>00:10.2</span><span>MP3 · 192 kbps</span></div></div></article>
        <article className="feature-card trim-feature"><div className="feature-copy"><span className="feature-icon"><Scissors/></span><h3>留下精彩，剪掉多余。</h3><p>拖动两端手柄，或输入精确时间。<br/>预览、撤销、重来，都很顺手。</p></div><div className="trim-illustration" aria-hidden="true"><div className="trim-labels"><span>开始时间 <b>00:02.0</b></span><ArrowRight/><span>结束时间 <b>00:16.0</b></span></div><div className="mini-track"><Waveform progress={1}/><div className="mini-selection"><i/><i/></div><span className="mini-cursor"><MousePointer2/></span></div><span className="mini-selection-note">刚刚好的 14 秒</span></div></article>
        <article className="feature-card export-feature"><div className="feature-copy"><span className="feature-icon"><ArrowDownToLine/></span><h3>喜欢的片段，随时带走。</h3><p>视频或声音，选好格式就能导出。<br/>保存下来，让好内容不止停留在网页里。</p></div><div className="format-illustration" aria-hidden="true">{["MP4","WebM","MP3","WAV"].map((f,i)=><span key={f} style={{"--rotation":`${[-8,3,-3,8][i]}deg`} as CSSProperties}>{i<2?<FileVideo/>:<FileAudio/>}<strong>{f}</strong><small>{i<2?"VIDEO":"AUDIO"}</small></span>)}</div></article>
        <article className="feature-card privacy-feature"><div className="feature-copy"><span className="feature-icon"><ShieldCheck/></span><h3>你的录制，留在你这里。</h3><p>无需上传，录制与编辑都在本地完成。<br/>没有等待上传的进度条，也不用交出文件。</p></div><div className="privacy-illustration" aria-hidden="true"><span className="privacy-orbit orbit-one"/><span className="privacy-orbit orbit-two"/><div className="local-device"><Monitor/><span><Check/>已保存在本地</span></div><span className="orbit-node node-one"><FileVideo/></span><span className="orbit-node node-two"><FileAudio/></span><span className="orbit-shield"><ShieldCheck/></span></div></article>
      </div></section>
      <section className="workflow-section section-space" id="how-it-works" aria-labelledby="workflow-title"><div className="container"><div className="section-heading"><div><span className="eyebrow">从这一页，到你的文件夹</span><h2 id="workflow-title">三个动作，留住一个瞬间。</h2></div><a href="#download" className="text-link">开始第一次录制 <ArrowRight/></a></div><div className="workflow-grid"><article><span className="step-number">01 <span>RECORD</span></span><div className="workflow-visual record-visual"><div><span className="small-record-dot"/><strong>录制视频与声音</strong><Monitor/></div><div><Waves/><span>仅录制声音</span><ChevronRight/></div><span className="cursor-decoration"><MousePointer2/></span></div><h3>打开网页，按下录制。</h3><p>点击浏览器中的刻页图标，<br/>选择视频或音频，开始收集精彩。</p></article><article><span className="step-number">02 <span>TRIM</span></span><div className="workflow-visual cut-visual"><span>00:02.0 <ArrowRight/> 00:16.0</span><div><Waveform progress={1}/><i/><i/></div><span className="cut-tag"><Scissors/>保留选中片段</span></div><h3>拖一拖，留下喜欢的。</h3><p>结束录制后进入编辑器，<br/>在时间轴上选好起点和终点。</p></article><article><span className="step-number">03 <span>KEEP</span></span><div className="workflow-visual save-visual"><span className="save-file"><FileVideo/><span>值得收藏的一段.mp4<small>准备好，带走这一刻。</small></span><span className="save-check"><Check/></span></span></div><h3>选好格式，保存到本地。</h3><p>确认片段，点击导出。<br/>属于你的内容，想看时就能再看。</p></article></div></div></section>
      <section className="brand-statement container section-space" aria-labelledby="statement-title"><div className="statement-mark" aria-hidden="true"><img src="/brand/mark.svg" width="150" height="112" alt=""/><span/><span/><span/></div><div><span className="eyebrow">为每一个想留下的瞬间</span><h2 id="statement-title">网页会翻过去，<br/>喜欢的内容可以留下来。</h2><p>一节反复回看的课程，一段带来灵感的分享，<br/>或是一首恰好打动你的旋律。<br/>刻页把工具做轻，让值得收藏的时刻多一点。</p><span className="statement-note">请仅录制和保存你有权使用的内容。</span></div></section>
      <section className="faq-section container section-space" id="faq" aria-labelledby="faq-title"><div className="faq-intro"><span className="eyebrow">你可能还想知道</span><h2 id="faq-title">先解答，<br/>再开始。</h2><span className="faq-icon"><CircleHelp/></span></div><div className="faq-list">{faqs.map(([question,answer],i)=><details key={question}><summary><span className="faq-number">0{i+1}</span><span>{question}</span><ChevronDown/></summary><p>{answer}</p></details>)}</div></section>
      <section className="download-section container" id="download" aria-labelledby="download-title"><div className="download-panel"><div className="download-copy"><span className="download-eyebrow"><span className="status-dot"/>刻页 · 当前测试版</span><h2 id="download-title">下一次精彩，<br/>别让它划走。</h2><p>一个浏览器扩展，收下网页里的声音与画面。</p><a className="button button-dark" href={`/downloads/${release.filename}`} download><Chrome/>下载刻页 {release.version}<ArrowDownToLine/></a><span className="download-meta">桌面 Chrome · ZIP 安装包 · {release.sizeLabel}</span><button type="button" className="download-release" onClick={()=>setDialog("release")}>看看这一版有什么 <ArrowRight/></button></div><div className="install-guide"><span className="install-title">一分钟，安装好你的刻页。</span><ol><li><span>1</span><div><strong>下载并解压安装包</strong><p>把解压后的文件夹保存在固定位置。</p></div></li><li><span>2</span><div><strong>打开扩展管理页面</strong><div className="copy-address"><code>chrome://extensions/</code><button type="button" onClick={copyAddress} aria-label={copied?"已复制扩展管理地址":"复制扩展管理地址"}>{copied?<Check/>:<Copy/>}</button></div><p role="status">{copied?"已复制，粘贴到 Chrome 地址栏打开。":copyError?"请手动复制上方地址，粘贴到 Chrome 地址栏。":"将地址粘贴到 Chrome 地址栏，然后打开开发者模式。"}</p></div></li><li><span>3</span><div><strong>加载扩展，开始记录</strong><p>点击「加载已解压的扩展程序」，选择包含 manifest.json 的 extension 文件夹。</p></div></li></ol><a href={`/downloads/${release.guideFilename}`} download className="install-guide-link">下载完整安装说明 <ArrowDown/></a></div></div><div className="download-footnote"><ShieldCheck/><span>从本页获取刻页测试版。无需注册，录制与剪辑在本地完成。</span></div></section>
    </main>
    <footer className="site-footer container"><div className="footer-main"><a className="brand-link" href="#" aria-label="回到刻页首页"><Brand/></a><span>记录此刻，留住每一页。</span><div><button type="button" onClick={()=>setDialog("privacy")}>隐私说明</button><button type="button" onClick={()=>setDialog("release")}>更新日志</button><a href="#faq">使用帮助 <ArrowRight/></a></div></div><div className="footer-bottom"><span>© {new Date().getFullYear()} 刻页</span><span>用心记录，轻轻留下。</span><span className="footer-version"><span className="status-dot"/>v{release.version}</span></div></footer>
    <dialog ref={dialogRef} className="info-dialog" aria-labelledby="dialog-title" onClose={()=>setDialog(null)} onClick={event=>{if(event.target===event.currentTarget)closeDialog();}}><div className="dialog-content"><button type="button" className="dialog-close" aria-label="关闭弹窗" onClick={closeDialog} autoFocus><X/></button><Brand compact/>{dialog==="privacy"?<><span className="eyebrow">让数据的去向清清楚楚</span><h2 id="dialog-title">隐私说明</h2><h3>录制内容保存在本地</h3><p>当前刻页扩展的录制、预览、裁剪与导出均在你的电脑上完成，不向刻页服务器上传音频、视频、网页标题、网页地址或录制文件名。</p><h3>官网当前不提供注册或使用追踪</h3><p>官网未接入业务统计脚本、注册、邮件订阅或支付服务。托管平台可能为提供访问、安全和故障排查而处理必要的访问日志；私有预览的访问控制由托管平台提供，不是刻页注册功能。</p><h3>请及时保存重要内容</h3><p>原始录制与预览缓存使用浏览器本地扩展存储。卸载扩展或清除存储可能删除录制历史，重要内容请及时导出。未来如调整数据处理方式，会更新说明并提供相应提示。</p></>:<><span className="eyebrow">一点点，变得更顺手</span><h2 id="dialog-title">刻页 v{release.version}</h2><p className="release-intro">当前测试版本 · 基础功能免费</p><ul className="release-list"><li><Monitor/><span><strong>网页画面与声音，一起留下</strong>支持当前页签的视频录制与纯音频录制，可暂停和继续。</span></li><li><Scissors/><span><strong>基础剪辑，有了自己的工作台</strong>波形、缩略图、拖动选区、精确时间与撤销重做。</span></li><li><FileVideo/><span><strong>多一种格式，多一种用法</strong>视频导出 MP4 / WebM，音频导出 MP3 / WAV。</span></li><li><Waves/><span><strong>声音预览，变得更丝滑</strong>圆角波形、渐进亮起，以及可复用的本地预览缓存。</span></li></ul><p className="release-limit">测试版提示：MP4 需浏览器与系统支持编码；视频转换速度取决于设备，完成前请保持编辑器打开。完整限制见安装说明。</p><a className="button" href={`/downloads/${release.filename}`} download><Download/>下载当前版本</a></>}</div></dialog>
  </>;
}
