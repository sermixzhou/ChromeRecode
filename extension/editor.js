'use strict';
const $ = id => document.getElementById(id);
let current = null, sourceBlob = null, sourceURL = null, clipBlob = null;
let duration = 0, exporting = false, currentName = '页签录制', previewMode = false;
let renderToken = 0, visualController = null, peaks = null, animationFrame = 0;
let undoStack = [], redoStack = [], drag = null;
const player = () => current?.mode === 'audio' ? $('audioPlayer') : $('player');
const startTime = () => Number($('startRange').value);
const endTime = () => Number($('endRange').value);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const minClip = () => Math.min(.5, duration);
const fmt = value => {
  const tenths = Math.max(0, Math.round((Number(value) || 0) * 10));
  return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
};
const precise = value => {
  const centis = Math.max(0, Math.round(value * 100));
  return `${String(Math.floor(centis / 6000)).padStart(2, '0')}:${String(Math.floor(centis / 100) % 60).padStart(2, '0')}.${String(centis % 100).padStart(2, '0')}`;
};
function parseTime(text) {
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\d+:\d{1,2}(\.\d+)?$/.test(value)) {
    const [minutes, seconds] = value.split(':').map(Number);
    if (seconds < 60) return minutes * 60 + seconds;
  }
  return NaN;
}
function safeName(title) { return String(title || '页签录制').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 75).trim() || '页签录制'; }
function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function fail(error) { status(`操作失败：${error.message || error}`, true); }
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function bounds() { return [startTime(), endTime()]; }
function sameBounds(a, b) { return Math.abs(a[0] - b[0]) < .005 && Math.abs(a[1] - b[1]) < .005; }
function remember(before) {
  if (sameBounds(before, bounds())) return;
  undoStack.push(before); if (undoStack.length > 100) undoStack.shift();
  redoStack = []; updateBounds();
}
function clearClip() {
  clipBlob = null; $('saveClip').disabled = true; $('saveClip').hidden = true;
  $('exportProgress').hidden = true; status('');
}
function updateControls() {
  const unavailable = !current || exporting;
  for (const id of ['cut', 'preview', 'original', 'delete', 'startInput', 'endInput', 'startAtPlayhead', 'endAtPlayhead', 'markStart', 'markEnd', 'reset', 'playPause', 'jumpStart', 'jumpEnd', 'speed', 'volume', 'startHandle', 'endHandle']) $(id).disabled = unavailable;
  $('cut').disabled = unavailable || endTime() - startTime() < minClip() - .011 || !!document.querySelector('.time-input-wrap input[aria-invalid="true"]');
  $('undo').disabled = unavailable || !undoStack.length;
  $('redo').disabled = unavailable || !redoStack.length;
  $('saveClip').disabled = unavailable || !clipBlob;
  document.querySelectorAll('.recording-item').forEach(button => { button.disabled = exporting; });
  document.body.classList.toggle('exporting', exporting);
  $('exportLabel').textContent = exporting ? '正在导出…' : '导出片段';
}
function updateBounds() {
  if (!current) return updateControls();
  const [start, end] = bounds(), selected = end - start;
  $('startInput').value = precise(start); $('endInput').value = precise(end);
  $('startInput').removeAttribute('aria-invalid'); $('endInput').removeAttribute('aria-invalid');
  $('selectedText').textContent = `已选 ${fmt(selected)}`;
  $('selectionDuration').textContent = fmt(selected);
  $('retainedText').textContent = `保留原始录制的 ${Math.round(selected / duration * 100)}%`;
  $('retainedBar').style.width = `${selected / duration * 100}%`;
  $('trimOverlay').style.setProperty('--start', `${start / duration * 100}%`);
  $('trimOverlay').style.setProperty('--end', `${end / duration * 100}%`);
  for (const which of ['start', 'end']) {
    const handle = $(`${which}Handle`), value = which === 'start' ? start : end;
    handle.setAttribute('aria-valuemin', which === 'start' ? '0' : String(start + minClip()));
    handle.setAttribute('aria-valuemax', which === 'start' ? String(end - minClip()) : String(duration));
    handle.setAttribute('aria-valuenow', String(value)); handle.setAttribute('aria-valuetext', precise(value));
  }
  updateControls();
}
function applyBounds(start, end) {
  $('startRange').value = String(start); $('endRange').value = String(end);
  clearClip(); updateBounds();
}
function setBoundary(which, value, record = true) {
  if (!current || exporting) return;
  const before = bounds(), min = minClip();
  const next = which === 'start' ? clamp(value, 0, endTime() - min) : clamp(value, startTime() + min, duration);
  if (Math.abs(next - (which === 'start' ? startTime() : endTime())) < .005) { status(''); updateBounds(); return; }
  player().pause(); previewMode = false;
  $(`${which}Range`).value = String(next);
  clearClip(); updateBounds();
  if (record) remember(before);
  seekPosition(next);
}
function restoreBounds(redo = false) {
  if (!current || exporting) return;
  const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
  if (!from.length) return;
  to.push(bounds()); const [start, end] = from.pop();
  player().pause(); previewMode = false; applyBounds(start, end); seekPosition(start);
}
function renderRuler() {
  const holder = $('ruler'); holder.replaceChildren();
  const count = Math.max(2, Math.min(10, Math.floor($('timeline').clientWidth / 110)));
  for (let i = 0; i <= count; i++) {
    const tick = document.createElement('span'); tick.className = 'ruler-tick';
    tick.style.left = `${i / count * 100}%`; tick.textContent = fmt(duration * i / count); holder.append(tick);
  }
}
function updatePlayback() {
  if (!current) return;
  const media = player(), time = clamp(media.currentTime || 0, 0, duration);
  $('currentText').textContent = fmt(time); $('playhead').style.left = `${time / duration * 100}%`;
  const playing = !media.paused && !media.ended;
  $('playPause').classList.toggle('playing', playing);
  $('playPause').setAttribute('aria-label', playing ? '暂停' : '播放');
  $('playIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  document.body.classList.toggle('is-playing', playing);
  if (current.mode === 'audio') drawWave($('audioWave'), true);
  if (previewMode && time >= endTime() - .02) { previewMode = false; media.pause(); }
}
function animatePlayback() {
  cancelAnimationFrame(animationFrame);
  function frame() {
    updatePlayback();
    if (current && !player().paused && !player().ended) animationFrame = requestAnimationFrame(frame);
  }
  frame();
}
function seekPosition(time) {
  if (!current || exporting) return;
  const media = player(); media.pause(); previewMode = false;
  try { media.currentTime = clamp(time, 0, duration); updatePlayback(); } catch (error) { fail(error); }
}
async function togglePlayback() {
  if (!current || exporting) return;
  const media = player();
  if (!media.paused) { media.pause(); return; }
  if (media.ended || media.currentTime >= duration - .025) await seekMedia(media, startTime());
  previewMode = false; await media.play();
}
async function preview() {
  if (!current || exporting) return;
  const media = player(); media.pause();
  await seekMedia(media, startTime()); previewMode = true; await media.play();
}
async function loadHistory(selected = current?.id) {
  const sessions = (await dbAllSessions()).filter(x => x.status === 'ready').sort((a, b) => b.startedAt - a.startedAt);
  if (selected && selected !== current?.id) return sessions;
  const holder = $('history'); holder.replaceChildren(); $('historyCount').textContent = sessions.length;
  for (const session of sessions) {
    const button = document.createElement('button');
    button.className = `recording-item${session.id === selected ? ' active' : ''}`;
    button.disabled = exporting; button.setAttribute('aria-pressed', String(session.id === selected));
    const top = document.createElement('div'); top.className = 'recording-item-top';
    const type = document.createElement('span'); type.className = 'recording-type';
    type.append(icon(session.mode), session.mode === 'video' ? '视频录制' : '音频录制');
    const length = document.createElement('span'); length.className = 'recording-item-duration'; length.textContent = fmt(session.durationMs / 1000);
    top.append(type, length);
    const name = document.createElement('strong'); name.textContent = session.title || '网页录制'; button.title = name.textContent;
    const date = document.createElement('small'); date.textContent = new Date(session.startedAt).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false});
    button.append(top, name, date);
    if (session.id === selected) { const check = icon('check'); check.classList.add('recording-selected'); button.append(check); }
    button.addEventListener('click', () => loadSession(session.id).catch(fail)); holder.append(button);
  }
  if (!sessions.length) { const empty = document.createElement('p'); empty.className = 'subtle'; empty.textContent = '还没有录制。点击浏览器扩展图标，录下第一段精彩。'; holder.append(empty); }
  return sessions;
}
function setDuration(value) {
  duration = Math.max(.01, value);
  for (const id of ['startRange', 'endRange']) $(id).max = String(duration);
  $('startRange').value = '0'; $('endRange').value = String(duration);
  $('durationText').textContent = fmt(duration); $('originalDuration').textContent = fmt(duration);
  updateBounds(); renderRuler();
}
async function loadSession(id) {
  if (exporting) return;
  const token = ++renderToken;
  const session = await dbRead('sessions', id);
  if (token !== renderToken || exporting) return;
  if (!session || session.status !== 'ready') throw new Error('录制文件未找到');
  const chunks = await dbChunks(id);
  if (token !== renderToken || exporting) return;
  if (!chunks.length) throw new Error('该录制没有保存任何数据');
  visualController?.abort(); visualController = new AbortController();
  $('player').pause(); $('audioPlayer').pause(); cancelAnimationFrame(animationFrame);
  for (const media of [$('player'), $('audioPlayer')]) { media.removeAttribute('src'); media.load(); }
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  current = session; sourceBlob = new Blob(chunks.map(x => x.blob), {type:session.mimeType});
  sourceURL = URL.createObjectURL(sourceBlob); currentName = safeName(session.title);
  previewMode = false; peaks = null; undoStack = []; redoStack = [];
  $('empty').hidden = true; $('workArea').hidden = false;
  const audio = session.mode === 'audio'; document.body.classList.toggle('audio-mode', audio);
  $('player').hidden = audio; $('audioPlayer').hidden = !audio; $('audioVisual').hidden = !audio;
  $('modeBadge').textContent = audio ? '音频' : '视频';
  $('stageBadge').textContent = audio ? '声音预览' : '原始画面';
  $('fileTitle').textContent = session.title || '网页录制'; $('audioTitle').textContent = session.title || '音频录制';
  $('formatText').textContent = audio ? 'WAV · PCM' : 'WebM · 视频';
  $('fileSize').textContent = `${(sourceBlob.size / 1024 / 1024).toFixed(2)} MB`;
  $('fileMeta').textContent = `${audio ? '音频' : '视频'}录制 · ${(sourceBlob.size / 1024 / 1024).toFixed(2)} MB`;
  $('hint').textContent = audio ? '导出 WAV 音频。预览音量与倍速不影响导出文件。' : '导出 WebM 视频。裁剪时按原速重新编码，耗时约等于片段时长，请保持此页打开。';
  $('cut').title = $('hint').textContent;
  $('filmstrip').replaceChildren(); $('filmstripLabel').hidden = false; $('filmstripLabel').textContent = '正在读取画面…';
  $('waveformLabel').hidden = false; $('waveformLabel').textContent = '正在分析声音…';
  clearClip(); setDuration(Math.max(.01, (session.durationMs || 500) / 1000));
  const media = player();
  media.onloadedmetadata = () => {
    if (token === renderToken && Number.isFinite(media.duration) && media.duration > 0 && !undoStack.length && !drag && !exporting) setDuration(media.duration);
  };
  media.src = sourceURL; media.volume = Number($('volume').value); media.playbackRate = Number($('speed').value); media.load();
  updatePlayback(); drawWaves();
  renderWaveform(sourceBlob, token);
  if (!audio) renderFilmstrip(sourceURL, token, visualController.signal);
  await loadHistory(id);
}
// Read actual audio peaks once; canvas redraws do not decode the file again.
async function renderWaveform(blob, token) {
  if (blob.size > 96 * 1024 * 1024) { $('waveformLabel').textContent = '文件较大，波形已省略；仍可正常剪辑'; return; }
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (token !== renderToken) return;
    const planes = Array.from({length: Math.min(2, decoded.numberOfChannels)}, (_, i) => decoded.getChannelData(i));
    const data = planes[0], bins = Math.min(1800, data.length);
    const values = new Float32Array(bins);
    for (let i = 0; i < bins; i++) {
      const from = Math.floor(i * data.length / bins), to = Math.floor((i + 1) * data.length / bins);
      const step = Math.max(1, Math.floor((to - from) / 160));
      for (let j = from; j < to; j += step) {
        for (const plane of planes) values[i] = Math.max(values[i], Math.abs(plane[j]));
      }
    }
    peaks = values; $('waveformLabel').hidden = true; drawWaves();
  } catch (error) {
    if (token === renderToken) $('waveformLabel').textContent = '无可用音轨或无法生成波形；仍可剪辑';
  } finally { await ctx.close().catch(() => {}); }
}
function drawWave(canvas, withProgress = false) {
  const box = canvas.getBoundingClientRect(); if (!box.width || !box.height) return;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(box.width * scale), height = Math.round(box.height * scale);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, width, height);
  if (!peaks) return;
  const count = Math.max(1, Math.floor(box.width / (withProgress ? 5 : 3)));
  const progress = current && duration ? player().currentTime / duration : 0;
  for (let i = 0; i < count; i++) {
    let peak = 0;
    const from = Math.floor(i * peaks.length / count), to = Math.max(from + 1, Math.floor((i + 1) * peaks.length / count));
    for (let j = from; j < to; j++) peak = Math.max(peak, peaks[j] || 0);
    const h = Math.max(scale, Math.sqrt(peak) * height * .82);
    ctx.fillStyle = withProgress ? (i / count <= progress ? '#b2ef83' : '#536e52') : '#9bc88d';
    ctx.fillRect(i * width / count, (height - h) / 2, Math.max(scale, width / count - 1.5 * scale), h);
  }
}
function drawWaves() { drawWave($('waveform')); drawWave($('audioWave'), true); }
async function renderFilmstrip(url, token, signal) {
  const media = document.createElement('video'); media.muted = true; media.preload = 'auto'; media.playsInline = true; media.src = url;
  const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
  const ctx = canvas.getContext('2d');
  const cancel = () => { media.removeAttribute('src'); media.load(); };
  signal.addEventListener('abort', cancel, {once:true});
  try {
    if (media.readyState < 1) await waitForEvent(media, 'loadedmetadata', 12000, signal);
    const length = Number.isFinite(media.duration) ? media.duration : duration;
    for (let i = 0; i < 10; i++) {
      if (signal.aborted || token !== renderToken) return;
      await seekMedia(media, Math.min(Math.max(0, length - .1), length * (i + .15) / 10), signal);
      if (media.readyState < 2) await waitForEvent(media, 'loadeddata', 8000, signal);
      if (signal.aborted || token !== renderToken) return;
      ctx.drawImage(media, 0, 0, 160, 90);
      const image = document.createElement('img'); image.src = canvas.toDataURL('image/jpeg', .65); image.alt = ''; image.draggable = false;
      $('filmstrip').append(image); $('filmstripLabel').hidden = true;
    }
  } catch (error) {
    if (token === renderToken && !signal.aborted && !$('filmstrip').children.length) $('filmstripLabel').textContent = '视频轨道 · 点击时间轴预览画面';
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}
function waitForEvent(element, event, timeoutMs = 15000, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('读取媒体超时，请重试')), timeoutMs);
    function cleanup() { clearTimeout(timer); element.removeEventListener(event, ok); element.removeEventListener('error', bad); signal?.removeEventListener('abort', aborted); }
    function finish(error) { cleanup(); error ? reject(error) : resolve(); }
    function ok() { finish(); }
    function bad() { finish(new Error('无法读取录制文件')); }
    function aborted() { finish(new DOMException('操作已取消', 'AbortError')); }
    element.addEventListener(event, ok, {once:true}); element.addEventListener('error', bad, {once:true});
    signal?.addEventListener('abort', aborted, {once:true}); if (signal?.aborted) aborted();
  });
}
async function seekMedia(media, time, signal) {
  if (Math.abs(media.currentTime - time) < .025 && media.readyState >= 2) return;
  // Register before setting currentTime so even a cached synchronous seek is observed.
  const pending = waitForEvent(media, 'seeked', 12000, signal);
  media.currentTime = time; await pending;
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function setProgress(percent, label) {
  const value = Math.round(clamp(percent, 0, 100));
  $('exportProgress').hidden = false; $('progressBar').value = value;
  $('progressPercent').textContent = `${value}%`; $('progressLabel').textContent = label;
}
// Retain selected PCM frames and encode standard 16-bit WAV audio.
async function createWAV(blob, start, end) {
  const ctx = new AudioContext(); let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { await ctx.close(); }
  const sampleRate = decoded.sampleRate, channels = Math.min(2, decoded.numberOfChannels);
  const first = Math.max(0, Math.floor(start * sampleRate)), last = Math.min(decoded.length, Math.floor(end * sampleRate));
  const frames = last - first;
  if (frames < 1) throw new Error('所选区间没有音频');
  const byteLength = 44 + frames * channels * 2;
  if (byteLength > 650_000_000) throw new Error('选中音频过大，请将片段缩短后重试');
  const buffer = new ArrayBuffer(byteLength), view = new DataView(buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, frames * channels * 2, true);
  const planes = Array.from({length:channels}, (_, i) => decoded.getChannelData(i));
  let offset = 44;
  for (let i = first; i < last; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = clamp(planes[channel][i], -1, 1);
      view.setInt16(offset, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true); offset += 2;
    }
    if ((i - first) % 131072 === 0) { setProgress(15 + (i - first) / frames * 84, '正在生成 WAV'); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  return new Blob([buffer], {type:'audio/wav'});
}
// Re-encode video in real time, routing export audio away from the speakers.
async function createVideoClip(url, start, end) {
  const media = document.createElement('video'); media.playsInline = true; media.preload = 'auto'; media.src = url;
  media.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;pointer-events:none'; document.body.append(media);
  let stream, captured, recorder, audioCtx, timer; const chunks = [];
  try {
    if (media.readyState < 1) await waitForEvent(media, 'loadedmetadata');
    await seekMedia(media, start);
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(media), destination = audioCtx.createMediaStreamDestination();
    source.connect(destination); await audioCtx.resume();
    captured = media.captureStream(); await media.play();
    if (!captured.getVideoTracks().length) throw new Error('未获得视频轨道');
    stream = new MediaStream([...captured.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('浏览器不支持视频导出');
    recorder = new MediaRecorder(stream, {mimeType:mime, videoBitsPerSecond:3500000});
    const done = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error('视频编码失败'));
      recorder.onstop = resolve;
      const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); media.pause(); };
      let lastTime = media.currentTime, lastAdvance = Date.now();
      timer = setInterval(() => {
        setProgress((media.currentTime - start) / (end - start) * 99, '正在导出视频');
        if (media.currentTime >= end - .025 || media.ended) return stop();
        if (media.currentTime !== lastTime) { lastTime = media.currentTime; lastAdvance = Date.now(); }
        if (media.error || Date.now() - lastAdvance > 20000) { reject(new Error('视频读取中断，请重试')); stop(); }
      }, 40);
    });
    recorder.start(300); await done;
    if (!chunks.length) throw new Error('导出的视频为空');
    return new Blob(chunks, {type:mime});
  } finally {
    clearInterval(timer); if (recorder && recorder.state !== 'inactive') recorder.stop();
    media.pause(); stream?.getTracks().forEach(track => track.stop()); captured?.getTracks().forEach(track => track.stop());
    await audioCtx?.close().catch(() => {}); media.removeAttribute('src'); media.load(); media.remove();
  }
}
async function cut() {
  if (exporting || !current) return;
  exporting = true; clearClip(); updateControls(); player().pause(); previewMode = false;
  const [start, end] = bounds();
  try {
    if (end - start < minClip() - .011) throw new Error('请选择至少 0.5 秒的片段');
    setProgress(0, current.mode === 'audio' ? '正在解码音频' : '正在准备视频');
    status('正在处理，请保持此页面打开。');
    if (current.mode === 'audio') clipBlob = await createWAV(sourceBlob, start, end);
    else if (start === 0 && Math.abs(end - duration) < .011) clipBlob = sourceBlob;
    else clipBlob = await createVideoClip(sourceURL, start, end);
    setProgress(100, '导出完成');
    download(clipBlob, `${currentName}-剪辑.${current.mode === 'audio' ? 'wav' : 'webm'}`);
    status(`已开始下载 · ${(clipBlob.size / 1024 / 1024).toFixed(2)} MB`);
    $('saveClip').hidden = false;
  } catch (error) { $('exportProgress').hidden = true; fail(error); }
  finally { exporting = false; updateControls(); }
}
function timeAtPointer(event) {
  const box = $('timeline').getBoundingClientRect(); return clamp((event.clientX - box.left) / box.width, 0, 1) * duration;
}
function finishDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const finished = drag; drag = null;
  if (finished.which) remember(finished.before);
  if ($('timeline').hasPointerCapture(event.pointerId)) $('timeline').releasePointerCapture(event.pointerId);
}
function initTimeline() {
  $('timeline').addEventListener('pointerdown', event => {
    if (!current || exporting || event.button !== 0) return;
    const handle = event.target.closest('.trim-handle');
    drag = {which:handle ? (handle.id === 'startHandle' ? 'start' : 'end') : null, pointerId:event.pointerId, before:bounds(), grabOffset:0};
    if (handle) { handle.focus(); drag.grabOffset = timeAtPointer(event) - (drag.which === 'start' ? startTime() : endTime()); }
    else { $('timeline').focus(); seekPosition(timeAtPointer(event)); }
    $('timeline').setPointerCapture(event.pointerId); event.preventDefault();
  });
  $('timeline').addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId || exporting) return;
    if (drag.which) setBoundary(drag.which, timeAtPointer(event) - drag.grabOffset, false);
    else seekPosition(timeAtPointer(event));
  });
  $('timeline').addEventListener('pointerup', finishDrag);
  $('timeline').addEventListener('pointercancel', finishDrag);
  $('timeline').addEventListener('lostpointercapture', finishDrag);
  for (const which of ['start', 'end']) {
    $(`${which}Handle`).addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const value = which === 'start' ? startTime() : endTime(), step = event.shiftKey ? 1 : .1;
      setBoundary(which, event.key === 'Home' ? 0 : event.key === 'End' ? duration : value + (event.key === 'ArrowRight' ? step : -step));
    });
    const input = $(`${which}Input`);
    input.addEventListener('change', () => {
      const time = parseTime(input.value);
      if (!Number.isFinite(time)) { input.setAttribute('aria-invalid', 'true'); status('时间格式：分:秒，例如 01:23.50，或直接输入秒数。', true); updateControls(); return; }
      setBoundary(which, time);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') { input.value = precise(which === 'start' ? startTime() : endTime()); input.removeAttribute('aria-invalid'); input.blur(); }
    });
  }
}
function resetSelection() {
  if (!current || exporting) return;
  const before = bounds(); player().pause(); previewMode = false;
  applyBounds(0, duration); remember(before); seekPosition(0);
}
function init() {
  const on = (id, event, handler) => $(id).addEventListener(event, (...args) => { Promise.resolve().then(() => handler(...args)).catch(fail); });
  on('playPause', 'click', togglePlayback); on('preview', 'click', preview); on('cut', 'click', cut);
  on('jumpStart', 'click', () => seekPosition(startTime())); on('jumpEnd', 'click', () => seekPosition(endTime()));
  on('markStart', 'click', () => setBoundary('start', player().currentTime)); on('markEnd', 'click', () => setBoundary('end', player().currentTime));
  on('startAtPlayhead', 'click', () => setBoundary('start', player().currentTime)); on('endAtPlayhead', 'click', () => setBoundary('end', player().currentTime));
  on('undo', 'click', () => restoreBounds()); on('redo', 'click', () => restoreBounds(true)); on('reset', 'click', resetSelection);
  on('speed', 'change', () => { if (current) player().playbackRate = Number($('speed').value); });
  on('volume', 'input', () => { if (current) player().volume = Number($('volume').value); });
  on('saveClip', 'click', () => { if (clipBlob) download(clipBlob, `${currentName}-剪辑.${current.mode === 'audio' ? 'wav' : 'webm'}`); });
  on('original', 'click', () => { if (sourceBlob) download(sourceBlob, `${currentName}-原始.webm`); });
  on('delete', 'click', async () => {
    if (!current || exporting || !confirm('确定永久删除这条录制及其原始文件吗？此操作无法撤销。')) return;
    const id = current.id; await dbDelete(id); ++renderToken; visualController?.abort(); cancelAnimationFrame(animationFrame);
    for (const media of [$('player'), $('audioPlayer')]) { media.pause(); media.removeAttribute('src'); media.load(); }
    current = null; sourceBlob = null; clipBlob = null; peaks = null;
    if (sourceURL) { URL.revokeObjectURL(sourceURL); sourceURL = null; }
    $('workArea').hidden = true; $('empty').hidden = false; document.body.classList.remove('is-playing', 'audio-mode');
    clearClip(); updateControls();
    const sessions = await loadHistory();
    if (sessions.length) await loadSession(sessions[0].id);
    else {
      $('formatText').textContent = $('originalDuration').textContent = $('fileSize').textContent = '—';
      $('selectionDuration').textContent = '00:00.0'; $('retainedText').textContent = '选择录制后开始剪辑'; $('retainedBar').style.width = '0';
      $('startInput').value = $('endInput').value = '00:00.0'; $('fileMeta').textContent = '简单一点，剪得刚好。';
    }
  });
  for (const media of [$('player'), $('audioPlayer')]) {
    media.addEventListener('play', animatePlayback); media.addEventListener('pause', updatePlayback);
    media.addEventListener('timeupdate', updatePlayback); media.addEventListener('seeked', updatePlayback); media.addEventListener('ended', updatePlayback);
    media.addEventListener('error', () => { if (media === player() && media.getAttribute('src')) fail(new Error('无法播放此录制文件')); });
  }
  initTimeline(); updateControls();
  new ResizeObserver(() => { if (current) { renderRuler(); drawWaves(); } }).observe($('timeline'));
  document.addEventListener('keydown', event => {
    if (!current || exporting || event.target.closest('input,select,textarea,[contenteditable=true]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); restoreBounds(event.shiftKey); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Native button activation owns Space / Enter when a button has focus.
    if (event.code === 'Space' && !event.target.closest('button,a')) { event.preventDefault(); togglePlayback().catch(fail); }
    if (event.key.toLowerCase() === 'i') { event.preventDefault(); setBoundary('start', player().currentTime); }
    if (event.key.toLowerCase() === 'o') { event.preventDefault(); setBoundary('end', player().currentTime); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seekPosition(player().currentTime + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1 : .1)); }
  });
  document.querySelector('.studio-brand').addEventListener('click', event => { if (exporting) event.preventDefault(); });
  window.addEventListener('beforeunload', event => { if (exporting) { event.preventDefault(); event.returnValue = ''; } });
  (async () => {
    const sessions = await loadHistory(), id = new URLSearchParams(location.search).get('id');
    const selected = id && sessions.some(session => session.id === id) ? id : sessions[0]?.id;
    if (selected) await loadSession(selected);
  })().catch(fail);
}
init();
