// Raster to vector tracing. Pure functions with no DOM access, so this runs
// inside the Web Worker (trace.worker.ts) and keeps phones responsive.
//
// Pipeline:
//   1. optional blur, then reduce the image to a few labels (k-means colours,
//      or a light/dark threshold)
//   2. merge specks smaller than `minArea` into their neighbours
//   3. walk the borders between labels on the pixel-corner grid, splitting
//      them into chains that run from one junction to the next
//   4. simplify and smooth each chain once, so neighbouring shapes share the
//      exact same edge and no gaps open up between colours
//   5. fill mode joins chains into closed outlines per colour; line mode
//      strokes the chains themselves

export type Mode = 'color' | 'bw' | 'line';
export type Background = 'original' | 'transparent' | 'white' | 'black';

export interface TraceOptions {
  mode: Mode;
  /** Palette size for colour and line modes, 2–32. */
  colors: number;
  /** Light/dark cut-off for black & white mode, 0–255; null picks one automatically. */
  threshold: number | null;
  /** Blur radius in trace pixels before reducing colours, 0–4. */
  blur: number;
  /** Edge-preserving texture smoothing before reducing colours, 0–100. */
  denoise: number;
  /** Shapes smaller than this many trace pixels merge into their neighbours. */
  minArea: number;
  /** How far, in trace pixels, a simplified edge may stray from the pixel edge. */
  simplify: number;
  /** 0 keeps every corner sharp, 1 rounds almost everything into curves. */
  smooth: number;
  /** Line mode stroke width in trace pixels. */
  lineWidth: number;
  /** Line mode: trace dark ink strokes, or the borders between colour areas. */
  lineSource: 'ink' | 'borders';
  /** Ink lines: how much darker than its surroundings a stroke must be, 0–100. */
  inkSensitivity: number;
  /** Ink lines: widest stroke picked up, in trace pixels. */
  inkWidth: number;
  /** Ink lines: also draw borders between different colour families, 0 (off) – 100 (most). */
  hueBorders: number;
  /** Line mode: keep the colour fills under the lines. */
  lineFill: boolean;
  background: Background;
  /** Shape colour in black & white mode, and line colour in line mode. */
  ink: string;
  /** Width and height attributes written on the SVG (the viewBox is the trace grid). */
  outWidth: number;
  outHeight: number;
}

export interface TraceInput {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface TraceResult {
  svg: string;
  /** Number of <path> outlines or line chains written. */
  shapes: number;
  /** Colours actually used in the output. */
  palette: string[];
}

export type Progress = (stage: string) => void;

const OUTSIDE = -1;

// ---------------------------------------------------------------------------
// 1. Colour reduction

function boxBlur(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  if (r <= 0) return src;
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  const pass = (from: Uint8ClampedArray, to: Uint8ClampedArray, horizontal: boolean) => {
    const lines = horizontal ? h : w;
    const len = horizontal ? w : h;
    const step = horizontal ? 4 : w * 4;
    const sums = [0, 0, 0, 0];
    for (let line = 0; line < lines; line++) {
      const base = horizontal ? line * w * 4 : line * 4;
      sums[0] = sums[1] = sums[2] = sums[3] = 0;
      // Window [i - r, i + r], clamped at the ends.
      for (let k = -r; k <= r; k++) {
        const idx = base + Math.min(len - 1, Math.max(0, k)) * step;
        for (let c = 0; c < 4; c++) sums[c] += from[idx + c];
      }
      const div = 2 * r + 1;
      for (let i = 0; i < len; i++) {
        const o = base + i * step;
        for (let c = 0; c < 4; c++) to[o + c] = sums[c] / div;
        const add = base + Math.min(len - 1, i + r + 1) * step;
        const sub = base + Math.max(0, i - r) * step;
        for (let c = 0; c < 4; c++) sums[c] += from[add + c] - from[sub + c];
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return out;
}

/**
 * Edge-preserving smoothing (a bilateral filter). Each pixel becomes a
 * weighted average of nearby pixels, but neighbours with a very different
 * colour get almost no weight. Grain and paper texture flatten out while
 * outlines and colour edges stay sharp, unlike a plain blur.
 */
function bilateral(src: Uint8ClampedArray, w: number, h: number, radius: number, sigmaR: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const sigmaS = Math.max(1, radius / 1.5);
  const offs: number[] = [];
  const sw: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius + radius) continue;
      offs.push(dx, dy);
      sw.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS)));
    }
  }
  // Range weights by squared colour distance, in steps of 16.
  const lut = new Float32Array(Math.ceil((3 * 255 * 255) / 16) + 1);
  for (let i = 0; i < lut.length; i++) lut[i] = Math.exp(-(i * 16) / (2 * sigmaR * sigmaR));
  const k = sw.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const r0 = src[o];
      const g0 = src[o + 1];
      const b0 = src[o + 2];
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let wt = 0;
      for (let j = 0; j < k; j++) {
        const xx = x + offs[j * 2];
        const yy = y + offs[j * 2 + 1];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = (yy * w + xx) * 4;
        const dr = src[q] - r0;
        const dg = src[q + 1] - g0;
        const db = src[q + 2] - b0;
        const wgt = sw[j] * lut[(dr * dr + dg * dg + db * db) >> 4];
        sr += src[q] * wgt;
        sg += src[q + 1] * wgt;
        sb += src[q + 2] * wgt;
        sa += src[q + 3] * wgt;
        wt += wgt;
      }
      out[o] = sr / wt;
      out[o + 1] = sg / wt;
      out[o + 2] = sb / wt;
      out[o + 3] = sa / wt;
    }
  }
  return out;
}

/** Texture smoothing level 0–100 → repeated bilateral passes, scaled to the trace size. */
function smoothTexture(src: Uint8ClampedArray, w: number, h: number, level: number): Uint8ClampedArray {
  if (level <= 0) return src;
  const t = level / 100;
  // A fixed small radius keeps the cost in check at high detail; extra passes
  // reach further instead.
  const radius = 2 + Math.round(2 * t);
  const sigmaR = 12 + 28 * t; // how different a colour may be and still blend
  const passes = 1 + Math.round(3 * t);
  let px = src;
  for (let i = 0; i < passes; i++) px = bilateral(px, w, h, radius, sigmaR);
  return px;
}

/** Small deterministic PRNG so the same settings always give the same SVG. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) => {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return 3 * dr * dr + 4 * dg * dg + 2 * db * db;
};

/** k-means on a sample of opaque pixels. Returns palette as flat [r, g, b, …]. */
function kmeans(px: Uint8ClampedArray, k: number): number[] {
  const n = px.length / 4;
  const random = rng(1234567);
  const MAX_SAMPLES = 40000;
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(n / MAX_SAMPLES));
  for (let i = 0; i < n; i += stride) {
    const j = Math.min(n - 1, i + Math.floor(random() * stride));
    if (px[j * 4 + 3] >= 128) sample.push(px[j * 4], px[j * 4 + 1], px[j * 4 + 2]);
  }
  const m = sample.length / 3;
  if (m === 0) return [];

  // k-means++ seeding.
  const centers: number[] = [];
  const first = Math.floor(random() * m) * 3;
  centers.push(sample[first], sample[first + 1], sample[first + 2]);
  const best = new Float64Array(m).fill(Infinity);
  while (centers.length / 3 < k) {
    const c = centers.length - 3;
    let total = 0;
    for (let i = 0; i < m; i++) {
      const d = dist2(sample[i * 3], sample[i * 3 + 1], sample[i * 3 + 2], centers[c], centers[c + 1], centers[c + 2]);
      if (d < best[i]) best[i] = d;
      total += best[i];
    }
    if (total === 0) break; // fewer distinct colours than k
    let target = random() * total;
    let pick = m - 1;
    for (let i = 0; i < m; i++) {
      target -= best[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centers.push(sample[pick * 3], sample[pick * 3 + 1], sample[pick * 3 + 2]);
  }

  const kk = centers.length / 3;
  const assign = new Int32Array(m);
  for (let iter = 0; iter < 16; iter++) {
    const sums = new Float64Array(kk * 4);
    let moved = 0;
    for (let i = 0; i < m; i++) {
      const r = sample[i * 3];
      const g = sample[i * 3 + 1];
      const b = sample[i * 3 + 2];
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < kk; c++) {
        const d = dist2(r, g, b, centers[c * 3], centers[c * 3 + 1], centers[c * 3 + 2]);
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      if (assign[i] !== bi) moved++;
      assign[i] = bi;
      sums[bi * 4] += r;
      sums[bi * 4 + 1] += g;
      sums[bi * 4 + 2] += b;
      sums[bi * 4 + 3]++;
    }
    for (let c = 0; c < kk; c++) {
      const cnt = sums[c * 4 + 3];
      if (cnt > 0) {
        centers[c * 3] = sums[c * 4] / cnt;
        centers[c * 3 + 1] = sums[c * 4 + 1] / cnt;
        centers[c * 3 + 2] = sums[c * 4 + 2] / cnt;
      }
    }
    if (iter > 0 && moved < m * 0.002) break;
  }
  return centers.map(Math.round);
}

interface Labelled {
  labels: Int16Array;
  /** Flat [r, g, b, …] per label. The transparent label has no entry. */
  palette: number[];
  /** Label used for transparent pixels (equals palette length / 3). */
  clear: number;
}

function quantizeColors(px: Uint8ClampedArray, w: number, h: number, k: number): Labelled {
  const palette = kmeans(px, k);
  const kk = palette.length / 3;
  const clear = kk;
  const labels = new Int16Array(w * h);
  // Cache nearest-colour lookups on a 15-bit colour key.
  const cache = new Int16Array(32768).fill(-1);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (px[o + 3] < 128 || kk === 0) {
      labels[i] = clear;
      continue;
    }
    const key = ((px[o] >> 3) << 10) | ((px[o + 1] >> 3) << 5) | (px[o + 2] >> 3);
    let l = cache[key];
    if (l < 0) {
      let bd = Infinity;
      l = 0;
      for (let c = 0; c < kk; c++) {
        const d = dist2(px[o], px[o + 1], px[o + 2], palette[c * 3], palette[c * 3 + 1], palette[c * 3 + 2]);
        if (d < bd) {
          bd = d;
          l = c;
        }
      }
      cache[key] = l;
    }
    labels[i] = l;
  }
  return { labels, palette, clear };
}

function otsu(hist: Float64Array): number {
  let total = 0;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sumAll += i * hist[i];
  }
  let sumB = 0;
  let wB = 0;
  let bestT = 128;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) {
      bestVar = v;
      bestT = t;
    }
  }
  return bestT + 0.5;
}

/** Label 0 = dark, 1 = light, 2 = transparent. Returns the threshold used. */
function quantizeBW(px: Uint8ClampedArray, w: number, h: number, threshold: number | null): Labelled & { threshold: number } {
  const n = w * h;
  const lum = new Uint8Array(n);
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    lum[i] = Math.round(0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]);
    if (px[o + 3] >= 128) hist[lum[i]]++;
  }
  const t = threshold ?? otsu(hist);
  const labels = new Int16Array(n);
  for (let i = 0; i < n; i++) labels[i] = px[i * 4 + 3] < 128 ? 2 : lum[i] < t ? 0 : 1;
  return { labels, palette: [0, 0, 0, 255, 255, 255], clear: 2, threshold: Math.round(t) };
}

/** Max (grow = true) or min filter over a square of side 2r + 1, done as two 1-D passes. */
function rankFilter(src: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const pick = grow ? Math.max : Math.min;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = src[row + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[row + k]);
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Ink lines: label 0 = stroke, 1 = paper, 2 = transparent. A morphological
 * closing paints over dark features narrower than the window; the difference
 * from the original (a "black top-hat") is large only on thin dark strokes.
 * Wide dark areas, soft shading and the rims of highlights stay untouched,
 * so lighting doesn't turn into outlines.
 */
function quantizeInk(px: Uint8ClampedArray, w: number, h: number, maxWidth: number, sensitivity: number): Labelled {
  const n = w * h;
  const lum = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Transparent pixels count as white paper.
    const a = px[o + 3] / 255;
    lum[i] = Math.round((0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]) * a + 255 * (1 - a));
  }
  const r = Math.max(1, Math.round(maxWidth / 2));
  const closed = rankFilter(rankFilter(lum, w, h, r, true), w, h, r, false);
  const thr = 64 - 0.5 * sensitivity; // 64 … 14 levels darker than the surroundings
  const labels = new Int16Array(n);
  for (let i = 0; i < n; i++) labels[i] = px[i * 4 + 3] < 128 ? 2 : closed[i] - lum[i] > thr ? 0 : 1;
  return { labels, palette: [0, 0, 0, 255, 255, 255], clear: 2 };
}

// ---------------------------------------------------------------------------
// 2. Speck removal

/**
 * Hands each pixel to its neighbours' label when fewer than 4 of the 9 pixels
 * around it share its own. This dissolves the one-pixel bands of in-between
 * colour that anti-aliasing leaves along edges, which would otherwise trace as
 * slivers and double lines.
 */
function dissolveThin(labels: Int16Array, w: number, h: number, nLabels: number) {
  const src = labels.slice();
  const counts = new Int32Array(nLabels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const own = src[i];
      let same = 0;
      counts.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const l = src[yy * w + xx];
          if (l === own) same++;
          else counts[l]++;
        }
      }
      if (same >= 4) continue;
      let best = own;
      let bestN = same;
      for (let k = 0; k < nLabels; k++) {
        if (counts[k] > bestN) {
          bestN = counts[k];
          best = k;
        }
      }
      labels[i] = best;
    }
  }
}

function despeckle(labels: Int16Array, w: number, h: number, nLabels: number, minArea: number) {
  if (minArea <= 1) return;
  const n = w * h;
  const comp = new Int32Array(n);
  const stack = new Int32Array(n);
  const counts = new Int32Array(nLabels);
  for (let pass = 0; pass < 3; pass++) {
    comp.fill(-1);
    const seeds: number[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < n; i++) {
      if (comp[i] >= 0) continue;
      const c = seeds.length;
      const l = labels[i];
      let sp = 0;
      let size = 0;
      stack[sp++] = i;
      comp[i] = c;
      while (sp > 0) {
        const p = stack[--sp];
        size++;
        const x = p % w;
        if (x > 0 && comp[p - 1] < 0 && labels[p - 1] === l) (comp[p - 1] = c), (stack[sp++] = p - 1);
        if (x < w - 1 && comp[p + 1] < 0 && labels[p + 1] === l) (comp[p + 1] = c), (stack[sp++] = p + 1);
        if (p >= w && comp[p - w] < 0 && labels[p - w] === l) (comp[p - w] = c), (stack[sp++] = p - w);
        if (p < n - w && comp[p + w] < 0 && labels[p + w] === l) (comp[p + w] = c), (stack[sp++] = p + w);
      }
      seeds.push(i);
      sizes.push(size);
    }

    let changed = false;
    const order = sizes.map((_, i) => i).filter((c) => sizes[c] < minArea);
    order.sort((a, b) => sizes[a] - sizes[b]);
    for (const c of order) {
      const seed = seeds[c];
      const l = labels[seed];
      // A neighbouring merge may already have absorbed this component.
      if (comp[seed] !== c) continue;
      counts.fill(0);
      let sp = 0;
      let len = 0;
      // Collect the component's pixels into the front of `stack`.
      stack[len++] = seed;
      comp[seed] = -2;
      while (sp < len) {
        const p = stack[sp++];
        const x = p % w;
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1];
        for (const q of nb) {
          if (q < 0) continue;
          if (labels[q] === l) {
            if (comp[q] === c) {
              comp[q] = -2;
              stack[len++] = q;
            }
          } else counts[labels[q]]++;
        }
      }
      let bestL = -1;
      let bestN = 0;
      for (let k = 0; k < nLabels; k++) {
        if (counts[k] > bestN) {
          bestN = counts[k];
          bestL = k;
        }
      }
      if (bestL >= 0) {
        for (let i = 0; i < len; i++) labels[stack[i]] = bestL;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

// ---------------------------------------------------------------------------
// 3. Border chains on the pixel-corner grid

interface Chain {
  /** Integer corner coordinates [x0, y0, x1, y1, …]. */
  pts: number[];
  left: number;
  right: number;
  closed: boolean;
  startNode: number;
  endNode: number;
  /** Simplified geometry, filled in step 4. */
  geo?: Geometry;
}

function buildChains(labels: Int16Array, w: number, h: number): Chain[] {
  const W1 = w + 1;
  const lab = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? OUTSIDE : labels[y * w + x]);
  // 0 = no border, 1 = border not yet walked, 2 = walked.
  const hE = new Uint8Array(w * (h + 1)); // edge from corner (x,y) to (x+1,y)
  const vE = new Uint8Array(W1 * h); // edge from corner (x,y) to (x,y+1)
  for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) if (lab(x, y - 1) !== lab(x, y)) hE[y * w + x] = 1;
  for (let y = 0; y < h; y++) for (let x = 0; x <= w; x++) if (lab(x - 1, y) !== lab(x, y)) vE[y * W1 + x] = 1;

  // Directions: 0 = east, 1 = south, 2 = west, 3 = north.
  const edgeIdx = (x: number, y: number, d: number): [Uint8Array, number] | null => {
    switch (d) {
      case 0:
        return x < w ? [hE, y * w + x] : null;
      case 2:
        return x > 0 ? [hE, y * w + x - 1] : null;
      case 1:
        return y < h ? [vE, y * W1 + x] : null;
      default:
        return y > 0 ? [vE, (y - 1) * W1 + x] : null;
    }
  };
  const state = (x: number, y: number, d: number) => {
    const e = edgeIdx(x, y, d);
    return e ? e[0][e[1]] : 0;
  };
  const degree = (x: number, y: number) => {
    let n = 0;
    for (let d = 0; d < 4; d++) if (state(x, y, d)) n++;
    return n;
  };
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const sides = (x: number, y: number, d: number): [number, number] => {
    switch (d) {
      case 0:
        return [lab(x, y - 1), lab(x, y)];
      case 1:
        return [lab(x, y), lab(x - 1, y)];
      case 2:
        return [lab(x - 1, y), lab(x - 1, y - 1)];
      default:
        return [lab(x - 1, y - 1), lab(x, y - 1)];
    }
  };

  const chains: Chain[] = [];
  const walk = (x0: number, y0: number, d0: number) => {
    const [left, right] = sides(x0, y0, d0);
    const pts = [x0, y0];
    let x = x0;
    let y = y0;
    let d = d0;
    for (;;) {
      const e = edgeIdx(x, y, d)!;
      e[0][e[1]] = 2;
      x += DX[d];
      y += DY[d];
      pts.push(x, y);
      if (degree(x, y) !== 2) break;
      let next = -1;
      for (let nd = 0; nd < 4; nd++) if (state(x, y, nd) === 1) next = nd;
      if (next < 0) break; // back at the start of a closed loop
      d = next;
    }
    // A loop through a junction stays "open" so its ends stay pinned to that junction.
    const closed = x === x0 && y === y0 && degree(x0, y0) === 2;
    chains.push({ pts, left, right, closed, startNode: y0 * W1 + x0, endNode: y * W1 + x });
  };

  // Chains that start and end at junctions (three or four borders meet).
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      if (degree(x, y) < 3) continue;
      for (let d = 0; d < 4; d++) if (state(x, y, d) === 1) walk(x, y, d);
    }
  }
  // Whatever is left is a closed loop with no junction on it.
  for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) if (hE[y * w + x] === 1) walk(x, y, 0);
  for (let y = 0; y < h; y++) for (let x = 0; x <= w; x++) if (vE[y * W1 + x] === 1) walk(x, y, 1);
  return chains;
}

// ---------------------------------------------------------------------------
// 4. Simplify and smooth

interface Geometry {
  /** Vertices [x0, y0, …]. Closed chains repeat the first vertex at the end. */
  p: number[];
  /** Per segment [c1x, c1y, c2x, c2y], or NaN for a straight line. */
  c: number[];
}

/** Collapse unit steps into runs, then put vertices at run midpoints to undo the pixel staircase. */
function destair(pts: number[], closed: boolean): number[] {
  // Run vertices: keep points where the direction changes.
  const v: number[] = [];
  const n = pts.length / 2;
  const dirAt = (i: number) => {
    const j = closed ? (i + 1) % (n - 1) : i + 1;
    return (pts[j * 2] - pts[i * 2]) * 3 + (pts[j * 2 + 1] - pts[i * 2 + 1]);
  };
  if (closed) {
    const m = n - 1; // last point repeats the first
    for (let i = 0; i < m; i++) {
      const prev = dirAt((i - 1 + m) % m);
      if (dirAt(i) !== prev) v.push(pts[i * 2], pts[i * 2 + 1]);
    }
  } else {
    v.push(pts[0], pts[1]);
    for (let i = 1; i < n - 1; i++) if (dirAt(i) !== dirAt(i - 1)) v.push(pts[i * 2], pts[i * 2 + 1]);
    v.push(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
  }

  const out: number[] = [];
  const runs = closed ? v.length / 2 : v.length / 2 - 1;
  if (!closed) out.push(v[0], v[1]);
  for (let r = 0; r < runs; r++) {
    const ax = v[r * 2];
    const ay = v[r * 2 + 1];
    const b = closed ? ((r + 1) % (v.length / 2)) * 2 : (r + 1) * 2;
    const bx = v[b];
    const by = v[b + 1];
    const len = Math.abs(bx - ax) + Math.abs(by - ay);
    const dx = Math.sign(bx - ax) * 0.5;
    const dy = Math.sign(by - ay) * 0.5;
    if (len <= 1) out.push((ax + bx) / 2, (ay + by) / 2);
    else out.push(ax + dx, ay + dy, bx - dx, by - dy);
  }
  if (!closed) out.push(v[v.length - 2], v[v.length - 1]);
  return out;
}

/** Ramer–Douglas–Peucker between fixed anchors a and b (inclusive), iterative. */
function rdp(p: number[], a: number, b: number, tol: number, keep: Uint8Array, force: boolean) {
  const stack: number[] = [a, b];
  let first = force;
  const tol2 = tol * tol;
  while (stack.length) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    if (j - i < 2) continue;
    const ax = p[i * 2];
    const ay = p[i * 2 + 1];
    const dx = p[j * 2] - ax;
    const dy = p[j * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let bestD = -1;
    let bestK = -1;
    for (let k = i + 1; k < j; k++) {
      const px = p[k * 2] - ax;
      const py = p[k * 2 + 1] - ay;
      let d: number;
      if (len2 === 0) d = px * px + py * py;
      else {
        const cross = px * dy - py * dx;
        d = (cross * cross) / len2;
      }
      if (d > bestD) {
        bestD = d;
        bestK = k;
      }
    }
    if (bestD > tol2 || first) {
      first = false;
      keep[bestK] = 1;
      stack.push(i, bestK, bestK, j);
    }
  }
}

function simplifyPoints(q: number[], closed: boolean, tol: number): number[] {
  const n = q.length / 2;
  if (!closed) {
    if (n <= 2) return q;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    rdp(q, 0, n - 1, tol, keep, false);
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(q[i * 2], q[i * 2 + 1]);
    return out;
  }
  // Closed: anchor at point 0 and the point farthest from it, and always keep
  // one extra point per half so tiny loops don't collapse to a line.
  const ring = q.concat([q[0], q[1]]);
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (q[i * 2] - q[0]) ** 2 + (q[i * 2 + 1] - q[1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  rdp(ring, 0, far, tol, keep, true);
  rdp(ring, far, n, tol, keep, true);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) if (keep[i]) out.push(ring[i * 2], ring[i * 2 + 1]);
  return out;
}

function smoothGeometry(p: number[], closed: boolean, smooth: number, tol: number): Geometry {
  const n = p.length / 2; // closed: last == first
  const segs = n - 1;
  const c: number[] = new Array(segs * 4).fill(NaN);
  if (smooth <= 0 || segs < 1) return { p, c };
  const maxTurn = smooth * ((140 * Math.PI) / 180);
  const cornerK = 8 * Math.max(tol, 0.5) * (1 + 3 * smooth);
  const verts = closed ? n - 1 : n;
  // Unit tangent per vertex, or null for a corner.
  const tan: ([number, number] | null)[] = new Array(n).fill(null);
  for (let i = 0; i < verts; i++) {
    let prev: number;
    let next: number;
    if (closed) {
      prev = (i - 1 + verts) % verts;
      next = (i + 1) % verts;
    } else {
      if (i === 0 || i === n - 1) continue; // chain ends sit on junctions: keep them as corners
      prev = i - 1;
      next = i + 1;
    }
    let ax = p[i * 2] - p[prev * 2];
    let ay = p[i * 2 + 1] - p[prev * 2 + 1];
    let bx = p[next * 2] - p[i * 2];
    let by = p[next * 2 + 1] - p[i * 2 + 1];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (!la || !lb) continue;
    ax /= la;
    ay /= la;
    bx /= lb;
    by /= lb;
    const turn = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by)));
    if (turn > maxTurn) continue;
    // On a traced curve, turn × segment length stays near 8 × tolerance. A
    // turn between two long straight edges is far above that: a real corner.
    if (turn * Math.min(la, lb) > cornerK) continue;
    const tx = ax + bx;
    const ty = ay + by;
    const lt = Math.hypot(tx, ty);
    if (lt) tan[i] = [tx / lt, ty / lt];
  }
  if (closed) tan[n - 1] = tan[0];
  const k = 0.36;
  const segLen = (s: number) => {
    if (s < 0 || s >= segs) {
      if (!closed) return Infinity;
      s = (s + segs) % segs;
    }
    return Math.hypot(p[s * 2 + 2] - p[s * 2], p[s * 2 + 3] - p[s * 2 + 1]);
  };
  for (let s = 0; s < segs; s++) {
    const t0 = tan[s];
    const t1 = tan[s + 1];
    if (!t0 && !t1) continue;
    const x0 = p[s * 2];
    const y0 = p[s * 2 + 1];
    const x1 = p[s * 2 + 2];
    const y1 = p[s * 2 + 3];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / (len || 1);
    const uy = (y1 - y0) / (len || 1);
    const [ax, ay] = t0 ?? [ux, uy];
    const [bx, by] = t1 ?? [ux, uy];
    // Cap each handle by the neighbouring segment's length, so a long edge next
    // to a short one doesn't bulge out.
    const h0 = Math.min(len, 2 * segLen(s - 1)) * k;
    const h1 = Math.min(len, 2 * segLen(s + 1)) * k;
    c[s * 4] = x0 + ax * h0;
    c[s * 4 + 1] = y0 + ay * h0;
    c[s * 4 + 2] = x1 - bx * h1;
    c[s * 4 + 3] = y1 - by * h1;
  }
  return { p, c };
}

/**
 * Destair cuts every pixel corner by half a pixel. Where a short cut sits
 * between two long edges that turn sharply, put the true corner back so
 * squares stay square instead of being rounded off by the smoothing.
 */
function restoreCorners(p: number[], closed: boolean): number[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < p.length; i += 2) pts.push([p[i], p[i + 1]]);
  if (closed) pts.pop(); // work on the ring without the repeated point
  const n = pts.length;
  if (n < 4) return p;
  const at = (i: number) => pts[closed ? ((i % n) + n) % n : i];
  const drop = new Uint8Array(n);
  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 3; // segment i runs from pts[i] to pts[i + 1]
  for (let i = first; i <= last; i++) {
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const d = at(i + 2);
    if (drop[((i % n) + n) % n] || drop[(((i + 1) % n) + n) % n]) continue;
    const cut = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (cut > 1.5) continue;
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(d[0] - c[0], d[1] - c[1]);
    if (l1 < 2 * cut || l2 < 2 * cut) continue;
    const ux = (b[0] - a[0]) / l1;
    const uy = (b[1] - a[1]) / l1;
    const vx = (d[0] - c[0]) / l2;
    const vy = (d[1] - c[1]) / l2;
    const cross = ux * vy - uy * vx;
    if (Math.abs(cross) < Math.sin(Math.PI / 3)) continue; // turn under 60 degrees: leave it
    // Intersect line a→b with line c→d.
    const t = ((c[0] - b[0]) * vy - (c[1] - b[1]) * vx) / cross;
    const x = b[0] + ux * t;
    const y = b[1] + uy * t;
    if (Math.hypot(x - (b[0] + c[0]) / 2, y - (b[1] + c[1]) / 2) > 1.5) continue;
    b[0] = x;
    b[1] = y;
    drop[((i + 1) % n + n) % n] = 1;
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!drop[i]) out.push(pts[i][0], pts[i][1]);
  if (closed) out.push(out[0], out[1]);
  return out.length >= (closed ? 8 : 4) ? out : p;
}

function chainGeometry(ch: Chain, tol: number, smooth: number): Geometry {
  const q = destair(ch.pts, ch.closed);
  const p = restoreCorners(simplifyPoints(q, ch.closed, tol), ch.closed);
  return smoothGeometry(p, ch.closed, smooth, tol);
}

// ---------------------------------------------------------------------------
// 5. SVG output

const num = (v: number) => {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Path commands for a chain, without the leading move. */
function segments(g: Geometry, reverse: boolean): string {
  const { p, c } = g;
  const segs = p.length / 2 - 1;
  let s = '';
  for (let i = 0; i < segs; i++) {
    const seg = reverse ? segs - 1 - i : i;
    const end = reverse ? seg : seg + 1;
    const ex = num(p[end * 2]);
    const ey = num(p[end * 2 + 1]);
    if (Number.isNaN(c[seg * 4])) s += `L${ex} ${ey}`;
    else if (reverse) s += `C${num(c[seg * 4 + 2])} ${num(c[seg * 4 + 3])} ${num(c[seg * 4])} ${num(c[seg * 4 + 1])} ${ex} ${ey}`;
    else s += `C${num(c[seg * 4])} ${num(c[seg * 4 + 1])} ${num(c[seg * 4 + 2])} ${num(c[seg * 4 + 3])} ${ex} ${ey}`;
  }
  return s;
}

function startPoint(g: Geometry, reverse: boolean): string {
  const i = reverse ? g.p.length / 2 - 1 : 0;
  return `M${num(g.p[i * 2])} ${num(g.p[i * 2 + 1])}`;
}

/** Closed outlines for every region of `label`, joined from the chains bordering it. */
function regionPath(chains: Chain[], label: number): string {
  interface Ref {
    ch: Chain;
    rev: boolean;
    used: boolean;
  }
  const byStart = new Map<number, Ref[]>();
  let d = '';
  for (const ch of chains) {
    if (ch.left !== label && ch.right !== label) continue;
    const rev = ch.right === label;
    if (ch.closed) {
      d += startPoint(ch.geo!, rev) + segments(ch.geo!, rev) + 'Z';
      continue;
    }
    const ref: Ref = { ch, rev, used: false };
    const start = rev ? ch.endNode : ch.startNode;
    const list = byStart.get(start);
    if (list) list.push(ref);
    else byStart.set(start, [ref]);
  }
  for (const list of byStart.values()) {
    for (const ref of list) {
      if (ref.used) continue;
      ref.used = true;
      const loopStart = ref.rev ? ref.ch.endNode : ref.ch.startNode;
      d += startPoint(ref.ch.geo!, ref.rev) + segments(ref.ch.geo!, ref.rev);
      let node = ref.rev ? ref.ch.startNode : ref.ch.endNode;
      while (node !== loopStart) {
        const next = byStart.get(node)?.find((r) => !r.used);
        if (!next) break;
        next.used = true;
        d += segments(next.ch.geo!, next.rev);
        node = next.rev ? next.ch.startNode : next.ch.endNode;
      }
      d += 'Z';
    }
  }
  return d;
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** The label touching the image border most often: the likely background. */
function borderLabel(labels: Int16Array, w: number, h: number, nLabels: number): number {
  const counts = new Int32Array(nLabels);
  for (let x = 0; x < w; x++) {
    counts[labels[x]]++;
    counts[labels[(h - 1) * w + x]]++;
  }
  for (let y = 1; y < h - 1; y++) {
    counts[labels[y * w]]++;
    counts[labels[y * w + w - 1]]++;
  }
  let best = 0;
  for (let i = 1; i < nLabels; i++) if (counts[i] > counts[best]) best = i;
  return best;
}

function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * Which pairs of palette colours belong to different colour families. Hue
 * and saturation count fully, lightness only a little, so light and shadow
 * on one material (skin, a red jacket) stay one family while hair against
 * skin does not.
 */
function familyBorders(palette: number[], clear: number, level: number): (a: number, b: number) => boolean {
  const lab: [number, number, number][] = [];
  for (let i = 0; i < clear; i++) lab.push(toLab(palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]));
  const limit = 60 - 0.45 * level; // 60 … 15
  return (a, b) => {
    if (a === b) return false;
    if (a === clear || b === clear) return true; // a shape's edge against transparency
    const [l1, a1, b1] = lab[a];
    const [l2, a2, b2] = lab[b];
    return Math.hypot(a1 - a2, b1 - b2, 0.3 * (l1 - l2)) > limit;
  };
}

interface Traced {
  q: Labelled;
  chains: Chain[];
  area: Float64Array;
}

function traceLabels(q: Labelled, w: number, h: number, o: TraceOptions, thinClean: boolean): Traced {
  const nLabels = q.clear + 1;
  if (thinClean && o.minArea > 1) dissolveThin(q.labels, w, h, nLabels);
  despeckle(q.labels, w, h, nLabels, o.minArea);
  const chains = buildChains(q.labels, w, h);
  for (const ch of chains) ch.geo = chainGeometry(ch, o.simplify, o.smooth);
  const area = new Float64Array(nLabels);
  for (let i = 0; i < w * h; i++) area[q.labels[i]]++;
  return { q, chains, area };
}

export function trace(input: TraceInput, o: TraceOptions, progress: Progress = () => {}): TraceResult & { threshold?: number } {
  const { width: w, height: h } = input;
  const inkMode = o.mode === 'line' && o.lineSource === 'ink';
  const needColors = o.mode === 'color' || (o.mode === 'line' && (o.lineSource === 'borders' || o.lineFill || o.hueBorders > 0));

  progress('Smoothing');
  const px = boxBlur(smoothTexture(input.data, w, h, o.denoise), w, h, Math.round(o.blur));

  let bw: (Labelled & { threshold: number }) | null = null;
  let colour: Traced | null = null;
  let ink: Traced | null = null;
  if (o.mode === 'bw') {
    progress('Tracing shapes');
    bw = quantizeBW(px, w, h, o.threshold);
    // Black & white keeps one-pixel strokes: there are no in-between colours to clean up.
    colour = traceLabels(bw, w, h, o, false);
  }
  if (needColors) {
    progress('Reducing colours');
    colour = traceLabels(quantizeColors(px, w, h, Math.round(o.colors)), w, h, o, true);
  }
  if (inkMode) {
    progress('Finding lines');
    ink = traceLabels(quantizeInk(px, w, h, o.inkWidth, o.inkSensitivity), w, h, o, false);
  }

  progress('Writing SVG');
  const parts: string[] = [];
  const used = new Set<string>();
  let shapes = 0;
  const bgFill = o.background === 'white' ? '#ffffff' : o.background === 'black' ? '#000000' : null;
  if (bgFill) {
    parts.push(`<rect width="${w}" height="${h}" fill="${bgFill}"/>`);
    used.add(bgFill);
  }

  const fills = o.mode === 'color' || (o.mode === 'line' && o.lineFill);
  if (fills && colour) {
    const { q, chains, area } = colour;
    const hasClear = area[q.clear] > 0;
    const bgLabel = borderLabel(q.labels, w, h, q.clear + 1);
    // Which colour layers to draw, largest first so small details sit on top.
    let skip = -1;
    if (o.background !== 'original') skip = bgLabel;
    else if (!hasClear && bgLabel !== q.clear) {
      // Paint the background colour as one rectangle instead of tracing it.
      const col = hex(q.palette[bgLabel * 3], q.palette[bgLabel * 3 + 1], q.palette[bgLabel * 3 + 2]);
      parts.push(`<rect width="${w}" height="${h}" fill="${col}"/>`);
      used.add(col);
      skip = bgLabel;
    }
    const order: number[] = [];
    for (let l = 0; l < q.clear; l++) if (l !== skip && area[l] > 0) order.push(l);
    order.sort((a, b) => area[b] - area[a]);
    const layers: string[] = [];
    for (const l of order) {
      const d = regionPath(chains, l);
      if (!d) continue;
      const col = hex(q.palette[l * 3], q.palette[l * 3 + 1], q.palette[l * 3 + 2]);
      used.add(col);
      // A hairline stroke in the same colour hides anti-aliasing seams between shapes.
      layers.push(`<path fill="${col}" stroke="${col}" d="${d}"/>`);
      shapes++;
    }
    if (layers.length) parts.push(`<g fill-rule="evenodd" stroke-width="0.6" stroke-linejoin="round">${layers.join('')}</g>`);
  }

  // Filled ink shapes: black & white mode, and ink lines (which keep the
  // artist's own varying stroke width).
  const inkShapes = o.mode === 'bw' ? colour : ink;
  if (inkShapes) {
    const d = regionPath(inkShapes.chains, 0);
    if (d) {
      parts.push(`<path fill="${o.ink}" fill-rule="evenodd" stroke="${o.ink}" stroke-width="0.6" stroke-linejoin="round" d="${d}"/>`);
      used.add(o.ink);
      shapes += o.mode === 'bw' ? 1 : inkShapes.chains.length;
    }
  }

  if (o.mode === 'line' && colour && (o.lineSource === 'borders' || o.hueBorders > 0)) {
    const differs = o.lineSource === 'ink' ? familyBorders(colour.q.palette, colour.q.clear, o.hueBorders) : null;
    // Drop small closed rings (dots and blobs from texture). Open lines are
    // kept whatever their length, so outlines don't get gaps at junctions.
    const minRing = o.minArea > 1 ? Math.sqrt(o.minArea) * 6 : 0;
    let d = '';
    for (const ch of colour.chains) {
      if (ch.left === OUTSIDE || ch.right === OUTSIDE) continue; // the image frame, not a line
      if (ch.closed && ch.pts.length / 2 - 1 < minRing) continue;
      if (differs && !differs(ch.left, ch.right)) continue; // same colour family: only shading
      d += startPoint(ch.geo!, false) + segments(ch.geo!, false) + (ch.closed ? 'Z' : '');
      shapes++;
    }
    if (d) {
      parts.push(
        `<path fill="none" stroke="${o.ink}" stroke-width="${num(o.lineWidth)}" stroke-linecap="round" stroke-linejoin="round" d="${d}"/>`
      );
      used.add(o.ink);
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${Math.round(o.outWidth)}" height="${Math.round(o.outHeight)}">` +
    parts.join('') +
    `</svg>`;
  return { svg, shapes, palette: Array.from(used), threshold: bw?.threshold };
}
