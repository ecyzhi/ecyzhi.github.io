// Turns the drawn shapes into photo cells. Strokes (as wide as the gap) and a
// border band are rasterised, then every enclosed area big enough for a photo
// becomes a cell. Working on pixels means lines, curves, circles and boxes can
// mix freely; the same code runs for the editor and for the full-size export.

import { shapePath, type Pt, type Shape } from './shapes';

export interface View {
  ox: number; // image centre offset from the cell box centre, in box widths
  oy: number; // … and box heights
  zoom: number; // 1 = image just covers the cell box
}

export const DEFAULT_VIEW: View = { ox: 0, oy: 0, zoom: 1 };
export const MAX_ZOOM = 8;
export const MAX_CELLS = 254;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CellInfo {
  box: Box; // in raster pixels
  anchor: Pt; // a point inside the cell near its middle, as canvas fractions
  area: number; // share of the canvas
}

export interface Layout {
  w: number;
  h: number;
  lab: Uint8Array; // 0 = gap, k + 1 = cell k
  alpha: Uint8Array; // coverage of each pixel by its cell, anti-aliased
  cells: CellInfo[];
  masks: (HTMLCanvasElement | null)[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const MIN_AREA = 0.0025; // cells smaller than this share of the canvas are dropped

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

let scratch: HTMLCanvasElement | null = null;

/** Greyscale of the strokes on white: 255 = free, 0 = gap. */
function rasterize(shapes: Shape[], w: number, h: number, strokePx: number, borderPx: number): Uint8Array {
  const big = w * h > 1_500_000;
  const c = big ? canvas(w, h) : (scratch ??= canvas(w, h));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.2, strokePx);
  for (const s of shapes) ctx.stroke(new Path2D(shapePath(s, w, h)));
  if (borderPx > 0) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, borderPx);
    ctx.fillRect(0, h - borderPx, w, borderPx);
    ctx.fillRect(0, 0, borderPx, h);
    ctx.fillRect(w - borderPx, 0, borderPx, h);
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < grey.length; i++) grey[i] = data[i * 4];
  if (big) c.width = c.height = 1;
  return grey;
}

/** Which pixels the strokes cover, for finding loose line ends. */
export function strokeMask(shapes: Shape[], w: number, h: number, strokePx: number): Uint8Array {
  const grey = rasterize(shapes, w, h, strokePx, 0);
  for (let i = 0; i < grey.length; i++) grey[i] = grey[i] < 128 ? 1 : 0;
  return grey;
}

const INF = 1e20;

/**
 * Exact squared Euclidean distance along one row or column (Felzenszwalb and
 * Huttenlocher). With `edge`, the cells just beyond both ends count as sources.
 */
function edt1d(f: Float64Array, len: number, edge: boolean, d: Float64Array, v: Int32Array, z: Float64Array) {
  const g = (q: number) => (q < 0 || q >= len ? 0 : f[q]);
  const lo = edge ? -1 : 0;
  const hi = edge ? len : len - 1;
  let k = -1;
  for (let q = lo; q <= hi; q++) {
    const gq = g(q);
    if (gq >= INF) continue;
    let s = -INF;
    while (k >= 0) {
      const p = v[k];
      s = (gq + q * q - (g(p) + p * p)) / (2 * (q - p));
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = k === 0 ? -INF : s;
    z[k + 1] = INF;
  }
  if (k < 0) {
    d.fill(INF, 0, len);
    return;
  }
  k = 0;
  for (let q = 0; q < len; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + g(p);
  }
}

/** Squared distance from every pixel to the nearest pixel where `src` is set. */
function distanceField(src: Uint8Array, w: number, h: number, edge: boolean): Float32Array {
  const out = new Float32Array(w * h);
  const m = Math.max(w, h);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m + 3);
  const z = new Float64Array(m + 4);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = src[y * w + x] ? 0 : INF;
    edt1d(f, h, edge, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = out[row + x];
    edt1d(f, w, edge, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = d[x];
  }
  return out;
}

/**
 * Finds the cells on a w × h raster. `gap` and `radius` are shares of the
 * short side: cells sit `gap` apart and `gap` from the canvas edge, and convex
 * corners are rounded by `radius`.
 */
export function computeLayout(shapes: Shape[], w: number, h: number, gap: number, radius: number): Layout {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const n = w * h;
  const short = Math.min(w, h);
  const gapPx = gap * short;
  const grey = rasterize(shapes, w, h, gapPx, gapPx);

  // Flood-fill the free pixels (scanline fill keeps the stack small).
  const comp = new Uint16Array(n); // 0 = not free or not yet visited
  const stats: { cnt: number; sx: number; sy: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] || grey[i] < 128) continue;
    if (stats.length >= 65534) break;
    const id = stats.length + 1;
    const st = { cnt: 0, sx: 0, sy: 0 };
    stats.push(st);
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      if (comp[j]) continue;
      const y = (j / w) | 0;
      const row = y * w;
      let x0 = j - row;
      while (x0 > 0 && !comp[row + x0 - 1] && grey[row + x0 - 1] >= 128) x0--;
      let x1 = j - row;
      while (x1 < w - 1 && !comp[row + x1 + 1] && grey[row + x1 + 1] >= 128) x1++;
      for (let x = x0; x <= x1; x++) {
        comp[row + x] = id;
        st.cnt++;
        st.sx += x;
        st.sy += y;
      }
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        const r = ny * w;
        let open = false;
        for (let x = x0; x <= x1; x++) {
          const k = r + x;
          const free = !comp[k] && grey[k] >= 128;
          if (free && !open) stack.push(k);
          open = free;
        }
      }
    }
  }

  // Keep cells big enough for a photo, numbered in reading order.
  const keep = stats
    .map((s, i) => ({ id: i + 1, cnt: s.cnt, cx: s.sx / s.cnt, cy: s.sy / s.cnt }))
    .filter((s) => s.cnt >= n * MIN_AREA)
    .sort((p, q) => (Math.abs(p.cy - q.cy) > h * 0.06 ? p.cy - q.cy : p.cx - q.cx))
    .slice(0, MAX_CELLS);
  const remap = new Uint8Array(stats.length + 1);
  keep.forEach((s, k) => (remap[s.id] = k + 1));

  const lab = new Uint8Array(n);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = comp[i] ? remap[comp[i]] : 0;
    if (k) {
      lab[i] = k;
      alpha[i] = Math.min(255, (grey[i] - 64) * 2);
    }
  }
  // Anti-aliased edges: a partly covered gap pixel joins the cell beside it.
  for (let i = 0; i < n; i++) {
    if (lab[i] || grey[i] <= 64) continue;
    const x = i % w;
    const k = (x > 0 && lab[i - 1]) || (x < w - 1 && lab[i + 1]) || (i >= w && lab[i - w]) || (i + w < n && lab[i + w]) || 0;
    if (k && grey[i] < 128) {
      lab[i] = k;
      alpha[i] = (grey[i] - 64) * 2;
    }
  }

  // Rounded corners: shrink every cell by r, then grow it back (an opening).
  const r = radius * short;
  if (r >= 0.75) {
    // Exact distances keep the corner arcs round (a chamfer approximation
    // turns them into short straight facets).
    const src = new Uint8Array(n);
    for (let i = 0; i < n; i++) src[i] = alpha[i] >= 128 ? 0 : 1;
    const inside = distanceField(src, w, h, true);
    const r2 = r * r;
    for (let i = 0; i < n; i++) src[i] = inside[i] >= r2 ? 1 : 0;
    const grow = distanceField(src, w, h, false);
    for (let i = 0; i < n; i++) {
      if (!lab[i]) continue;
      const a = Math.min(alpha[i], Math.round(clamp(r + 0.5 - Math.sqrt(grow[i]), 0, 1) * 255));
      alpha[i] = a;
      if (!a) lab[i] = 0;
    }
  }

  // Boxes and anchors.
  const boxes = keep.map(() => ({ x0: w, y0: h, x1: -1, y1: -1, best: Infinity, ax: 0, ay: 0, cnt: 0 }));
  for (let i = 0; i < n; i++) {
    const k = lab[i];
    if (!k) continue;
    const b = boxes[k - 1];
    const x = i % w;
    const y = (i / w) | 0;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
    if (alpha[i] === 255) {
      b.cnt++;
      const s = keep[k - 1];
      const dd = (x - s.cx) ** 2 + (y - s.cy) ** 2;
      if (dd < b.best) {
        b.best = dd;
        b.ax = x;
        b.ay = y;
      }
    }
  }
  const cells: CellInfo[] = boxes.map((b, k) => {
    if (b.x1 < 0) return { box: { x: 0, y: 0, w: 0, h: 0 }, anchor: { x: keep[k].cx / w, y: keep[k].cy / h }, area: 0 };
    return {
      box: { x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 },
      anchor: { x: (b.ax + 0.5) / w, y: (b.ay + 0.5) / h },
      area: b.cnt / n,
    };
  });
  return { w, h, lab, alpha, cells, masks: cells.map(() => null) };
}

/** Which cell covers the canvas point p, or -1. */
export function cellAt(l: Layout, p: Pt): number {
  const x = Math.floor(p.x * l.w);
  const y = Math.floor(p.y * l.h);
  if (x < 0 || y < 0 || x >= l.w || y >= l.h) return -1;
  return l.lab[y * l.w + x] - 1;
}

/** The cell as a white alpha mask the size of its box. */
export function cellMask(l: Layout, k: number): HTMLCanvasElement {
  const cached = l.masks[k];
  if (cached) return cached;
  const { x, y, w, h } = l.cells[k].box;
  const c = canvas(w, h);
  if (w && h) {
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const i = (y + yy) * l.w + x + xx;
        if (l.lab[i] !== k + 1) continue;
        const o = (yy * w + xx) * 4;
        d[o] = d[o + 1] = d[o + 2] = 255;
        d[o + 3] = l.alpha[i];
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  l.masks[k] = c;
  return c;
}

export interface ImageLike {
  el: CanvasImageSource;
  width: number;
  height: number;
}

/** Keeps the photo covering its cell box: zoom >= 1 and no edge pulled inside. */
export function clampView(v: View, img: ImageLike, bw: number, bh: number): View {
  const zoom = clamp(v.zoom, 1, MAX_ZOOM);
  if (bw <= 0 || bh <= 0) return { ox: 0, oy: 0, zoom };
  const s = Math.max(bw / img.width, bh / img.height) * zoom;
  const lx = Math.max(0, (img.width * s - bw) / 2 / bw);
  const ly = Math.max(0, (img.height * s - bh) / 2 / bh);
  return { zoom, ox: clamp(v.ox, -lx, lx), oy: clamp(v.oy, -ly, ly) };
}

export interface DrawOptions {
  bg: string | null; // null = transparent
  placeholder: string | null; // fill for empty cells; null leaves them as background
  photo: (k: number) => { img: ImageLike; view: View } | null;
}

let piece: HTMLCanvasElement | null = null;

/** Paints the collage onto a context the same size as the layout raster. */
export function drawCollage(ctx: CanvasRenderingContext2D, l: Layout, o: DrawOptions) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, l.w, l.h);
  if (o.bg) {
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, l.w, l.h);
  }
  piece ??= canvas(1, 1);
  l.cells.forEach((cell, k) => {
    const { x, y, w, h } = cell.box;
    if (!w || !h) return;
    const ph = o.photo(k);
    if (!ph && !o.placeholder) return;
    const pc = piece!;
    pc.width = w;
    pc.height = h;
    const p = pc.getContext('2d')!;
    if (ph) {
      const v = clampView(ph.view, ph.img, w, h);
      const s = Math.max(w / ph.img.width, h / ph.img.height) * v.zoom;
      const cx = w / 2 + v.ox * w;
      const cy = h / 2 + v.oy * h;
      p.imageSmoothingEnabled = true;
      p.imageSmoothingQuality = 'high';
      p.drawImage(ph.img.el, cx - (ph.img.width * s) / 2, cy - (ph.img.height * s) / 2, ph.img.width * s, ph.img.height * s);
    } else {
      p.fillStyle = o.placeholder!;
      p.fillRect(0, 0, w, h);
    }
    p.globalCompositeOperation = 'destination-in';
    p.drawImage(cellMask(l, k), 0, 0);
    p.globalCompositeOperation = 'source-over';
    ctx.drawImage(pc, x, y);
  });
  ctx.restore();
}

/** A ring just outside a cell, for showing the selected cell. */
export function drawOutline(ctx: CanvasRenderingContext2D, l: Layout, k: number, color: string, width: number, faint = false) {
  const cell = l.cells[k];
  if (!cell || !cell.box.w) return;
  const { x, y, w, h } = cell.box;
  const pad = Math.ceil(width) + 1;
  const c = canvas(w + pad * 2, h + pad * 2);
  const g = c.getContext('2d')!;
  const mask = cellMask(l, k);
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * Math.PI * 2;
    g.drawImage(mask, pad + Math.cos(t) * width, pad + Math.sin(t) * width);
  }
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(mask, pad, pad);
  ctx.save();
  ctx.globalAlpha = faint ? 0.55 : 1;
  ctx.drawImage(c, x - pad, y - pad);
  ctx.restore();
}

/**
 * Matches the cells of a new layout to an old one: for each new cell, the old
 * cell under its anchor, or -1. An old cell goes to at most one new cell (the
 * largest), so a photo lands in the bigger half when a cell is split.
 */
export function matchCells(from: Layout, to: Layout): number[] {
  const out = to.cells.map(() => -1);
  const best = new Map<number, number>();
  to.cells.forEach((c, k) => {
    const old = cellAt(from, c.anchor);
    if (old < 0) return;
    const cur = best.get(old);
    if (cur === undefined || c.area > to.cells[cur].area) best.set(old, k);
  });
  best.forEach((k, old) => (out[k] = old));
  return out;
}

/** Cell count for a set of shapes on a canvas of the given ratio. */
export function countCells(shapes: Shape[], ratio: number) {
  const s = 110;
  const w = ratio >= 1 ? s : Math.round(s * ratio);
  const h = ratio >= 1 ? Math.round(s / ratio) : s;
  return computeLayout(shapes, w, h, 0.015, 0).cells.length;
}
