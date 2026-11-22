// MediaPlayer：動画（MP4）を端末の中に取りこんで再生する。iPad・Windows・Android のブラウザで動く（PWA）
'use strict';

// 再生／一時停止のマーク（絵文字だと iPad で色つきの四角になるので、自分で描く）
const ICON_PLAY = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const ICON_FOLDER = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6a2 2 0 0 1 2-2h4.6l2 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_FILM = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h16V6zm6 2.5 6 3.5-6 3.5z"/></svg>';
const ICON_DOTS = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
const ICON_PAUSE = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
// 版数は sw.js の VERSION の1か所だけで決める（棚の下には、しまってある画面の版数を出す）

const $ = (id) => document.getElementById(id);
const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;
const OTHER_VIDEO_RE = /\.(mkv|avi|wmv|flv|ts|m2ts|mts|mpg|mpeg|vob|iso|rmvb|3gp)$/i;   // iPad では再生できない形式
const SPACE_MARGIN = 200 * 1024 * 1024;   // 空きの目安から、念のため残しておく量
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
// Brave は、のぞき見を防ぐために「空きの目安」を本当より小さく（2GBほどに）出すことがある。
// そのため Brave では目安を使わず、実際に書いてみて、入らなければそこで止める
const braveP = (async () => { try { return !!(navigator.brave && await navigator.brave.isBrave()); } catch (e) { return false; } })();
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
    // 取りこむ前に、空きの目安を調べておく（大きな動画を最後まで書いてから「入らない」とならないように）
    let free = null;
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (est && est.quota && !(await braveP)) free = Math.max(0, est.quota - (est.usage || 0));
    } catch (e) { }
    const have = await dbAll('videos');
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const head = (files.length > 1 ? '（' + (i + 1) + '／' + files.length + '）' : '') + f.name;
      const show = (what, p) => {
        $('importBar').hidden = false;
        $('importText').textContent = what + '：' + head;
        $('importProg').style.width = Math.round(p * 100) + '%';
      };
      try {
        if (OTHER_VIDEO_RE.test(f.name)) throw new Error('この形式（' + f.name.replace(/^.*\./, '').toUpperCase() + '）は iPad では再生できません。パソコンで MP4 に変えてから取りこんでください');
        if (!VIDEO_RE.test(f.name) && !/^video\//.test(f.type)) throw new Error('動画ファイルではないようです');
        // 同じ動画（名前と大きさが同じ）が、もう入っていれば取りこまない
        const dup = have.concat(added).find((m) => m.file === f.name && m.size === f.size);
        if (dup) throw new Error('もう入っています（' + (dup.folder ? 'フォルダ「' + dup.folder + '」の中の ' : '') + '「' + dup.name + '」）');
        if (free != null && f.size > free - SPACE_MARGIN) {
          throw new Error('端末の空きが足りません（この動画 ' + fmtSize(f.size) + '、空きの目安 ' + (free - SPACE_MARGIN > 1048576 ? fmtSize(free - SPACE_MARGIN) : 'ほぼなし') + '）。見終わった動画を消すと空きができます');
        }
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
        if (free != null) free -= f.size;
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
  else cv.innerHTML = ICON_FILM;
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
    const pm = document.createElement('span'); pm.className = 'pmark'; pm.innerHTML = ICON_PLAY; cv.appendChild(pm);
    st.textContent = pos && m.duration ? 'あと ' + fmtTime(Math.max(0, m.duration - pos.t)) : '';
    p.append(st);
  } else {
    st.className = 'grow';
    st.textContent = (pos && !pos.done && pos.t > 0 ? fmtTime(pos.t) + ' から ・ ' : '') + fmtSize(m.size);
    const more = document.createElement('button'); more.className = 'btn dots'; more.innerHTML = ICON_DOTS;
    more.setAttribute('aria-label', '移す・消す'); more.title = '移す・消す';
    more.onclick = (ev) => { ev.stopPropagation(); openAct(m); };
    p.append(st, more);
  }
  card.append(cv, t, p);
  card.onclick = () => { if (card.held) { card.held = false; return; } openPlayer(m); };
  onLongPress(card, () => openAct(m));
  return card;
}
// 長押し（0.5秒）で fn を呼ぶ。なぞって動かしたときは、長押しにしない
function onLongPress(el, fn) {
  let timer = 0, sx = 0, sy = 0;
  el.addEventListener('pointerdown', (ev) => {
    el.held = false;
    if (ev.button) return;
    sx = ev.clientX; sy = ev.clientY;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; el.held = true; fn(); }, 500);
  });
  el.addEventListener('pointermove', (ev) => { if (timer && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) { clearTimeout(timer); timer = 0; } });
  for (const n of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(n, () => { clearTimeout(timer); timer = 0; });
  el.addEventListener('contextmenu', (ev) => ev.preventDefault());
}
// 動画の「…」や長押しで出る一覧：再生する・フォルダへ移す・消す
function openAct(m) {
  const pos = loadJson('mp_pos_' + m.id, null);
  $('actTitle').textContent = m.name;
  $('actInfo').textContent = [m.duration ? fmtTime(m.duration) : '', fmtSize(m.size), m.folder ? 'フォルダ「' + m.folder + '」' : '', pos && pos.done ? '見終わり' : ''].filter(Boolean).join(' ・ ');
  const close = () => { $('actDlg').hidden = true; };
  $('actPlay').onclick = () => { close(); openPlayer(m); };
  $('actMove').onclick = () => { close(); openMove(m); };
  $('actDel').onclick = async () => {
    close();
    if (!confirm('「' + m.name + '」を、この端末から消しますか？\n（もとのファイルは消えません）')) return;
    await deleteVideo(m);
    renderLibrary();
  };
  $('actDlg').hidden = false;
}
$('actClose').onclick = () => { $('actDlg').hidden = true; };
$('actDlg').addEventListener('click', (ev) => { if (ev.target === $('actDlg')) $('actDlg').hidden = true; });
// 動画を1本消す（中身・情報・覚えていることをすべて）
async function deleteVideo(m) {
  await deleteBody(m); await dbDel('videos', m.id);
  for (const k of ['mp_pos_', 'mp_sub_', 'mp_aud_', 'mp_bm_', 'mp_suboff_']) removeKey(k + m.id);
}
function folderCard(name, list) {
  const card = document.createElement('div');
  card.className = 'video folder';
  const cv = document.createElement('div');
  cv.className = 'cv';
  const withThumb = list.find((m) => m.thumb);
  if (withThumb) { const img = document.createElement('img'); img.src = withThumb.thumb; img.alt = ''; cv.appendChild(img); }
  const ic = document.createElement('span'); ic.className = 'fic'; ic.innerHTML = ICON_FOLDER; cv.appendChild(ic);
  const t = document.createElement('div'); t.className = 't'; t.textContent = name;
  const p = document.createElement('div'); p.className = 'p'; p.textContent = 'フォルダ ・ ' + list.length + ' 本';
  card.append(cv, t, p);
  card.onclick = () => { curFolder = name; renderLibrary(); window.scrollTo(0, 0); };
  return card;
}
// 並べ方：name 名前の順 / added 取りこんだ順（新しい順）/ recent 最近見た順 / size 大きい順
let sortMode = loadJson('mp_sort', 'name');
function sortVideos(list) {
  const a = list.slice();
  if (sortMode === 'added') a.sort((x, y) => (y.added || 0) - (x.added || 0));
  else if (sortMode === 'size') a.sort((x, y) => y.size - x.size);
  else if (sortMode === 'recent') {
    const at = (m) => (loadJson('mp_pos_' + m.id, null) || {}).at || 0;
    a.sort((x, y) => at(y) - at(x) || collator.compare(x.name, y.name));
  }
  return a;   // name は、読みこんだときに名前の順にしてある
}
$('sortSel').value = sortMode;
if ($('sortSel').value !== sortMode) { sortMode = 'name'; $('sortSel').value = 'name'; }
$('sortSel').onchange = () => { sortMode = $('sortSel').value; saveJson('mp_sort', sortMode); renderLibrary(); };
let searchTimer = 0;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderLibrary, 200); });
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
  const query = $('search').value.trim().toLowerCase();
  const sorted = sortVideos(metas);
  if (query) {
    // 名前で探しているときは、フォルダの中の動画もまとめて出す
    $('contWrap').hidden = true;
    if (!top) $('folderName').textContent = curFolder;
    for (const m of sorted) if (m.name.toLowerCase().includes(query) && (top || m.folder === curFolder)) { box.appendChild(videoCard(m)); shown++; }
  } else if (top) {
    // 続きを見る：途中まで見た動画を、最近見た順に
    const inprog = metas.map((m) => [m, loadJson('mp_pos_' + m.id, null)])
      .filter(([m, p]) => p && !p.done && p.t > 5).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 12);
    for (const [m] of inprog) $('contRow').appendChild(videoCard(m, true));
    $('contWrap').hidden = !inprog.length;
    for (const f of folders) { box.appendChild(folderCard(f, metas.filter((m) => m.folder === f))); shown++; }
    for (const m of sorted) if (!m.folder) { box.appendChild(videoCard(m)); shown++; }
  } else {
    $('contWrap').hidden = true;
    $('folderName').textContent = curFolder;
    for (const m of sorted) if (m.folder === curFolder) { box.appendChild(videoCard(m)); shown++; }
  }
  // 見終わった動画をまとめて消すボタン（棚のいちばん上ではすべて、フォルダの中ではそのフォルダだけ）
  const doneList = metas.filter((m) => (top || m.folder === curFolder) && (loadJson('mp_pos_' + m.id, null) || {}).done);
  $('cleanBtn').hidden = !doneList.length;
  $('cleanBtn').textContent = '見終わった ' + doneList.length + ' 本を消す（' + fmtSize(doneList.reduce((s, m) => s + m.size, 0)) + '）';
  $('cleanBtn').onclick = async () => {
    if (!confirm('見終わった動画 ' + doneList.length + ' 本を、この端末から消しますか？\n' + doneList.map((m) => '・' + m.name).join('\n') + '\n（もとのファイルは消えません）')) return;
    for (const m of doneList) { try { await deleteVideo(m); } catch (e) { } }
    renderLibrary();
  };
  // 動画が1本もないときは、真ん中に大きな「動画を取りこむ」を出す
  const empty = !metas.length && top && !query;
  $('emptyBox').hidden = !empty;
  $('libTools').hidden = !metas.length;
  $('libTip').hidden = !metas.length;
  $('libHint').hidden = shown > 0 || empty;
  $('libHint').textContent = query ? '「' + $('search').value.trim() + '」に合う動画はありません。'
    : 'このフォルダには、まだ動画がありません。\nここで「＋ 動画を取りこむ」を押すと、このフォルダに入ります。棚の動画の「…」→「フォルダへ移す」でも入れられます。';
  showStorage();
}
async function showStorage() {
  let text = '', frac = -1;
  const total = metas.reduce((s, m) => s + m.size, 0);
  if (metas.length) text = '動画 ' + metas.length + ' 本・合わせて ' + fmtSize(total);
  try {
    const e = await navigator.storage.estimate();
    if (await braveP) text += (text ? ' ／ ' : '') + 'Brave では空きの目安が出せません（入らないときは、取りこみの途中で止まります）';
    else if (e && e.quota) {
      text += (text ? ' ／ ' : '') + 'あと ' + fmtSize(Math.max(0, e.quota - (e.usage || 0))) + ' しまえます（目安）';
      frac = Math.max(0, Math.min(1, (e.usage || 0) / e.quota));
    }
  } catch (e) { }
  $('storage').textContent = text;
  $('storageBox').hidden = !text;
  $('storageBar').hidden = frac < 0;
  $('storageFill').style.width = (frac > 0 ? Math.max(1, frac * 100) : 0) + '%';
  $('storageBar').classList.toggle('full', frac > 0.9);   // 残りが少ないときは、色を変える
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
  for (const f of folders) add('フォルダ「' + f + '」', f, m.folder === f);
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
  if (locked) return;   // 画面ロック中は、ボタンを出さない
  $('player').classList.remove('hidectl');
  clearTimeout(hideTimer);
  if (!keep && !video.paused) hideTimer = setTimeout(() => { if (!video.paused && !seeking && !panelOpen()) $('player').classList.add('hidectl'); }, 3500);
}
function updatePlayBtn() { $('play').innerHTML = video.paused ? ICON_PLAY : ICON_PAUSE; $('play').setAttribute('aria-label', video.paused ? '再生' : '一時停止'); }
function updateTime() {
  const d = video.duration || (cur && cur.duration) || 0;
  $('timeNow').textContent = fmtTime(video.currentTime);
  $('timeAll').textContent = fmtTime(d);
  if (!seeking) { $('seek').value = d ? Math.round(video.currentTime / d * 1000) : 0; paintSeek(); }
  $('miniFill').style.transform = 'scaleX(' + (d ? Math.min(1, video.currentTime / d) : 0) + ')';
  // 残りの時間と、見終わる時刻（速さを変えているときは、その分も入れる）
  const left = d ? Math.max(0, d - video.currentTime) / (video.playbackRate || 1) : 0;
  let info = '';
  if (left > 0) {
    const end = new Date(Date.now() + left * 1000);
    info = 'あと ' + fmtLeft(left) + '・' + end.getHours() + ':' + String(end.getMinutes()).padStart(2, '0') + ' に終わる';
  }
  if ($('endInfo').textContent !== info) $('endInfo').textContent = info;
}
function fmtLeft(sec) {
  if (sec < 60) return '1分未満';
  const m = Math.round(sec / 60);
  return m >= 60 ? Math.floor(m / 60) + '時間' + (m % 60 ? (m % 60) + '分' : '') : m + '分';
}
// 位置のバーの、見た所までを白くぬる
function paintSeek() { $('seek').style.setProperty('--pf', $('seek').value / 1000); }
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
  subOff = Number(loadJson('mp_suboff_' + meta.id, 0)) || 0;
  renderBmMarks();
  const pos = loadJson('mp_pos_' + meta.id, null);
  const startAt = pos && !pos.done && pos.t > 5 ? pos.t : 0;
  video.src = curUrl;
  video.addEventListener('loadedmetadata', function f() {
    video.removeEventListener('loadedmetadata', f);
    video.defaultPlaybackRate = speed; video.playbackRate = speed;   // 動画を入れたあとに設定しないと 1.0 にもどる
    if (startAt && startAt < video.duration - 5) video.currentTime = startAt;
    updateTime();
    renderBmMarks();
    applySavedSub();
    const ai = loadJson('mp_aud_' + meta.id, null);
    if (ai != null) selectAudio(ai, false);
  });
  updatePlayBtn(); updateTime(); showCtl(true);
  if (!loadJson('mp_help_seen', false)) openHelp();   // はじめて再生するときだけ、操作の説明を出す
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
  $('helpDlg').hidden = true;
  setLock(false);
  setSleep(0);
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
  seeking = true; showCtl(true); paintSeek();
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
  // ボタンが消えているときは、すぐに出す（待たない）。出ているときは、2回目が来ないのを確かめてから消す
  if ($('player').classList.contains('hidectl')) { tapTimer = 0; showCtl(); return; }
  tapTimer = setTimeout(() => {
    tapTimer = 0;
    if (!video.paused) $('player').classList.add('hidectl');
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
let subSel = null, subShown = '', subRaf = 0, subOff = 0;
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
// 動画の中の字幕も、ずれ直しができるように、文の一覧を自分で読む
function trackCues(track) {
  try {
    if (!track || !track.cues || !track.cues.length) return null;
    if (track._mpCues && track._mpCues.n === track.cues.length) return track._mpCues.list;
    const list = Array.from(track.cues).map((x) => ({ s: x.startTime, e: x.endTime, t: String(x.text || '').replace(/<[^>]+>/g, '') }))
      .sort((x, y) => x.s - y.s);
    track._mpCues = { n: track.cues.length, list };
    return list;
  } catch (e) { return null; }
}
function renderSub() {
  let text = '';
  const cues = subSel && (subSel.cues || trackCues(subSel.track));
  if (cues) {
    const c = cues, t = video.currentTime - subOff;   // subOff が＋なら、字幕をおそく出す
    let lo = 0, hi = c.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (c[mid].s <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    const on = [];
    for (let i = k; i >= 0 && i > k - 4; i--) if (c[i].e > t) on.unshift(c[i].t);   // 重なっている字幕も出す
    text = on.join('\n');
  } else if (subSel && subSel.track && subSel.track.activeCues) {   // 文の一覧が読めないとき（ずれ直しは効かない）
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
  $('subOffBox').hidden = !subSel;
  $('subOffVal').textContent = (subOff > 0 ? '＋' : subOff < 0 ? '−' : '') + Math.abs(subOff).toFixed(1) + '秒' + (subOff > 0 ? '（おそく）' : subOff < 0 ? '（はやく）' : '');
  $('compBtn').textContent = '小さな音を聞きやすく：' + (comp ? 'オン' : 'オフ');
  $('compBtn').className = 'btn' + (comp ? ' primary' : '');
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
// 字幕のずれ直し：動画ごとに覚える
function moveSubOff(d) {
  subOff = d == null ? 0 : Math.round((subOff + d) * 10) / 10;
  if (cur) { if (subOff) saveJson('mp_suboff_' + cur.id, subOff); else removeKey('mp_suboff_' + cur.id); }
  subShown = null; renderSub(); buildSubPanel();
}
$('subOffMinus').onclick = (ev) => { ev.stopPropagation(); moveSubOff(-0.1); };
$('subOffPlus').onclick = (ev) => { ev.stopPropagation(); moveSubOff(0.1); };
$('subOffMinus1').onclick = (ev) => { ev.stopPropagation(); moveSubOff(-1); };
$('subOffPlus1').onclick = (ev) => { ev.stopPropagation(); moveSubOff(1); };
$('subOffReset').onclick = (ev) => { ev.stopPropagation(); moveSubOff(null); };
$('compBtn').onclick = (ev) => { ev.stopPropagation(); setComp(!comp); buildSubPanel(); flashMark('小さな音を聞きやすく：' + (comp ? 'オン' : 'オフ')); };
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

// ---------------- 操作の説明 ----------------
function openHelp() { closePanels(); $('helpDlg').hidden = false; showCtl(true); }
function closeHelp() { $('helpDlg').hidden = true; saveJson('mp_help_seen', true); showCtl(); }
$('helpBtn').onclick = (ev) => { ev.stopPropagation(); openHelp(); };
$('helpOk').onclick = (ev) => { ev.stopPropagation(); closeHelp(); };
$('helpDlg').addEventListener('click', (ev) => { ev.stopPropagation(); if (ev.target === $('helpDlg')) closeHelp(); });
for (const n of ['touchstart', 'touchmove', 'touchend']) $('helpDlg').addEventListener(n, (ev) => ev.stopPropagation(), { passive: true });

const PANELS = ['speedPanel', 'subPanel', 'timerPanel', 'bmPanel', 'morePanel'];
// 「その他」：画面ロック・しおり・スリープタイマーなどをまとめた一覧
$('moreBtn').onclick = (ev) => { ev.stopPropagation(); togglePanel('morePanel', () => { }); };
$('morePanel').addEventListener('click', (ev) => ev.stopPropagation());
for (const id of ['pipBtn', 'airBtn', 'fullBtn']) $(id).addEventListener('click', () => { closePanels(); showCtl(); });
function closePanels() { for (const p of PANELS) $(p).hidden = true; }
const panelOpen = () => PANELS.some((p) => !$(p).hidden);
function togglePanel(id, build) {
  const open = $(id).hidden;
  closePanels();
  if (open) { build(); $(id).hidden = false; showCtl(true); } else showCtl();
}

// ---------------- 画面ロック ----------------
// ロック中は、画面をさわっても何も起きない。鍵のマークを長押し（0.8秒）すると解除
let locked = false, lockHold = 0, lockBadgeTimer = 0;
function setLock(on) {
  locked = !!on;
  $('lockLayer').hidden = !locked;
  if (locked) {
    closePanels(); $('player').classList.add('hidectl');
    showLockBadge();
  } else {
    $('lockBadge').hidden = true; clearTimeout(lockHold); $('lockBadge').classList.remove('hold');
  }
}
function showLockBadge() {
  $('lockBadge').hidden = false;
  clearTimeout(lockBadgeTimer);
  lockBadgeTimer = setTimeout(() => { if (!$('lockBadge').classList.contains('hold')) $('lockBadge').hidden = true; }, 2500);
}
// 下の進み具合バー：ボタンをかくしている間も、画面のいちばん下に細いバーで、どこまで見たかを出す（オン／オフを覚えておく）
let miniOn = loadJson('mp_minibar', true) !== false;
function setMini(on) {
  miniOn = !!on; saveJson('mp_minibar', miniOn);
  $('player').classList.toggle('minion', miniOn);
  $('miniState').textContent = miniOn ? 'オン' : 'オフ';
}
setMini(miniOn);
$('miniBtn').onclick = (ev) => { ev.stopPropagation(); setMini(!miniOn); flashMark('下の進み具合バー：' + (miniOn ? 'オン' : 'オフ')); };
$('lockBtn').onclick = (ev) => { ev.stopPropagation(); setLock(true); };
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
  $('lockLayer').addEventListener(n, (ev) => {
    ev.stopPropagation();
    if (ev.cancelable && !$('lockBadge').contains(ev.target)) ev.preventDefault();
    if (n === 'touchstart' && $('lockBadge').hidden) showLockBadge();
  }, { passive: false });
}
$('lockLayer').addEventListener('click', (ev) => { ev.stopPropagation(); if ($('lockBadge').hidden) showLockBadge(); });
$('lockLayer').addEventListener('contextmenu', (ev) => ev.preventDefault());
$('lockBadge').addEventListener('pointerdown', (ev) => {
  ev.stopPropagation();
  $('lockBadge').classList.add('hold');
  clearTimeout(lockHold);
  lockHold = setTimeout(() => { setLock(false); showCtl(); flashMark('ロックを解除しました'); }, 800);
});
for (const n of ['pointerup', 'pointerleave', 'pointercancel']) {
  $('lockBadge').addEventListener(n, () => { clearTimeout(lockHold); $('lockBadge').classList.remove('hold'); if (locked) showLockBadge(); });
}

// ---------------- スリープタイマー ----------------
// 分を選ぶと、その時間がたったら止める。「この動画の終わり」は、終わりまで見たら止める（棚にはもどらない）
let sleepAt = 0, sleepEnd = false, sleepTick = 0;
const SLEEP_LIST = [[0, 'オフ'], [15, '15分'], [30, '30分'], [45, '45分'], [60, '60分'], [90, '90分'], ['end', 'この動画の終わり']];
function setSleep(v) {
  clearInterval(sleepTick); sleepTick = 0;
  sleepAt = 0; sleepEnd = false;
  if (v === 'end') sleepEnd = true;
  else if (v > 0) { sleepAt = Date.now() + v * 60000; sleepTick = setInterval(checkSleep, 1000); }
  showSleep();
}
function checkSleep() {
  if (sleepAt && Date.now() >= sleepAt) {
    video.pause();
    setSleep(0);
    flashMark('タイマーで止めました');
  } else showSleep();
}
function showSleep() {
  const on = !!(sleepAt || sleepEnd);
  $('timerChip').hidden = !on;   // タイマーが動いている間は、上に残りの時間を出す
  $('timerState').textContent = on ? 'オン' : '';
  $('timerLeft').textContent = sleepEnd ? '終わりで' : sleepAt ? Math.max(1, Math.ceil((sleepAt - Date.now()) / 60000)) + '分' : '';
  $('timerNow').textContent = sleepEnd ? 'この動画の終わりで止めます' : sleepAt ? 'あと ' + fmtTime((sleepAt - Date.now()) / 1000) + ' で止めます' : '';
}
function buildTimerPanel() {
  const box = $('timerList');
  box.textContent = '';
  for (const [v, label] of SLEEP_LIST) {
    const b = document.createElement('button');
    const isOn = v === 'end' ? sleepEnd : v === 0 ? !sleepAt && !sleepEnd : false;
    b.className = 'btn' + (isOn ? ' primary' : '');
    b.textContent = label;
    if (v === 'end') b.style.gridColumn = 'span 3';
    b.onclick = (ev) => { ev.stopPropagation(); setSleep(v); closePanels(); showCtl(); flashMark(v === 0 ? 'タイマー：オフ' : 'タイマー：' + label + (v === 'end' ? 'で止める' : '後に止める')); };
    box.appendChild(b);
  }
  showSleep();
}
$('timerBtn').onclick = (ev) => { ev.stopPropagation(); togglePanel('timerPanel', buildTimerPanel); };
$('timerChip').onclick = (ev) => { ev.stopPropagation(); togglePanel('timerPanel', buildTimerPanel); };
$('timerPanel').addEventListener('click', (ev) => ev.stopPropagation());
video.addEventListener('ended', () => { if (sleepEnd) { setSleep(0); flashMark('タイマーで止めました'); } });
// うしろに回っている間は時計が止まることがあるので、もどったときにも確かめる
document.addEventListener('visibilitychange', () => { if (!document.hidden && sleepAt) checkSleep(); });

// ---------------- しおり ----------------
// 動画ごとに mp_bm_<id> = [秒, 秒, ...]
const getBms = () => (cur ? loadJson('mp_bm_' + cur.id, []) : []).filter((t) => typeof t === 'number').sort((a, b) => a - b);
function saveBms(list) { if (!cur) return; if (list.length) saveJson('mp_bm_' + cur.id, list); else removeKey('mp_bm_' + cur.id); renderBmMarks(); }
function renderBmMarks() {
  const box = $('bmMarks');
  box.textContent = '';
  const d = video.duration || (cur && cur.duration) || 0;
  if (!d) return;
  for (const t of getBms()) { const i = document.createElement('i'); i.style.left = Math.min(100, t / d * 100) + '%'; box.appendChild(i); }
}
function buildBmPanel() {
  $('bmAdd').textContent = '＋ いまの場面（' + fmtTime(video.currentTime) + '）に しおりを付ける';
  const list = $('bmList');
  list.textContent = '';
  const bms = getBms();
  if (!bms.length) { const p = document.createElement('div'); p.className = 'small tnow'; p.textContent = 'まだ しおりはありません。'; list.appendChild(p); }
  for (const t of bms) {
    const row = document.createElement('div'); row.className = 'bmrow';
    const go = document.createElement('button'); go.className = 'btn'; go.textContent = fmtTime(t) + ' へ移る';
    go.onclick = (ev) => { ev.stopPropagation(); video.currentTime = t; updateTime(); closePanels(); showCtl(); };
    const del = document.createElement('button'); del.className = 'btn del'; del.textContent = '外す';
    del.onclick = (ev) => { ev.stopPropagation(); saveBms(getBms().filter((x) => x !== t)); buildBmPanel(); };
    row.append(go, del); list.appendChild(row);
  }
}
$('bmAdd').onclick = (ev) => {
  ev.stopPropagation();
  const t = Math.round(video.currentTime * 10) / 10;
  const bms = getBms();
  if (!bms.some((x) => Math.abs(x - t) < 2)) bms.push(t);
  saveBms(bms); buildBmPanel(); flashMark('しおり：' + fmtTime(t));
};
$('bmBtn').onclick = (ev) => { ev.stopPropagation(); togglePanel('bmPanel', buildBmPanel); };
$('bmPanel').addEventListener('click', (ev) => ev.stopPropagation());

// ---------------- 音量 ----------------
// iPad・iPhone の Safari は、ページから動画の音量（video.volume）を変えられない（いつも最大のまま）
// そこで、動画の音を「音の通り道」（Web Audio）に通し、とちゅうの音量つまみ（gain）で小さくする
// 100% が iPad 本体の音量と同じ大きさ。本体の音量ボタンも、いつもどおり使える
let vol = loadJson('mp_vol', 1);
if (!(vol >= 0 && vol <= 1)) vol = 1;
let actx = null, gainNode = null, srcNode = null, compNode = null, makeupNode = null;
// 小さな音を聞きやすく：大きい音をおさえ、全体を持ち上げる（音の通り道に「圧縮」の部品をはさむ）
let comp = !!loadJson('mp_comp', false);
function routeAudio() {
  if (!srcNode) return;
  try {
    srcNode.disconnect();
    if (comp) {
      if (!compNode) {
        compNode = actx.createDynamicsCompressor();
        compNode.threshold.value = -40; compNode.knee.value = 20; compNode.ratio.value = 8;
        compNode.attack.value = 0.005; compNode.release.value = 0.3;
        makeupNode = actx.createGain(); makeupNode.gain.value = 2.2;
        compNode.connect(makeupNode); makeupNode.connect(gainNode);
      }
      srcNode.connect(compNode);
    } else srcNode.connect(gainNode);
  } catch (e) { }
}
function setComp(on) {
  comp = !!on; saveJson('mp_comp', comp);
  ensureAudio.need = true;
  ensureAudio();
  routeAudio();
}
function ensureAudio() {   // 指で操作したとき（再生ボタンなど）に呼ぶ。iPad は、そのときでないと音を出す準備ができない
  if (actx) { if (actx.state !== 'running') actx.resume().catch(() => { }); return; }
  if (vol >= 1 && !comp && !ensureAudio.need) return;   // 音量も聞こえ方も変えていなければ、ふつうのまま再生する（いちばん安全）
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    // 消音スイッチ（サイレント）のときでも、動画の音が出るように
    if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (e) { } }
    actx = new AC();
    gainNode = actx.createGain();
    gainNode.gain.value = vol;
    srcNode = actx.createMediaElementSource(video);
    gainNode.connect(actx.destination);
    routeAudio();
    if (actx.state !== 'running') actx.resume().catch(() => { });
  } catch (e) { actx = null; gainNode = null; srcNode = null; }
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
  if ($('player').hidden || panelOpen() || locked) return;
  ev.preventDefault();
  setVol(vol + (ev.deltaY < 0 ? 0.05 : -0.05), true);
}, { passive: false });

// Windows：スペースで再生／一時停止、← → で10秒もどる／すすむ、↑ ↓ で音量、Esc で棚へ
document.addEventListener('keydown', (ev) => {
  if ($('player').hidden || locked) return;
  if (!$('helpDlg').hidden) { if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); closeHelp(); } return; }
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
// 版数：sw.js がしまった入れ物の名前（mp-v11 など）から出す
function showVersion() {
  if (!window.caches) return;
  caches.keys().then((ks) => {
    const v = ks.filter((k) => /^mp-v\d+$/.test(k)).sort((a, b) => b.slice(4) - a.slice(4))[0];
    if (v) $('ver').textContent = 'MediaPlayer ' + v.slice(3);
  }).catch(() => { });
}
showVersion();
if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', showVersion);
// iPad の Safari で開いているときは、ホーム画面から使うようにお知らせする（Safari のままだと、しばらく使わないと動画が消えることがある）
if (appleTouch && !isStandalone()) $('homeBar').hidden = false;
$('homeClose').onclick = () => { $('homeBar').hidden = true; };
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
renderLibrary().catch((e) => showMsg('棚を開けませんでした：' + errText(e)));
