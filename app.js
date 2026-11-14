// MediaPlayer：動画（MP4）を端末の中に取りこんで再生する。iPad・Windows・Android のブラウザで動く（PWA）
'use strict';

const APP_VERSION = 'v2';  // 画面を直したら、sw.js の VERSION といっしょに上げる

const $ = (id) => document.getElementById(id);
const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const THUMB_W = 480;                 // 棚の絵の幅（画素）
const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
const baseName = (name) => name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
const errText = (e) => (e && e.message ? e.message : String(e));

// ---------------- しまっておく所 ----------------
// 動画の情報（名前・長さ・棚の絵）は IndexedDB の videos に、動画の中身はブラウザ専用の入れ物（OPFS）にしまう
// OPFS が使えないブラウザでは、中身も IndexedDB の blobs にしまう
const DB_NAME = 'mediaplayer', STORES = ['videos', 'blobs'];
let dbP = null;
function openDb() {
  if (!dbP) dbP = new Promise((ok, ng) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ng(r.error);
  });
  return dbP;
}
async function dbDo(store, mode, fn) {
  const db = await openDb();
  return new Promise((ok, ng) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = () => ng(tx.error || (req && req.error) || new Error('しまえませんでした'));
    tx.onabort = () => ng(tx.error || (req && req.error) || new Error('しまえませんでした'));
  });
}
const dbGet = (s, k) => dbDo(s, 'readonly', (o) => o.get(k));
const dbPut = (s, k, v) => dbDo(s, 'readwrite', (o) => o.put(v, k));
const dbDel = (s, k) => dbDo(s, 'readwrite', (o) => o.delete(k));
const dbAll = (s) => dbDo(s, 'readonly', (o) => o.getAll());

function loadJson(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function saveJson(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { } }
function removeKey(key) { try { localStorage.removeItem(key); } catch (e) { } }
// 動画ごとに覚えること：mp_pos_<id> = { t: 見た位置（秒）, d: 長さ（秒）, at: 最後に見た時刻, done: 最後まで見たか }

const canOpfs = !!(navigator.storage && navigator.storage.getDirectory && window.Worker);
async function videosDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('videos', { create: !!create });
}
// 中身をしまう。もどり値は、しまった所（'opfs' か 'idb'）
function saveToOpfs(id, file, onProgress) {
  return new Promise((ok, ng) => {
    const w = new Worker('store-worker.js');
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.progress != null) onProgress(m.progress);
      else if (m.done) { w.terminate(); ok(); }
      else if (m.error) { w.terminate(); ng(Object.assign(new Error(m.error.message), { name: m.error.name })); }
    };
    w.onerror = (ev) => { w.terminate(); ng(new Error(ev.message || '取りこみの係が止まりました')); };
    w.postMessage({ id, file });
  });
}
async function saveBody(id, file, onProgress) {
  if (canOpfs) {
    try { await saveToOpfs(id, file, onProgress); return 'opfs'; }
    catch (e) { if (e.name === 'QuotaExceededError') throw e; }   // 空きが足りないとき以外は、下の方法でもう一度ためす
  }
  await dbPut('blobs', id, file);
  onProgress(1);
  return 'idb';
}
async function loadBody(meta) {
  if (meta.store === 'opfs') {
    const fh = await (await videosDir()).getFileHandle(meta.id);
    return fh.getFile();
  }
  const b = await dbGet('blobs', meta.id);
  if (!b) throw new Error('動画の中身が見つかりません');
  return b;
}
async function deleteBody(meta) {
  if (meta.store === 'opfs') { try { await (await videosDir()).removeEntry(meta.id); } catch (e) { } }
  else await dbDel('blobs', meta.id);
}

// ---------------- 表示の小さな道具 ----------------
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}
function fmtSize(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(n >= 10737418240 ? 0 : 1) + ' GB';
  if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}
function showMsg(text) { $('msgText').textContent = text; $('msgBar').hidden = false; }
$('msgClose').onclick = () => { $('msgBar').hidden = true; };

// ---------------- 取りこむ ----------------
const once = (el, names, ms) => new Promise((ok, ng) => {
  const list = names.split(' ');
  const t = setTimeout(() => { off(); ng(new Error('時間がかかりすぎました')); }, ms);
  const onOk = () => { off(); ok(); };
  const onNg = () => { off(); ng(new Error('この動画は、このブラウザでは再生できない形式です')); };
  function off() { clearTimeout(t); for (const n of list) el.removeEventListener(n, onOk); el.removeEventListener('error', onNg); }
  for (const n of list) el.addEventListener(n, onOk);
  el.addEventListener('error', onNg);
});
// 動画の今の場面を絵にする。まっ黒な場面（または、まだ絵が出ていない）ときは '' を返す
function grabFrame(v) {
  if (!v.videoWidth) return '';
  try {
    const s = document.createElement('canvas');
    s.width = 32; s.height = 18;
    const sx = s.getContext('2d', { willReadFrequently: true });
    sx.drawImage(v, 0, 0, 32, 18);
    const px = sx.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] * 0.3 + px[i + 1] * 0.6 + px[i + 2] * 0.1;
    if (sum / (px.length / 4) < 14) return '';
    const c = document.createElement('canvas');
    c.width = THUMB_W; c.height = Math.max(1, Math.round(THUMB_W * v.videoHeight / v.videoWidth));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  } catch (e) { return ''; }
}
// 場面を移したあと、絵が出てくるのを少し待つ
const frameReady = (v) => new Promise((ok) => {
  const t = setTimeout(ok, 400);
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { clearTimeout(t); ok(); });
});

// 動画を一度開いて、長さを調べ、棚の絵を作る。再生できない形式なら、ここでわかる
async function probe(file) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  const url = URL.createObjectURL(file);
  const info = { duration: 0, thumb: '', w: 0, h: 0 };
  try {
    v.src = url;
    await once(v, 'loadedmetadata', 20000);
    info.duration = isFinite(v.duration) ? v.duration : 0;
    info.w = v.videoWidth; info.h = v.videoHeight;
    if (!info.w) return info;   // 音だけのファイルなど
    try {
      // iPad は、少し再生しないと絵が出てこないことがある（音を消してあるので、自動で再生できる）
      try { await v.play(); v.pause(); } catch (e) { }
      // はじめの方は黒い画面のことが多いので、場所を変えながら、絵が出る所を探す
      for (const r of [0.1, 0.25, 0.5]) {
        const at = info.duration * r;
        if (at > 0.1) { v.currentTime = at; await once(v, 'seeked', 10000); }
        else if (v.readyState < 2) await once(v, 'loadeddata', 10000);
        await frameReady(v);
        info.thumb = grabFrame(v);
        if (info.thumb || !info.duration) break;
      }
    } catch (e) { }   // 絵が作れなくても、取りこみは続ける
    return info;
  } finally {
    v.removeAttribute('src'); v.load();
    URL.revokeObjectURL(url);
  }
}

let importing = false;
async function importFiles(files) {
  if (importing || !files.length) return;
  importing = true;
  const failed = [];
  try {
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { } }
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const head = (files.length > 1 ? '（' + (i + 1) + '／' + files.length + '）' : '') + f.name;
      const show = (what, p) => {
        $('importBar').hidden = false;
        $('importText').textContent = what + '：' + head;
        $('importProg').style.width = Math.round(p * 100) + '%';
      };
      try {
        if (!VIDEO_RE.test(f.name) && !/^video\//.test(f.type)) throw new Error('動画ファイルではないようです');
        show('調べています', 0);
        const info = await probe(f);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        show('取りこんでいます 0%', 0);
        const store = await saveBody(id, f, (p) => show('取りこんでいます ' + Math.floor(p * 100) + '%', p));
        const meta = { id, name: baseName(f.name), file: f.name, size: f.size, type: f.type || 'video/mp4', added: Date.now(),
          duration: info.duration, w: info.w, h: info.h, thumb: info.thumb, thumbOk: !!info.thumb, store };
        try { await dbPut('videos', id, meta); }
        catch (e) { await deleteBody(meta); throw e; }
      } catch (e) {
        failed.push('・' + f.name + '：' + (e && e.name === 'QuotaExceededError'
          ? '端末の空きが足りないため、入りませんでした。見終わった動画を消すと空きができます。' : errText(e)));
      }
    }
  } finally {
    importing = false;
    $('importBar').hidden = true;
  }
  if (failed.length) showMsg('取りこめなかった動画があります。\n' + failed.join('\n'));
  await renderLibrary();
}
$('fileInput').onchange = (ev) => {
  const files = Array.from(ev.target.files || []);
  ev.target.value = '';
  importFiles(files);
};

// ---------------- 棚 ----------------
let metas = [];
async function renderLibrary() {
  metas = (await dbAll('videos')).sort((a, b) => collator.compare(a.name, b.name));
  const box = $('videos');
  box.textContent = '';
  for (const m of metas) {
    const pos = loadJson('mp_pos_' + m.id, null);
    const card = document.createElement('div');
    card.className = 'video';
    const cv = document.createElement('div');
    cv.className = 'cv';
    if (m.thumb) { const img = document.createElement('img'); img.src = m.thumb; img.alt = ''; cv.appendChild(img); }
    else cv.textContent = '🎬';
    if (m.duration) { const len = document.createElement('span'); len.className = 'len'; len.textContent = fmtTime(m.duration); cv.appendChild(len); }
    if (pos && pos.done) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '見終わり'; cv.appendChild(tag); }
    if (pos && !pos.done && pos.t > 0 && m.duration) {
      const bar = document.createElement('div'); bar.className = 'bar2';
      const i = document.createElement('i'); i.style.width = Math.min(100, pos.t / m.duration * 100) + '%';
      bar.appendChild(i); cv.appendChild(bar);
    }
    const t = document.createElement('div'); t.className = 't'; t.textContent = m.name;
    const p = document.createElement('div'); p.className = 'p';
    const st = document.createElement('span');
    st.textContent = (pos && !pos.done && pos.t > 0 ? fmtTime(pos.t) + ' から ・ ' : '') + fmtSize(m.size);
    const del = document.createElement('button'); del.className = 'btn del'; del.textContent = '消す';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('「' + m.name + '」を、この端末から消しますか？\n（もとのファイルは消えません）')) return;
      await deleteBody(m); await dbDel('videos', m.id); removeKey('mp_pos_' + m.id);
      renderLibrary();
    };
    p.append(st, del);
    card.append(cv, t, p);
    card.onclick = () => openPlayer(m);
    box.appendChild(card);
  }
  $('libHint').hidden = metas.length > 0;
  $('libHint').textContent = 'まだ動画がありません。\n右上の「＋ 動画を取りこむ」を押して、MP4 のファイルを選んでください（いくつかまとめて選べます）。\n取りこんだ動画はこの端末の中にしまうので、次からはネットなしで見られます。';
  showStorage();
}
async function showStorage() {
  let text = '';
  const total = metas.reduce((s, m) => s + m.size, 0);
  if (metas.length) text = '動画 ' + metas.length + ' 本・合わせて ' + fmtSize(total);
  try {
    const e = await navigator.storage.estimate();
    if (e && e.quota) text += (text ? ' ／ ' : '') + 'この端末でしまえる量の目安：あと ' + fmtSize(Math.max(0, e.quota - (e.usage || 0)));
  } catch (e) { }
  $('storage').textContent = text;
}

// ---------------- 再生する ----------------
const video = $('video');
let cur = null, curUrl = '', hideTimer = 0, lastSave = 0, seeking = false, speedIx = 0;

function savePos(done) {
  if (!cur || !video.duration) return;
  const t = video.currentTime, d = video.duration;
  saveJson('mp_pos_' + cur.id, { t: done ? 0 : t, d, at: Date.now(), done: !!done || t >= d - 3 });
  lastSave = Date.now();
}
function showCtl(keep) {
  $('player').classList.remove('hidectl');
  clearTimeout(hideTimer);
  if (!keep && !video.paused) hideTimer = setTimeout(() => { if (!video.paused && !seeking) $('player').classList.add('hidectl'); }, 3500);
}
function updatePlayBtn() { $('play').textContent = video.paused ? '▶' : '⏸'; $('play').setAttribute('aria-label', video.paused ? '再生' : '一時停止'); }
function updateTime() {
  const d = video.duration || (cur && cur.duration) || 0;
  $('timeNow').textContent = fmtTime(video.currentTime);
  $('timeAll').textContent = fmtTime(d);
  if (!seeking) $('seek').value = d ? Math.round(video.currentTime / d * 1000) : 0;
}
function togglePlay() { if (video.paused) video.play().catch(() => { }); else video.pause(); }
function skip(sec) {
  if (!video.duration) return;
  video.currentTime = Math.max(0, Math.min(video.duration - 0.5, video.currentTime + sec));
  updateTime();
  const mk = $('skipMark');
  mk.textContent = (sec < 0 ? '« ' : '') + Math.abs(sec) + '秒' + (sec > 0 ? ' »' : '');
  mk.className = 'skipmark ' + (sec < 0 ? 'left' : 'right');
  mk.hidden = false;
  clearTimeout(skip.timer); skip.timer = setTimeout(() => { mk.hidden = true; }, 600);
}

async function openPlayer(meta) {
  let body;
  try { body = await loadBody(meta); }
  catch (e) { showMsg('「' + meta.name + '」を開けませんでした：' + errText(e)); return; }
  cur = meta;
  curUrl = URL.createObjectURL(body);
  $('title').textContent = meta.name;
  $('library').hidden = true; $('player').hidden = false;
  $('loading').hidden = false;
  $('fullBtn').hidden = !(document.fullscreenEnabled || document.webkitFullscreenEnabled) || isStandalone() || appleTouch;
  video.playbackRate = SPEEDS[speedIx];
  const pos = loadJson('mp_pos_' + meta.id, null);
  const startAt = pos && !pos.done && pos.t > 5 ? pos.t : 0;
  video.src = curUrl;
  video.addEventListener('loadedmetadata', function f() {
    video.removeEventListener('loadedmetadata', f);
    if (startAt && startAt < video.duration - 5) video.currentTime = startAt;
    updateTime();
  });
  updatePlayBtn(); updateTime(); showCtl(true);
  video.play().catch(() => { });   // 自動で始まらないブラウザでは、▶ を押してもらう
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: meta.name });
      navigator.mediaSession.setActionHandler('seekbackward', () => skip(-10));
      navigator.mediaSession.setActionHandler('seekforward', () => skip(10));
    } catch (e) { }
  }
}
function closePlayer() {
  savePos(false);
  video.pause();
  video.removeAttribute('src'); video.load();
  if (curUrl) URL.revokeObjectURL(curUrl);
  cur = null; curUrl = '';
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  $('player').hidden = true; $('library').hidden = false;
  renderLibrary();
}
const appleTouch = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

video.addEventListener('play', () => { updatePlayBtn(); showCtl(); });
video.addEventListener('pause', () => { updatePlayBtn(); showCtl(true); if (cur) savePos(false); });
video.addEventListener('timeupdate', () => { updateTime(); if (Date.now() - lastSave > 3000) savePos(false); fixThumb(); });
// 取りこんだときに棚の絵が作れなかった動画は、再生している間に絵を作り直す（iPad は、再生中でないと絵が取れない動画がある）
let lastThumbTry = 0;
function fixThumb() {
  const m = cur;
  if (!m || m.thumbOk || video.paused || video.currentTime < 1 || Date.now() - lastThumbTry < 2000) return;
  lastThumbTry = Date.now();
  const th = grabFrame(video);
  if (!th) return;
  m.thumb = th; m.thumbOk = true;
  dbPut('videos', m.id, m).catch(() => { });
}
video.addEventListener('durationchange', updateTime);
video.addEventListener('waiting', () => { $('loading').hidden = false; });
video.addEventListener('canplay', () => { $('loading').hidden = true; });
video.addEventListener('playing', () => { $('loading').hidden = true; });
video.addEventListener('ended', () => { savePos(true); showCtl(true); });
video.addEventListener('error', () => {
  if (!cur) return;
  $('loading').hidden = true;
  const name = cur.name;
  closePlayer();
  showMsg('「' + name + '」は、このブラウザでは再生できませんでした。');
});

$('back').onclick = closePlayer;
$('play').onclick = (ev) => { ev.stopPropagation(); togglePlay(); };
$('back10').onclick = (ev) => { ev.stopPropagation(); skip(-10); showCtl(); };
$('fwd10').onclick = (ev) => { ev.stopPropagation(); skip(10); showCtl(); };
$('speedBtn').onclick = () => {
  speedIx = (speedIx + 1) % SPEEDS.length;
  video.playbackRate = SPEEDS[speedIx];
  $('speedBtn').textContent = '速さ：' + SPEEDS[speedIx].toFixed(SPEEDS[speedIx] % 1 && SPEEDS[speedIx] * 10 % 1 ? 2 : 1);
  showCtl();
};
$('fullBtn').onclick = () => {
  const el = $('player');
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  showCtl();
};
const seekEl = $('seek');
seekEl.addEventListener('input', () => {
  seeking = true; showCtl(true);
  const d = video.duration || 0;
  if (d) { video.currentTime = seekEl.value / 1000 * d; $('timeNow').textContent = fmtTime(video.currentTime); }
});
seekEl.addEventListener('change', () => { seeking = false; showCtl(); });

// 画面を1回押すと、ボタンを出す／かくす。左右のはしを2回つづけて押すと、10秒もどる／すすむ
let lastTap = 0, lastSide = 0;
$('stage').addEventListener('click', (ev) => {
  const now = Date.now(), x = ev.clientX / window.innerWidth;
  const side = x < 0.35 ? -1 : x > 0.65 ? 1 : 0;
  if (side && side === lastSide && now - lastTap < 350) { skip(side * 10); lastTap = 0; showCtl(); return; }
  lastTap = now; lastSide = side;
  if ($('player').classList.contains('hidectl')) showCtl(); else if (!video.paused) $('player').classList.add('hidectl');
});
// ボタンのない所（ctl のすきま）を押したときも、同じ動きにする
$('ctl').addEventListener('click', (ev) => { if (ev.target === $('ctl')) $('stage').dispatchEvent(new MouseEvent('click', { clientX: ev.clientX, clientY: ev.clientY })); });
$('player').addEventListener('mousemove', () => { if (!$('player').hidden) showCtl(); });

// 2本の指で同時に1回押すと、再生／一時停止（画面のどこでもよい）
let two = null;
$('player').addEventListener('touchstart', (ev) => {
  if (ev.touches.length === 2) two = { at: Date.now(), x: ev.touches[0].clientX, y: ev.touches[0].clientY, x2: ev.touches[1].clientX, y2: ev.touches[1].clientY, moved: false };
  else if (ev.touches.length > 2) two = null;
}, { passive: true });
$('player').addEventListener('touchmove', (ev) => {
  if (!two || ev.touches.length < 2) return;
  const a = ev.touches[0], b = ev.touches[1];
  if (Math.hypot(a.clientX - two.x, a.clientY - two.y) > 24 || Math.hypot(b.clientX - two.x2, b.clientY - two.y2) > 24) two.moved = true;
}, { passive: true });
$('player').addEventListener('touchend', (ev) => {
  if (!two || ev.touches.length) return;
  const ok = !two.moved && Date.now() - two.at < 500;
  two = null;
  if (!ok) return;
  ev.preventDefault();   // このあとに「1回押した」あつかいにならないように
  const willPlay = video.paused;
  togglePlay();
  flashMark(willPlay ? '▶ 再生' : '⏸ 一時停止');
});
$('player').addEventListener('touchcancel', () => { two = null; });
function flashMark(text) {
  const mk = $('skipMark');
  mk.textContent = text; mk.className = 'skipmark mid'; mk.hidden = false;
  clearTimeout(skip.timer); skip.timer = setTimeout(() => { mk.hidden = true; }, 700);
}

// Windows：スペースで再生／一時停止、← → で10秒もどる／すすむ、Esc で棚へ
document.addEventListener('keydown', (ev) => {
  if ($('player').hidden) return;
  if (ev.key === ' ') { ev.preventDefault(); togglePlay(); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); skip(-10); showCtl(); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); skip(10); showCtl(); }
  else if (ev.key === 'Escape' && !(document.fullscreenElement || document.webkitFullscreenElement)) closePlayer();
});
// アプリを閉じたり、うしろに回したりしたときも、見た位置を覚える
document.addEventListener('visibilitychange', () => { if (document.hidden && cur) savePos(false); });
window.addEventListener('pagehide', () => { if (cur) savePos(false); });

// ---------------- はじめ ----------------
if (appleTouch && isStandalone()) document.documentElement.classList.add('iosapp');
$('ver').textContent = 'MediaPlayer ' + APP_VERSION;
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
renderLibrary().catch((e) => showMsg('棚を開けませんでした：' + errText(e)));
