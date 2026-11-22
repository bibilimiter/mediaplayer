// MediaPlayer のサービスワーカー：画面の部品をしまっておき、ネットがなくても開けるようにする
// 画面の部品を直したときは、VERSION の数を上げる（新しいものに入れかわる）。アプリの版数はここだけで決める（棚の下にも出る）
const VERSION = 'mp-v19';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'store-worker.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// ネットにつながっていれば新しいものを使い、つながらなければしまっておいたものを使う
// 電波が弱い所で起動が遅くならないように、3秒で返事がなければ、しまっておいたものを使う（新しいものは、うしろで受け取っておく）
const WAIT_MS = 3000;
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== location.origin) return;
  const req = new Request(e.request, { cache: 'no-cache' });
  const net = fetch(req).then((r) => {
    if (r.ok) { const cp = r.clone(); return caches.open(VERSION).then((c) => c.put(e.request, cp)).catch(() => { }).then(() => r); }
    return r;
  });
  e.waitUntil(net.catch(() => { }));
  const cached = () => caches.match(e.request, { ignoreSearch: true });
  e.respondWith((async () => {
    // ネットにつながっていないとわかっているときは、待たずにしまっておいたものを使う
    if (self.navigator && self.navigator.onLine === false) { const c = await cached(); if (c) return c; }
    let timer = 0;
    const slow = new Promise((ok) => { timer = setTimeout(ok, WAIT_MS); });
    try {
      const r = await Promise.race([net, slow]);
      if (r) return r;
      const c = await cached();   // 3秒たっても返事がない
      if (c) return c;
      return await net;
    } catch (err) {
      const c = await cached();
      if (c) return c;
      throw err;
    } finally { clearTimeout(timer); }
  })());
});
