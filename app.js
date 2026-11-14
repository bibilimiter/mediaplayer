// MediaPlayer：動画（MP4）を端末の中に取りこんで再生する。iPad・Windows・Android のブラウザで動く（PWA）
'use strict';

const APP_VERSION = 'v10';

// 再生／一時停止のマーク（絵文字だと iPad で色つきの四角になるので、自分で描く）
const ICON_PLAY = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';  // 画面を直したら、sw.js の VERSION といっしょに上げる

const $ = (id) => document.getElementById(id);
const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const THUMB_W = 480;                 // 棚の絵の幅（画素）
// 選べる速さ：0.5〜2.0 倍を 0.1 ずつ
const SPEEDS = Array.from({ length: 16 }, (_, i) => Math.round((0.5 + i * 0.1) * 10) / 10);
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
  const failed = [], added = [];
  const subFiles = files.filter(isSubFile);
  files = files.filter((f) => !isSubFile(f));
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
          duration: info.duration, w: info.w, h: info.h, thumb: info.thumb, thumbOk: !!info.thumb, store, folder: curFolder || '', subs: [] };
        try { await dbPut('videos', id, meta); }
        catch (e) { await deleteBody(meta); throw e; }
        added.push(meta);
      } catch (e) {
        failed.push('・' + f.name + '：' + (e && e.name === 'QuotaExceededError'
          ? '端末の空きが足りないため、入りませんでした。見終わった動画を消すと空きができます。' : errText(e)));
      }
    }
    // 字幕ファイル：同じ名前の動画（いま取りこんだ動画か、棚にある動画）に付ける
    const all = added.concat((await dbAll('videos')).filter((m) => !added.some((a) => a.id === m.id)));
    for (const f of subFiles) {
      try {
        const m = findVideoFor(f, added) || findVideoFor(f, all) || (added.length === 1 ? added[0] : null);
        if (!m) throw new Error('どの動画の字幕かわかりませんでした。動画と同じ名前にしてください（例：映画.mp4 と 映画.srt）。再生画面の「字幕・音声」からも足せます');
        await addSubTo(m, f);
      } catch (e) { failed.push('・' + f.name + '：' + errText(e)); }
    }
  } finally {
    importing = false;
    $('importBar').hidden = true;
  }
  if (failed.length) showMsg('取りこめなかったファイルがあります。\n' + failed.join('\n'));
  await renderLibrary();
}
$('fileInput').onchange = (ev) => {
  const files = Array.from(ev.target.files || []);
  ev.target.value = '';
  importFiles(files);
};

// ---------------- 棚 ----------------
// フォルダ：動画ごとに meta.folder（フォルダの名前、'' は棚の上）。フォルダの名前の一覧は mp_folders に覚える
let metas = [];
let folders = loadJson('mp_folders', []);
let curFolder = null;   // いま開いているフォルダ（null は棚のいちばん上）
const saveFolders = () => saveJson('mp_folders', folders);

function videoCard(m, small) {
  const pos = loadJson('mp_pos_' + m.id, null);
  const card = document.createElement('div');
  card.className = 'video' + (small ? ' small' : '');
  const cv = document.createElement('div');
  cv.className = 'cv';
  if (m.thumb) { const img = document.createElement('img'); img.src = m.thumb; img.alt = ''; cv.appendChild(img); }
  else cv.textContent = '🎬';
  if (m.duration) { const len = document.createElement('span'); len.className = 'len'; len.textContent = fmtTime(m.duration); cv.appendChild(len); }
  if (pos && pos.done) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '見終わり'; cv.appendChild(tag); }
  else if (m.subs && m.subs.length) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = '字幕'; cv.appendChild(tag); }
  if (pos && !pos.done && pos.t > 0 && m.duration) {
    const bar = document.createElement('div'); bar.className = 'bar2';
    const i = document.createElement('i'); i.style.width = Math.min(100, pos.t / m.duration * 100) + '%';
    bar.appendChild(i); cv.appendChild(bar);
  }
  const t = document.createElement('div'); t.className = 't'; t.textContent = m.name;
  const p = document.createElement('div'); p.className = 'p';
  const st = document.createElement('span');
  if (small) {
    st.textContent = pos && m.duration ? 'あと ' + fmtTime(Math.max(0, m.duration - pos.t)) : '';
    p.append(st);
  } else {
    st.className = 'grow';
    st.textContent = (pos && !pos.done && pos.t > 0 ? fmtTime(pos.t) + ' から ・ ' : '') + fmtSize(m.size);
    const mv = document.createElement('button'); mv.className = 'btn mini'; mv.textContent = '移す';
    mv.onclick = (ev) => { ev.stopPropagation(); openMove(m); };
    const del = document.createElement('button'); del.className = 'btn del'; del.textContent = '消す';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('「' + m.name + '」を、この端末から消しますか？\n（もとのファイルは消えません）')) return;
      await deleteBody(m); await dbDel('videos', m.id);
      for (const k of ['mp_pos_', 'mp_sub_', 'mp_aud_']) removeKey(k + m.id);
      renderLibrary();
    };
    p.append(st, mv, del);
  }
  card.append(cv, t, p);
  card.onclick = () => openPlayer(m);
  return card;
}
function folderCard(name, list) {
  const card = document.createElement('div');
  card.className = 'video folder';
  const cv = document.createElement('div');
  cv.className = 'cv';
  const withThumb = list.find((m) => m.thumb);
  if (withThumb) { const img = document.createElement('img'); img.src = withThumb.thumb; img.alt = ''; cv.appendChild(img); }
  const ic = document.createElement('span'); ic.className = 'fic'; ic.textContent = '📁'; cv.appendChild(ic);
  const t = document.createElement('div'); t.className = 't'; t.textContent = name;
  const p = document.createElement('div'); p.className = 'p'; p.textContent = 'フォルダ ・ ' + list.length + ' 本';
  card.append(cv, t, p);
  card.onclick = () => { curFolder = name; renderLibrary(); window.scrollTo(0, 0); };
  return card;
}
async function renderLibrary() {
  metas = (await dbAll('videos')).sort((a, b) => collator.compare(a.name, b.name));
  // 動画が入っているのに一覧にないフォルダは、一覧にもどす
  for (const m of metas) if (m.folder && !folders.includes(m.folder)) { folders.push(m.folder); saveFolders(); }
  folders.sort((a, b) => collator.compare(a, b));
  if (curFolder != null && !folders.includes(curFolder)) curFolder = null;
  const box = $('videos');
  box.textContent = '';
  $('contRow').textContent = '';
  const top = curFolder == null;
  $('folderBar').hidden = top;
  $('folderNew').hidden = !top;
  let shown = 0;
  if (top) {
    // 続きを見る：途中まで見た動画を、最近見た順に
    const inprog = metas.map((m) => [m, loadJson('mp_pos_' + m.id, null)])
      .filter(([m, p]) => p && !p.done && p.t > 5).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 12);
    for (const [m] of inprog) $('contRow').appendChild(videoCard(m, true));
    $('contWrap').hidden = !inprog.length;
    for (const f of folders) { box.appendChild(folderCard(f, metas.filter((m) => m.folder === f))); shown++; }
    for (const m of metas) if (!m.folder) { box.appendChild(videoCard(m)); shown++; }
  } else {
    $('contWrap').hidden = true;
    $('folderName').textContent = '📁 ' + curFolder;
    for (const m of metas) if (m.folder === curFolder) { box.appendChild(videoCard(m)); shown++; }
  }
  $('libHint').hidden = shown > 0;
  $('libHint').textContent = top
    ? 'まだ動画がありません。\n右上の「＋ 動画を取りこむ」を押して、MP4 のファイルを選んでください（いくつかまとめて選べます）。\n取りこんだ動画はこの端末の中にしまうので、次からはネットなしで見られます。'
    : 'このフォルダには、まだ動画がありません。\nここで「＋ 動画を取りこむ」を押すと、このフォルダに入ります。棚の動画の「移す」でも入れられます。';
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
function askFolderName(def) {
  const v = prompt('フォルダの名前', def || '');
  const name = v == null ? '' : v.trim();
  if (!name) return '';
  if (folders.includes(name) && name !== def) { alert('「' + name + '」というフォルダは、もうあります。'); return ''; }
  return name;
}
$('folderNew').onclick = () => {
  const name = askFolderName('');
  if (!name) return;
  folders.push(name); saveFolders(); renderLibrary();
};
$('folderUp').onclick = () => { curFolder = null; renderLibrary(); };
$('folderRename').onclick = async () => {
  const old = curFolder, name = askFolderName(old);
  if (!name || name === old) return;
  for (const m of metas) if (m.folder === old) { m.folder = name; await dbPut('videos', m.id, m); }
  folders = folders.map((f) => (f === old ? name : f)); saveFolders();
  curFolder = name; renderLibrary();
};
$('folderDel').onclick = async () => {
  const f = curFolder;
  if (!confirm('フォルダ「' + f + '」をなくしますか？\n（中の動画は消えません。棚にもどります）')) return;
  for (const m of metas) if (m.folder === f) { m.folder = ''; await dbPut('videos', m.id, m); }
  folders = folders.filter((x) => x !== f); saveFolders();
  curFolder = null; renderLibrary();
};
// 「移す」：動画を入れるフォルダを選ぶ
function openMove(m) {
  $('moveTitle').textContent = '「' + m.name + '」を移す';
  const list = $('moveList');
  list.textContent = '';
  const add = (label, folder, on) => {
    const b = document.createElement('button');
    b.className = 'btn' + (on ? ' primary' : '');
    b.textContent = label;
    b.onclick = async () => {
      let f = folder;
      if (f === null) { f = askFolderName(''); if (!f) return; folders.push(f); saveFolders(); }
      m.folder = f; await dbPut('videos', m.id, m);
      $('moveDlg').hidden = true; renderLibrary();
    };
    list.appendChild(b);
  };
  add('棚（フォルダに入れない）', '', !m.folder);
  for (const f of folders) add('📁 ' + f, f, m.folder === f);
  add('＋ 新しいフォルダを作って入れる', null, false);
  $('moveDlg').hidden = false;
}
$('moveClose').onclick = () => { $('moveDlg').hidden = true; };
$('moveDlg').addEventListener('click', (ev) => { if (ev.target === $('moveDlg')) $('moveDlg').hidden = true; });

// ---------------- 再生する ----------------
const video = $('video');
let cur = null, curUrl = '', hideTimer = 0, lastSave = 0, seeking = false;
let speed = loadJson('mp_speed', 1);
if (!SPEEDS.includes(speed)) speed = 1;

function savePos(done) {
  if (!cur || !video.duration) return;
  const t = video.currentTime, d = video.duration;
  saveJson('mp_pos_' + cur.id, { t: done ? 0 : t, d, at: Date.now(), done: !!done || t >= d - 3 });
  lastSave = Date.now();
}
function showCtl(keep) {
  $('player').classList.remove('hidectl');
  clearTimeout(hideTimer);
  if (!keep && !video.paused) hideTimer = setTimeout(() => { if (!video.paused && !seeking && !panelOpen()) $('player').classList.add('hidectl'); }, 3500);
}
function updatePlayBtn() { $('play').innerHTML = video.paused ? ICON_PLAY : ICON_PAUSE; $('play').setAttribute('aria-label', video.paused ? '再生' : '一時停止'); }
function updateTime() {
  const d = video.duration || (cur && cur.duration) || 0;
  $('timeNow').textContent = fmtTime(video.currentTime);
  $('timeAll').textContent = fmtTime(d);
  if (!seeking) $('seek').value = d ? Math.round(video.currentTime / d * 1000) : 0;
}
function togglePlay() { ensureAudio(); if (video.paused) video.play().catch(() => { }); else video.pause(); }
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
  setSpeedLabel();
  setSubSize(subSize);
  subSel = null; subShown = null; $('subText').hidden = true;
  const pos = loadJson('mp_pos_' + meta.id, null);
  const startAt = pos && !pos.done && pos.t > 5 ? pos.t : 0;
  video.src = curUrl;
  video.addEventListener('loadedmetadata', function f() {
    video.removeEventListener('loadedmetadata', f);
    video.defaultPlaybackRate = speed; video.playbackRate = speed;   // 動画を入れたあとに設定しないと 1.0 にもどる
    if (startAt && startAt < video.duration - 5) video.currentTime = startAt;
    updateTime();
    applySavedSub();
    const ai = loadJson('mp_aud_' + meta.id, null);
    if (ai != null) selectAudio(ai, false);
  });
  updatePlayBtn(); updateTime(); showCtl(true);
  ensureAudio();
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
  closePanels();
  exitPip();
  pvUnload();
  selectSub(null);
  $('subText').hidden = true;
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
// 速さ：ボタンを押すと一覧が出て、0.5〜2.0 倍を 0.1 ずつ選べる。選んだ速さは次の動画にも使う
function setSpeedLabel() { $('speedBtn').textContent = '速さ：' + speed.toFixed(1); }
function buildSpeedList() {
  const box = $('speedList');
  box.textContent = '';
  for (const v of SPEEDS) {
    const b = document.createElement('button');
    b.className = 'btn' + (v === speed ? ' primary' : '');
    b.textContent = v.toFixed(1);
    b.onclick = (ev) => {
      ev.stopPropagation();
      setSpeed(v); closeSpeed(); showCtl();
    };
    box.appendChild(b);
  }
}
function closeSpeed() { $('speedPanel').hidden = true; }
// 「速さ」を長押しすると、1回で 1.0 倍にもどす
let speedHold = 0, speedHeld = false;
function setSpeed(v) { speed = v; video.defaultPlaybackRate = v; video.playbackRate = v; saveJson('mp_speed', v); setSpeedLabel(); }
$('speedBtn').addEventListener('pointerdown', () => {
  speedHeld = false;
  clearTimeout(speedHold);
  speedHold = setTimeout(() => {
    speedHeld = true;
    setSpeed(1); closeSpeed(); showCtl();
    flashMark('速さ 1.0');
  }, 600);
});
for (const n of ['pointerup', 'pointerleave', 'pointercancel']) $('speedBtn').addEventListener(n, () => clearTimeout(speedHold));
$('speedBtn').addEventListener('contextmenu', (ev) => ev.preventDefault());   // 長押しでメニューが出ないように
$('speedBtn').onclick = (ev) => {
  ev.stopPropagation();
  if (speedHeld) { speedHeld = false; return; }   // 長押しのあとは、一覧を出さない
  if (!$('speedPanel').hidden) { closeSpeed(); showCtl(); return; }
  closePanels();
  buildSpeedList();
  $('speedPanel').hidden = false;
  showCtl(true);   // 選んでいる間はボタンを消さない
};
$('speedPanel').addEventListener('click', (ev) => ev.stopPropagation());
$('fullBtn').onclick = () => {
  const el = $('player');
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  showCtl();
};
const seekEl = $('seek');
// つまみを動かしている間は、場面の小さな絵と時間だけを出し、指をはなしたときに本体の動画を移す
seekEl.addEventListener('input', () => {
  seeking = true; showCtl(true);
  const d = video.duration || 0;
  if (d) { $('timeNow').textContent = fmtTime(seekEl.value / 1000 * d); showPreview(seekEl.value / 1000); }
});
seekEl.addEventListener('change', () => {
  const d = video.duration || 0;
  if (d) video.currentTime = seekEl.value / 1000 * d;
  seeking = false; $('seekPrev').hidden = true; showCtl();
});

// 画面の左半分を2回つづけて押すと10秒もどる、右半分を2回つづけて押すと10秒すすむ
// 1回だけ押したときは、ボタンを出す／かくす（2回目が来ないか、少しだけ待ってから動く）
const DOUBLE_MS = 320;
let tapTimer = 0, lastTap = 0, lastSide = 0;
$('stage').addEventListener('click', (ev) => {
  if (Date.now() - volSwipeEnd < 500) return;   // 上下になぞって音量を変えたあとの「押した」は、なかったことにする
  if (panelOpen()) { closePanels(); showCtl(); return; }   // 一覧が出ているときは、閉じるだけ
  const now = Date.now();
  const side = ev.clientX < window.innerWidth / 2 ? -1 : 1;
  if (side === lastSide && now - lastTap < DOUBLE_MS) {
    clearTimeout(tapTimer); tapTimer = 0;
    lastTap = now;   // つづけて押せば、さらに10秒ずつ動く
    skip(side * 10);
    return;
  }
  lastTap = now; lastSide = side;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => {
    tapTimer = 0;
    if ($('player').classList.contains('hidectl')) showCtl(); else if (!video.paused) $('player').classList.add('hidectl');
  }, DOUBLE_MS);
});
// ボタンのない所（ctl のすきま）を押したときも、同じ動きにする
$('ctl').addEventListener('click', (ev) => { if (ev.target === $('ctl')) $('stage').dispatchEvent(new MouseEvent('click', { clientX: ev.clientX, clientY: ev.clientY })); });
// マウスを動かしたらボタンを出す（指で押したときは、ここでは出さない。上の「1回押す」にまかせる）
let lastMouse = '';
$('player').addEventListener('pointermove', (ev) => {
  if (ev.pointerType !== 'mouse' || $('player').hidden) return;
  const at = ev.clientX + ',' + ev.clientY;
  if (at === lastMouse) return;   // 押しただけで、動いていない
  lastMouse = at;
  showCtl();
});

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
  flashMark((willPlay ? ICON_PLAY : ICON_PAUSE) + (willPlay ? '再生' : '一時停止'));
});
$('player').addEventListener('touchcancel', () => { two = null; });
function flashMark(text) {
  const mk = $('skipMark');
  mk.innerHTML = text; mk.className = 'skipmark mid'; mk.hidden = false;
  clearTimeout(skip.timer); skip.timer = setTimeout(() => { mk.hidden = true; }, text.length > 30 ? 4000 : 700);
}

// ---------------- 字幕 ----------------
// 字幕ファイル（.srt・.vtt）を読んで、{ s: 始まり（秒）, e: 終わり（秒）, t: 文 } の一覧にする
// 日本語の字幕は Shift_JIS で書かれていることが多いので、UTF-8 で読めなければ Shift_JIS で読む
function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); } catch (e) { }
  try { return new TextDecoder('shift_jis').decode(u8); } catch (e) { }
  return new TextDecoder().decode(u8);
}
const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
function toSec(str) {
  const m = String(str).trim().match(TIME_RE);
  return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000 : null;
}
function parseSubs(text) {
  const cues = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const s = toSec(a), e = toSec(b);
    if (s == null || e == null) continue;
    const t = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
    if (t) cues.push({ s, e, t });
  }
  return cues.sort((x, y) => x.s - y.s);
}
const LANGS = { ja: '日本語', jp: '日本語', jpn: '日本語', en: '英語', eng: '英語', zh: '中国語', chi: '中国語', zho: '中国語', ko: '韓国語', kor: '韓国語',
  fr: 'フランス語', fra: 'フランス語', fre: 'フランス語', de: 'ドイツ語', deu: 'ドイツ語', ger: 'ドイツ語', es: 'スペイン語', spa: 'スペイン語', it: 'イタリア語', ita: 'イタリア語' };
const langName = (code) => LANGS[String(code || '').toLowerCase().split(/[-_]/)[0]] || '';
const isSubFile = (f) => /\.(srt|vtt)$/i.test(f.name);
// 字幕ファイルを1つ読んで、動画の情報（meta.subs）に足す
async function addSubTo(meta, file) {
  const cues = parseSubs(decodeText(await file.arrayBuffer()));
  if (!cues.length) throw new Error('字幕の文が見つかりませんでした');
  const rest = baseName(file.name).slice(meta.name.length).replace(/^[.\s_-]+/, '');   // 「映画.ja.srt」の「ja」
  const label = langName(rest) || rest || file.name;
  meta.subs = (meta.subs || []).filter((x) => x.file !== file.name);
  meta.subs.push({ file: file.name, label, cues });
  await dbPut('videos', meta.id, meta);
  return meta.subs.length - 1;
}
// 字幕ファイルが、どの動画のものかを名前で探す（「映画.srt」「映画.ja.srt」→「映画」）
function findVideoFor(subFile, list) {
  const b = baseName(subFile.name);
  let best = null;
  for (const m of list) if ((b === m.name || b.startsWith(m.name + '.')) && (!best || m.name.length > best.name.length)) best = m;
  return best;
}

// 再生中の字幕：選べるのは、取りこんだ字幕と、動画の中に入っている字幕（iPad の Safari で読めるもの）
let subSel = null, subShown = '', subRaf = 0;
let subSize = loadJson('mp_subsize', 'm');
function subSources() {
  const list = [];
  (cur && cur.subs || []).forEach((x, i) => list.push({ key: 'f' + i, label: x.label, cues: x.cues }));
  const tt = video.textTracks;
  if (tt) for (let i = 0; i < tt.length; i++) {
    const t = tt[i];
    if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
    list.push({ key: 'i' + i, label: (t.label || langName(t.language) || '字幕 ' + (i + 1)) + '（動画の中）', track: t });
  }
  return list;
}
function selectSub(key, save) {
  const tt = video.textTracks;
  if (tt) for (let i = 0; i < tt.length; i++) tt[i].mode = 'disabled';
  subSel = key ? subSources().find((x) => x.key === key) || null : null;
  if (subSel && subSel.track) { subSel.track.mode = 'hidden'; subSel.track.oncuechange = renderSub; }   // 自分で出すので、ブラウザには出させない
  if (save && cur) saveJson('mp_sub_' + cur.id, key || 'off');
  subShown = null; renderSub();
}
function applySavedSub() {
  if (!cur) return;
  const saved = loadJson('mp_sub_' + cur.id, null);
  const list = subSources();
  if (saved === 'off') selectSub(null);
  else if (saved && list.some((x) => x.key === saved)) selectSub(saved);
  else selectSub(cur.subs && cur.subs.length ? 'f0' : null);   // 字幕を取りこんであれば、はじめから出す
}
function renderSub() {
  let text = '';
  if (subSel && subSel.cues) {
    const c = subSel.cues, t = video.currentTime;
    let lo = 0, hi = c.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (c[mid].s <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    const on = [];
    for (let i = k; i >= 0 && i > k - 4; i--) if (c[i].e > t) on.unshift(c[i].t);   // 重なっている字幕も出す
    text = on.join('\n');
  } else if (subSel && subSel.track && subSel.track.activeCues) {
    text = Array.from(subSel.track.activeCues).map((x) => String(x.text || '').replace(/<[^>]+>/g, '')).join('\n');
  }
  if (text === subShown) return;
  subShown = text;
  $('subText').textContent = text;
  $('subText').hidden = !text;
}
function subLoop() { renderSub(); subRaf = video.paused ? 0 : requestAnimationFrame(subLoop); }
video.addEventListener('play', () => { if (!subRaf) subRaf = requestAnimationFrame(subLoop); });
video.addEventListener('seeked', renderSub);
video.addEventListener('timeupdate', renderSub);
function setSubSize(v) {
  subSize = v; saveJson('mp_subsize', v);
  $('subText').className = 'subtext sz-' + v;
}

// ---------------- 音声の切り替え（日本語・英語など、音声が2つ以上入っている動画） ----------------
function audioTracks() {
  const at = video.audioTracks;
  if (!at || at.length < 2) return [];
  return Array.from({ length: at.length }, (_, i) => at[i]);
}
function selectAudio(i, save) {
  const list = audioTracks();
  if (!list[i]) return;
  list.forEach((t, j) => { t.enabled = j === i; });
  if (save && cur) saveJson('mp_aud_' + cur.id, i);
}

// ---------------- 字幕・音声の一覧 ----------------
function buildSubPanel() {
  const list = $('subList');
  list.textContent = '';
  const add = (label, key) => {
    const b = document.createElement('button');
    b.className = 'btn' + ((subSel ? subSel.key : null) === key ? ' primary' : '');
    b.textContent = label;
    b.onclick = (ev) => { ev.stopPropagation(); selectSub(key, true); buildSubPanel(); };
    list.appendChild(b);
  };
  add('字幕なし', null);
  for (const s of subSources()) add(s.label, s.key);
  const sz = $('subSizeList');
  sz.textContent = '';
  for (const [v, label] of [['s', '小'], ['m', '中'], ['l', '大']]) {
    const b = document.createElement('button');
    b.className = 'btn' + (subSize === v ? ' primary' : '');
    b.textContent = label;
    b.onclick = (ev) => { ev.stopPropagation(); setSubSize(v); buildSubPanel(); };
    sz.appendChild(b);
  }
  const at = audioTracks();
  $('audioBox').hidden = !at.length;
  const al = $('audioList');
  al.textContent = '';
  at.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'btn' + (t.enabled ? ' primary' : '');
    b.textContent = t.label || langName(t.language) || '音声 ' + (i + 1);
    b.onclick = (ev) => { ev.stopPropagation(); selectAudio(i, true); buildSubPanel(); };
    al.appendChild(b);
  });
}
$('subBtn').onclick = (ev) => {
  ev.stopPropagation();
  const open = $('subPanel').hidden;
  closePanels();
  if (open) { buildSubPanel(); $('subPanel').hidden = false; showCtl(true); } else showCtl();
};
$('subPanel').addEventListener('click', (ev) => ev.stopPropagation());
$('subInput').onchange = async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f || !cur) return;
  try {
    if (!isSubFile(f)) throw new Error('字幕ファイル（.srt か .vtt）を選んでください');
    const i = await addSubTo(cur, f);
    selectSub('f' + i, true);
    buildSubPanel();
    flashMark('字幕：' + cur.subs[i].label);
  } catch (e) { flashMark(errText(e)); }
};

// ---------------- 小さい画面で見る（ピクチャ・イン・ピクチャ）・テレビに映す（AirPlay） ----------------
const canPip = !!((document.pictureInPictureEnabled && video.requestPictureInPicture) ||
  (video.webkitSupportsPresentationMode && video.webkitSupportsPresentationMode('picture-in-picture')));
// iPad で確かめた（2026-11-15）：Safari では小さい画面にできるが、ホーム画面から開いたアプリでは iPad が断る（NotSupportedError）
// そのため、ホーム画面から開いたときはボタンを出さない
$('pipBtn').hidden = !canPip || (appleTouch && isStandalone());
function inPip() { return !!document.pictureInPictureElement || video.webkitPresentationMode === 'picture-in-picture'; }
function exitPip() {
  try {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => { });
    else if (video.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode('inline');
  } catch (e) { }
}
// iPad・iPhone は Safari 専用の呼び方（webkitSetPresentationMode）の方が確実なので、先に使う
// 押したその場で呼ばないと断られるので、待たずに呼ぶ。1.5秒たっても小さくならなければ、わけを出す
$('pipBtn').onclick = (ev) => {
  ev.stopPropagation();
  if (inPip()) { exitPip(); return; }
  let err = '';
  try {
    if (video.webkitSupportsPresentationMode && video.webkitSupportsPresentationMode('picture-in-picture')) video.webkitSetPresentationMode('picture-in-picture');
    else if (video.requestPictureInPicture) video.requestPictureInPicture().catch((e) => { err = (e && e.name) || 'Error'; });
  } catch (e) { err = (e && e.name) || 'Error'; }
  setTimeout(() => {
    if (inPip()) return;
    flashMark('小さい画面にできませんでした' + (err ? '（' + err + '）' : '') + (isStandalone() ? '（ホーム画面から開いたとき）' : '（Safari）') + (actx ? '・音量の変更あり' : ''));
  }, 1500);
};
if (window.WebKitPlaybackTargetAvailabilityEvent) {
  video.addEventListener('webkitplaybacktargetavailabilitychanged', (ev) => { $('airBtn').hidden = ev.availability !== 'available'; });
}
$('airBtn').onclick = (ev) => { ev.stopPropagation(); try { video.webkitShowPlaybackTargetPicker(); } catch (e) { } };

// ---------------- つまみを動かしている間、その場面の小さな絵を出す ----------------
// 本体の動画は、指をはなしたときに移す。絵は、別の小さな動画（音なし）を、その場所へ動かして見せる
const pv = $('prevVideo');
pv.muted = true;
let pvSrc = '', pvBusy = false, pvWant = null, pvTimer = 0;
function pvLoad() {
  if (!cur || !cur.w || pvSrc === curUrl) return;
  pvSrc = curUrl; pv.src = curUrl;
  pv.play().then(() => pv.pause()).catch(() => { });   // iPad は、一度再生しないと絵が出ないことがある
}
function pvSeek(t) {
  if (!pvSrc) return;
  if (pvBusy || pv.readyState < 1) { pvWant = t; return; }
  pvBusy = true;
  clearTimeout(pvTimer); pvTimer = setTimeout(pvDone, 1500);   // 返事がないときも、次へ進む
  if (pv.fastSeek) pv.fastSeek(t); else pv.currentTime = t;
}
function pvDone() {
  pvBusy = false;
  if (pvWant != null) { const t = pvWant; pvWant = null; pvSeek(t); }
}
pv.addEventListener('seeked', pvDone);
pv.addEventListener('loadedmetadata', () => { if (pvWant != null) pvDone(); });
function pvUnload() { pvSrc = ''; pvWant = null; pvBusy = false; pv.removeAttribute('src'); pv.load(); $('seekPrev').hidden = true; }
function showPreview(frac) {
  const d = video.duration || 0;
  if (!d) return;
  const t = frac * d;
  const box = $('seekPrev');
  box.classList.toggle('noimg', !(cur && cur.w));
  box.hidden = false;
  $('prevTime').textContent = fmtTime(t);
  const r = seekEl.getBoundingClientRect(), fr = $('ctl').getBoundingClientRect();
  const w = box.offsetWidth;
  const x = Math.max(8, Math.min(fr.width - w - 8, r.left - fr.left + frac * r.width - w / 2));
  box.style.left = x + 'px';
  pvLoad(); pvSeek(t);
}

function closePanels() { $('speedPanel').hidden = true; $('subPanel').hidden = true; }
const panelOpen = () => !$('speedPanel').hidden || !$('subPanel').hidden;

// ---------------- 音量 ----------------
// iPad・iPhone の Safari は、ページから動画の音量（video.volume）を変えられない（いつも最大のまま）
// そこで、動画の音を「音の通り道」（Web Audio）に通し、とちゅうの音量つまみ（gain）で小さくする
// 100% が iPad 本体の音量と同じ大きさ。本体の音量ボタンも、いつもどおり使える
let vol = loadJson('mp_vol', 1);
if (!(vol >= 0 && vol <= 1)) vol = 1;
let actx = null, gainNode = null;
function ensureAudio() {   // 指で操作したとき（再生ボタンなど）に呼ぶ。iPad は、そのときでないと音を出す準備ができない
  if (actx) { if (actx.state !== 'running') actx.resume().catch(() => { }); return; }
  if (vol >= 1 && !ensureAudio.need) return;   // 音量を変えたことがなければ、ふつうのまま再生する（いちばん安全）
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    // 消音スイッチ（サイレント）のときでも、動画の音が出るように
    if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (e) { } }
    actx = new AC();
    gainNode = actx.createGain();
    gainNode.gain.value = vol;
    actx.createMediaElementSource(video).connect(gainNode);
    gainNode.connect(actx.destination);
    if (actx.state !== 'running') actx.resume().catch(() => { });
  } catch (e) { actx = null; gainNode = null; }
}
function setVol(v, show) {
  vol = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
  saveJson('mp_vol', vol);
  ensureAudio.need = true;
  ensureAudio();
  if (gainNode) gainNode.gain.setTargetAtTime(vol, actx.currentTime, 0.02);
  else video.volume = vol;   // Web Audio が使えないブラウザ（iPad では効かない）
  if (show) showVol();
}
function showVol() {
  const pct = Math.round(vol * 100);
  $('volFill').style.height = pct + '%';
  $('volNum').textContent = pct === 0 ? '消音' : pct + '%';
  $('volMark').hidden = false;
  clearTimeout(showVol.timer); showVol.timer = setTimeout(() => { $('volMark').hidden = true; }, 900);
}
video.addEventListener('play', ensureAudio);
// iPad は、指をはなしたときでないと音の準備（resume）が効かないことがあるので、そのたびに確かめる
for (const n of ['touchend', 'click']) $('player').addEventListener(n, () => { if (actx && actx.state !== 'running') actx.resume().catch(() => { }); }, { capture: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden && actx && actx.state !== 'running') actx.resume().catch(() => { }); });

// 1本の指で上へなぞると音量を上げ、下へなぞると下げる（画面のどこでもよい）。画面の高さの半分で 0%→100%
let vs = null, volSwipeEnd = 0;
$('stage').addEventListener('touchstart', (ev) => {
  if (ev.touches.length !== 1) { vs = null; return; }
  const t = ev.touches[0];
  vs = { x: t.clientX, y: t.clientY, v: vol, on: false };
}, { passive: true });
$('stage').addEventListener('touchmove', (ev) => {
  if (!vs) return;
  if (ev.touches.length !== 1) { vs = null; return; }
  const t = ev.touches[0], dx = t.clientX - vs.x, dy = t.clientY - vs.y;
  if (!vs.on) {
    if (Math.abs(dy) < 14) return;
    if (Math.abs(dx) > Math.abs(dy)) { vs = null; return; }   // 横に動かしたときは、音量にしない
    vs.on = true; vs.y = t.clientY;
  }
  ev.preventDefault();
  setVol(vs.v - (t.clientY - vs.y) / (window.innerHeight * 0.5), true);
}, { passive: false });
$('stage').addEventListener('touchend', () => { if (vs && vs.on) volSwipeEnd = Date.now(); vs = null; });
$('stage').addEventListener('touchcancel', () => { if (vs && vs.on) volSwipeEnd = Date.now(); vs = null; });
// Windows：マウスのホイールでも音量を変えられる
$('player').addEventListener('wheel', (ev) => {
  if ($('player').hidden || panelOpen()) return;
  ev.preventDefault();
  setVol(vol + (ev.deltaY < 0 ? 0.05 : -0.05), true);
}, { passive: false });

// Windows：スペースで再生／一時停止、← → で10秒もどる／すすむ、↑ ↓ で音量、Esc で棚へ
document.addEventListener('keydown', (ev) => {
  if ($('player').hidden) return;
  if (ev.key === 'ArrowUp') { ev.preventDefault(); setVol(vol + 0.05, true); return; }
  if (ev.key === 'ArrowDown') { ev.preventDefault(); setVol(vol - 0.05, true); return; }
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
