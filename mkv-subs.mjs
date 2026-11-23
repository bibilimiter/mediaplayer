// MKV の中に入っている文字の字幕（SRT・ASS）を取り出す
// MKV は「名前・大きさ・中身」の箱が入れ子になった作り。字幕の箱だけを拾い、ほかの箱（映像・音声）は飛ばす
// 絵の字幕は、ブルーレイの PGS だけ取り出す（DVD の VobSub などは取り出せない）

const READ = 4 * 1024 * 1024;   // いちどに読む量
const ID = {
  SEGMENT: 0x18538067, INFO: 0x1549A966, SCALE: 0x2AD7B1, TRACKS: 0x1654AE6B, ENTRY: 0xAE, NUMBER: 0xD7,
  CODEC: 0x86, LANG: 0x22B59C, LANG_BCP: 0x22B59D, NAME: 0x536E, DEFAULT: 0x88, FORCED: 0x55AA, CODEC_PRIVATE: 0x63A2,
  ENCODINGS: 0x6D80, ENCODING: 0x6240, COMPRESSION: 0x5034, COMP_ALGO: 0x4254, COMP_SETTINGS: 0x4255,
  CLUSTER: 0x1F43B675, TIME: 0xE7, SIMPLE: 0xA3, GROUP: 0xA0, BLOCK: 0xA1, DURATION: 0x9B,
};
const TEXT_CODECS = ['S_TEXT/UTF8', 'S_TEXT/ASS', 'S_TEXT/SSA', 'S_ASS', 'S_SSA'];

class Reader {
  constructor(file) { this.file = file; this.start = 0; this.buf = new Uint8Array(0); }
  async need(pos, n) {
    if (pos >= this.start && pos + n <= this.start + this.buf.length) return true;
    if (pos >= this.file.size) return false;
    const end = Math.min(this.file.size, pos + Math.max(n, READ));
    this.buf = new Uint8Array(await this.file.slice(pos, end).arrayBuffer());
    this.start = pos;
    return pos + n <= end;
  }
  at(pos) { return this.buf[pos - this.start]; }
  bytes(pos, n) { return this.buf.subarray(pos - this.start, pos - this.start + n); }
}

// 箱の名前（ID）と大きさを読む。大きさがわからない箱は size = -1
async function head(r, pos) {
  if (!(await r.need(pos, 16))) { if (!(await r.need(pos, 2))) return null; }
  const vint = (p, keepMark) => {
    const b = r.at(p);
    if (b === undefined) return null;
    let len = 1, mask = 0x80;
    while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
    if (len > 8) return null;
    let v = keepMark ? b : (b & (mask - 1)), all1 = (b & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { const c = r.at(p + i); if (c === undefined) return null; v = v * 256 + c; if (c !== 0xFF) all1 = false; }
    return { v, len, all1 };
  };
  const id = vint(pos, true); if (!id) return null;
  const sz = vint(pos + id.len, false); if (!sz) return null;
  return { id: id.v, size: sz.all1 ? -1 : sz.v, data: pos + id.len + sz.len };
}
const uint = (b) => { let v = 0; for (const c of b) v = v * 256 + c; return v; };
const str = (b) => new TextDecoder().decode(b).replace(/\0+$/, '');

// 小さな箱（字幕の情報など）の中身を、子の箱の一覧にする
function children(b) {
  const out = [];
  let p = 0;
  while (p < b.length) {
    const v = (q, keep) => {
      const x = b[q]; if (x === undefined) return null;
      let len = 1, mask = 0x80;
      while (len <= 8 && !(x & mask)) { len++; mask >>= 1; }
      if (len > 8) return null;
      let val = keep ? x : (x & (mask - 1));
      for (let i = 1; i < len; i++) val = val * 256 + (b[q + i] || 0);
      return { val, len };
    };
    const id = v(p, true); if (!id) break;
    const sz = v(p + id.len, false); if (!sz) break;
    const d = p + id.len + sz.len;
    out.push({ id: id.val, body: b.subarray(d, d + sz.val) });
    p = d + sz.val;
  }
  return out;
}

function parseTracks(body) {
  const list = [];
  for (const e of children(body)) {
    if (e.id !== ID.ENTRY) continue;
    const t = { num: 0, codec: '', lang: '', name: '', def: false, forced: false, priv: '', comp: null };
    for (const c of children(e.body)) {
      if (c.id === ID.NUMBER) t.num = uint(c.body);
      else if (c.id === ID.CODEC) t.codec = str(c.body);
      else if (c.id === ID.LANG) t.lang = t.lang || str(c.body);
      else if (c.id === ID.LANG_BCP) t.lang = str(c.body);
      else if (c.id === ID.NAME) t.name = str(c.body);
      else if (c.id === ID.DEFAULT) t.def = !!uint(c.body);
      else if (c.id === ID.FORCED) t.forced = !!uint(c.body);
      else if (c.id === ID.CODEC_PRIVATE) t.priv = str(c.body);
      else if (c.id === ID.ENCODINGS) {
        // 字幕が縮めて（圧縮して）しまってあるとき：zlib（0）か、先頭を省いたもの（3）
        for (const en of children(c.body)) if (en.id === ID.ENCODING) for (const x of children(en.body)) if (x.id === ID.COMPRESSION) {
          const comp = { algo: 0, head: new Uint8Array(0) };
          for (const y of children(x.body)) { if (y.id === ID.COMP_ALGO) comp.algo = uint(y.body); else if (y.id === ID.COMP_SETTINGS) comp.head = y.body.slice(); }
          t.comp = comp;
        }
      }
    }
    list.push(t);
  }
  return list;
}

// ASS の1行（ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text）から文だけを取る
function assText(s) {
  let p = 0;
  for (let i = 0; i < 8 && p >= 0; i++) p = s.indexOf(',', p) + 1 || -1;
  if (p < 0) return s;
  return s.slice(p);
}
function cleanText(s, ass) {
  if (ass) s = assText(s).replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  return s.replace(/\r\n?/g, '\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}

async function unpack(b, comp) {
  if (!comp) return b;
  if (comp.algo === 3) { const o = new Uint8Array(comp.head.length + b.length); o.set(comp.head); o.set(b, comp.head.length); return o; }
  if (comp.algo === 0) return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  throw new Error('この縮め方の字幕は読めません');
}

// ---------------- 絵の字幕（PGS：ブルーレイの字幕） ----------------
// 1回分の字幕は「区切り」の並び：0x14 色の表、0x15 絵（縮めた点の並び）、0x16 どこに出すか、0x17 枠、0x80 おわり
// 絵は、出すときに速く出せるように、ここで PNG の画像にしておく
class Pgs {
  constructor() { this.palettes = new Map(); this.objects = new Map(); this.pcs = null; this.sets = []; this.cache = new Map(); }
  async push(t, b) {
    let p = 0;
    while (p + 3 <= b.length) {
      const type = b[p], size = (b[p + 1] << 8) | b[p + 2];
      const d = b.subarray(p + 3, p + 3 + size);
      p += 3 + size;
      if (type === 0x16) this.onPcs(t, d);
      else if (type === 0x14) this.onPds(d);
      else if (type === 0x15) this.onOds(d);
      else if (type === 0x80) await this.onEnd();
    }
  }
  onPcs(t, d) {
    const state = d[7];
    if (state & 0x80) { this.objects.clear(); this.palettes.clear(); this.cache.clear(); }   // 新しい区切りの始まり
    const pcs = { t, w: (d[0] << 8) | d[1], h: (d[2] << 8) | d[3], pal: d[9], objs: [] };
    let q = 11;
    for (let i = 0; i < d[10] && q + 8 <= d.length; i++) {
      const o = { id: (d[q] << 8) | d[q + 1], x: (d[q + 4] << 8) | d[q + 5], y: (d[q + 6] << 8) | d[q + 7], crop: null };
      if (d[q + 3] & 0x40) { o.crop = [(d[q + 8] << 8) | d[q + 9], (d[q + 10] << 8) | d[q + 11], (d[q + 12] << 8) | d[q + 13], (d[q + 14] << 8) | d[q + 15]]; q += 8; }
      q += 8;
      pcs.objs.push(o);
    }
    this.pcs = pcs;
  }
  onPds(d) {
    const id = d[0], ver = d[1];
    const pal = new Uint32Array(256);   // 書いていない色は、すきとおり
    const old = this.palettes.get(id);
    if (old) pal.set(old.c);
    for (let q = 2; q + 5 <= d.length; q += 5) {
      const y = d[q + 1], cr = d[q + 2] - 128, cb = d[q + 3] - 128, a = d[q + 4];
      const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
      const R = clamp(y + 1.5748 * cr), G = clamp(y - 0.1873 * cb - 0.4681 * cr), B = clamp(y + 1.8556 * cb);
      pal[d[q]] = ((a << 24) | (B << 16) | (G << 8) | R) >>> 0;   // 画素の並び（RGBA、リトルエンディアン）
    }
    this.palettes.set(id, { ver, c: pal });
  }
  onOds(d) {
    const id = (d[0] << 8) | d[1], ver = d[2], seq = d[3];
    if (seq & 0x80) {
      const len = (d[4] << 16) | (d[5] << 8) | d[6];
      const o = { ver, w: (d[7] << 8) | d[8], h: (d[9] << 8) | d[10], data: new Uint8Array(Math.max(0, len - 4)), n: 0 };
      this.objects.set(id, o);
      this.add(o, d.subarray(11));
    } else { const o = this.objects.get(id); if (o) this.add(o, d.subarray(4)); }
  }
  add(o, part) { const n = Math.min(part.length, o.data.length - o.n); o.data.set(part.subarray(0, n), o.n); o.n += n; }
  async onEnd() {
    const pcs = this.pcs; this.pcs = null;
    if (!pcs) return;
    const set = { s: pcs.t, w: pcs.w, h: pcs.h, items: [] };
    const pal = this.palettes.get(pcs.pal);
    for (const ob of pcs.objs) {
      const o = this.objects.get(ob.id);
      if (!o || !pal || !o.w || !o.h) continue;
      const key = ob.id + ':' + o.ver + ':' + pcs.pal + ':' + pal.ver + ':' + (ob.crop || '');
      let blob = this.cache.get(key);
      if (!blob) { blob = await this.draw(o, pal.c, ob.crop); if (blob) this.cache.set(key, blob); }
      if (blob) set.items.push({ x: ob.x, y: ob.y, w: ob.crop ? ob.crop[2] : o.w, h: ob.crop ? ob.crop[3] : o.h, blob });
    }
    this.sets.push(set);
  }
  // 縮めた点の並び（ランレングス）を、色の付いた画像にする
  async draw(o, pal, crop) {
    const px = new Uint32Array(o.w * o.h);
    const b = o.data;
    let i = 0, x = 0, y = 0;
    while (i < b.length && y < o.h) {
      let c = b[i++], n = 1;
      if (c === 0) {
        const f = b[i++];
        if (f === 0) { x = 0; y++; continue; }   // 行のおわり
        n = f & 0x3F;
        if (f & 0x40) n = (n << 8) | b[i++];
        c = f & 0x80 ? b[i++] : 0;
      }
      const v = pal[c], row = y * o.w;
      for (let k = 0; k < n && x < o.w; k++) px[row + x++] = v;
    }
    let w = o.w, h = o.h, sx = 0, sy = 0;
    if (crop) { [sx, sy, w, h] = crop; w = Math.min(w, o.w - sx); h = Math.min(h, o.h - sy); }
    if (w <= 0 || h <= 0) return null;
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(o.w, o.h) : Object.assign(document.createElement('canvas'), { width: o.w, height: o.h });
    const g = cv.getContext('2d');
    g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), o.w, o.h), 0, 0);
    let out = cv;
    if (crop) {
      out = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      out.getContext('2d').drawImage(cv, sx, sy, w, h, 0, 0, w, h);
    }
    return out.convertToBlob ? out.convertToBlob({ type: 'image/png' }) : new Promise((ok) => out.toBlob(ok, 'image/png'));
  }
  // 出す字幕の一覧：{ s: 始まり, e: 終わり（次の区切りまで）, w, h: 画面の大きさ, items: [{ x, y, w, h, blob }] }
  cues() {
    const sets = this.sets.sort((a, b) => a.s - b.s), out = [];
    sets.forEach((x, i) => {
      if (!x.items.length) return;
      const next = sets.slice(i + 1).find((y) => y.s > x.s);
      out.push({ s: x.s, e: next ? next.s : x.s + 5, w: x.w, h: x.h, items: x.items });
    });
    // 同じ絵が続くとき（出し直し）は1つにまとめる
    const merged = [];
    for (const c of out) {
      const p = merged[merged.length - 1];
      if (p && p.e >= c.s - 0.001 && p.items.length === c.items.length && p.items.every((it, k) => it.blob === c.items[k].blob && it.x === c.items[k].x && it.y === c.items[k].y)) p.e = c.e;
      else merged.push(c);
    }
    return merged;
  }
}

// もどり値：{ subs: 文字の字幕 [{ num, lang, name, def, forced, cues: [{ s, e, t }] }],
//            pics: 絵の字幕 [{ num, lang, name, def, forced, cues: [{ s, e, w, h, items }] }], images: 出せない絵の字幕の数 }
export async function extractSubs(file, onProgress) {
  const r = new Reader(file);
  let pos = 0, scale = 1e6, clusterTs = 0;
  let tracks = null, want = new Map(), lastCue = null, images = 0;
  let lastShown = 0;
  while (pos < file.size) {
    const h = await head(r, pos);
    if (!h) break;
    if (h.id === ID.SEGMENT || h.id === ID.CLUSTER || h.id === ID.GROUP) {
      // 入れ子の箱には入る（中身を順に読む）
      if (h.id === ID.CLUSTER && tracks && !want.size) break;   // 文字の字幕がない
      pos = h.data;
      if (pos - lastShown > 64 * 1024 * 1024 && onProgress) { lastShown = pos; onProgress(pos / file.size); }
      continue;
    }
    if (h.size < 0) break;   // 大きさのわからない箱（ふつうは無い）
    const end = h.data + h.size;
    if (h.id === ID.TRACKS || h.id === ID.INFO) {
      if (h.size > 16 * 1024 * 1024 || !(await r.need(h.data, h.size))) break;
      const body = r.bytes(h.data, h.size).slice();
      if (h.id === ID.INFO) { for (const c of children(body)) if (c.id === ID.SCALE) scale = uint(c.body) || 1e6; }
      else {
        tracks = parseTracks(body);
        for (const t of tracks) {
          if (TEXT_CODECS.includes(t.codec)) want.set(t.num, Object.assign(t, { ass: t.codec !== 'S_TEXT/UTF8', cues: [] }));
          else if (t.codec === 'S_HDMV/PGS') want.set(t.num, Object.assign(t, { pgs: new Pgs() }));
          else if (/^S_(HDMV|VOBSUB|DVBSUB|IMAGE)/.test(t.codec)) images++;
        }
      }
    } else if (h.id === ID.TIME) {
      if (await r.need(h.data, h.size)) clusterTs = uint(r.bytes(h.data, h.size));
    } else if ((h.id === ID.SIMPLE || h.id === ID.BLOCK) && want.size) {
      lastCue = null;
      if (await r.need(h.data, Math.min(h.size, 12))) {
        const b0 = r.at(h.data);
        let len = 1, mask = 0x80;
        while (len <= 8 && !(b0 & mask)) { len++; mask >>= 1; }
        let num = b0 & (mask - 1);
        for (let i = 1; i < len; i++) num = num * 256 + r.at(h.data + i);
        const t = want.get(num);
        if (t && h.size < 8 * 1024 * 1024 && (await r.need(h.data, h.size))) {
          let rel = (r.at(h.data + len) << 8) | r.at(h.data + len + 1);
          if (rel & 0x8000) rel -= 0x10000;
          const raw = await unpack(r.bytes(h.data + len + 3, h.size - len - 3).slice(), t.comp);
          const s = (clusterTs + rel) * scale / 1e9;
          if (t.pgs) await t.pgs.push(s, raw);
          else {
            const text = cleanText(new TextDecoder().decode(raw), t.ass);
            if (text) { lastCue = { s, e: -1, t: text }; t.cues.push(lastCue); }
          }
        }
      }
    } else if (h.id === ID.DURATION && lastCue) {
      if (await r.need(h.data, h.size)) lastCue.e = lastCue.s + uint(r.bytes(h.data, h.size)) * scale / 1e9;
    }
    pos = end;
  }
  const subs = [], pics = [];
  for (const t of want.values()) {
    if (t.pgs) {
      const cues = t.pgs.cues();
      if (cues.length) pics.push({ num: t.num, lang: t.lang, name: t.name, def: t.def, forced: t.forced, cues });
      continue;
    }
    t.cues.sort((a, b) => a.s - b.s);
    t.cues.forEach((c, i) => { if (c.e <= c.s) c.e = Math.min(c.s + 5, i + 1 < t.cues.length ? t.cues[i + 1].s : c.s + 5); });
    if (t.cues.length) subs.push({ num: t.num, lang: t.lang, name: t.name, def: t.def, forced: t.forced, cues: t.cues });
  }
  return { subs, pics, images };
}
