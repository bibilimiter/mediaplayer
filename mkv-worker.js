// MKV を取りこむ係：中身（映像・音声）はそのままで、入れ物だけを MP4 に詰め替えて、端末の中へしまう
// 作り直し（変換）はしないので、画質は変わらない。少しずつ読んで書くので、大きなファイルでもメモリをあまり使わない
// 中に文字の字幕があれば、取り出して返す
import { Input, Output, Conversion, BlobSource, StreamTarget, Mp4OutputFormat, MATROSKA, WEBM } from './lib/mediabunny.min.mjs';
import { extractSubs } from './mkv-subs.mjs';

const VIDEO_OK = ['avc', 'hevc', 'av1', 'vp9'];
const AUDIO_NG = ['dts', 'truehd'];   // iPad では音が出ない
const NAMES = { avc: 'H.264', hevc: 'H.265', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', dts: 'DTS', truehd: 'TrueHD', vorbis: 'Vorbis' };
const nameOf = (c) => NAMES[c] || String(c || '不明').toUpperCase();
const fail = (msg, name) => Object.assign(new Error(msg), { name: name || 'Error' });

self.onmessage = async (ev) => {
  const { id, file } = ev.data;
  let dir = null, access = null;
  const notes = [];
  try {
    const root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle('videos', { create: true });
    const fh = await dir.getFileHandle(id, { create: true });
    if (!fh.createSyncAccessHandle) throw fail('この端末では MKV を取りこめません', 'NotSupportedError');
    access = await fh.createSyncAccessHandle();
    access.truncate(0);

    const input = new Input({ source: new BlobSource(file), formats: [MATROSKA, WEBM] });
    const vts = await input.getVideoTracks();
    const ats = await input.getAudioTracks();
    if (!vts.length) throw fail('映像が見つかりませんでした');
    const v = vts[0];
    if (!VIDEO_OK.includes(v.codec)) throw fail('映像の形式（' + nameOf(v.codec) + '）が iPad では再生できません。パソコンで MP4 に変えてから取りこんでください');
    const ngAudio = ats.filter((a) => AUDIO_NG.includes(a.codec));
    if (ats.length && ngAudio.length === ats.length) notes.push('音声の形式（' + nameOf(ats[0].codec) + '）が iPad では出せないため、音なしで取りこみました。');
    else if (ngAudio.length) notes.push('iPad で出せない音声（' + [...new Set(ngAudio.map((a) => nameOf(a.codec)))].join('・') + '）は、はぶきました。');

    const writable = new WritableStream({
      write(chunk) {
        let done = 0;
        while (done < chunk.data.byteLength) {
          const n = access.write(chunk.data.subarray(done), { at: chunk.position + done });
          if (!n) throw fail('書けませんでした', 'QuotaExceededError');
          done += n;
        }
      },
    });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new StreamTarget(writable) });
    const conv = await Conversion.init({
      input, output,
      video: (t) => (t === v ? {} : { discard: true }),   // 映像は1つだけ
      audio: (t) => (AUDIO_NG.includes(t.codec) ? { discard: true } : {}),
    });
    const lost = conv.discardedTracks.filter((d) => d.reason !== 'discarded_by_user');
    if (lost.some((d) => d.track === v) || !conv.isValid) throw fail('この MKV は詰め替えられませんでした（映像：' + nameOf(v.codec) + '）');
    for (const d of lost) if (d.track.type === 'audio') notes.push('音声（' + nameOf(d.track.codec) + '）は iPad で出せないため、はぶきました。');
    // 中身を作り直すことになる場合は、とても時間がかかるのでやめる
    if (conv.utilizedTracks && conv.utilizedTracks.length === 0) throw fail('この MKV は詰め替えられませんでした');
    conv.onProgress = (p) => self.postMessage({ id, stage: 'mux', progress: p });
    await conv.execute();
    access.flush();
    access.close(); access = null;

    // 文字の字幕を取り出す（失敗しても、動画の取りこみは続ける）
    let subs = [], images = 0;
    try {
      const r = await extractSubs(file, (p) => self.postMessage({ id, stage: 'subs', progress: p }));
      subs = r.subs; images = r.images;
    } catch (e) { notes.push('中の字幕は読めませんでした。'); }
    if (images && !subs.length) notes.push('中の字幕は絵の字幕のため、付けられませんでした（.srt の字幕ファイルなら付けられます）。');
    else if (images) notes.push('絵の字幕ははぶきました。');
    self.postMessage({ id, done: true, subs, notes });
  } catch (e) {
    try { if (access) access.close(); } catch (e2) { }
    try { if (dir) await dir.removeEntry(id); } catch (e2) { }
    self.postMessage({ id, error: { name: (e && e.name) || 'Error', message: (e && e.message) || String(e) } });
  }
};
