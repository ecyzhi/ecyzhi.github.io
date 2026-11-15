// Geometry for the collage layout. Cells are convex polygons in normalised
// canvas coordinates (0..1 on both axes), so a layout survives ratio changes
// and maps straight onto any export size. Cutting a convex polygon with a
// straight line always gives two convex polygons, which keeps every test here
// simple.

export interface Pt {
  x: number;
  y: number;
}
export type Poly = Pt[];

export interface View {
  ox: number; // image centre offset from the cell box centre, in box widths
  oy: number; // … and box heights
  zoom: number; // 1 = image just covers the cell
}

export interface Cell {
  id: string;
  poly: Poly;
  img: string | null;
  view: View;
}

export const DEFAULT_VIEW: View = { ox: 0, oy: 0, zoom: 1 };
export const MAX_ZOOM = 8;
export const UNIT_RECT: Poly = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const EPS = 1e-9;
let idCounter = 0;
export const newId = () => `c${++idCounter}`;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function area(p: Poly) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function perimeter(p: Poly) {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += dist(p[i], p[(i + 1) % p.length]);
  return s;
}

export function centroid(p: Poly): Pt {
  let x = 0;
  let y = 0;
  for (const q of p) {
    x += q.x;
    y += q.y;
  }
  return { x: x / p.length, y: y / p.length };
}

export function bbox(p: Poly) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of p) {
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function pointInConvex(p: Poly, pt: Pt) {
  let sign = 0;
  for (let i = 0; i < p.length; i++) {
    const c = cross(p[i], p[(i + 1) % p.length], pt);
    if (Math.abs(c) < EPS) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Keeps the part of `poly` where f(p) >= 0, for a linear f. */
function clipBy(poly: Poly, f: (p: Pt) => number): Poly {
  const out: Poly = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const fc = f(cur);
    const fn = f(nxt);
    if (fc >= 0) out.push(cur);
    if ((fc > 0 && fn < 0) || (fc < 0 && fn > 0)) out.push(lerp(cur, nxt, fc / (fc - fn)));
  }
  return out;
}

/** Splits a convex polygon by the infinite line through a and b. */
export function splitByLine(poly: Poly, a: Pt, b: Pt): [Poly, Poly] {
  return [clipBy(poly, (p) => cross(a, b, p)), clipBy(poly, (p) => -cross(a, b, p))];
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Does the segment ab pass through the polygon? */
export function segmentHits(poly: Poly, a: Pt, b: Pt) {
  if (pointInConvex(poly, a) || pointInConvex(poly, b)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (segmentsCross(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return false;
}

/** Where the infinite line through a and b crosses a convex polygon. */
export function chord(poly: Poly, a: Pt, b: Pt): [Pt, Pt] | null {
  const pts: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const fc = cross(a, b, cur);
    const fn = cross(a, b, nxt);
    if ((fc > 0 && fn < 0) || (fc < 0 && fn > 0)) pts.push(lerp(cur, nxt, fc / (fc - fn)));
  }
  return pts.length >= 2 ? [pts[0], pts[1]] : null;
}

/**
 * A part is too small when its area or thickness would leave no room for a
 * photo. Measured with the canvas aspect applied, so thin slivers on wide
 * canvases are caught too.
 */
function bigEnough(p: Poly, aspect: number) {
  if (p.length < 3) return false;
  const q = p.map((v) => ({ x: v.x * aspect, y: v.y }));
  const a = area(q);
  const scale = Math.min(aspect, 1);
  return a / (aspect * 1) > 0.004 && (2 * a) / perimeter(q) > 0.02 * scale;
}

/**
 * Cuts every cell the segment ab passes through, along the full line, so a
 * short stroke inside a cell still splits it edge to edge. The larger half
 * keeps the cell's photo. Returns the cells unchanged when nothing splits.
 */
export function cutCells(cells: Cell[], a: Pt, b: Pt, aspect: number): { cells: Cell[]; changed: boolean } {
  let changed = false;
  const out: Cell[] = [];
  for (const cell of cells) {
    if (!segmentHits(cell.poly, a, b)) {
      out.push(cell);
      continue;
    }
    const [l, r] = splitByLine(cell.poly, a, b);
    if (!bigEnough(l, aspect) || !bigEnough(r, aspect)) {
      out.push(cell);
      continue;
    }
    changed = true;
    const [big, small] = area(l) >= area(r) ? [l, r] : [r, l];
    out.push({ id: cell.id, poly: big, img: cell.img, view: DEFAULT_VIEW });
    out.push({ id: newId(), poly: small, img: null, view: DEFAULT_VIEW });
  }
  return { cells: out, changed };
}

/** Cells that a cut along ab would split, for the drawing preview. */
export function previewCut(cells: Cell[], a: Pt, b: Pt, aspect: number): [Pt, Pt][] {
  const chords: [Pt, Pt][] = [];
  for (const cell of cells) {
    if (!segmentHits(cell.poly, a, b)) continue;
    const [l, r] = splitByLine(cell.poly, a, b);
    if (!bigEnough(l, aspect) || !bigEnough(r, aspect)) continue;
    const c = chord(cell.poly, a, b);
    if (c) chords.push(c);
  }
  return chords;
}

// ----- templates -----

type Cut = [number, number, number, number];
export interface Template {
  id: string;
  name: string;
  cuts: Cut[];
}

const T = 1 / 3;
export const TEMPLATES: Template[] = [
  { id: 'big-left', name: 'One large, two small', cuts: [[0.5, 0, 0.5, 1], [0.6, 0.5, 0.9, 0.5]] },
  { id: 'two-cols', name: 'Two side by side', cuts: [[0.5, 0, 0.5, 1]] },
  { id: 'two-rows', name: 'Two stacked', cuts: [[0, 0.5, 1, 0.5]] },
  { id: 'grid-4', name: 'Grid of four', cuts: [[0.5, 0, 0.5, 1], [0, 0.5, 1, 0.5]] },
  { id: 'big-top', name: 'One wide, two below', cuts: [[0, 0.6, 1, 0.6], [0.5, 0.7, 0.5, 0.9]] },
  { id: 'three-cols', name: 'Three columns', cuts: [[T, 0, T, 1], [2 * T, 0, 2 * T, 1]] },
  { id: 'three-rows', name: 'Three rows', cuts: [[0, T, 1, T], [0, 2 * T, 1, 2 * T]] },
  { id: 'grid-6', name: 'Grid of six', cuts: [[0.5, 0, 0.5, 1], [0, T, 1, T], [0, 2 * T, 1, 2 * T]] },
  { id: 'grid-9', name: 'Grid of nine', cuts: [[T, 0, T, 1], [2 * T, 0, 2 * T, 1], [0, T, 1, T], [0, 2 * T, 1, 2 * T]] },
  { id: 'diagonal', name: 'Diagonal split', cuts: [[0.62, 0, 0.38, 1]] },
  { id: 'diagonal-3', name: 'Diagonal, three', cuts: [[0.6, 0, 0.4, 1], [0.6, 0.55, 1, 0.42]] },
  { id: 'single', name: 'One photo', cuts: [] },
];

export function templateCells(t: Template): Cell[] {
  let cells: Cell[] = [{ id: newId(), poly: UNIT_RECT, img: null, view: DEFAULT_VIEW }];
  for (const [x1, y1, x2, y2] of t.cuts) cells = cutCells(cells, { x: x1, y: y1 }, { x: x2, y: y2 }, 1).cells;
  // Reading order: top to bottom, then left to right.
  return cells.sort((p, q) => {
    const a = centroid(p.poly);
    const b = centroid(q.poly);
    return Math.abs(a.y - b.y) > 0.05 ? a.y - b.y : a.x - b.x;
  });
}

// ----- drawing -----

function onSameBorder(a: Pt, b: Pt) {
  const e = 1e-6;
  return (
    (Math.abs(a.x) < e && Math.abs(b.x) < e) ||
    (Math.abs(a.x - 1) < e && Math.abs(b.x - 1) < e) ||
    (Math.abs(a.y) < e && Math.abs(b.y) < e) ||
    (Math.abs(a.y - 1) < e && Math.abs(b.y - 1) < e)
  );
}

/**
 * The cell's polygon in pixels, shrunk so cells sit `gap` px apart and `gap` px
 * from the canvas edge (inner edges move in by half the gap from each side).
 */
export function insetCell(poly: Poly, w: number, h: number, gap: number): Poly {
  const px = poly.map((p) => ({ x: p.x * w, y: p.y * h }));
  if (gap <= 0) return px;
  const c = centroid(px);
  let out = px;
  for (let i = 0; i < px.length; i++) {
    const p = px[i];
    const q = px[(i + 1) % px.length];
    const len = dist(p, q);
    if (len < EPS) continue;
    let nx = -(q.y - p.y) / len;
    let ny = (q.x - p.x) / len;
    if (nx * (c.x - p.x) + ny * (c.y - p.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const d = onSameBorder(poly[i], poly[(i + 1) % poly.length]) ? gap : gap / 2;
    out = clipBy(out, (v) => nx * (v.x - p.x) + ny * (v.y - p.y) - d);
    if (out.length < 3) return [];
  }
  return out;
}

/** Adds a closed path with rounded corners for a convex polygon. */
export function roundedPath(ctx: CanvasRenderingContext2D, pts: Poly, radius: number) {
  const n = pts.length;
  ctx.beginPath();
  if (n < 3) return;
  if (radius <= 0) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    return;
  }
  const start = lerp(pts[n - 1], pts[0], 0.5);
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const v1 = { x: p0.x - p1.x, y: p0.y - p1.y };
    const v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    if (l1 < EPS || l2 < EPS) continue;
    const cos = clamp((v1.x * v2.x + v1.y * v2.y) / (l1 * l2), -1, 1);
    const half = Math.tan(Math.acos(cos) / 2);
    // Tangent length = r / tan(θ/2); keep it within half of each edge.
    const r = Math.min(radius, (Math.min(l1, l2) / 2) * half);
    ctx.arcTo(p1.x, p1.y, p2.x, p2.y, Math.max(0, r));
  }
  ctx.closePath();
}

export interface ImageLike {
  el: CanvasImageSource;
  width: number;
  height: number;
}

/** Keeps the photo covering its cell: zoom >= 1 and no edge pulled inside. */
export function clampView(v: View, img: ImageLike, bw: number, bh: number): View {
  const zoom = clamp(v.zoom, 1, MAX_ZOOM);
  if (bw <= 0 || bh <= 0) return { ox: 0, oy: 0, zoom };
  const s = Math.max(bw / img.width, bh / img.height) * zoom;
  const lx = Math.max(0, (img.width * s - bw) / 2 / bw);
  const ly = Math.max(0, (img.height * s - bh) / 2 / bh);
  return { zoom, ox: clamp(v.ox, -lx, lx), oy: clamp(v.oy, -ly, ly) };
}

export interface DrawOptions {
  gap: number; // share of the canvas's short side
  radius: number; // share of the canvas's short side
  bg: string | null; // null = transparent
  placeholder: string | null; // fill for empty cells; null leaves them as background
}

export function cellBox(cell: Cell, w: number, h: number, gap: number) {
  return bbox(insetCell(cell.poly, w, h, gap * Math.min(w, h)));
}

export function drawCollage(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cells: Cell[],
  images: Record<string, ImageLike>,
  o: DrawOptions
) {
  const short = Math.min(w, h);
  const gap = o.gap * short;
  const radius = o.radius * short;
  ctx.clearRect(0, 0, w, h);
  if (o.bg) {
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, w, h);
  }
  for (const cell of cells) {
    const pts = insetCell(cell.poly, w, h, gap);
    if (pts.length < 3) continue;
    roundedPath(ctx, pts, radius);
    const img = cell.img ? images[cell.img] : null;
    if (img) {
      const box = bbox(pts);
      const v = clampView(cell.view, img, box.w, box.h);
      const s = Math.max(box.w / img.width, box.h / img.height) * v.zoom;
      const cx = box.x + box.w / 2 + v.ox * box.w;
      const cy = box.y + box.h / 2 + v.oy * box.h;
      ctx.save();
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img.el, cx - (img.width * s) / 2, cy - (img.height * s) / 2, img.width * s, img.height * s);
      ctx.restore();
    } else if (o.placeholder) {
      ctx.fillStyle = o.placeholder;
      ctx.fill();
    }
  }
}
