// The layout is a list of shapes drawn on the canvas. Each shape's stroke is a
// gap, and the areas the strokes enclose become the photo cells (see layout.ts).
// Points are canvas fractions: x of the width, y of the height. A circle's
// radius is a share of the short side, so it stays round on any canvas ratio.

export interface Pt {
  x: number;
  y: number;
}

export type Shape =
  | { type: 'line'; a: Pt; b: Pt }
  // m is the point on the curve halfway along it; ea/eb extend loose ends straight.
  | { type: 'curve'; a: Pt; b: Pt; m: Pt; ea?: Pt; eb?: Pt }
  | { type: 'oval'; c: Pt; rx: number; ry: number }
  | { type: 'circle'; c: Pt; r: number }
  | { type: 'rect'; p0: Pt; p1: Pt };

export type Tool = Shape['type'];
export type HandleKey = 'a' | 'b' | 'm' | 'c' | 'e' | 'w' | 'n' | 's' | 'r' | 'tl' | 'tr' | 'br' | 'bl';

export const TOOL_NAMES: Record<Tool, string> = { line: 'line', curve: 'curve', oval: 'oval', circle: 'circle', rect: 'box' };

const P = (x: number, y: number): Pt => ({ x, y });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const MIN_SIZE = 0.02;

/** Distance in pixels between two canvas points on a w × h canvas. */
export const distPx = (a: Pt, b: Pt, w: number, h: number) => Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);

/** The quadratic control point that makes the curve pass through m. */
export const control = (s: { a: Pt; b: Pt; m: Pt }): Pt => P(2 * s.m.x - (s.a.x + s.b.x) / 2, 2 * s.m.y - (s.a.y + s.b.y) / 2);

function radii(s: Shape, w: number, h: number): [number, number] {
  if (s.type === 'oval') return [s.rx * w, s.ry * h];
  if (s.type === 'circle') return [s.r * Math.min(w, h), s.r * Math.min(w, h)];
  return [0, 0];
}

/** SVG path data for the shape on a w × h canvas. */
export function shapePath(s: Shape, w: number, h: number): string {
  const q = (p: Pt) => `${(p.x * w).toFixed(2)} ${(p.y * h).toFixed(2)}`;
  switch (s.type) {
    case 'line':
      return `M${q(s.a)}L${q(s.b)}`;
    case 'curve':
      return `M${q(s.ea ?? s.a)}L${q(s.a)}Q${q(control(s))} ${q(s.b)}L${q(s.eb ?? s.b)}`;
    case 'oval':
    case 'circle': {
      const [rx, ry] = radii(s, w, h);
      const cx = s.c.x * w;
      const cy = s.c.y * h;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'rect': {
      const x0 = Math.min(s.p0.x, s.p1.x) * w;
      const x1 = Math.max(s.p0.x, s.p1.x) * w;
      const y0 = Math.min(s.p0.y, s.p1.y) * h;
      const y1 = Math.max(s.p0.y, s.p1.y) * h;
      return `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
    }
  }
}

/** Points along the shape, for hit tests. */
function samples(s: Shape, w: number, h: number): Pt[] {
  switch (s.type) {
    case 'line':
      return [s.a, s.b];
    case 'curve': {
      const c = control(s);
      const pts: Pt[] = s.ea ? [s.ea] : [];
      for (let i = 0; i <= 28; i++) {
        const t = i / 28;
        const k = 1 - t;
        pts.push(P(k * k * s.a.x + 2 * k * t * c.x + t * t * s.b.x, k * k * s.a.y + 2 * k * t * c.y + t * t * s.b.y));
      }
      if (s.eb) pts.push(s.eb);
      return pts;
    }
    case 'oval':
    case 'circle': {
      const [rx, ry] = radii(s, w, h);
      const pts: Pt[] = [];
      for (let i = 0; i <= 56; i++) {
        const t = (i / 56) * Math.PI * 2;
        pts.push(P(s.c.x + (rx / w) * Math.cos(t), s.c.y + (ry / h) * Math.sin(t)));
      }
      return pts;
    }
    case 'rect':
      return [s.p0, P(s.p1.x, s.p0.y), s.p1, P(s.p0.x, s.p1.y), s.p0];
  }
}

function segDistPx(p: Pt, a: Pt, b: Pt, w: number, h: number) {
  const ax = a.x * w;
  const ay = a.y * h;
  const dx = b.x * w - ax;
  const dy = b.y * h - ay;
  const px = p.x * w;
  const py = p.y * h;
  const l = dx * dx + dy * dy;
  const t = l ? clamp(((px - ax) * dx + (py - ay) * dy) / l, 0, 1) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Pixel distance from p to the shape's stroke. */
export function shapeDistPx(s: Shape, p: Pt, w: number, h: number) {
  const pts = samples(s, w, h);
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDistPx(p, pts[i - 1], pts[i], w, h));
  return d;
}

/** Largest extent of the shape in pixels, to discard accidental taps. */
export function shapeSizePx(s: Shape, w: number, h: number) {
  const pts = samples(s, w, h);
  let d = 0;
  for (const q of pts) d = Math.max(d, distPx(q, pts[0], w, h));
  return d;
}

export function handles(s: Shape, w: number, h: number): [HandleKey, Pt][] {
  switch (s.type) {
    case 'line':
      return [['a', s.a], ['b', s.b]];
    case 'curve':
      return [['a', s.a], ['b', s.b], ['m', s.m]];
    case 'oval':
      return [
        ['c', s.c],
        ['e', P(s.c.x + s.rx, s.c.y)],
        ['w', P(s.c.x - s.rx, s.c.y)],
        ['n', P(s.c.x, s.c.y - s.ry)],
        ['s', P(s.c.x, s.c.y + s.ry)],
      ];
    case 'circle':
      return [['c', s.c], ['r', P(s.c.x + (s.r * Math.min(w, h)) / w, s.c.y)]];
    case 'rect':
      return [['tl', s.p0], ['tr', P(s.p1.x, s.p0.y)], ['br', s.p1], ['bl', P(s.p0.x, s.p1.y)]];
  }
}

/** Returns a copy of the shape with one handle moved to p. */
export function moveHandle(s: Shape, k: HandleKey, p: Pt, w: number, h: number): Shape {
  switch (s.type) {
    case 'line':
      return k === 'a' ? { ...s, a: p } : { ...s, b: p };
    case 'curve':
      return k === 'a' ? { ...s, a: p } : k === 'b' ? { ...s, b: p } : { ...s, m: p };
    case 'circle':
      return k === 'c' ? { ...s, c: p } : { ...s, r: Math.max(MIN_SIZE, distPx(s.c, p, w, h) / Math.min(w, h)) };
    case 'rect':
      if (k === 'tl') return { ...s, p0: p };
      if (k === 'br') return { ...s, p1: p };
      if (k === 'tr') return { ...s, p0: P(s.p0.x, p.y), p1: P(p.x, s.p1.y) };
      return { ...s, p0: P(p.x, s.p0.y), p1: P(s.p1.x, p.y) };
    case 'oval': {
      if (k === 'c') return { ...s, c: p };
      // A side handle moves that side only.
      let l = s.c.x - s.rx;
      let r = s.c.x + s.rx;
      let t = s.c.y - s.ry;
      let b = s.c.y + s.ry;
      if (k === 'e') r = Math.max(l + MIN_SIZE, p.x);
      if (k === 'w') l = Math.min(r - MIN_SIZE, p.x);
      if (k === 'n') t = Math.min(b - MIN_SIZE, p.y);
      if (k === 's') b = Math.max(t + MIN_SIZE, p.y);
      return { type: 'oval', c: P((l + r) / 2, (t + b) / 2), rx: (r - l) / 2, ry: (b - t) / 2 };
    }
  }
}

export function translate(s: Shape, dx: number, dy: number): Shape {
  const m = (p: Pt) => P(p.x + dx, p.y + dy);
  switch (s.type) {
    case 'line':
      return { ...s, a: m(s.a), b: m(s.b) };
    case 'curve':
      return { type: 'curve', a: m(s.a), b: m(s.b), m: m(s.m) };
    case 'oval':
    case 'circle':
      return { ...s, c: m(s.c) };
    case 'rect':
      return { ...s, p0: m(s.p0), p1: m(s.p1) };
  }
}

/** The shape a drag from p0 to p makes with the given tool. */
export function createShape(tool: Tool, p0: Pt, p: Pt, w: number, h: number): Shape {
  switch (tool) {
    case 'line':
      return { type: 'line', a: p0, b: p };
    case 'curve': {
      // Starts with a gentle bend so the middle handle is easy to find.
      const dx = (p.x - p0.x) * w;
      const dy = (p.y - p0.y) * h;
      let nx = -dy;
      let ny = dx;
      if (ny > 0 || (ny === 0 && nx > 0)) {
        nx = -nx;
        ny = -ny;
      }
      return { type: 'curve', a: p0, b: p, m: P((p0.x + p.x) / 2 + (nx * 0.18) / w, (p0.y + p.y) / 2 + (ny * 0.18) / h) };
    }
    case 'oval':
      return { type: 'oval', c: P((p0.x + p.x) / 2, (p0.y + p.y) / 2), rx: Math.abs(p.x - p0.x) / 2, ry: Math.abs(p.y - p0.y) / 2 };
    case 'circle':
      return { type: 'circle', c: p0, r: distPx(p0, p, w, h) / Math.min(w, h) };
    case 'rect':
      return { type: 'rect', p0, p1: p };
  }
}

/** Ends of open shapes, which snap to each other and stretch when loose. */
export function lineEnds(s: Shape): Pt[] {
  if (s.type === 'line') return [s.a, s.b];
  if (s.type === 'curve') return [s.ea ?? s.a, s.eb ?? s.b];
  return [];
}

// ----- snapping -----

export interface EdgePoint {
  p: Pt;
  f: number;
  edge: 'top' | 'bottom' | 'left' | 'right';
  weight: 1 | 2 | 3; // 3 = halves, 2 = quarters, 1 = eighths
}

/** Snap points along the four canvas edges, every 1/density. */
export function edgePoints(density: number): EdgePoint[] {
  const pts: EdgePoint[] = [];
  for (let k = 0; k <= density; k++) {
    const f = k / density;
    const weight = (k * 2) % density === 0 ? 3 : (k * 4) % density === 0 ? 2 : 1;
    pts.push({ p: P(f, 0), f, edge: 'top', weight }, { p: P(f, 1), f, edge: 'bottom', weight });
    if (k > 0 && k < density) pts.push({ p: P(0, f), f, edge: 'left', weight }, { p: P(1, f), f, edge: 'right', weight });
  }
  return pts;
}

/** A fraction as text: "1/4", "3/8", or a percentage when it isn't one. */
export function fraction(v: number) {
  for (const d of [1, 2, 4, 8, 16]) {
    const k = Math.round(v * d);
    if (Math.abs(v * d - k) < 1e-6) return k === 0 ? '0' : k === d ? '1' : `${k}/${d}`;
  }
  return `${Math.round(v * 100)}%`;
}

export interface Snap {
  p: Pt;
  label?: string;
  hit?: Pt; // the snap point it landed on
  gx?: number; // vertical guide at this x
  gy?: number; // horizontal guide at this y
}

const SNAP_PX = 16;
const EDGE_PX = 10;
const AXIS_PX = 7;

/**
 * Snaps a dragged point to edge points, other line ends or the centre; failing
 * that it sticks to a nearby edge and lines up with the 1/density grid.
 */
export function snapPoint(raw: Pt, o: { on: boolean; density: number; shapes: Shape[]; w: number; h: number }): Snap {
  const { w, h } = o;
  const free = P(clamp(raw.x, -0.02, 1.02), clamp(raw.y, -0.02, 1.02));
  if (!o.on) return { p: free };
  let best: Snap | null = null;
  let bd = SNAP_PX;
  const consider = (p: Pt, label: string) => {
    const d = distPx(raw, p, w, h);
    if (d < bd) {
      bd = d;
      best = { p, label, hit: p };
    }
  };
  for (const e of edgePoints(o.density)) consider(e.p, `${e.edge} ${fraction(e.f)}`);
  for (const s of o.shapes) for (const q of lineEnds(s)) consider(q, 'line end');
  consider(P(0.5, 0.5), 'centre');
  if (best) return best;
  let { x, y } = free;
  const snap: Snap = { p: free };
  if (Math.abs(x) * w < EDGE_PX) x = 0;
  else if (Math.abs(1 - x) * w < EDGE_PX) x = 1;
  if (Math.abs(y) * h < EDGE_PX) y = 0;
  else if (Math.abs(1 - y) * h < EDGE_PX) y = 1;
  const kx = Math.round(x * o.density) / o.density;
  const ky = Math.round(y * o.density) / o.density;
  if (x > 0 && x < 1 && Math.abs(x - kx) * w < AXIS_PX) snap.gx = x = kx;
  if (y > 0 && y < 1 && Math.abs(y - ky) * h < AXIS_PX) snap.gy = y = ky;
  snap.p = P(x, y);
  return snap;
}

// ----- templates -----

export interface Template {
  id: string;
  name: string;
  shapes: Shape[];
}

const L = (x1: number, y1: number, x2: number, y2: number): Shape => ({ type: 'line', a: P(x1, y1), b: P(x2, y2) });
const C = (ax: number, ay: number, mx: number, my: number, bx: number, by: number): Shape => ({ type: 'curve', a: P(ax, ay), m: P(mx, my), b: P(bx, by) });
const O = (cx: number, cy: number, rx: number, ry: number): Shape => ({ type: 'oval', c: P(cx, cy), rx, ry });
const Ci = (cx: number, cy: number, r: number): Shape => ({ type: 'circle', c: P(cx, cy), r });
const R = (x0: number, y0: number, x1: number, y1: number): Shape => ({ type: 'rect', p0: P(x0, y0), p1: P(x1, y1) });
const T = 1 / 3;

// Photo counts aren't stored: the tool counts each template's cells for the
// current canvas ratio, so a template is always listed under the right number.
export const TEMPLATES: Template[] = [
  { id: 'h2', name: 'Side by side', shapes: [L(0.5, 0, 0.5, 1)] },
  { id: 'v2', name: 'Stacked', shapes: [L(0, 0.5, 1, 0.5)] },
  { id: 'diag', name: 'Slanted split', shapes: [L(0.62, 0, 0.38, 1)] },
  { id: 'corner', name: 'Corner to corner', shapes: [L(1, 0, 0, 1)] },
  { id: 'wave-h', name: 'Horizon curve', shapes: [C(0, 0.58, 0.5, 0.4, 1, 0.58)] },
  { id: 'spot', name: 'Spotlight circle', shapes: [Ci(0.5, 0.5, 0.3)] },
  { id: 'oval-in', name: 'Oval portrait', shapes: [O(0.5, 0.5, 0.28, 0.38)] },
  { id: 'h3', name: 'Three columns', shapes: [L(T, 0, T, 1), L(2 * T, 0, 2 * T, 1)] },
  { id: 'v3', name: 'Three rows', shapes: [L(0, T, 1, T), L(0, 2 * T, 1, 2 * T)] },
  { id: 'big-l', name: 'Large left', shapes: [L(0.5, 0, 0.5, 1), L(0.5, 0.5, 1, 0.5)] },
  { id: 'big-r', name: 'Large right', shapes: [L(0.5, 0, 0.5, 1), L(0, 0.5, 0.5, 0.5)] },
  { id: 'big-t', name: 'Large top', shapes: [L(0, 0.5, 1, 0.5), L(0.5, 0.5, 0.5, 1)] },
  { id: 'big-b', name: 'Large bottom', shapes: [L(0, 0.5, 1, 0.5), L(0.5, 0, 0.5, 0.5)] },
  { id: 'diag3', name: 'Slanted three', shapes: [L(0.6, 0, 0.4, 1), L(0.5, 0.5, 1, 0.42)] },
  { id: 'y', name: 'Y split', shapes: [L(0, 0, 0.5, 0.5), L(1, 0, 0.5, 0.5), L(0.5, 0.5, 0.5, 1)] },
  { id: 'g4', name: 'Grid of four', shapes: [L(0.5, 0, 0.5, 1), L(0, 0.5, 1, 0.5)] },
  { id: 'h4', name: 'Four columns', shapes: [L(0.25, 0, 0.25, 1), L(0.5, 0, 0.5, 1), L(0.75, 0, 0.75, 1)] },
  { id: 'v4', name: 'Four rows', shapes: [L(0, 0.25, 1, 0.25), L(0, 0.5, 1, 0.5), L(0, 0.75, 1, 0.75)] },
  { id: 'big-t3', name: 'Large top, three below', shapes: [L(0, 0.6, 1, 0.6), L(T, 0.6, T, 1), L(2 * T, 0.6, 2 * T, 1)] },
  { id: 'big-l3', name: 'Large left, three right', shapes: [L(0.6, 0, 0.6, 1), L(0.6, T, 1, T), L(0.6, 2 * T, 1, 2 * T)] },
  { id: 'stagger', name: 'Staggered', shapes: [L(0.5, 0, 0.5, 1), L(0, 0.4, 0.5, 0.4), L(0.5, 0.6, 1, 0.6)] },
  { id: 'x', name: 'Cross cut', shapes: [L(0, 0, 1, 1), L(1, 0, 0, 1)] },
  { id: 'tilt4', name: 'Tilted grid', shapes: [L(0.56, 0, 0.44, 1), L(0, 0.44, 1, 0.56)] },
  { id: 'wave4', name: 'Wavy rows', shapes: [C(0, 0.25, 0.5, 0.18, 1, 0.25), C(0, 0.5, 0.5, 0.43, 1, 0.5), C(0, 0.75, 0.5, 0.68, 1, 0.75)] },
  { id: 'diamond', name: 'Diamond', shapes: [L(0.5, 0, 1, 0.5), L(1, 0.5, 0.5, 1), L(0.5, 1, 0, 0.5), L(0, 0.5, 0.5, 0)] },
  { id: 'big-circle', name: 'Circle and corners', shapes: [Ci(0.5, 0.5, 0.5)] },
  { id: 'two-three', name: 'Two over three', shapes: [L(0, 0.5, 1, 0.5), L(0.5, 0, 0.5, 0.5), L(T, 0.5, T, 1), L(2 * T, 0.5, 2 * T, 1)] },
  { id: 'big-l4', name: 'Large left, four right', shapes: [L(0.5, 0, 0.5, 1), L(0.5, 0.5, 1, 0.5), L(0.75, 0, 0.75, 1)] },
  { id: 'pinwheel', name: 'Pinwheel', shapes: [L(0.3, 0, 0.3, 0.7), L(0, 0.7, 0.7, 0.7), L(0.7, 1, 0.7, 0.3), L(1, 0.3, 0.3, 0.3)] },
  {
    id: 'frame4',
    name: 'Frame of four',
    shapes: [R(0.22, 0.22, 0.78, 0.78), L(0.5, 0, 0.5, 0.22), L(0.5, 0.78, 0.5, 1), L(0, 0.5, 0.22, 0.5), L(0.78, 0.5, 1, 0.5)],
  },
  { id: 'g6', name: 'Two by three', shapes: [L(0.5, 0, 0.5, 1), L(0, T, 1, T), L(0, 2 * T, 1, 2 * T)] },
  { id: 'g6w', name: 'Three by two', shapes: [L(T, 0, T, 1), L(2 * T, 0, 2 * T, 1), L(0, 0.5, 1, 0.5)] },
  {
    id: 'feature5',
    name: 'Feature and five',
    shapes: [L(0, 2 * T, 1, 2 * T), L(2 * T, 0, 2 * T, 2 * T), L(2 * T, T, 1, T), L(T, 2 * T, T, 1), L(2 * T, 2 * T, 2 * T, 1)],
  },
  { id: 'star', name: 'Starburst', shapes: [L(0, 0, 1, 1), L(1, 0, 0, 1), L(0.5, 0, 0.5, 1)] },
  { id: 'wave6', name: 'Wave and columns', shapes: [C(0, 0.5, 0.5, 0.4, 1, 0.5), L(T, 0, T, 1), L(2 * T, 0, 2 * T, 1)] },
  { id: 'banner', name: 'Banner and grid', shapes: [L(0, 0.4, 1, 0.4), L(0, 0.7, 1, 0.7), L(T, 0.4, T, 1), L(2 * T, 0.4, 2 * T, 1)] },
  { id: 'g8', name: 'Four by two', shapes: [L(0.25, 0, 0.25, 1), L(0.5, 0, 0.5, 1), L(0.75, 0, 0.75, 1), L(0, 0.5, 1, 0.5)] },
  { id: 'g4-ring', name: 'Grid through circle', shapes: [L(0.5, 0, 0.5, 1), L(0, 0.5, 1, 0.5), Ci(0.5, 0.5, 0.28)] },
  { id: 'g9', name: 'Grid of nine', shapes: [L(T, 0, T, 1), L(2 * T, 0, 2 * T, 1), L(0, T, 1, T), L(0, 2 * T, 1, 2 * T)] },
  { id: 'centre9', name: 'Centre stage', shapes: [L(0.25, 0, 0.25, 1), L(0.75, 0, 0.75, 1), L(0, 0.25, 1, 0.25), L(0, 0.75, 1, 0.75)] },
];

export const DEFAULT_TEMPLATE = TEMPLATES.find((t) => t.id === 'big-l')!;
