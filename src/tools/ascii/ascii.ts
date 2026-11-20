// ASCII art engine: samples a picture or video frame into a grid of cells,
// maps each cell's brightness to a character, and draws the result on a canvas.
// Everything runs in the browser.

export type CharsetId = 'standard' | 'detailed' | 'blocks' | 'minimal' | 'custom';
export type Ink = 'mono' | 'colour' | 'green' | 'amber';
export type Paper = 'dark' | 'light';

/** Character ramps, from empty to dense. */
export const CHARSETS: Record<Exclude<CharsetId, 'custom'>, string> = {
  standard: ' .:-=+*#%@',
  detailed: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  blocks: ' ░▒▓█',
  minimal: ' .:oO@',
};

/** Shade of each block character, for drawing them as filled cells. */
const BLOCK_ALPHA: Record<string, number> = { '░': 0.25, '▒': 0.5, '▓': 0.75, '█': 1 };

// Output colours. These are the user's exported picture rather than page chrome,
// so they stay fixed whatever the site theme is (they match the theme tokens).
export const PAPER: Record<Paper, string> = { dark: '#0d0e11', light: '#ffffff' };
const INK: Record<Paper, Record<Exclude<Ink, 'colour'>, string>> = {
  dark: { mono: '#ecedef', green: '#3dff7a', amber: '#ffe14d' },
  light: { mono: '#14161a', green: '#0a7a33', amber: '#8a6400' },
};

export const FONT_FAMILY = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace";
/** Cell width as a share of the font size (JetBrains Mono advance is 0.6em). */
export const CELL_W = 0.6;
/** Line height as a share of the font size. */
export const CELL_H = 1.0;

export interface Settings {
  cols: number;
  charset: CharsetId;
  custom: string;
  ink: Ink;
  paper: Paper;
  invert: boolean;
  /** 1 = unchanged. */
  contrast: number;
  /** -1..1, 0 = unchanged. */
  brightness: number;
}

export interface Grid {
  cols: number;
  rows: number;
  lines: string[];
  /** RGBA per cell (from the sampled picture), for colour output. */
  rgba: Uint8ClampedArray;
}

export function ramp(s: Settings): string {
  if (s.charset !== 'custom') return CHARSETS[s.charset];
  const chars = Array.from(s.custom.replace(/[\r\n\t]/g, ''));
  return chars.length >= 2 ? chars.join('') : chars.length === 1 ? ` ${chars[0]}` : CHARSETS.standard;
}

export function rowsFor(cols: number, w: number, h: number): number {
  return Math.max(1, Math.round(cols * (h / w) * (CELL_W / CELL_H)));
}

export class AsciiEngine {
  private sample = document.createElement('canvas');
  private sctx = this.sample.getContext('2d', { willReadFrequently: true })!;
  private ink = document.createElement('canvas');
  private ictx = this.ink.getContext('2d')!;
  grid: Grid | null = null;

  /** Samples `source` (w × h) into a grid of characters. */
  sampleFrom(source: CanvasImageSource, w: number, h: number, s: Settings): Grid {
    const cols = Math.max(1, Math.round(s.cols));
    const rows = rowsFor(cols, w, h);
    if (this.sample.width !== cols || this.sample.height !== rows) {
      this.sample.width = cols;
      this.sample.height = rows;
    }
    const c = this.sctx;
    // Transparent parts read as the paper colour, so they become empty cells.
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = PAPER[s.paper];
    c.fillRect(0, 0, cols, rows);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(source, 0, 0, w, h, 0, 0, cols, rows);
    const rgba = c.getImageData(0, 0, cols, rows).data;

    const chars = Array.from(ramp(s));
    const n = chars.length;
    // On dark paper bright cells get dense characters; on light paper, dark cells do.
    const brightIsDense = (s.paper === 'dark') !== s.invert;
    const lines: string[] = new Array(rows);
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        let l = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
        l = (l - 0.5) * s.contrast + 0.5 + s.brightness;
        l = l < 0 ? 0 : l > 1 ? 1 : l;
        const t = brightIsDense ? l : 1 - l;
        line += chars[Math.min(n - 1, Math.round(t * (n - 1)))];
      }
      lines[y] = line;
    }
    this.grid = { cols, rows, lines, rgba };
    return this.grid;
  }

  /** Pixel size of the drawn grid at a font size. */
  static size(grid: { cols: number; rows: number }, font: number) {
    return { w: Math.ceil(grid.cols * font * CELL_W), h: Math.ceil(grid.rows * font * CELL_H) };
  }

  /** Draws the last sampled grid onto `out` at `font` px, resizing it to fit. */
  draw(out: HTMLCanvasElement, font: number, s: Settings, size?: { w: number; h: number }) {
    const g = this.grid;
    if (!g) return;
    const { w, h } = size ?? AsciiEngine.size(g, font);
    if (out.width !== w || out.height !== h) {
      out.width = w;
      out.height = h;
    }
    const ctx = out.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAPER[s.paper];
    ctx.fillRect(0, 0, w, h);
    // Centre the grid if the canvas is a little bigger (even sizes for video).
    const gw = g.cols * font * CELL_W;
    const gh = g.rows * font * CELL_H;
    const ox = (w - gw) / 2;
    const oy = (h - gh) / 2;

    if (s.ink === 'colour') {
      if (this.ink.width !== w || this.ink.height !== h) {
        this.ink.width = w;
        this.ink.height = h;
      }
      const ic = this.ictx;
      ic.setTransform(1, 0, 0, 1, 0, 0);
      ic.globalCompositeOperation = 'source-over';
      ic.clearRect(0, 0, w, h);
      this.glyphs(ic, g, font, '#fff', ox, oy, s);
      // Tint the white glyphs with each cell's colour.
      ic.globalCompositeOperation = 'source-in';
      ic.imageSmoothingEnabled = false;
      ic.drawImage(this.sample, ox, oy, gw, gh);
      ic.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.ink, 0, 0);
    } else {
      this.glyphs(ctx, g, font, INK[s.paper][s.ink], ox, oy, s);
    }
  }

  private glyphs(ctx: CanvasRenderingContext2D, g: Grid, font: number, color: string, ox: number, oy: number, s: Settings) {
    const cw = font * CELL_W;
    const ch = font * CELL_H;
    ctx.fillStyle = color;
    const chars = ramp(s);

    if (s.charset === 'blocks') {
      // Block glyphs aren't in the web font, so draw them as shaded cells.
      for (const [glyph, alpha] of Object.entries(BLOCK_ALPHA)) {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (let y = 0; y < g.rows; y++) {
          const line = g.lines[y];
          let x = 0;
          while (x < g.cols) {
            if (line[x] !== glyph) {
              x++;
              continue;
            }
            const start = x;
            while (x < g.cols && line[x] === glyph) x++;
            ctx.rect(ox + start * cw, oy + y * ch, (x - start) * cw + 0.5, ch + 0.5);
          }
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }

    ctx.font = `500 ${font}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const ascii = /^[\x20-\x7e]*$/.test(chars);
    if (ascii) {
      // One call per row; the font is monospaced, so columns line up.
      const natural = ctx.measureText('M'.repeat(10)).width / 10;
      const squeeze = natural > 0 ? cw / natural : 1;
      for (let y = 0; y < g.rows; y++) {
        const cy = oy + y * ch + ch / 2;
        if (Math.abs(squeeze - 1) < 0.01) ctx.fillText(g.lines[y], ox, cy);
        else ctx.fillText(g.lines[y], ox, cy, g.cols * cw);
      }
    } else {
      // Other characters may come from a fallback font with another width:
      // place each one in its own cell.
      ctx.textAlign = 'center';
      for (let y = 0; y < g.rows; y++) {
        const cells = Array.from(g.lines[y]);
        const cy = oy + y * ch + ch / 2;
        for (let x = 0; x < cells.length; x++) {
          if (cells[x] !== ' ') ctx.fillText(cells[x], ox + x * cw + cw / 2, cy, cw * 1.2);
        }
      }
    }
  }
}

/** The grid as plain text. */
export function toText(g: Grid): string {
  return g.lines.map((l) => l.replace(/\s+$/, '')).join('\n') + '\n';
}

const esc = (c: string) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c);
const hex = (n: number) => n.toString(16).padStart(2, '0');

/** A standalone HTML page with the art in a <pre>, coloured per character when ink is colour. */
export function toHtml(g: Grid, s: Settings, title: string): string {
  const fg = s.ink === 'colour' ? INK[s.paper].mono : INK[s.paper][s.ink];
  let body = '';
  for (let y = 0; y < g.rows; y++) {
    const cells = Array.from(g.lines[y]);
    if (s.ink !== 'colour') {
      body += cells.map(esc).join('');
    } else {
      // Group runs of similar colour into one span (colours rounded to 16 steps).
      let run = '';
      let runColor = '';
      for (let x = 0; x < cells.length; x++) {
        const i = (y * g.cols + x) * 4;
        const q = (v: number) => hex(Math.min(255, Math.round(v / 17) * 17));
        const color = cells[x] === ' ' ? runColor : `#${q(g.rgba[i])}${q(g.rgba[i + 1])}${q(g.rgba[i + 2])}`;
        if (color !== runColor && run) {
          body += runColor ? `<span style="color:${runColor}">${run}</span>` : run;
          run = '';
        }
        runColor = color;
        run += esc(cells[x]);
      }
      if (run) body += runColor ? `<span style="color:${runColor}">${run}</span>` : run;
    }
    body += '\n';
  }
  const safeTitle = title.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  html, body { margin: 0; background: ${PAPER[s.paper]}; }
  pre { margin: 0; padding: 16px; color: ${fg}; font: 500 10px/1 ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace; letter-spacing: 0; white-space: pre; }
</style>
</head>
<body>
<pre>
${body}</pre>
</body>
</html>
`;
}

/** Best video format MediaRecorder can write here, MP4 first. */
export function pickVideoType(): { mime: string; ext: 'mp4' | 'webm' } | null {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
  const options: [string, 'mp4' | 'webm'][] = [
    ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'mp4'],
    ['video/mp4;codecs=avc1', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [mime, ext] of options) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
    } catch {
      /* try the next one */
    }
  }
  return null;
}
