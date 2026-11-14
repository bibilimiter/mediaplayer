// 動画の中身を、端末の中のしまう所（ブラウザ専用の入れ物）へ少しずつ写す係
// 動画は大きいので、いちどに全部をメモリにのせず、8MB ずつ読んで書く
'use strict';
const CHUNK = 8 * 1024 * 1024;

self.onmessage = async (ev) => {
  const { id, file } = ev.data;
  let dir = null, access = null;
  try {
    const root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle('videos', { create: true });
    const fh = await dir.getFileHandle(id, { create: true });
    if (!fh.createSyncAccessHandle) throw Object.assign(new Error('この書き方は使えません'), { name: 'NotSupportedError' });
    access = await fh.createSyncAccessHandle();
    access.truncate(0);
    let off = 0;
    while (off < file.size) {
      const buf = await file.slice(off, Math.min(file.size, off + CHUNK)).arrayBuffer();
      let done = 0;
      while (done < buf.byteLength) {
        const n = access.write(new Uint8Array(buf, done), { at: off + done });
        if (!n) throw Object.assign(new Error('書けませんでした'), { name: 'QuotaExceededError' });
        done += n;
      }
      off += buf.byteLength;
      self.postMessage({ id, progress: off / file.size });
    }
    access.flush();
    access.close(); access = null;
    self.postMessage({ id, done: true });
  } catch (e) {
    try { if (access) access.close(); } catch (e2) { }
    try { if (dir) await dir.removeEntry(id); } catch (e2) { }
    self.postMessage({ id, error: { name: (e && e.name) || 'Error', message: (e && e.message) || String(e) } });
  }
};
