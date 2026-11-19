// Hand edits made on the source image before tracing. They live on the image,
// not on one style, so Colour, B & W and Line art all trace the edited version.
//
// - Smudge pushes colour along the brush path, to blend stray spots and noise
//   into what surrounds them. It changes the source pixels.
// - Eraser paints a mask. Masked areas trace as empty: no shapes, no lines,
//   just the chosen background.
// - Lasso and smart select erase a whole area at once: what you draw around,
//   or the patch of similar colour you tap. Inverted, they erase everything
//   else instead.

export type BrushTool = 'smudge' | 'erase';
export type EditTool = 'move' | BrushTool | 'lasso' | 'wand';

/** Mask colour on screen. Only the mask's alpha matters for tracing. */
export const MASK_TINT = 'rgb(255, 64, 129)';
const TINT = [255, 64, 129];

interface Snapshot {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  before: ImageData;
  after: ImageData;
}

const MAX_HISTORY = 30;

export class EditLayer {
  readonly source: HTMLCanvasElement;
  readonly mask: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  private sctx: CanvasRenderingContext2D;
  private mctx: CanvasRenderingContext2D;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private maskUsed = false;

  // Current stroke.
  private tool: BrushTool | null = null;
  private radius = 0;
  private strength = 0;
  private last: { x: number; y: number } | null = null;
  private start: ImageData | null = null;
  private box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  private buf: Float32Array | null = null;

  constructor(img: HTMLImageElement, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.source = document.createElement('canvas');
    this.mask = document.createElement('canvas');
    for (const c of [this.source, this.mask]) {
      c.width = width;
      c.height = height;
    }
    this.sctx = this.source.getContext('2d', { willReadFrequently: true })!;
    this.mctx = this.mask.getContext('2d', { willReadFrequently: true })!;
    this.sctx.imageSmoothingQuality = 'high';
    this.sctx.drawImage(img, 0, 0, width, height);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get hasMask() {
    return this.maskUsed;
  }
  get edited() {
    return this.undoStack.length > 0;
  }

  /** Start a stroke at (x, y) in layer pixels. */
  begin(tool: BrushTool, x: number, y: number, radius: number, strength: number) {
    this.tool = tool;
    this.radius = Math.max(1, radius);
    this.strength = strength;
    const ctx = tool === 'smudge' ? this.sctx : this.mctx;
    this.start = ctx.getImageData(0, 0, this.width, this.height);
    this.box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    if (tool === 'smudge') this.pickUp(x, y);
    this.last = { x, y };
    this.dab(x, y);
  }

  move(x: number, y: number) {
    if (!this.tool || !this.last) return;
    const { x: lx, y: ly } = this.last;
    const dist = Math.hypot(x - lx, y - ly);
    const spacing = Math.max(1, this.radius * (this.tool === 'smudge' ? 0.2 : 0.35));
    if (dist < spacing) return;
    const steps = Math.floor(dist / spacing);
    for (let i = 1; i <= steps; i++) this.dab(lx + ((x - lx) * i) / steps, ly + ((y - ly) * i) / steps);
    this.last = { x, y };
  }

  /** Finish the stroke and record it for undo. Returns false if nothing changed. */
  end(): boolean {
    if (!this.tool || !this.start) return false;
    const canvas = this.tool === 'smudge' ? this.source : this.mask;
    const ctx = this.tool === 'smudge' ? this.sctx : this.mctx;
    const { x0, y0, x1, y1 } = this.box;
    const done = this.tool;
    this.tool = null;
    this.buf = null;
    if (x1 < x0) {
      this.start = null;
      return false;
    }
    this.record(canvas, ctx, this.start, x0, y0, x1, y1);
    this.start = null;
    if (done === 'erase') this.maskUsed = true;
    return true;
  }

  /** Abandon the current stroke, putting the pixels back. */
  cancel() {
    if (!this.tool || !this.start) return;
    const ctx = this.tool === 'smudge' ? this.sctx : this.mctx;
    ctx.putImageData(this.start, 0, 0);
    this.tool = null;
    this.start = null;
    this.buf = null;
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    s.canvas.getContext('2d')!.putImageData(s.before, s.x, s.y);
    this.redoStack.push(s);
    return true;
  }

  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    s.canvas.getContext('2d')!.putImageData(s.after, s.x, s.y);
    this.undoStack.push(s);
    if (s.canvas === this.mask) this.maskUsed = true;
    return true;
  }

  /** Erased area at a trace size: 1 where erased. Null when nothing is erased. */
  maskAt(w: number, h: number): Uint8Array | null {
    if (!this.maskUsed) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.mask, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    let any = false;
    for (let i = 0; i < out.length; i++) {
      if (data[i * 4 + 3] >= 128) {
        out[i] = 1;
        any = true;
      }
    }
    return any ? out : null;
  }

  // ----- area selections -----

  /** Erase inside (or, inverted, outside) a lasso drawn in layer pixels. */
  lasso(points: { x: number; y: number }[], invert: boolean): boolean {
    if (points.length < 3) return false;
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fill();
    const a = ctx.getImageData(0, 0, this.width, this.height).data;
    const sel = new Uint8Array(this.width * this.height);
    for (let i = 0; i < sel.length; i++) sel[i] = a[i * 4 + 3] >= 128 ? 1 : 0;
    return this.eraseSelection(sel, invert);
  }

  /**
   * Smart select: the connected patch around (x, y) whose colour is within
   * `tolerance` (0–100) of the tapped pixel. Erases it, or everything else.
   */
  wand(x: number, y: number, tolerance: number, invert: boolean): boolean {
    const w = this.width;
    const h = this.height;
    const sx = Math.floor(x);
    const sy = Math.floor(y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;
    const d = this.sctx.getImageData(0, 0, w, h).data;
    const seed = (sy * w + sx) * 4;
    const [r0, g0, b0, a0] = [d[seed], d[seed + 1], d[seed + 2], d[seed + 3]];
    const lim = (tolerance / 100) * 255 * 1.2;
    const lim2 = lim * lim * 3;
    const near = (i: number) => {
      const o = i * 4;
      const dr = d[o] - r0;
      const dg = d[o + 1] - g0;
      const db = d[o + 2] - b0;
      const da = d[o + 3] - a0;
      return dr * dr + dg * dg + db * db + da * da <= lim2;
    };
    const sel = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    stack[sp++] = sy * w + sx;
    sel[sy * w + sx] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const nb = [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < w * (h - 1) ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && !sel[q] && near(q)) {
          sel[q] = 1;
          stack[sp++] = q;
        }
      }
    }
    return this.eraseSelection(sel, invert);
  }

  private eraseSelection(sel: Uint8Array, invert: boolean): boolean {
    const w = this.width;
    const h = this.height;
    const start = this.mctx.getImageData(0, 0, w, h);
    const next = new ImageData(new Uint8ClampedArray(start.data), w, h);
    const m = next.data;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let i = 0; i < sel.length; i++) {
      if (!sel[i] === !invert) continue; // keep: not selected (or selected, when inverted)
      const o = i * 4;
      if (m[o + 3] === 255) continue; // already erased
      m[o] = TINT[0];
      m[o + 1] = TINT[1];
      m[o + 2] = TINT[2];
      m[o + 3] = 255;
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) return false;
    this.mctx.putImageData(next, 0, 0);
    this.record(this.mask, this.mctx, start, x0, y0, x1 + 1, y1 + 1);
    this.maskUsed = true;
    return true;
  }

  /** Push an undo step for the changed box, given the full image from before. */
  private record(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, start: ImageData, x0: number, y0: number, x1: number, y1: number) {
    const x = Math.max(0, Math.floor(x0));
    const y = Math.max(0, Math.floor(y0));
    const w = Math.min(this.width, Math.ceil(x1)) - x;
    const h = Math.min(this.height, Math.ceil(y1)) - y;
    if (w <= 0 || h <= 0) return;
    const before = new ImageData(w, h);
    for (let row = 0; row < h; row++) {
      const from = ((y + row) * this.width + x) * 4;
      before.data.set(start.data.subarray(from, from + w * 4), row * w * 4);
    }
    this.undoStack.push({ canvas, x, y, before, after: ctx.getImageData(x, y, w, h) });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  // ----- brushes -----

  private grow(x0: number, y0: number, x1: number, y1: number) {
    const b = this.box;
    b.x0 = Math.min(b.x0, x0);
    b.y0 = Math.min(b.y0, y0);
    b.x1 = Math.max(b.x1, x1);
    b.y1 = Math.max(b.y1, y1);
  }

  private dab(x: number, y: number) {
    const r = this.radius;
    this.grow(x - r - 1, y - r - 1, x + r + 1, y + r + 1);
    if (this.tool === 'erase') {
      const ctx = this.mctx;
      ctx.fillStyle = MASK_TINT;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    this.smudgeDab(x, y);
  }

  /** Fill the smudge buffer with the pixels under the brush. */
  private pickUp(cx: number, cy: number) {
    const r = Math.ceil(this.radius);
    const size = 2 * r + 1;
    const x0 = Math.round(cx) - r;
    const y0 = Math.round(cy) - r;
    const img = this.readClamped(x0, y0, size);
    this.buf = new Float32Array(img.length);
    this.buf.set(img);
  }

  /** Pixels of a size × size square, edges clamped to the image. */
  private readClamped(x0: number, y0: number, size: number): Uint8ClampedArray {
    const sx = Math.max(0, x0);
    const sy = Math.max(0, y0);
    const ex = Math.min(this.width, x0 + size);
    const ey = Math.min(this.height, y0 + size);
    const out = new Uint8ClampedArray(size * size * 4);
    if (ex <= sx || ey <= sy) return out;
    const part = this.sctx.getImageData(sx, sy, ex - sx, ey - sy);
    const pw = ex - sx;
    for (let j = 0; j < size; j++) {
      const yy = Math.min(ey - 1, Math.max(sy, y0 + j)) - sy;
      for (let i = 0; i < size; i++) {
        const xx = Math.min(ex - 1, Math.max(sx, x0 + i)) - sx;
        const from = (yy * pw + xx) * 4;
        const to = (j * size + i) * 4;
        out[to] = part.data[from];
        out[to + 1] = part.data[from + 1];
        out[to + 2] = part.data[from + 2];
        out[to + 3] = part.data[from + 3];
      }
    }
    return out;
  }

  private smudgeDab(cx: number, cy: number) {
    const buf = this.buf;
    if (!buf) return;
    const r = Math.ceil(this.radius);
    const size = 2 * r + 1;
    const x0 = Math.round(cx) - r;
    const y0 = Math.round(cy) - r;
    const sx = Math.max(0, x0);
    const sy = Math.max(0, y0);
    const ex = Math.min(this.width, x0 + size);
    const ey = Math.min(this.height, y0 + size);
    if (ex <= sx || ey <= sy) return;
    const part = this.sctx.getImageData(sx, sy, ex - sx, ey - sy);
    const d = part.data;
    const pw = ex - sx;
    const s = this.strength;
    for (let yy = sy; yy < ey; yy++) {
      for (let xx = sx; xx < ex; xx++) {
        const dx = xx - cx;
        const dy = yy - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) / this.radius;
        if (dist >= 1) continue;
        const f = 1 - dist * dist; // soft edge
        const a = s * f;
        const o = ((yy - sy) * pw + (xx - sx)) * 4;
        const b = ((yy - y0) * size + (xx - x0)) * 4;
        for (let c = 0; c < 4; c++) {
          const dst = d[o + c];
          d[o + c] = dst + (buf[b + c] - dst) * a;
          // The brush slowly picks up what it passes over, so colour trails off.
          buf[b + c] += (dst - buf[b + c]) * (1 - s) * f * 0.5;
        }
      }
    }
    this.sctx.putImageData(part, sx, sy);
  }
}
