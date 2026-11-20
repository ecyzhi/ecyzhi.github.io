// Pixelation engine for the pixelate tool. Everything runs on canvases in the browser.

import type { LoadedImage } from '../shared/image';

/** Longest side and pixel budget for the working copy, so phones stay inside canvas memory limits. */
export const MAX_SIDE = 4096;
export const MAX_PIXELS = 12_600_000;

export type StrokeKind = 'paint' | 'erase' | 'clear';

/** One brush stroke in image pixels. `pts` is a flat x, y list. */
export interface Stroke {
  kind: StrokeKind;
  r: number;
  pts: number[];
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Working size for an image: the original, scaled down to fit MAX_SIDE and MAX_PIXELS. */
export function workingSize(width: number, height: number) {
  const k = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)), scaled: k < 1 };
}

/**
 * Holds the image, its pixelated copy and the brushed area.
 *
 * The brushed area is kept on the block grid (one cell per block), so a block
 * is either fully pixelated or untouched and the edges stay crisp. A cell is
 * switched on when the brush touches it. Changing the block size replays the
 * strokes onto the new grid.
 */
export class Pixelator {
  readonly w: number;
  readonly h: number;
  readonly scaled: boolean;
  readonly source: HTMLCanvasElement;
  readonly result: HTMLCanvasElement;
  private data: ImageData;
  private pix: HTMLCanvasElement;
  private tmp: HTMLCanvasElement;
  private grid: HTMLCanvasElement;
  private gridData: ImageData;
  private block = 0;
  private gw = 0;
  private gh = 0;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(img: LoadedImage) {
    const { w, h, scaled } = workingSize(img.width, img.height);
    this.w = w;
    this.h = h;
    this.scaled = scaled;
    this.source = canvas(w, h);
    const sctx = this.source.getContext('2d', { willReadFrequently: true })!;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(img.el, 0, 0, w, h);
    this.data = sctx.getImageData(0, 0, w, h);
    this.pix = canvas(w, h);
    this.tmp = canvas(w, h);
    this.result = canvas(w, h);
    this.grid = canvas(1, 1);
    this.gridData = new ImageData(1, 1);
  }

  /** Re-pixelates the image with square blocks of `block` image pixels. */
  setBlock(block: number) {
    block = Math.max(1, Math.round(block));
    if (block === this.block) return;
    this.block = block;
    const { w, h } = this;
    const gw = Math.ceil(w / block);
    const gh = Math.ceil(h / block);
    this.gw = gw;
    this.gh = gh;

    // Average each block, weighting colour by alpha so transparent pixels don't darken edges.
    const src = this.data.data;
    const small = new ImageData(gw, gh);
    const out = small.data;
    const acc = new Float64Array(gw * 5);
    const bx = new Int32Array(w);
    for (let x = 0; x < w; x++) bx[x] = (x / block) | 0;
    for (let gy = 0; gy < gh; gy++) {
      acc.fill(0);
      const y1 = Math.min(h, (gy + 1) * block);
      for (let y = gy * block; y < y1; y++) {
        let i = y * w * 4;
        for (let x = 0; x < w; x++, i += 4) {
          const a = src[i + 3];
          const j = bx[x] * 5;
          acc[j] += src[i] * a;
          acc[j + 1] += src[i + 1] * a;
          acc[j + 2] += src[i + 2] * a;
          acc[j + 3] += a;
          acc[j + 4] += 1;
        }
      }
      for (let gx = 0; gx < gw; gx++) {
        const j = gx * 5;
        const o = (gy * gw + gx) * 4;
        const sa = acc[j + 3];
        if (sa > 0) {
          out[o] = acc[j] / sa;
          out[o + 1] = acc[j + 1] / sa;
          out[o + 2] = acc[j + 2] / sa;
          out[o + 3] = sa / acc[j + 4];
        }
      }
    }
    const sc = canvas(gw, gh);
    sc.getContext('2d')!.putImageData(small, 0, 0);
    const pctx = this.pix.getContext('2d')!;
    pctx.clearRect(0, 0, w, h);
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(sc, 0, 0, gw * block, gh * block);

    // Fresh grid for the brushed area.
    this.grid.width = gw;
    this.grid.height = gh;
    this.gridData = new ImageData(gw, gh);
    this.dirty = null;
  }

  /** Rebuilds the brushed area from a stroke list. */
  replay(strokes: Stroke[]) {
    this.gridData.data.fill(0);
    for (const s of strokes) this.apply(s);
    this.dirty = { x0: 0, y0: 0, x1: this.gw, y1: this.gh };
    this.flush();
  }

  /** Applies a whole stroke without flushing. */
  private apply(s: Stroke) {
    if (s.kind === 'clear') {
      this.gridData.data.fill(0);
      return;
    }
    const p = s.pts;
    if (p.length === 2) this.mark(s, p[0], p[1], p[0], p[1]);
    for (let i = 2; i + 1 < p.length; i += 2) this.mark(s, p[i - 2], p[i - 1], p[i], p[i + 1]);
  }

  /** Adds one segment of a stroke and updates the grid. */
  segment(s: Stroke, x0: number, y0: number, x1: number, y1: number) {
    if (s.kind === 'clear') {
      this.gridData.data.fill(0);
      this.dirty = { x0: 0, y0: 0, x1: this.gw, y1: this.gh };
    } else {
      this.mark(s, x0, y0, x1, y1);
    }
    this.flush();
  }

  /** Sets or clears every grid cell the brush capsule from (x0, y0) to (x1, y1) touches. */
  private mark(s: Stroke, x0: number, y0: number, x1: number, y1: number) {
    const b = this.block;
    const { gw, gh, w, h } = this;
    const r = s.r;
    const cx0 = Math.max(0, Math.floor((Math.min(x0, x1) - r) / b));
    const cy0 = Math.max(0, Math.floor((Math.min(y0, y1) - r) / b));
    const cx1 = Math.min(gw - 1, Math.floor((Math.max(x0, x1) + r) / b));
    const cy1 = Math.min(gh - 1, Math.floor((Math.max(y0, y1) + r) / b));
    if (cx0 > cx1 || cy0 > cy1) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const r2 = r * r;
    const val = s.kind === 'paint' ? 255 : 0;
    const d = this.gridData.data;
    for (let cy = cy0; cy <= cy1; cy++) {
      const top = cy * b;
      const bottom = Math.min(h, top + b);
      const my = (top + bottom) / 2;
      for (let cx = cx0; cx <= cx1; cx++) {
        const left = cx * b;
        const right = Math.min(w, left + b);
        const mx = (left + right) / 2;
        // Point on the segment nearest the cell centre, then its distance to the cell.
        let t = len2 > 0 ? ((mx - x0) * dx + (my - y0) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = x0 + dx * t;
        const py = y0 + dy * t;
        const qx = px < left ? left - px : px > right ? px - right : 0;
        const qy = py < top ? top - py : py > bottom ? py - bottom : 0;
        if (qx * qx + qy * qy <= r2) d[(cy * gw + cx) * 4 + 3] = val;
      }
    }
    const dr = this.dirty;
    this.dirty = dr
      ? { x0: Math.min(dr.x0, cx0), y0: Math.min(dr.y0, cy0), x1: Math.max(dr.x1, cx1 + 1), y1: Math.max(dr.y1, cy1 + 1) }
      : { x0: cx0, y0: cy0, x1: cx1 + 1, y1: cy1 + 1 };
  }

  private flush() {
    const dr = this.dirty;
    if (!dr) return;
    this.grid.getContext('2d')!.putImageData(this.gridData, 0, 0, dr.x0, dr.y0, dr.x1 - dr.x0, dr.y1 - dr.y0);
    this.dirty = null;
  }

  /** True when any block is brushed. */
  hasBrushed() {
    const d = this.gridData.data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
    return false;
  }

  /** Draws the final image into `result`: all pixelated, or pixelated only where brushed. */
  compose(whole: boolean) {
    const { w, h, block, gw, gh } = this;
    const ctx = this.result.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    if (whole) {
      ctx.drawImage(this.pix, 0, 0);
      return;
    }
    // Pixelated copy cut down to the brushed blocks.
    const t = this.tmp.getContext('2d')!;
    t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, w, h);
    t.drawImage(this.pix, 0, 0);
    t.globalCompositeOperation = 'destination-in';
    t.imageSmoothingEnabled = false;
    t.drawImage(this.grid, 0, 0, gw * block, gh * block);
    // Original with those blocks cut out, then the pixelated blocks dropped in.
    ctx.drawImage(this.source, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.grid, 0, 0, gw * block, gh * block);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.tmp, 0, 0);
  }
}
