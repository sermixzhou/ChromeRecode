'use strict';
const $ = id => document.getElementById(id);
let current = null, sourceBlob = null, sourceURL = null, clipBlob = null, clipFormat = '';
let duration = 0, exporting = false, currentName = '刻页录制', previewMode = false;
let renderToken = 0, visualController = null, peaks = null, animationFrame = 0;
let audioWaveFrame = 0, waveProgress = null;
const reducedWaveMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let undoStack = [], redoStack = [], drag = null;
let activePreview = null, previewWrites = Promise.resolve();
const previewMemory = new Map();
const previewSignature = (session, blob, chunks) => JSON.stringify([1, blob.size, session.mimeType, session.durationMs, session.completedAt || session.startedAt, chunks]);
function rememberPreview(record) {
  previewMemory.delete(record.id); previewMemory.set(record.id, record);
  if (previewMemory.size > 8) previewMemory.delete(previewMemory.keys().next().value);
}
function savePreview(token, part) {
  if (token !== renderToken || !activePreview) return;
  const record = activePreview = {...activePreview, ...part};
  rememberPreview(record);
  // Serialize independent waveform / thumbnail writes so neither overwrites the other.
  previewWrites = previewWrites.then(() => dbWrite('previews', record)).catch(error => console.warn('预览缓存保存失败:', error));
}
const preferredFormats = {video:'mp4', audio:'mp3'};
const videoMimeTypes = {
  mp4:['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.424028,mp4a.40.2'],
  webm:['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
};
const videoMime = format => videoMimeTypes[format]?.find(type => MediaRecorder.isTypeSupported(type));
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
function safeName(title) { return String(title || '刻页录制').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 75).trim() || '刻页录制'; }
function status(text, error = false, state = 'info') {
  const element = $('status'); element.replaceChildren();
  element.dataset.state = text ? (error ? 'error' : state) : 'idle';
  if (text) {
    if (error || state === 'success') element.append(icon(error ? 'alert' : 'check'));
    const message = document.createElement('span'); message.textContent = text; element.append(message);
  }
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
  clipBlob = null; clipFormat = ''; $('saveClip').disabled = true; $('saveClip').hidden = true;
  $('cut').dataset.state = 'idle';
  $('exportProgress').hidden = true; status('');
}
function updateControls() {
  const unavailable = !current || exporting;
  for (const id of ['cut', 'preview', 'delete', 'startInput', 'endInput', 'startAtPlayhead', 'endAtPlayhead', 'markStart', 'markEnd', 'reset', 'playPause', 'jumpStart', 'jumpEnd', 'speed', 'volume', 'startHandle', 'endHandle', 'exportFormat']) $(id).disabled = unavailable;
  $('cut').disabled = unavailable || endTime() - startTime() < minClip() - .011 || !!document.querySelector('.time-input-wrap input[aria-invalid="true"]');
  $('undo').disabled = unavailable || !undoStack.length;
  $('redo').disabled = unavailable || !redoStack.length;
  $('saveClip').disabled = unavailable || !clipBlob;
  document.querySelectorAll('.recording-item').forEach(button => { button.disabled = exporting; });
  document.body.classList.toggle('exporting', exporting);
  $('exportLabel').textContent = exporting ? '正在导出…' : $('cut').dataset.state === 'error' ? '重试导出' : '导出片段';
}
function updateExportHint() {
  const format = $('exportFormat').value;
  $('hint').textContent = current?.mode === 'audio'
    ? (format === 'mp3' ? 'MP3 · 192 kbps，本地编码。预览音量与倍速不影响导出。' : 'WAV · PCM 音频。预览音量与倍速不影响导出。')
    : `${format === 'mp4' ? 'MP4 · H.264 / AAC' : 'WebM · VP8 / Opus'}。按原速编码，耗时约等于片段时长，请保持此页打开。`;
  $('cut').title = $('hint').textContent;
  $('exportFormat').title = current?.mode === 'video' && !videoMime('mp4')
    ? '当前浏览器或系统不支持 MP4 编码，请更新 Chrome 或使用 WebM。'
    : $('hint').textContent;
}
function configureExportFormats() {
  const select = $('exportFormat'); select.replaceChildren();
  const formats = current.mode === 'audio' ? ['mp3', 'wav'] : ['mp4', 'webm'];
  for (const format of formats) {
    const option = document.createElement('option'); option.value = format; option.textContent = format === 'webm' ? 'WebM' : format.toUpperCase();
    option.disabled = current.mode === 'video' && !videoMime(format);
    if (option.disabled) option.textContent += '（不可用）';
    select.append(option);
  }
  select.value = [...select.options].find(option => option.value === preferredFormats[current.mode] && !option.disabled)?.value
    || [...select.options].find(option => !option.disabled)?.value || '';
  updateExportHint();
}
function downloadClip() {
  if (clipBlob && clipFormat) download(clipBlob, `${currentName}-剪辑.${clipFormat}`);
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
  if (current.mode === 'audio') requestAudioWave();
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
    const glyph = document.createElement('span'); glyph.className = `recording-glyph ${session.mode}`; glyph.append(icon(session.mode));
    const copy = document.createElement('span'); copy.className = 'recording-copy';
    const name = document.createElement('strong'); name.textContent = session.title || '刻页录制'; button.title = name.textContent;
    const detail = document.createElement('span'); detail.className = 'recording-detail';
    detail.textContent = `${session.mode === 'video' ? '视频' : '音频'} · ${fmt(session.durationMs / 1000)}`;
    const date = document.createElement('small'); date.className = 'recording-date'; date.textContent = new Date(session.startedAt).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false});
    copy.append(name, detail, date); button.append(glyph, copy);
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
  visualController?.abort();
  const session = await dbRead('sessions', id);
  if (token !== renderToken || exporting) return;
  if (!session || session.status !== 'ready') throw new Error('录制文件未找到');
  const [chunks, cached] = await Promise.all([dbChunks(id),
    previewMemory.has(id) ? previewMemory.get(id) : dbRead('previews', id).catch(() => null)]);
  if (token !== renderToken || exporting) return;
  if (!chunks.length) throw new Error('该录制没有保存任何数据');
  visualController = new AbortController();
  $('player').pause(); $('audioPlayer').pause(); cancelAnimationFrame(animationFrame);
  resetAudioWave();
  for (const media of [$('player'), $('audioPlayer')]) { media.removeAttribute('src'); media.load(); }
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  current = session; sourceBlob = new Blob(chunks.map(x => x.blob), {type:session.mimeType});
  const signature = previewSignature(session, sourceBlob, chunks.length);
  activePreview = cached?.signature === signature ? cached : {id, signature};
  rememberPreview(activePreview);
  sourceURL = URL.createObjectURL(sourceBlob); currentName = safeName(session.title);
  previewMode = false; peaks = activePreview.peaks || null; undoStack = []; redoStack = [];
  $('empty').hidden = true; $('workArea').hidden = false;
  const audio = session.mode === 'audio'; document.body.classList.toggle('audio-mode', audio);
  $('player').hidden = audio; $('audioPlayer').hidden = !audio; $('audioVisual').hidden = !audio;
  $('modeBadge').textContent = audio ? '音频' : '视频';
  $('stageBadge').textContent = audio ? '声音预览' : '原始画面';
  $('fileTitle').textContent = session.title || '刻页录制'; $('audioTitle').textContent = session.title || '音频录制';
  configureExportFormats();
  $('fileSize').textContent = `${(sourceBlob.size / 1024 / 1024).toFixed(2)} MB`;
  $('fileMeta').textContent = `${audio ? '音频' : '视频'}录制 · ${(sourceBlob.size / 1024 / 1024).toFixed(2)} MB`;
  $('filmstrip').replaceChildren(); $('filmstrip').setAttribute('aria-busy', 'false');
  $('filmstripLabel').hidden = false; $('filmstripLabel').textContent = '正在读取画面…';
  $('waveformLabel').hidden = !!peaks; $('waveformLabel').textContent = '正在分析声音…';
  clearClip(); setDuration(Math.max(.01, (session.durationMs || 500) / 1000));
  const media = player();
  media.onloadedmetadata = () => {
    if (token === renderToken && Number.isFinite(media.duration) && media.duration > 0 && !undoStack.length && !drag && !exporting) setDuration(media.duration);
  };
  media.src = sourceURL; media.volume = Number($('volume').value); media.playbackRate = Number($('speed').value); media.load();
  updatePlayback(); drawWaves();
  if (!peaks) renderWaveform(sourceBlob, token, visualController.signal);
  if (!audio) {
    if (activePreview.thumbnails?.length) showThumbnails(activePreview.thumbnails);
    else renderFilmstrip(sourceURL, token, visualController.signal);
  }
  await loadHistory(id);
}
// Read actual audio peaks once; canvas redraws do not decode the file again.
async function renderWaveform(blob, token, signal) {
  if (blob.size > 96 * 1024 * 1024) { $('waveformLabel').textContent = '文件较大，波形已省略；仍可正常剪辑'; return; }
  // Preview peaks do not need full-rate PCM. This uses a quarter of 48 kHz PCM memory.
  const ctx = new AudioContext({sampleRate:12000});
  const close = () => { ctx.close().catch(() => {}); };
  signal.addEventListener('abort', close, {once:true});
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (token !== renderToken || signal.aborted) return;
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
    savePreview(token, {peaks:values});
  } catch (error) {
    if (token === renderToken && !signal.aborted) {
      const label = '无可用音轨或无法生成波形；仍可剪辑';
      $('waveformLabel').textContent = label;
    }
  } finally { signal.removeEventListener('abort', close); if (ctx.state !== 'closed') close(); }
}
function resetAudioWave() {
  cancelAnimationFrame(audioWaveFrame); audioWaveFrame = 0; waveProgress = null;
}
function requestAudioWave() {
  if (audioWaveFrame || current?.mode !== 'audio') return;
  audioWaveFrame = requestAnimationFrame(now => {
    audioWaveFrame = 0;
    // Keep fading after a pause, then stop requesting frames once all bars settle.
    if (current?.mode === 'audio' && drawWave($('audioWave'), true, now)) requestAudioWave();
  });
}
function drawWave(canvas, withProgress = false, now = performance.now()) {
  const box = canvas.getBoundingClientRect(); if (!box.width || !box.height) return;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(box.width * scale), height = Math.round(box.height * scale);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, width, height);
  if (!peaks) return;
  const count = Math.max(1, Math.floor(box.width / (withProgress ? 5 : 3)));
  const progress = current && duration ? player().currentTime / duration : 0;
  const fadeDuration = reducedWaveMotion.matches ? 0 : 320;
  if (withProgress && (waveProgress?.peaks !== peaks || waveProgress.count !== count)) {
    waveProgress = {peaks, count, bars:Array.from({length:count}, (_, i) => {
      const lit = Number(i / count < progress);
      return {from:lit, to:lit, since:now};
    })};
  }
  let fading = false;
  for (let i = 0; i < count; i++) {
    let peak = 0;
    const from = Math.floor(i * peaks.length / count), to = Math.max(from + 1, Math.floor((i + 1) * peaks.length / count));
    for (let j = from; j < to; j++) peak = Math.max(peak, peaks[j] || 0);
    const h = Math.max(scale, Math.sqrt(peak) * height * .82);
    let light = 1;
    if (withProgress) {
      const bar = waveProgress.bars[i], target = Number(i / count < progress);
      const t = fadeDuration ? clamp((now - bar.since) / fadeDuration, 0, 1) : 1;
      light = bar.from + (bar.to - bar.from) * t * t * (3 - 2 * t);
      if (bar.to !== target) { bar.from = light; bar.to = target; bar.since = now; }
      if (!fadeDuration) light = target;
      fading ||= light !== bar.to;
    }
    ctx.fillStyle = withProgress ? `rgb(${Math.round(83 + 95 * light)}, ${Math.round(110 + 129 * light)}, ${Math.round(82 + 49 * light)})` : '#b2ef83';
    const barWidth = Math.max(scale, width / count - 1.5 * scale);
    ctx.beginPath();
    ctx.roundRect(i * width / count, (height - h) / 2, barWidth, h, Math.min(barWidth, h) / 2);
    ctx.fill();
  }
  return fading;
}
function drawWaves() { drawWave($('waveform')); requestAudioWave(); }
function showThumbnails(images) {
  const elements = images.map(src => {
    const image = document.createElement('img'); image.src = src; image.alt = ''; image.draggable = false; return image;
  });
  $('filmstrip').replaceChildren(...elements); $('filmstripLabel').hidden = true;
}
async function renderFilmstrip(url, token, signal) {
  const holder = $('filmstrip'), main = player(); holder.setAttribute('aria-busy', 'true');
  const count = clamp(Math.ceil($('timeline').clientWidth / 100), 4, 12);
  const snapshot = media => {
    const canvas = document.createElement('canvas'); canvas.width = 144; canvas.height = 81;
    canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .6);
  };
  try {
    // Reuse the player's first decoded frame immediately; refine the rest progressively.
    if (main.readyState < 2) await waitForEvent(main, 'loadeddata', 12000, signal);
    if (signal.aborted || token !== renderToken) return;
    const images = Array(count).fill(snapshot(main)); showThumbnails(images);
    const length = Number.isFinite(main.duration) ? main.duration : duration;
    // If the user has already scrubbed, the seed is only a placeholder for slot zero.
    let next = main.currentTime < .1 ? 1 : 0, completed = next;
    async function fillFrames() {
      const media = document.createElement('video'); media.muted = true; media.preload = 'metadata'; media.playsInline = true;
      const cancel = () => { media.removeAttribute('src'); media.load(); };
      signal.addEventListener('abort', cancel, {once:true});
      try {
        media.src = url;
        if (media.readyState < 1) await waitForEvent(media, 'loadedmetadata', 12000, signal);
        while (next < count && !signal.aborted && token === renderToken) {
          const index = next++;
          await seekMedia(media, Math.min(Math.max(0, length - .1), length * (index + .15) / count), signal);
          if (media.readyState < 2) await waitForEvent(media, 'loadeddata', 8000, signal);
          if (signal.aborted || token !== renderToken) return;
          images[index] = snapshot(media); holder.children[index].src = images[index]; completed++;
        }
      } finally { signal.removeEventListener('abort', cancel); cancel(); }
    }
    // Two decoders avoid a long serial seek chain, without spawning one per thumbnail.
    await Promise.allSettled([fillFrames(), fillFrames()]);
    if (token === renderToken && !signal.aborted && completed === count) savePreview(token, {thumbnails:images});
  } catch (error) {
    if (token === renderToken && !signal.aborted && !$('filmstrip').children.length) $('filmstripLabel').textContent = '视频轨道 · 点击时间轴预览画面';
  } finally { if (token === renderToken) holder.setAttribute('aria-busy', 'false'); }
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
// Decode only once per export, then transfer the selected audio to a dedicated encoder worker.
async function createMP3(blob, start, end) {
  const ctx = new AudioContext({sampleRate:48000});
  let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); }
  finally { await ctx.close(); }
  const first = Math.max(0, Math.floor(start * decoded.sampleRate));
  const last = Math.min(decoded.length, Math.floor(end * decoded.sampleRate));
  if (last <= first) throw new Error('所选区间没有音频');
  const sampleRate = decoded.sampleRate;
  const planes = Array.from({length:Math.min(2, decoded.numberOfChannels)}, (_, channel) => decoded.getChannelData(channel).slice(first, last));
  decoded = null;
  const worker = new Worker('mp3-worker.js');
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const refreshTimeout = () => { clearTimeout(timer); timer = setTimeout(() => reject(new Error('MP3 编码长时间无响应，请重试')), 60000); };
      worker.onmessage = event => {
        const message = event.data; refreshTimeout();
        if (message.type === 'progress') setProgress(15 + message.progress * 84, '正在生成 MP3');
        else if (message.type === 'done') resolve(message.blob);
        else if (message.type === 'error') reject(new Error(message.error));
      };
      worker.onerror = event => { event.preventDefault(); reject(new Error('MP3 编码器加载或运行失败，请重新加载扩展后重试')); };
      worker.onmessageerror = () => reject(new Error('无法读取 MP3 编码结果'));
      refreshTimeout(); setProgress(15, '正在生成 MP3');
      worker.postMessage({planes, sampleRate}, planes.map(plane => plane.buffer));
    });
  } finally { clearTimeout(timer); worker.terminate(); }
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
async function createVideoClip(url, start, end, format) {
  const mime = videoMime(format);
  if (!mime) throw new Error(format === 'mp4' ? '当前浏览器或系统不支持 MP4 编码，请更新 Chrome 或选择 WebM。' : '浏览器不支持 WebM 导出');
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
    recorder = new MediaRecorder(stream, {mimeType:mime, videoBitsPerSecond:3500000, audioBitsPerSecond:192000});
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
    return new Blob(chunks, {type:recorder.mimeType || mime});
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
  const format = $('exportFormat').value;
  try {
    if (!(current.mode === 'audio' ? ['mp3', 'wav'] : ['mp4', 'webm']).includes(format)) throw new Error('请选择可用的导出格式');
    if (end - start < minClip() - .011) throw new Error('请选择至少 0.5 秒的片段');
    setProgress(0, current.mode === 'audio' ? '正在解码音频' : '正在准备视频');
    status('正在处理，请保持此页面打开。');
    if (current.mode === 'audio') clipBlob = await (format === 'mp3' ? createMP3(sourceBlob, start, end) : createWAV(sourceBlob, start, end));
    else if (format === 'webm' && sourceBlob.type.startsWith('video/webm') && start === 0 && Math.abs(end - duration) < .011) clipBlob = sourceBlob;
    else clipBlob = await createVideoClip(sourceURL, start, end, format);
    clipFormat = format;
    setProgress(100, '导出完成');
    downloadClip();
    status(`已开始下载 · ${(clipBlob.size / 1024 / 1024).toFixed(2)} MB`, false, 'success');
    $('saveClip').hidden = false;
  } catch (error) { $('cut').dataset.state = 'error'; $('exportProgress').hidden = true; fail(error); }
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
  on('exportFormat', 'change', () => {
    if (!current || exporting) return;
    preferredFormats[current.mode] = $('exportFormat').value;
    clearClip(); updateExportHint(); updateControls();
  });
  on('saveClip', 'click', downloadClip);
  on('delete', 'click', async () => {
    if (!current || exporting || !confirm('确定永久删除这条录制及其原始文件吗？此操作无法撤销。')) return;
    const id = current.id; ++renderToken; visualController?.abort(); cancelAnimationFrame(animationFrame);
    await previewWrites; await dbDelete(id); previewMemory.delete(id); activePreview = null;
    for (const media of [$('player'), $('audioPlayer')]) { media.pause(); media.removeAttribute('src'); media.load(); }
    current = null; sourceBlob = null; clipBlob = null; peaks = null;
    resetAudioWave();
    if (sourceURL) { URL.revokeObjectURL(sourceURL); sourceURL = null; }
    $('workArea').hidden = true; $('empty').hidden = false; document.body.classList.remove('is-playing', 'audio-mode');
    clearClip(); updateControls();
    const sessions = await loadHistory();
    if (sessions.length) await loadSession(sessions[0].id);
    else {
      $('exportFormat').replaceChildren(new Option('—', ''));
      $('originalDuration').textContent = $('fileSize').textContent = '—';
      $('selectionDuration').textContent = '00:00.0'; $('retainedText').textContent = '选择录制后开始剪辑'; $('retainedBar').style.width = '0';
      $('startInput').value = $('endInput').value = '00:00.0'; $('fileMeta').textContent = '刻页 · 记录网页的声音与画面';
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
