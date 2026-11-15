import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canShareFiles, canvasToBlob, downloadBlob, loadImageFile, type LoadedImage } from '../shared/image';
import {
  DEFAULT_VIEW,
  MAX_ZOOM,
  TEMPLATES,
  UNIT_RECT,
  bbox,
  cellBox,
  centroid,
  clampView,
  cutCells,
  drawCollage,
  insetCell,
  newId,
  pointInConvex,
  previewCut,
  roundedPath,
  templateCells,
  type Cell,
  type Pt,
  type Template,
} from './geometry';
import '../shared/tool.css';
import './collage.css';

type Mode = 'photos' | 'draw';

const RATIOS = [
  { key: '1:1', r: 1, label: 'Square 1:1' },
  { key: '4:5', r: 4 / 5, label: 'Portrait 4:5' },
  { key: '3:4', r: 3 / 4, label: 'Portrait 3:4' },
  { key: '2:3', r: 2 / 3, label: 'Portrait 2:3' },
  { key: '9:16', r: 9 / 16, label: 'Story 9:16' },
  { key: '4:3', r: 4 / 3, label: 'Landscape 4:3' },
  { key: '3:2', r: 3 / 2, label: 'Landscape 3:2' },
  { key: '16:9', r: 16 / 9, label: 'Wide 16:9' },
];
const BACKGROUNDS = [
  { value: '#ffffff', label: 'White' },
  { value: '#f4efe4', label: 'Cream' },
  { value: '#0d0e11', label: 'Black' },
  { value: '#ffe14d', label: 'Yellow' },
  { value: 'transparent', label: 'Transparent' },
];
const SIZES = [1080, 2048, 3072];
const PLACEHOLDER = '#262a32';
const ACCENT = '#FFE14D';
const DRAW_MIN = 16; // px a stroke must travel to count as a cut
const SNAP_ANGLE = Math.tan((7 * Math.PI) / 180);
const SNAP_PX = 10;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const DEFAULT_TEMPLATE = TEMPLATES[0];

/** Straightens near-level strokes and lines them up with existing edges. */
function snapLine(a: Pt, b: Pt, w: number, h: number, cells: Cell[]): [Pt, Pt] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const targets = (axis: 'x' | 'y', size: number) => {
    const t = [size / 3, size / 2, (2 * size) / 3];
    for (const c of cells) for (const p of c.poly) t.push(p[axis] * size);
    return t;
  };
  const snapTo = (v: number, list: number[]) => {
    let best = v;
    let bestD = SNAP_PX;
    for (const t of list) {
      const d = Math.abs(t - v);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  };
  if (Math.abs(dy) <= Math.abs(dx) * SNAP_ANGLE) {
    const y = snapTo((a.y + b.y) / 2, targets('y', h));
    return [{ x: a.x, y }, { x: b.x, y }];
  }
  if (Math.abs(dx) <= Math.abs(dy) * SNAP_ANGLE) {
    const x = snapTo((a.x + b.x) / 2, targets('x', w));
    return [{ x, y: a.y }, { x, y: b.y }];
  }
  return [a, b];
}

type Drag =
  | { kind: 'draw'; a: Pt }
  | { kind: 'pan'; id: string; last: Pt }
  | null;

export default function Collage() {
  const [ratioKey, setRatioKey] = useState('1:1');
  const [cells, setCells] = useState<Cell[]>(() => templateCells(DEFAULT_TEMPLATE));
  const [templateId, setTemplateId] = useState<string | null>(DEFAULT_TEMPLATE.id);
  const [history, setHistory] = useState<Cell[][]>([]);
  const [images, setImages] = useState<Record<string, LoadedImage>>({});
  const [mode, setMode] = useState<Mode>('photos');
  const [selected, setSelected] = useState<string | null>(null);
  const [swapFrom, setSwapFrom] = useState<string | null>(null);
  const [gap, setGap] = useState(0.015);
  const [radius, setRadius] = useState(0);
  const [bg, setBg] = useState('#ffffff');
  const [size, setSize] = useState(2048);
  const [format, setFormat] = useState<'png' | 'jpeg'>('jpeg');
  const [draft, setDraft] = useState<[Pt, Pt] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [shareable, setShareable] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const [maxH, setMaxH] = useState(560);
  const ratio = RATIOS.find((r) => r.key === ratioKey)?.r ?? 1;
  // The box takes the canvas ratio, capped so tall canvases still fit on screen.
  const boxH = Math.round(Math.min(box.w / ratio, maxH));
  const stageW = Math.max(0, Math.min(box.w, boxH * ratio));
  const stageH = ratio ? stageW / ratio : 0;

  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const targetCell = useRef<string | null>(null);
  const drag = useRef<Drag>(null);

  useEffect(() => setShareable(canShareFiles()), []);

  // Object URLs are freed when the tool unmounts; undo can bring a removed photo back.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => Object.values(imagesRef.current).forEach((i) => URL.revokeObjectURL(i.url)), []);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ w: width, h: height });
    });
    ro.observe(el);
    const fit = () => setMaxH(Math.max(280, window.innerHeight * (window.innerWidth <= 640 ? 0.62 : 0.72)));
    fit();
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);

  // ----- layout changes (undoable) -----

  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const commit = useCallback((next: Cell[]) => {
    const prev = cellsRef.current;
    setHistory((h) => [...h.slice(-39), prev]);
    cellsRef.current = next;
    setCells(next);
  }, []);

  /** Moves photos into a new layout in reading order. */
  const carryPhotos = (from: Cell[], to: Cell[]) => {
    const photos = from.filter((c) => c.img).map((c) => c.img);
    return to.map((c, i) => ({ ...c, img: photos[i] ?? null, view: DEFAULT_VIEW }));
  };

  const applyTemplate = (t: Template) => {
    commit(carryPhotos(cells, templateCells(t)));
    setTemplateId(t.id);
    setSelected(null);
    setSwapFrom(null);
  };

  const startDrawing = () => {
    const first = cells.find((c) => c.img)?.img ?? null;
    commit([{ id: newId(), poly: UNIT_RECT, img: first, view: DEFAULT_VIEW }]);
    setTemplateId(null);
    setMode('draw');
    setSelected(null);
    setSwapFrom(null);
  };

  const undo = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setCells(prev);
    setTemplateId(null);
    setSelected(null);
    setSwapFrom(null);
  };

  const changeMode = (m: Mode) => {
    setMode(m);
    setSelected(null);
    setSwapFrom(null);
    setDraft(null);
    drag.current = null;
  };

  // ----- photos -----

  const addFiles = useCallback(async (files: File[], target: string | null) => {
    const list = files.filter((f) => !f.type || f.type.startsWith('image/'));
    if (!list.length) return;
    setNote(null);
    const loaded: LoadedImage[] = [];
    let failed = 0;
    for (const f of list) {
      try {
        loaded.push(await loadImageFile(f, f.name || 'photo'));
      } catch {
        failed++;
      }
    }
    if (!loaded.length) {
      setNote("Couldn't open that file. Try a JPG, PNG or WebP image.");
      return;
    }
    const ids = loaded.map(() => newId());
    setImages((prev) => {
      const next = { ...prev };
      loaded.forEach((img, i) => (next[ids[i]] = img));
      return next;
    });
    const queue = [...ids];
    const out = cellsRef.current.map((c) => ({ ...c }));
    const place = (c: Cell) => {
      c.img = queue.shift()!;
      c.view = DEFAULT_VIEW;
    };
    const t = target ? out.find((c) => c.id === target) : null;
    if (t && queue.length) place(t);
    for (const c of out) if (!c.img && queue.length) place(c);
    const left = queue.length;
    cellsRef.current = out;
    setCells(out);
    const msgs: string[] = [];
    if (left) msgs.push(`${left} photo${left > 1 ? 's' : ''} didn't fit. Pick a template with more cells, or draw more lines.`);
    if (failed) msgs.push(`${failed} file${failed > 1 ? 's' : ''} couldn't be opened.`);
    if (msgs.length) setNote(msgs.join(' '));
  }, []);

  const pickFor = (id: string | null) => {
    targetCell.current = id;
    fileRef.current?.click();
  };

  const updateCell = (id: string, fn: (c: Cell) => Cell) => setCells((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));

  const removePhoto = (id: string) => updateCell(id, (c) => ({ ...c, img: null, view: DEFAULT_VIEW }));

  const swap = (a: string, b: string) => {
    setCells((cs) => {
      const ca = cs.find((c) => c.id === a);
      const cb = cs.find((c) => c.id === b);
      if (!ca || !cb) return cs;
      return cs.map((c) =>
        c.id === a ? { ...c, img: cb.img, view: DEFAULT_VIEW } : c.id === b ? { ...c, img: ca.img, view: DEFAULT_VIEW } : c
      );
    });
  };

  // Paste goes into the selected cell, else the first empty ones.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length) addFiles(files, selectedRef.current);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  // ----- geometry in stage pixels -----

  const toNorm = (p: Pt): Pt => ({ x: p.x / stageW, y: p.y / stageH });
  const cellAt = (p: Pt) => cells.find((c) => pointInConvex(c.poly, toNorm(p))) ?? null;
  const boxOf = (c: Cell) => cellBox(c, stageW, stageH, gap);

  const panCell = (id: string, dx: number, dy: number) =>
    updateCell(id, (c) => {
      const img = c.img ? imagesRef.current[c.img] : null;
      if (!img) return c;
      const b = boxOf(c);
      const v = clampView(c.view, img, b.w, b.h);
      return { ...c, view: clampView({ ...v, ox: v.ox + dx / b.w, oy: v.oy + dy / b.h }, img, b.w, b.h) };
    });

  /** Zooms a cell's photo by `f`, keeping the stage point p still. */
  const zoomCell = (id: string, p: Pt, f: number) =>
    updateCell(id, (c) => {
      const img = c.img ? imagesRef.current[c.img] : null;
      if (!img) return c;
      const b = boxOf(c);
      const v = clampView(c.view, img, b.w, b.h);
      const zoom = clamp(v.zoom * f, 1, MAX_ZOOM);
      const k = zoom / v.zoom;
      const ux = p.x - (b.x + b.w / 2);
      const uy = p.y - (b.y + b.h / 2);
      const cx = ux - (ux - v.ox * b.w) * k;
      const cy = uy - (uy - v.oy * b.h) * k;
      return { ...c, view: clampView({ zoom, ox: cx / b.w, oy: cy / b.h }, img, b.w, b.h) };
    });

  const finishCut = (a: Pt, b: Pt) => {
    setDraft(null);
    if (Math.hypot(b.x - a.x, b.y - a.y) < DRAW_MIN) return;
    const [sa, sb] = snapLine(a, b, stageW, stageH, cells);
    const res = cutCells(cells, toNorm(sa), toNorm(sb), ratio);
    if (res.changed) {
      commit(res.cells);
      setTemplateId(null);
    }
  };

  const tapCell = (c: Cell | null) => {
    if (!c) return;
    if (swapFrom) {
      if (swapFrom !== c.id) swap(swapFrom, c.id);
      setSwapFrom(null);
      setSelected(c.id);
      return;
    }
    setSelected(c.id);
  };

  // Handlers read the latest state through this ref, so the native touch
  // listeners can be attached once.
  const api = useRef({ cellAt, panCell, zoomCell, finishCut, tapCell, setSelected, setDraft, mode, cells, stageW, stageH, swapFrom });
  api.current = { cellAt, panCell, zoomCell, finishCut, tapCell, setSelected, setDraft, mode, cells, stageW, stageH, swapFrom };

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Mouse and pen use pointer events. Touch uses the native listeners below,
  // because iOS Safari doesn't reliably honour `touch-action: none` and cancels
  // pointers to scroll or zoom the page.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as Element).closest('button')) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
    const p = local(e);
    if (mode === 'draw') {
      drag.current = { kind: 'draw', a: p };
      setDraft([p, p]);
      return;
    }
    const c = cellAt(p);
    if (swapFrom) {
      tapCell(c);
      drag.current = null;
      return;
    }
    setSelected(c?.id ?? null);
    drag.current = c?.img ? { kind: 'pan', id: c.id, last: p } : null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerType === 'touch') return;
    const p = local(e);
    if (d.kind === 'draw') setDraft(snapLine(d.a, p, stageW, stageH, cells));
    else {
      panCell(d.id, p.x - d.last.x, p.y - d.last.y);
      d.last = p;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerType === 'touch') return;
    drag.current = null;
    if (d.kind === 'draw') finishCut(d.a, local(e));
  };

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let last: Pt[] = [];
    let start: Pt | null = null;
    let moved = false;
    let fingers = 0; // most fingers seen in this gesture
    let cellId: string | null = null;
    const points = (e: TouchEvent): Pt[] => {
      const r = el.getBoundingClientRect();
      return Array.from(e.touches)
        .slice(0, 2)
        .map((t) => ({ x: t.clientX - r.left, y: t.clientY - r.top }));
    };
    const onStart = (e: TouchEvent) => {
      // Let the "add photo" buttons on the stage get their normal click.
      if ((e.target as Element).closest('button')) return;
      e.preventDefault();
      const a = api.current;
      const pts = points(e);
      if (e.touches.length === 1) {
        start = pts[0];
        moved = false;
        fingers = 1;
        if (a.mode === 'draw') {
          a.setDraft([pts[0], pts[0]]);
        } else {
          const c = a.cellAt(pts[0]);
          cellId = c?.id ?? null;
          if (!a.swapFrom) a.setSelected(cellId);
        }
      } else {
        fingers = Math.max(fingers, e.touches.length);
        if (a.mode === 'draw') {
          start = null; // a second finger cancels the stroke
          a.setDraft(null);
        } else if (!cellId && pts.length === 2) {
          cellId = a.cellAt({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 })?.id ?? null;
        }
      }
      last = pts;
    };
    const onMove = (e: TouchEvent) => {
      if (!last.length) return;
      e.preventDefault();
      const a = api.current;
      const cur = points(e);
      if (start && Math.hypot(cur[0].x - start.x, cur[0].y - start.y) > 6) moved = true;
      if (a.mode === 'draw') {
        if (start && cur.length === 1) a.setDraft(snapLine(start, cur[0], a.stageW, a.stageH, a.cells));
      } else if (cellId) {
        if (cur.length === 1 && last.length === 1) {
          a.panCell(cellId, cur[0].x - last[0].x, cur[0].y - last[0].y);
        } else if (cur.length === 2 && last.length === 2) {
          const midPrev = { x: (last[0].x + last[1].x) / 2, y: (last[0].y + last[1].y) / 2 };
          const midCur = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 };
          const dPrev = Math.hypot(last[0].x - last[1].x, last[0].y - last[1].y);
          const dCur = Math.hypot(cur[0].x - cur[1].x, cur[0].y - cur[1].y);
          if (dPrev > 0) a.zoomCell(cellId, midCur, dCur / dPrev);
          a.panCell(cellId, midCur.x - midPrev.x, midCur.y - midPrev.y);
        }
      }
      last = cur;
    };
    const onEnd = (e: TouchEvent) => {
      if (!last.length) return;
      const a = api.current;
      if (e.touches.length === 0) {
        const end = last[0];
        if (a.mode === 'draw') {
          if (start && fingers === 1) a.finishCut(start, end);
          else a.setDraft(null);
        } else if (!moved && fingers === 1) {
          a.tapCell(a.cells.find((c) => c.id === cellId) ?? null);
        }
        start = null;
        cellId = null;
        last = [];
        return;
      }
      last = points(e);
    };
    const onCancel = () => {
      api.current.setDraft(null);
      start = null;
      cellId = null;
      last = [];
    };
    // Safari's own pinch gesture events would otherwise zoom the whole page.
    const blockGesture = (e: Event) => e.preventDefault();
    const opts = { passive: false } as const;
    el.addEventListener('touchstart', onStart, opts);
    el.addEventListener('touchmove', onMove, opts);
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onCancel);
    el.addEventListener('gesturestart', blockGesture, opts);
    el.addEventListener('gesturechange', blockGesture, opts);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
      el.removeEventListener('gesturestart', blockGesture);
      el.removeEventListener('gesturechange', blockGesture);
    };
  }, []);

  // Wheel zooms the photo under the cursor.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const a = api.current;
      if (a.mode !== 'photos') return;
      const r = el.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      const c = a.cellAt(p);
      if (!c?.img) return;
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      a.zoomCell(c.id, p, Math.exp(-delta * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ----- editor rendering -----

  const transparent = bg === 'transparent';
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stageW || !stageH) return;
    const frame = requestAnimationFrame(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(stageW * dpr);
      canvas.height = Math.round(stageH * dpr);
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawCollage(ctx, stageW, stageH, cells, images, {
        gap,
        radius,
        bg: transparent ? null : bg,
        placeholder: PLACEHOLDER,
      });
      const short = Math.min(stageW, stageH);
      if (mode === 'draw') {
        // Show every cell edge so lines can be placed even when gap is 0.
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 225, 77, 0.55)';
        ctx.setLineDash([5, 4]);
        for (const c of cells) {
          roundedPath(ctx, insetCell(c.poly, stageW, stageH, 0), 0);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        if (draft) {
          const [a, b] = draft;
          const chords = previewCut(cells, toNorm(a), toNorm(b), ratio);
          ctx.lineWidth = 3;
          ctx.strokeStyle = ACCENT;
          for (const [p, q] of chords) {
            ctx.beginPath();
            ctx.moveTo(p.x * stageW, p.y * stageH);
            ctx.lineTo(q.x * stageW, q.y * stageH);
            ctx.stroke();
          }
          ctx.fillStyle = ACCENT;
          for (const p of draft) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else {
        const ring = (id: string | null, dashed: boolean) => {
          const c = id ? cells.find((x) => x.id === id) : null;
          if (!c) return;
          roundedPath(ctx, insetCell(c.poly, stageW, stageH, gap * short), radius * short);
          ctx.lineWidth = 3;
          ctx.strokeStyle = ACCENT;
          ctx.setLineDash(dashed ? [8, 6] : []);
          ctx.stroke();
          ctx.setLineDash([]);
        };
        ring(selected, false);
        if (swapFrom !== selected) ring(swapFrom, true);
      }
    });
    return () => cancelAnimationFrame(frame);
    // toNorm depends only on stageW/stageH, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, images, stageW, stageH, gap, radius, bg, transparent, mode, selected, swapFrom, draft, ratio]);

  // ----- export -----

  const outW = ratio >= 1 ? size : Math.round(size * ratio);
  const outH = ratio >= 1 ? Math.round(size / ratio) : size;
  const filled = cells.filter((c) => c.img && images[c.img]).length;
  const empty = cells.length - filled;
  const ext = format === 'png' ? 'png' : 'jpg';
  const fileName = `collage-${outW}x${outH}.${ext}`;

  const exportBlob = async () => {
    const c = document.createElement('canvas');
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('canvas');
    // JPG has no transparency, so a transparent background exports as white.
    const fill = transparent ? (format === 'png' ? null : '#ffffff') : bg;
    drawCollage(ctx, outW, outH, cells, images, { gap, radius, bg: fill, placeholder: null });
    return canvasToBlob(c, format === 'png' ? 'image/png' : 'image/jpeg', 0.92);
  };

  const onDownload = async () => {
    setBusy(true);
    try {
      downloadBlob(await exportBlob(), fileName);
    } catch {
      setNote('Export failed. Try a smaller size.');
    } finally {
      setBusy(false);
    }
  };

  const onShare = async () => {
    setBusy(true);
    try {
      const blob = await exportBlob();
      await navigator.share({ files: [new File([blob], fileName, { type: blob.type })] });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setNote('Sharing failed. Use Download instead.');
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    commit(templateCells(DEFAULT_TEMPLATE));
    setTemplateId(DEFAULT_TEMPLATE.id);
    setMode('photos');
    setSelected(null);
    setSwapFrom(null);
    setNote(null);
  };

  // ----- view -----

  const sel = selected ? cells.find((c) => c.id === selected) ?? null : null;
  const selImg = sel?.img ? images[sel.img] : null;
  const selView = sel && selImg ? (() => {
    const b = boxOf(sel);
    return clampView(sel.view, selImg, b.w, b.h);
  })() : null;
  const short = Math.min(stageW, stageH);

  return (
    <div className="cm">
      <div className="cm-stage-card">
        <div className="cm-toolbar">
          <div className="cm-seg cm-mode" role="group" aria-label="Editing mode">
            <button type="button" aria-pressed={mode === 'photos'} onClick={() => changeMode('photos')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
              Photos
            </button>
            <button type="button" aria-pressed={mode === 'draw'} onClick={() => changeMode('draw')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20L20 4" /><circle cx="4" cy="20" r="1.5" /><circle cx="20" cy="4" r="1.5" /></svg>
              Draw lines
            </button>
          </div>
          <div className="cm-tools">
            <button type="button" className="cm-icon-btn" disabled={!history.length} onClick={undo} aria-label="Undo layout change" title="Undo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
            </button>
            <button type="button" className="btn btn-ghost cm-small cm-clear" onClick={startDrawing} title="Clear lines and start from one blank cell" aria-label="Clear lines">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /></svg>
              <span>Clear lines</span>
            </button>
          </div>
        </div>

        <div ref={boxRef} className="cm-box" style={{ height: boxH || undefined }}>
          <div
            ref={stageRef}
            className={`cm-stage${transparent ? ' checker' : ''}${mode === 'draw' ? ' is-draw' : ''}`}
            style={{ width: stageW, height: stageH }}
            tabIndex={0}
            role="application"
            aria-label={
              mode === 'draw'
                ? 'Collage canvas. Drag across it to split cells with a line.'
                : 'Collage canvas. Tap a cell to select it, drag to move its photo, pinch or scroll to zoom.'
            }
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              drag.current = null;
              setDraft(null);
            }}
            onKeyDown={(e) => {
              if (!sel?.img || mode !== 'photos') return;
              const step = e.shiftKey ? 20 : 4;
              const b = boxOf(sel);
              const mid = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
              const keys: Record<string, () => void> = {
                ArrowLeft: () => panCell(sel.id, -step, 0),
                ArrowRight: () => panCell(sel.id, step, 0),
                ArrowUp: () => panCell(sel.id, 0, -step),
                ArrowDown: () => panCell(sel.id, 0, step),
                '+': () => zoomCell(sel.id, mid, 1.1),
                '=': () => zoomCell(sel.id, mid, 1.1),
                '-': () => zoomCell(sel.id, mid, 1 / 1.1),
              };
              const fn = keys[e.key];
              if (fn) {
                e.preventDefault();
                fn();
              }
            }}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const c = cellAt(local(e));
              addFiles(Array.from(e.dataTransfer.files), c?.id ?? null);
            }}
          >
            <canvas ref={canvasRef} />
            {mode === 'photos' &&
              stageW > 0 &&
              cells.map((c, i) => {
                if (c.img && images[c.img]) return null;
                const pts = insetCell(c.poly, stageW, stageH, gap * short);
                if (pts.length < 3) return null;
                const b = bbox(pts);
                const m = centroid(pts);
                const small = Math.min(b.w, b.h) < 64;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`cm-add${small ? ' is-small' : ''}`}
                    style={{ left: m.x, top: m.y }}
                    onClick={() => {
                      if (swapFrom) {
                        tapCell(c);
                        return;
                      }
                      setSelected(c.id);
                      pickFor(c.id);
                    }}
                    aria-label={`Add photo to cell ${i + 1}`}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                );
              })}
          </div>
        </div>

        <div className="cm-cellbar">
          {mode === 'draw' ? (
            <p className="cm-hint">
              Drag across the canvas to split it. Each line runs edge to edge through the cells it touches, and near-straight lines snap level.
              {' '}
              <button type="button" className="cm-link" onClick={() => changeMode('photos')}>Done drawing</button>
            </p>
          ) : swapFrom ? (
            <p className="cm-hint">
              Tap another cell to swap photos.{' '}
              <button type="button" className="cm-link" onClick={() => setSwapFrom(null)}>Cancel</button>
            </p>
          ) : sel && selImg && selView ? (
            <div className="cm-selbar">
              <label className="cm-zoom">
                <span className="mono">zoom</span>
                <input
                  type="range"
                  min={0}
                  max={Math.log(MAX_ZOOM)}
                  step={0.01}
                  value={Math.log(selView.zoom)}
                  onChange={(e) => {
                    const b = boxOf(sel);
                    zoomCell(sel.id, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, Math.exp(Number(e.target.value)) / selView.zoom);
                  }}
                  aria-label="Zoom selected photo"
                />
              </label>
              <div className="cm-selbtns">
                <button type="button" className="btn btn-ghost cm-small" onClick={() => pickFor(sel.id)}>Replace</button>
                <button type="button" className="btn btn-ghost cm-small" disabled={cells.length < 2} onClick={() => setSwapFrom(sel.id)}>Swap</button>
                <button type="button" className="btn btn-ghost cm-small" onClick={() => updateCell(sel.id, (c) => ({ ...c, view: DEFAULT_VIEW }))}>Fit</button>
                <button type="button" className="btn btn-ghost cm-small" onClick={() => removePhoto(sel.id)}>Remove</button>
              </div>
            </div>
          ) : (
            <p className="cm-hint">
              {filled === 0
                ? 'Tap + to add a photo to a cell, or add several at once from the panel.'
                : 'Tap a photo to select it. Drag to move it, pinch or scroll to zoom.'}
            </p>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            addFiles(files, targetCell.current);
          }}
        />
      </div>

      <aside className="cm-panel" aria-label="Collage settings">
        <div className="cm-field">
          <span className="cm-label mono">template</span>
          <div className="cm-templates">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className="cm-tpl"
                aria-pressed={templateId === t.id}
                aria-label={t.name}
                title={t.name}
                onClick={() => applyTemplate(t)}
              >
                <TemplateIcon t={t} />
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost cm-draw-own" onClick={startDrawing}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            Draw your own
          </button>
        </div>

        <button type="button" className="btn btn-primary" onClick={() => pickFor(null)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Add photos
        </button>

        <div className="cm-field">
          <label htmlFor="cm-ratio" className="cm-label mono">canvas</label>
          <select id="cm-ratio" value={ratioKey} onChange={(e) => setRatioKey(e.target.value)}>
            {RATIOS.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
        </div>

        <div className="cm-field">
          <label htmlFor="cm-gap" className="cm-label mono cm-row">
            <span>spacing</span>
            <span className="cm-val">{Math.round(gap * 1000) / 10}%</span>
          </label>
          <input id="cm-gap" type="range" min={0} max={0.06} step={0.001} value={gap} onChange={(e) => setGap(Number(e.target.value))} />
        </div>

        <div className="cm-field">
          <label htmlFor="cm-radius" className="cm-label mono cm-row">
            <span>corners</span>
            <span className="cm-val">{Math.round(radius * 1000) / 10}%</span>
          </label>
          <input id="cm-radius" type="range" min={0} max={0.08} step={0.001} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
        </div>

        <fieldset className="cm-field">
          <legend className="cm-label mono">background</legend>
          <div className="cm-swatches">
            {BACKGROUNDS.map((b) => (
              <button
                key={b.value}
                type="button"
                className={`cm-swatch${b.value === 'transparent' ? ' checker' : ''}`}
                style={b.value === 'transparent' ? undefined : { background: b.value }}
                aria-pressed={bg === b.value}
                aria-label={b.label}
                title={b.label}
                onClick={() => setBg(b.value)}
              />
            ))}
            <label className="cm-swatch cm-custom" title="Custom colour" aria-pressed={!BACKGROUNDS.some((b) => b.value === bg)}>
              <input
                type="color"
                value={bg.startsWith('#') ? bg : '#ffffff'}
                onChange={(e) => setBg(e.target.value)}
                aria-label="Custom background colour"
              />
            </label>
          </div>
        </fieldset>

        <div className="cm-two">
          <div className="cm-field">
            <label htmlFor="cm-size" className="cm-label mono">size</label>
            <select id="cm-size" value={size} onChange={(e) => setSize(Number(e.target.value))}>
              {SIZES.map((s) => (
                <option key={s} value={s}>{s} px</option>
              ))}
            </select>
          </div>
          <div className="cm-field">
            <label htmlFor="cm-format" className="cm-label mono">format</label>
            <select id="cm-format" value={format} onChange={(e) => setFormat(e.target.value as 'png' | 'jpeg')}>
              <option value="jpeg">JPG</option>
              <option value="png">PNG</option>
            </select>
          </div>
        </div>

        <div className="cm-result">
          <div className="cm-result-name">{fileName}</div>
          {outW} × {outH} px · {filled} of {cells.length} cells filled
          {empty > 0 && filled > 0 && <div className="cm-warn">Empty cells export as background.</div>}
          {transparent && format === 'jpeg' && <div className="cm-warn">JPG can't be transparent, so the background will be white. Pick PNG to keep it.</div>}
        </div>

        {note && (
          <p className="cm-error" role="alert">
            {note}
          </p>
        )}

        <div className="cm-actions">
          <button type="button" className="btn btn-primary" disabled={busy || filled === 0} onClick={onDownload}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            {busy ? 'Preparing…' : `Download ${ext.toUpperCase()}`}
          </button>
          {shareable && (
            <button type="button" className="btn btn-ghost" disabled={busy || filled === 0} onClick={onShare}>
              Share or save to photos
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={startOver}>
            Start over
          </button>
        </div>
      </aside>
    </div>
  );
}

function TemplateIcon({ t }: { t: Template }) {
  const [cells] = useState(() => templateCells(t));
  return (
    <svg viewBox="-2 -2 44 44" width="40" height="40" aria-hidden="true">
      {cells.map((c) => {
        const pts = insetCell(c.poly, 40, 40, 3);
        return <polygon key={c.id} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} />;
      })}
    </svg>
  );
}
