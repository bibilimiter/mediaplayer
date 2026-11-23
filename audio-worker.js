// 音声を切り替える係（パソコンのブラウザ用）
// Brave・Chrome などは、動画に入っている音声を自分で切り替えられない。
// そこで、選んだ音声だけを入れた動画（中身はそのまま）を、端末の中の一時的な場所に作り、それに差し替える
import { Input, Output, Conversion, BlobSource, StreamTarget, Mp4OutputFormat, ALL_FORMATS } from './lib/mediabunny.min.mjs';

const TMP = '_audio_tmp';

self.onmessage = async (ev) => {
  const { cmd, file, index } = ev.data;
  let access = null;
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const ats = await input.getAudioTracks();
    if (cmd === 'list') {
      self.postMessage({ list: ats.map((t) => ({ lang: t.languageCode || '', name: t.name || '', codec: t.codec || '' })) });
      return;
    }
    const want = ats[index];
    if (!want) throw new Error('その音声が見つかりません');
    const vts = await input.getVideoTracks();
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('videos', { create: true });
    const fh = await dir.getFileHandle(TMP, { create: true });
    access = await fh.createSyncAccessHandle();
    access.truncate(0);
    const writable = new WritableStream({
      write(chunk) {
        let done = 0;
        while (done < chunk.data.byteLength) {
          const n = access.write(chunk.data.subarray(done), { at: chunk.position + done });
          if (!n) throw Object.assign(new Error('端末の空きが足りません'), { name: 'QuotaExceededError' });
          done += n;
        }
      },
    });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable) });
    const conv = await Conversion.init({
      input, output,
      video: (t) => (t === vts[0] ? {} : { discard: true }),
      audio: (t) => (t === want ? {} : { discard: true }),
    });
    if (!conv.isValid || conv.discardedTracks.some((d) => d.track === want || d.track === vts[0])) throw new Error('この音声には切り替えられませんでした');
    conv.onProgress = (p) => self.postMessage({ progress: p });
    await conv.execute();
    access.flush(); access.close(); access = null;
    self.postMessage({ done: true, name: TMP });
  } catch (e) {
    try { if (access) access.close(); } catch (e2) { }
    self.postMessage({ error: (e && e.message) || String(e) });
  }
};
