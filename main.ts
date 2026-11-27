// png-squeeze: losslessly recompress 1280x720 RGBA screenshots into the smallest PNG.
//
// Reads every instance under $MAKEFUN_INPUT_DIR (default /input) as <id>/image.png — a stored
// PNG, colour type 6, every row unfiltered — and writes the same image, pixel for pixel
// (including a fully transparent pixel's colour), as /output/<id>/image.png.
//
// How it squeezes:
//   1. Colour-type reduction, tried as competing candidates and the smallest kept:
//      a palette (colour type 3, with tRNS when any entry is transparent) when at
//      most 256 distinct colours occur — in two orders, by luminance and by
//      descending frequency — and the best non-palette type for the image: grey
//      (type 0) when every pixel is grey and opaque, grey+alpha (type 4) when grey
//      with varying alpha, RGB (type 2) when opaque but not grey, RGBA (type 6)
//      otherwise. A palette is not always the smallest: on a grey image with many
//      grey levels, frequency-ordered indices destroy the smoothness the filters
//      exploit, so every candidate is actually compressed and the smallest wins.
//   2. Per-scanline filter choice: every row is tried under all five PNG filters and
//      the one whose filtered bytes have the smallest sum of absolute (signed) values
//      wins (the minimum-sum heuristic), ties going to the lower filter type; the
//      winning colour type is also tried under fixed None, Sub, Up and Paeth, and
//      under the fewest-distinct-byte-pairs choice, which often beats minimum-sum on
//      photographic rows.
//   3. The filtered data is compressed at zlib level 9; for the winning colour type
//      the smallest of the tried encodings wins, including the filtered zlib
//      strategy on the minimum-sum data.
//   4. When the image has exactly one fully transparent value and every other pixel
//      is opaque, that value is keyed by tRNS instead of an alpha channel, so a
//      capture over a clean transparent background drops a whole channel.
// Everything is deterministic: no clock, no randomness, fixed iteration orders.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------- CRC-32 (PNG, ISO 3309) ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- PNG chunk writing ----------

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = colourType;
  return data;
}

// ---------- PNG decoding (the stored RGBA input) ----------

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || !SIGNATURE.every((b, i) => bytes[i] === b)) {
    return { ok: false, why: 'not a PNG' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      colourType = data[9];
      if (data[8] !== 8 || data[10] !== 0 || data[11] !== 0) return { ok: false, why: 'unsupported IHDR' };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (colourType !== 6) return { ok: false, why: 'input is not colour type 6' };
  const bpp = 4;
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      rgba.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (i >= bpp ? rgba[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) rgba[o + i] = raw[src + i] + (y > 0 ? rgba[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        rgba[o + i] = raw[src + i] + (((i >= bpp ? rgba[o + i - bpp] : 0) + (y > 0 ? rgba[p + i] : 0)) >> 1);
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? rgba[o + i - bpp] : 0;
        const b = y > 0 ? rgba[p + i] : 0;
        const c = y > 0 && i >= bpp ? rgba[p + i - bpp] : 0;
        rgba[o + i] = raw[src + i] + paethPredictor(a, b, c);
      }
    } else {
      return { ok: false, why: `row ${y} has filter type ${ft}` };
    }
  }
  return { ok: true, width, height, rgba };
}

// ---------- PNG filtering ----------

function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (prev ? prev[i] : 0)) & 0xff;
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      out[i] = (cur[i] - ((a + b) >> 1)) & 0xff;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      out[i] = (cur[i] - paethPredictor(a, b, c)) & 0xff;
    }
  }
}

// Sum of a filtered row's bytes read as signed values (-128..127), absolute.
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// The one fully transparent value (a grey level, or an RGB triple) the image may key
// by tRNS instead of an alpha channel: every non-opaque pixel is that exact value at
// alpha 0, and no opaque pixel holds that value. Null when there is none. This is a
// big win on captures over a clean transparent background: the image drops its alpha
// channel entirely and costs one tiny tRNS chunk instead.
function transparentKey(rgba, n, grey) {
  let key = -1;
  for (let p = 0; p < n * 4; p += 4) {
    const a = rgba[p + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[p] : (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let p = 0; p < n * 4; p += 4) {
    if (rgba[p + 3] !== 255) continue;
    const v = grey ? rgba[p] : (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------- Encoding one image ----------

// Analyse the pixels once: distinct colours (counted only up to 256), grey?, any alpha?
function analyse(rgba, n) {
  const colourCount = new Map();
  let grey = true;
  let hasAlpha = false;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const a = rgba[p + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) hasAlpha = true;
    if (colourCount.size <= 256) {
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      const entry = colourCount.get(key);
      if (entry) entry.count++;
      else colourCount.set(key, { count: 1, first: i });
    }
  }
  return { colourCount, grey, hasAlpha };
}

// mode 'fallback-trns': the best non-palette type with the image's single transparent
// value keyed by tRNS instead of an alpha channel (grey -> type 0, otherwise RGB);
// returns null when no such single transparent value exists.
function buildSamples(rgba, width, height, mode, info, trnsKey) {
  const n = width * height;
  const { colourCount, grey, hasAlpha } = info;
  if (mode === 'fallback-trns') {
    if (trnsKey === null || trnsKey === undefined) return null;
    if (grey) {
      const samples = new Uint8Array(n);
      for (let i = 0, p = 0; i < n; i++, p += 4) samples[i] = rgba[p];
      return { colourType: 0, bpp: 1, samples, palette: null, trns: Uint8Array.of(0, trnsKey) };
    }
    const samples = new Uint8Array(n * 3);
    for (let i = 0, p = 0, s = 0; i < n; i++, p += 4, s += 3) {
      samples[s] = rgba[p];
      samples[s + 1] = rgba[p + 1];
      samples[s + 2] = rgba[p + 2];
    }
    return {
      colourType: 2,
      bpp: 3,
      samples,
      palette: null,
      trns: Uint8Array.of(0, (trnsKey >>> 16) & 0xff, 0, (trnsKey >>> 8) & 0xff, 0, trnsKey & 0xff),
    };
  }
  if (mode === 'palette-value' || mode === 'palette-freq') {
    if (colourCount.size > 256) return null;
    const entries = [...colourCount.entries()].map(([key, v]) => ({ key, count: v.count, first: v.first }));
    if (mode === 'palette-value') {
      entries.sort((x, y) => {
        const lx = ((x.key >>> 24) & 0xff) * 299 + ((x.key >>> 16) & 0xff) * 587 + ((x.key >>> 8) & 0xff) * 114;
        const ly = ((y.key >>> 24) & 0xff) * 299 + ((y.key >>> 16) & 0xff) * 587 + ((y.key >>> 8) & 0xff) * 114;
        return lx - ly || x.key - y.key || x.first - y.first;
      });
    } else {
      entries.sort((x, y) => y.count - x.count || x.first - y.first);
    }
    const indexOf = new Map();
    entries.forEach((e, idx) => indexOf.set(e.key, idx));
    const palette = new Uint8Array(entries.length * 3);
    const alphas = new Uint8Array(entries.length);
    entries.forEach((e, idx) => {
      palette[idx * 3] = (e.key >>> 24) & 0xff;
      palette[idx * 3 + 1] = (e.key >>> 16) & 0xff;
      palette[idx * 3 + 2] = (e.key >>> 8) & 0xff;
      alphas[idx] = e.key & 0xff;
    });
    let lastNonOpaque = -1;
    for (let i = 0; i < alphas.length; i++) if (alphas[i] !== 255) lastNonOpaque = i;
    const trns = lastNonOpaque >= 0 ? alphas.subarray(0, lastNonOpaque + 1) : null;
    const samples = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const key = (rgba[p] << 24) | (rgba[p + 1] << 16) | (rgba[p + 2] << 8) | rgba[p + 3];
      samples[i] = indexOf.get(key);
    }
    return { colourType: 3, bpp: 1, samples, palette, trns };
  }
  if (grey && !hasAlpha) {
    const samples = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) samples[i] = rgba[p];
    return { colourType: 0, bpp: 1, samples, palette: null, trns: null };
  }
  if (grey) {
    const samples = new Uint8Array(n * 2);
    for (let i = 0, p = 0, s = 0; i < n; i++, p += 4, s += 2) {
      samples[s] = rgba[p];
      samples[s + 1] = rgba[p + 3];
    }
    return { colourType: 4, bpp: 2, samples, palette: null, trns: null };
  }
  if (!hasAlpha) {
    const samples = new Uint8Array(n * 3);
    for (let i = 0, p = 0, s = 0; i < n; i++, p += 4, s += 3) {
      samples[s] = rgba[p];
      samples[s + 1] = rgba[p + 1];
      samples[s + 2] = rgba[p + 2];
    }
    return { colourType: 2, bpp: 3, samples, palette: null, trns: null };
  }
  return { colourType: 6, bpp: 4, samples: rgba, palette: null, trns: null };
}

// How many distinct pairs of neighbouring bytes a filtered row holds: the
// fewest-pairs heuristic's cost. Rows whose filtered bytes repeat a small set of
// pairs compress well under LZ77, so this cost often picks better than the
// minimum-sum heuristic on photographic and noisy rows.
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Brute-force per-row filter choice: for each row, compress each of the five
// filtered trials with zlib level 4 using the preceding 32 KiB of filtered data
// as dictionary, and keep the filter whose trial compresses smallest. This is the
// choice the reference compressor screens; it usually beats the heuristics by a
// few percent on photographic rows, at the cost of five small compressions a row.
function filterBrute(samples, width, height, bpp) {
  const stride = width * bpp;
  const trial = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride + 1));
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[t][0] = t;
      filterRowInto(t, cur, prev, bpp, trial[t].subarray(1));
      const opts =
        before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before };
      const cost = deflateSync(trial[t], opts).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    filterRowInto(type, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

// Filter the rows of a sample buffer: 'minsum' picks, per row, the filter whose bytes
// have the smallest sum of absolute (signed) values; 'pairs' picks, per row, the
// filter whose bytes hold the fewest distinct neighbouring pairs; a number picks
// that filter for every row. Returns the raw scanline data (filter byte + filtered
// bytes per row).
function filterAll(samples, width, height, bpp, choose) {
  const stride = width * bpp;
  const trial = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const rowOut = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    let type;
    if (choose === 'minsum' || choose === 'pairs') {
      let best = Infinity;
      type = 0;
      for (let t = 0; t < 5; t++) {
        filterRowInto(t, cur, prev, bpp, trial[t]);
        const s = choose === 'minsum' ? signedSum(trial[t]) : pairsOf(trial[t], seen, ++stamp);
        if (s < best) {
          best = s;
          type = t;
        }
      }
      rowOut.set(trial[type]);
    } else {
      type = choose;
      filterRowInto(type, cur, prev, bpp, rowOut);
    }
    raw[y * (stride + 1)] = type;
  }
  return raw;
}

function encodeImage(rgba, width, height) {
  const n = width * height;
  const info = analyse(rgba, n);
  const trnsKey = info.hasAlpha ? transparentKey(rgba, n, info.grey) : null;

  // Phase 1: try every viable colour type with minimum-sum filtering, zlib level 9.
  const modes = info.colourCount.size <= 256 ? ['palette-value', 'palette-freq', 'fallback'] : ['fallback'];
  if (trnsKey !== null) modes.push('fallback-trns');
  let best = null;
  for (const mode of modes) {
    const cand = buildSamples(rgba, width, height, mode, info, trnsKey);
    if (cand === null) continue;
    const raw = filterAll(cand.samples, width, height, cand.bpp, 'minsum');
    const comp = deflateSync(raw, { level: 9 });
    if (best === null || comp.length < best.size) {
      best = { size: comp.length, cand, raw, comp };
    }
  }

  // Phase 2: for the winning colour type, try the other filter strategies — fixed
  // None, Sub and Up, the fewest-pairs choice, fixed Paeth and brute force per row —
  // and keep the smallest encoding overall. The filtered zlib strategy is then
  // tried on the three filtered datasets with the smallest plain-strategy sizes,
  // so no dataset's result under that strategy is hidden by a later winner.
  const minsumRaw = best.raw;
  const tried = [{ raw: minsumRaw, s0: best.size }];
  const extra = [0, 1, 2, 'pairs', 4];
  for (const choice of extra) {
    const raw = filterAll(best.cand.samples, width, height, best.cand.bpp, choice);
    const comp = deflateSync(raw, { level: 9 });
    tried.push({ raw, s0: comp.length });
    if (comp.length < best.size) {
      best = { size: comp.length, cand: best.cand, raw, comp };
    }
  }
  const rawBrute = filterBrute(best.cand.samples, width, height, best.cand.bpp);
  const compBrute = deflateSync(rawBrute, { level: 9 });
  tried.push({ raw: rawBrute, s0: compBrute.length });
  if (compBrute.length < best.size) {
    best = { size: compBrute.length, cand: best.cand, raw: rawBrute, comp: compBrute };
  }
  tried.sort((a, b) => a.s0 - b.s0);
  const seenRaws = new Set();
  for (const t of tried.slice(0, 3)) {
    if (seenRaws.has(t.raw)) continue;
    seenRaws.add(t.raw);
    const comp = deflateSync(t.raw, { level: 9, strategy: 1 });
    if (comp.length < best.size) {
      best = { size: comp.length, cand: best.cand, raw: t.raw, comp };
    }
  }

  const chunks = [['IHDR', ihdrOf(width, height, best.cand.colourType)]];
  if (best.cand.palette !== null) chunks.push(['PLTE', best.cand.palette]);
  if (best.cand.trns !== null) chunks.push(['tRNS', best.cand.trns]);
  chunks.push(['IDAT', new Uint8Array(best.comp)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------- Main: every instance in the input directory ----------

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'image.png'), encodeImage(image.rgba, image.width, image.height));
}
