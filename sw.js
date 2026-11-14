// MediaPlayer のサービスワーカー：画面の部品をしまっておき、ネットがなくても開けるようにする
// 画面の部品を直したときは、VERSION の数を上げる（新しいものに入れかわる）
const VERSION = 'mp-v4';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'store-worker.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// ネットにつながっていれば新しいものを使い、つながらなければしまっておいたものを使う
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== location.origin) return;
  const req = new Request(e.request, { cache: 'no-cache' });
  e.respondWith(
    fetch(req).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
