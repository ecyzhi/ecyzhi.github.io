import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { canShareFiles, canvasToBlob, downloadBlob, loadImageFile, type LoadedImage } from '../shared/image';
import {
  DEFAULT_VIEW,
  MAX_ZOOM,
  cellAt,
  clampView,
  computeLayout,
  countCells,
  drawCollage,
  drawOutline,
  matchCells,
  strokeMask,
  type Layout,
  type View,
} from './layout';
import {
  DEFAULT_TEMPLATE,
  TEMPLATES,
  TOOL_NAMES,
  control,
  createShape,
  distPx,
  edgePoints,
  fraction,
  handles,
  lineEnds,
  moveHandle,
  shapeDistPx,
  shapePath,
  shapeSizePx,
  snapPoint,
  translate,
  type HandleKey,
  type Pt,
  type Shape,
  type Snap,
  type Template,
  type Tool,
} from './shapes';
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
const GROUPS = [2, 3, 4, 5, 6, 7] as const; // 7 means "7 or more"
const RULER = 24; // px
const HANDLE_HIT = 22; // px
const TOOLS: Tool[] = ['line', 'curve', 'oval', 'circle', 'rect'];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Slot {
  img: string | null;
  view: View;
}
const EMPTY: Slot = { img: null, view: DEFAULT_VIEW };

interface Pending {
  shape: Shape;
  index: number; // the confirmed shape it replaces, or -1 for a new one
  creating: boolean; // still being dragged out
}

type PhotoDrag = { kind: 'pan'; cell: number; last: Pt } | null;
type DrawDrag =
  | { kind: 'maybe'; start: Pt; hit: number }
  | { kind: 'create'; p0: Pt }
  | { kind: 'handle'; key: HandleKey }
  | { kind: 'move'; last: Pt }
  | null;

interface Snapshot {
  shapes: Shape[];
  slots: Slot[];
}

/** Puts photos into new cells, matching each cell to the old one under it. */
function remapSlots(from: Layout, to: Layout, slots: Slot[]): { slots: Slot[]; dropped: number } {
  const match = matchCells(from, to);
  const out = to.cells.map((_, k) => (match[k] >= 0 && slots[match[k]] ? { ...slots[match[k]] } : { ...EMPTY }));
  const used = new Set(match.filter((m) => m >= 0));
  const spare = slots.filter((s, i) => s?.img && !used.has(i));
  for (const s of out) if (!s.img && spare.length) Object.assign(s, { img: spare.shift()!.img, view: DEFAULT_VIEW });
  return { slots: out, dropped: spare.length };
}

/** Moves photos into a new layout in reading order. */
function carrySlots(slots: Slot[], count: number): Slot[] {
  const imgs = slots.filter((s) => s?.img).map((s) => s.img);
  return Array.from({ length: count }, (_, i) => ({ img: imgs[i] ?? null, view: DEFAULT_VIEW }));
}

export default function Collage() {
  const [ratioKey, setRatioKey] = useState('1:1');
  const [shapes, setShapes] = useState<Shape[]>(() => DEFAULT_TEMPLATE.shapes);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(DEFAULT_TEMPLATE.id);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [images, setImages] = useState<Record<string, LoadedImage>>({});
  const [mode, setMode] = useState<Mode>('photos');
  const [selected, setSelected] = useState<number | null>(null);
  const [swapFrom, setSwapFrom] = useState<number | null>(null);
  const [gap, setGap] = useState(0.015);
  const [radius, setRadius] = useState(0);
  const [bg, setBg] = useState('#ffffff');
  const [size, setSize] = useState(2048);
  const [format, setFormat] = useState<'png' | 'jpeg'>('jpeg');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [shareable, setShareable] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [maxH, setMaxH] = useState(560);
  const [dpr, setDpr] = useState(1);

  // drawing
  const [tool, setTool] = useState<Tool>('line');
  const [ruler, setRuler] = useState(false);
  const [snapOn, setSnapOn] = useState(false);
  const [density, setDensity] = useState(4);
  const [pending, setPending] = useState<Pending | null>(null);
  const [active, setActive] = useState<Snap | null>(null);
  const [dragging, setDragging] = useState(false);
  const [nudge, setNudge] = useState(0);
  const [filter, setFilter] = useState<number | 'all'>('all');

  const ratio = RATIOS.find((r) => r.key === ratioKey)?.r ?? 1;
  const showRuler = ruler && mode === 'draw';
  const pad = showRuler ? RULER : 0;
  // The box takes the canvas ratio, capped so tall canvases still fit on screen.
  const availW = Math.max(0, box.w - pad - (mode === 'draw' ? 12 : 0));
  const boxH = Math.round(Math.min(availW / ratio, maxH - pad)) + pad;
  const stageW = Math.max(0, Math.min(availW, (boxH - pad) * ratio));
  const stageH = ratio ? stageW / ratio : 0;

  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const targetCell = useRef<number | null>(null);
  const photoDrag = useRef<PhotoDrag>(null);
  const drawDrag = useRef<DrawDrag>(null);

  useEffect(() => setShareable(canShareFiles()), []);

  // Object URLs are freed when the tool unmounts; undo can bring a removed photo back.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => Object.values(imagesRef.current).forEach((i) => URL.revokeObjectURL(i.url)), []);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    const fit = () => {
      setMaxH(Math.max(280, window.innerHeight * (window.innerWidth <= 640 ? 0.62 : 0.72)));
      setDpr(Math.min(window.devicePixelRatio || 1, 2));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);

  // ----- layouts -----

  // Full quality for display, and a lighter raster while a shape is dragged.
  const dims = (scale: number, cap: number) => {
    const s = Math.min(scale, cap / Math.max(stageW, stageH, 1));
    return [Math.max(1, Math.round(stageW * s)), Math.max(1, Math.round(stageH * s))] as const;
  };
  const [hiW, hiH] = dims(dpr, 1400);
  const [loW, loH] = dims(1, 640);

  const base = useMemo(
    () => (stageW > 0 ? computeLayout(shapes, hiW, hiH, gap, radius) : null),
    [shapes, hiW, hiH, gap, radius, stageW]
  );

  // Keep photos in their cells whenever the layout under them changes.
  const prevBase = useRef<Layout | null>(null);
  const slotMode = useRef<'remap' | 'carry' | 'keep'>('remap');
  useLayoutEffect(() => {
    const prev = prevBase.current;
    prevBase.current = base;
    if (!base) return;
    const how = slotMode.current;
    slotMode.current = 'remap';
    if (how === 'keep') {
      setSlots((s) => base.cells.map((_, k) => s[k] ?? EMPTY));
    } else if (how === 'carry' || !prev) {
      setSlots((s) => carrySlots(s, base.cells.length));
    } else if (prev !== base) {
      setSlots((s) => {
        const res = remapSlots(prev, base, s);
        if (res.dropped) setNote(`${res.dropped} photo${res.dropped > 1 ? 's' : ''} no longer had a cell and ${res.dropped > 1 ? 'were' : 'was'} taken out. Undo brings ${res.dropped > 1 ? 'them' : 'it'} back.`);
        return res.slots;
      });
    }
  }, [base]);

  const liveShapes = useMemo(() => {
    if (!pending) return shapes;
    if (pending.index < 0) return [...shapes, pending.shape];
    return shapes.map((s, i) => (i === pending.index ? pending.shape : s));
  }, [shapes, pending]);
  // Shapes other than the one being edited; line ends snap to these.
  const others = useMemo(() => (pending && pending.index >= 0 ? shapes.filter((_, i) => i !== pending.index) : shapes), [shapes, pending]);

  const live = useMemo(() => {
    if (!pending || !base) return base;
    const [w, h] = dragging ? [loW, loH] : [hiW, hiH];
    return computeLayout(liveShapes, w, h, gap, radius);
  }, [pending, base, liveShapes, dragging, loW, loH, hiW, hiH, gap, radius]);

  const liveSlots = useMemo(() => {
    if (!pending || !base || !live || live === base) return slots;
    return remapSlots(base, live, slots).slots;
  }, [pending, base, live, slots]);

  // Pixels covered by the other shapes, to tell loose line ends.
  const othersMask = useMemo(
    () => (stageW > 0 ? strokeMask(others, Math.round(stageW), Math.round(stageH), Math.max(1.5, gap * Math.min(stageW, stageH))) : null),
    [others, stageW, stageH, gap]
  );
  const mw = Math.round(stageW);
  const mh = Math.round(stageH);
  const isLoose = (p: Pt) => {
    if (!othersMask) return false;
    const x = p.x * stageW;
    const y = p.y * stageH;
    if (x < 3 || y < 3 || x > stageW - 3 || y > stageH - 3) return false;
    for (let yy = Math.round(y) - 3; yy <= Math.round(y) + 3; yy++)
      for (let xx = Math.round(x) - 3; xx <= Math.round(x) + 3; xx++)
        if (xx >= 0 && yy >= 0 && xx < mw && yy < mh && othersMask[yy * mw + xx]) return false;
    return true;
  };
  /** Follows dir from p until it meets another shape or the canvas edge. */
  const extend = (p: Pt, dir: Pt): Pt => {
    const dx = dir.x * stageW;
    const dy = dir.y * stageH;
    const l = Math.hypot(dx, dy);
    if (!l || !othersMask) return p;
    const ux = dx / l;
    const uy = dy / l;
    const sx = p.x * stageW;
    const sy = p.y * stageH;
    for (let t = 0.5; t < 2 * Math.max(stageW, stageH); t += 0.5) {
      const qx = sx + ux * t;
      const qy = sy + uy * t;
      if (qx <= 0 || qy <= 0 || qx >= stageW || qy >= stageH) {
        const tx = ux > 0 ? (stageW - sx) / ux : ux < 0 ? -sx / ux : Infinity;
        const ty = uy > 0 ? (stageH - sy) / uy : uy < 0 ? -sy / uy : Infinity;
        const te = Math.min(tx, ty);
        return { x: (sx + ux * te) / stageW, y: (sy + uy * te) / stageH };
      }
      const xi = Math.min(mw - 1, Math.floor(qx));
      const yi = Math.min(mh - 1, Math.floor(qy));
      if (othersMask[yi * mw + xi]) return { x: (qx + ux) / stageW, y: (qy + uy) / stageH };
    }
    return p;
  };

  // ----- layout changes (undoable) -----

  const snapshot = (): Snapshot => ({ shapes, slots });
  const pushHistory = () => setHistory((h) => [...h.slice(-39), snapshot()]);

  const commitShapes = (next: Shape[]) => {
    pushHistory();
    setShapes(next);
    setTemplateId(null);
    setSelected(null);
    setSwapFrom(null);
  };

  const applyTemplate = (t: Template) => {
    pushHistory();
    slotMode.current = 'carry';
    setShapes(t.shapes);
    setTemplateId(t.id);
    setPending(null);
    setSelected(null);
    setSwapFrom(null);
  };

  const clearLines = () => {
    if (!shapes.length && !pending) return;
    pushHistory();
    slotMode.current = 'carry';
    setShapes([]);
    setTemplateId(null);
    setPending(null);
    setSelected(null);
    setSwapFrom(null);
  };

  const undo = () => {
    if (pending) {
      setPending(null);
      return;
    }
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    slotMode.current = 'keep';
    setShapes(prev.shapes);
    setSlots(prev.slots);
    setTemplateId(null);
    setSelected(null);
    setSwapFrom(null);
  };

  const confirmPending = () => {
    if (!pending) return;
    let s = pending.shape;
    if (s.type === 'line') {
      const a = isLoose(s.a) ? extend(s.a, { x: s.a.x - s.b.x, y: s.a.y - s.b.y }) : s.a;
      const b = isLoose(s.b) ? extend(s.b, { x: s.b.x - s.a.x, y: s.b.y - s.a.y }) : s.b;
      s = { ...s, a, b };
    } else if (s.type === 'curve') {
      const c = control(s);
      const ea = isLoose(s.a) ? extend(s.a, { x: s.a.x - c.x, y: s.a.y - c.y }) : null;
      const eb = isLoose(s.b) ? extend(s.b, { x: s.b.x - c.x, y: s.b.y - c.y }) : null;
      s = { ...s, ea: ea && distPx(ea, s.a, stageW, stageH) > 0.5 ? ea : undefined, eb: eb && distPx(eb, s.b, stageW, stageH) > 0.5 ? eb : undefined };
    }
    const next = pending.index < 0 ? [...shapes, s] : shapes.map((x, i) => (i === pending.index ? s : x));
    setPending(null);
    commitShapes(next);
  };

  const deletePending = () => {
    if (!pending) return;
    if (pending.index >= 0) commitShapes(shapes.filter((_, i) => i !== pending.index));
    setPending(null);
  };

  const reopen = (i: number) => {
    const s = shapes[i];
    // Stretched ends are worked out again on confirm.
    const shape: Shape = s.type === 'curve' ? { type: 'curve', a: s.a, b: s.b, m: s.m } : s;
    setPending({ shape, index: i, creating: false });
  };

  const changeMode = (m: Mode) => {
    if (m === 'photos' && pending) {
      setNudge((n) => n + 1);
      return;
    }
    setMode(m);
    setSelected(null);
    setSwapFrom(null);
    photoDrag.current = null;
    drawDrag.current = null;
  };

  const startDrawing = () => {
    changeMode('draw');
    stageRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // ----- photos -----

  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const addFiles = useCallback(async (files: File[], target: number | null) => {
    const picked = files.filter((f) => !f.type || f.type.startsWith('image/'));
    if (!picked.length) return;
    // Take only as many photos as there are cells to put them in.
    const cur = slotsRef.current;
    const room = cur.filter((s, i) => !s.img && i !== target).length + (target !== null && cur[target] ? 1 : 0);
    if (!room) {
      setNote('Every cell already has a photo. Remove one, or pick a layout with more cells.');
      return;
    }
    const list = picked.slice(0, room);
    const skipped = picked.length - list.length;
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
    const ids = loaded.map((_, i) => `p${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`);
    setImages((prev) => {
      const next = { ...prev };
      loaded.forEach((img, i) => (next[ids[i]] = img));
      return next;
    });
    const queue = [...ids];
    const out = slotsRef.current.map((s) => ({ ...s }));
    const place = (s: Slot) => Object.assign(s, { img: queue.shift()!, view: DEFAULT_VIEW });
    if (target !== null && out[target] && queue.length) place(out[target]);
    for (const s of out) if (!s.img && queue.length) place(s);
    const left = queue.length;
    setSlots(out);
    const msgs: string[] = [];
    if (skipped || left) {
      const n = skipped + left;
      msgs.push(`Only ${room} cell${room > 1 ? 's were' : ' was'} free, so ${n} photo${n > 1 ? 's were' : ' was'} left out. Pick a layout with more cells to add more.`);
    }
    if (failed) msgs.push(`${failed} file${failed > 1 ? 's' : ''} couldn't be opened.`);
    if (msgs.length) setNote(msgs.join(' '));
  }, []);

  const pickFor = (k: number | null) => {
    targetCell.current = k;
    fileRef.current?.click();
  };

  const updateSlot = (k: number, fn: (s: Slot) => Slot) => setSlots((ss) => ss.map((s, i) => (i === k ? fn(s) : s)));
  const removePhoto = (k: number) => updateSlot(k, () => ({ ...EMPTY }));
  const swap = (a: number, b: number) =>
    setSlots((ss) => ss.map((s, i) => (i === a ? { img: ss[b].img, view: DEFAULT_VIEW } : i === b ? { img: ss[a].img, view: DEFAULT_VIEW } : s)));

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
  const kx = base ? base.w / stageW : 1; // raster px per stage px
  const cellIndexAt = (p: Pt) => (base ? cellAt(base, toNorm(p)) : -1);
  /** The cell's box in stage pixels. */
  const boxOf = (k: number) => {
    const b = base?.cells[k]?.box ?? { x: 0, y: 0, w: 0, h: 0 };
    return { x: b.x / kx, y: b.y / kx, w: b.w / kx, h: b.h / kx };
  };

  const panCell = (k: number, dx: number, dy: number) =>
    updateSlot(k, (s) => {
      const img = s.img ? imagesRef.current[s.img] : null;
      if (!img) return s;
      const b = boxOf(k);
      const v = clampView(s.view, img, b.w, b.h);
      return { ...s, view: clampView({ ...v, ox: v.ox + dx / b.w, oy: v.oy + dy / b.h }, img, b.w, b.h) };
    });

  /** Zooms a cell's photo by `f`, keeping the stage point p still. */
  const zoomCell = (k: number, p: Pt, f: number) =>
    updateSlot(k, (s) => {
      const img = s.img ? imagesRef.current[s.img] : null;
      if (!img) return s;
      const b = boxOf(k);
      const v = clampView(s.view, img, b.w, b.h);
      const zoom = clamp(v.zoom * f, 1, MAX_ZOOM);
      const r = zoom / v.zoom;
      const ux = p.x - (b.x + b.w / 2);
      const uy = p.y - (b.y + b.h / 2);
      const cx = ux - (ux - v.ox * b.w) * r;
      const cy = uy - (uy - v.oy * b.h) * r;
      return { ...s, view: clampView({ zoom, ox: cx / b.w, oy: cy / b.h }, img, b.w, b.h) };
    });

  const tapCell = (k: number) => {
    if (k < 0) return;
    if (swapFrom !== null) {
      if (swapFrom !== k) swap(swapFrom, k);
      setSwapFrom(null);
      setSelected(k);
      return;
    }
    setSelected(k);
  };

  // ----- drawing gestures (points in stage px) -----

  const snapAt = (pn: Pt) => snapPoint(pn, { on: snapOn, density, shapes: others, w: stageW, h: stageH });

  const drawDown = (p: Pt) => {
    const pn = toNorm(p);
    if (pending && !pending.creating) {
      let key: HandleKey | null = null;
      let bd = HANDLE_HIT;
      for (const [k, q] of handles(pending.shape, stageW, stageH)) {
        const d = distPx(pn, q, stageW, stageH);
        if (d < bd) {
          bd = d;
          key = k;
        }
      }
      if (key) drawDrag.current = { kind: 'handle', key };
      else if (shapeDistPx(pending.shape, pn, stageW, stageH) < 16) drawDrag.current = { kind: 'move', last: pn };
      else {
        drawDrag.current = null;
        setNudge((n) => n + 1);
        return;
      }
      setDragging(true);
      return;
    }
    let hit = -1;
    let hd = 12;
    shapes.forEach((s, i) => {
      const d = shapeDistPx(s, pn, stageW, stageH);
      if (d < hd) {
        hd = d;
        hit = i;
      }
    });
    drawDrag.current = { kind: 'maybe', start: pn, hit };
  };

  const drawMove = (p: Pt) => {
    let d = drawDrag.current;
    if (!d) return;
    const pn = toNorm(p);
    if (d.kind === 'maybe') {
      if (distPx(pn, d.start, stageW, stageH) < 6) return;
      d = drawDrag.current = { kind: 'create', p0: snapAt(d.start).p };
      setDragging(true);
    }
    if (d.kind === 'create') {
      const sp = snapAt(pn);
      setPending({ shape: createShape(tool, d.p0, sp.p, stageW, stageH), index: -1, creating: true });
      setActive(sp);
    } else if (d.kind === 'handle' && pending) {
      const sp = snapAt(pn);
      const key = d.key;
      const shape = moveHandle(pending.shape, key, sp.p, stageW, stageH);
      const at = handles(shape, stageW, stageH).find(([k]) => k === key)?.[1] ?? sp.p;
      setPending((pd) => (pd ? { ...pd, shape: moveHandle(pd.shape, key, sp.p, stageW, stageH) } : pd));
      setActive({ ...sp, p: at });
    } else if (d.kind === 'move') {
      const dx = pn.x - d.last.x;
      const dy = pn.y - d.last.y;
      d.last = pn;
      setPending((pd) => (pd ? { ...pd, shape: translate(pd.shape, dx, dy) } : pd));
    }
  };

  const drawUp = () => {
    const d = drawDrag.current;
    drawDrag.current = null;
    setDragging(false);
    setActive(null);
    if (!d) return;
    if (d.kind === 'maybe') {
      if (d.hit >= 0) reopen(d.hit);
      return;
    }
    if (d.kind === 'create') {
      setPending((pd) => {
        if (!pd) return pd;
        if (shapeSizePx(pd.shape, stageW, stageH) < 14) return null;
        return { ...pd, creating: false };
      });
    }
  };

  const drawCancel = () => {
    const d = drawDrag.current;
    drawDrag.current = null;
    setDragging(false);
    setActive(null);
    if (d?.kind === 'create') setPending(null);
  };

  // Handlers read the latest state through this ref, so the native touch
  // listeners can be attached once.
  const api = useRef({ cellIndexAt, panCell, zoomCell, tapCell, setSelected, mode, swapFrom, drawDown, drawMove, drawUp, drawCancel });
  api.current = { cellIndexAt, panCell, zoomCell, tapCell, setSelected, mode, swapFrom, drawDown, drawMove, drawUp, drawCancel };

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
      drawDown(p);
      return;
    }
    const k = cellIndexAt(p);
    if (swapFrom !== null) {
      tapCell(k);
      photoDrag.current = null;
      return;
    }
    setSelected(k >= 0 ? k : null);
    photoDrag.current = k >= 0 && slots[k]?.img ? { kind: 'pan', cell: k, last: p } : null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const p = local(e);
    if (mode === 'draw') {
      drawMove(p);
      return;
    }
    const d = photoDrag.current;
    if (!d) return;
    panCell(d.cell, p.x - d.last.x, p.y - d.last.y);
    d.last = p;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (mode === 'draw') drawUp();
    photoDrag.current = null;
  };

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let last: Pt[] = [];
    let start: Pt | null = null;
    let moved = false;
    let fingers = 0; // most fingers seen in this gesture
    let cell = -1;
    const points = (e: TouchEvent): Pt[] => {
      const r = el.getBoundingClientRect();
      return Array.from(e.touches)
        .slice(0, 2)
        .map((t) => ({ x: t.clientX - r.left, y: t.clientY - r.top }));
    };
    const onStart = (e: TouchEvent) => {
      // Let buttons on the stage get their normal click.
      if ((e.target as Element).closest('button')) return;
      e.preventDefault();
      const a = api.current;
      const pts = points(e);
      if (e.touches.length === 1) {
        start = pts[0];
        moved = false;
        fingers = 1;
        if (a.mode === 'draw') a.drawDown(pts[0]);
        else {
          cell = a.cellIndexAt(pts[0]);
          if (a.swapFrom === null) a.setSelected(cell >= 0 ? cell : null);
        }
      } else {
        fingers = Math.max(fingers, e.touches.length);
        if (a.mode === 'draw') {
          start = null; // a second finger cancels the stroke
          a.drawCancel();
        } else if (cell < 0 && pts.length === 2) {
          cell = a.cellIndexAt({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 });
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
        if (start && cur.length === 1 && fingers === 1) a.drawMove(cur[0]);
      } else if (cell >= 0) {
        if (cur.length === 1 && last.length === 1) {
          a.panCell(cell, cur[0].x - last[0].x, cur[0].y - last[0].y);
        } else if (cur.length === 2 && last.length === 2) {
          const midPrev = { x: (last[0].x + last[1].x) / 2, y: (last[0].y + last[1].y) / 2 };
          const midCur = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 };
          const dPrev = Math.hypot(last[0].x - last[1].x, last[0].y - last[1].y);
          const dCur = Math.hypot(cur[0].x - cur[1].x, cur[0].y - cur[1].y);
          if (dPrev > 0) a.zoomCell(cell, midCur, dCur / dPrev);
          a.panCell(cell, midCur.x - midPrev.x, midCur.y - midPrev.y);
        }
      }
      last = cur;
    };
    const onEnd = (e: TouchEvent) => {
      if (!last.length) return;
      const a = api.current;
      if (e.touches.length === 0) {
        if (a.mode === 'draw') {
          if (start && fingers === 1) a.drawUp();
          else a.drawCancel();
        } else if (!moved && fingers === 1) {
          a.tapCell(cell);
        }
        start = null;
        cell = -1;
        last = [];
        return;
      }
      last = points(e);
    };
    const onCancel = () => {
      api.current.drawCancel();
      start = null;
      cell = -1;
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
      const k = a.cellIndexAt(p);
      if (k < 0 || !slotsRef.current[k]?.img) return;
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      a.zoomCell(k, p, Math.exp(-delta * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keyboard: Enter confirms, Escape cancels, Ctrl/Cmd+Z undoes.
  const keyApi = useRef({ confirmPending, deletePending, undo, pending });
  keyApi.current = { confirmPending, deletePending, undo, pending };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, select, textarea')) return;
      const a = keyApi.current;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        a.undo();
      } else if (e.key === 'Enter' && a.pending && !a.pending.creating && !t.closest('.cm-pendbtns')) {
        e.preventDefault();
        a.confirmPending();
      } else if (e.key === 'Escape' && a.pending) {
        if (a.pending.index >= 0) setPending(null);
        else a.deletePending();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ----- editor rendering -----

  const transparent = bg === 'transparent';
  const shown = live ?? base;
  const shownSlots = live && live !== base ? liveSlots : slots;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shown) return;
    const frame = requestAnimationFrame(() => {
      if (canvas.width !== shown.w || canvas.height !== shown.h) {
        canvas.width = shown.w;
        canvas.height = shown.h;
      }
      const ctx = canvas.getContext('2d')!;
      drawCollage(ctx, shown, {
        bg: transparent ? null : bg,
        placeholder: PLACEHOLDER,
        photo: (k) => {
          const s = shownSlots[k];
          const img = s?.img ? images[s.img] : null;
          return img ? { img, view: s.view } : null;
        },
      });
      if (mode === 'photos' && shown === base) {
        const k = shown.w / stageW;
        if (selected !== null) drawOutline(ctx, shown, selected, ACCENT, 3 * k);
        if (swapFrom !== null && swapFrom !== selected) drawOutline(ctx, shown, swapFrom, ACCENT, 3 * k, true);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, base, shownSlots, images, bg, transparent, mode, selected, swapFrom, stageW]);

  // ----- export -----

  const outW = ratio >= 1 ? size : Math.round(size * ratio);
  const outH = ratio >= 1 ? Math.round(size / ratio) : size;
  const cellCount = base?.cells.length ?? 0;
  const filled = slots.filter((s) => s?.img && images[s.img]).length;
  const empty = cellCount - filled;
  const ext = format === 'png' ? 'png' : 'jpg';
  const fileName = `collage-${outW}x${outH}.${ext}`;

  const exportBlob = async () => {
    if (!base) throw new Error('layout');
    // Let the "Preparing…" state paint before the heavy work.
    await new Promise((r) => setTimeout(r, 30));
    const full = computeLayout(shapes, outW, outH, gap, radius);
    const match = matchCells(base, full);
    const c = document.createElement('canvas');
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('canvas');
    // JPG has no transparency, so a transparent background exports as white.
    const fill = transparent ? (format === 'png' ? null : '#ffffff') : bg;
    drawCollage(ctx, full, {
      bg: fill,
      placeholder: null,
      photo: (k) => {
        const s = match[k] >= 0 ? slots[match[k]] : null;
        const img = s?.img ? images[s.img] : null;
        return img && s ? { img, view: s.view } : null;
      },
    });
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
    pushHistory();
    slotMode.current = 'carry';
    setShapes(DEFAULT_TEMPLATE.shapes);
    setSlots([]);
    setTemplateId(DEFAULT_TEMPLATE.id);
    setPending(null);
    setMode('photos');
    setSelected(null);
    setSwapFrom(null);
    setNote(null);
  };

  // ----- templates -----

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of TEMPLATES) m[t.id] = countCells(t.shapes, ratio);
    return m;
  }, [ratio]);
  const groupOf = (n: number) => Math.min(7, n);
  const groupCount = (g: number) => TEMPLATES.filter((t) => groupOf(counts[t.id]) === g && counts[t.id] >= 2).length;
  const groups = (filter === 'all' ? [...GROUPS] : [filter]).filter((g) => groupCount(g) > 0);
  const thumbW = ratio >= 1 ? 40 : 40 * ratio;
  const thumbH = ratio >= 1 ? 40 / ratio : 40;

  // ----- view -----

  const sel = selected !== null && base?.cells[selected] ? selected : null;
  const selSlot = sel !== null ? slots[sel] : null;
  const selImg = selSlot?.img ? images[selSlot.img] : null;
  const selView = sel !== null && selImg && selSlot ? (() => {
    const b = boxOf(sel);
    return clampView(selSlot.view, selImg, b.w, b.h);
  })() : null;

  const pendingLoose =
    pending && !pending.creating && (pending.shape.type === 'line' || pending.shape.type === 'curve')
      ? [pending.shape.a, pending.shape.b].some(isLoose)
      : false;

  const ticks = (len: number) =>
    Array.from({ length: 17 }, (_, i) => ({ i, v: (i / 16) * len, l: i % 8 === 0 ? 12 : i % 4 === 0 ? 9 : i % 2 === 0 ? 6 : 3 }));

  const overlay = mode === 'draw' && stageW > 0 && (
    <svg className="cm-overlay" viewBox={`0 0 ${stageW} ${stageH}`} aria-hidden="true">
      {showRuler &&
        Array.from({ length: density - 1 }, (_, i) => {
          const f = (i + 1) / density;
          const half = f === 0.5;
          return (
            <path
              key={i}
              d={`M${f * stageW} 0V${stageH}M0 ${f * stageH}H${stageW}`}
              stroke={`rgba(255,225,77,${half ? 0.35 : 0.18})`}
              strokeWidth={1}
              strokeDasharray={half ? undefined : '4 4'}
            />
          );
        })}
      {shapes.map((s, i) =>
        pending?.index === i ? null : (
          <path key={i} d={shapePath(s, stageW, stageH)} fill="none" stroke="rgba(255,225,77,0.6)" strokeWidth={1} strokeDasharray="5 4" />
        )
      )}
      {snapOn &&
        edgePoints(density).map((e, i) => (
          <circle
            key={i}
            cx={e.p.x * stageW}
            cy={e.p.y * stageH}
            r={[0, 2.5, 3.5, 4.5][e.weight]}
            fill={`rgba(255,225,77,${[0, 0.5, 0.7, 0.95][e.weight]})`}
            stroke="#0d0e11"
            strokeWidth={1.2}
          />
        ))}
      {active?.gx !== undefined && <path d={`M${active.gx * stageW} 0V${stageH}`} stroke={ACCENT} strokeWidth={1.2} strokeDasharray="5 4" />}
      {active?.gy !== undefined && <path d={`M0 ${active.gy * stageH}H${stageW}`} stroke={ACCENT} strokeWidth={1.2} strokeDasharray="5 4" />}
      {pending && (
        <g>
          <path d={shapePath(pending.shape, stageW, stageH)} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" />
          {pending.shape.type === 'curve' && (() => {
            const s = pending.shape;
            const c = control(s);
            return (
              <path
                d={`M${s.a.x * stageW} ${s.a.y * stageH}L${c.x * stageW} ${c.y * stageH}L${s.b.x * stageW} ${s.b.y * stageH}`}
                fill="none"
                stroke="rgba(255,225,77,0.4)"
                strokeDasharray="3 3"
              />
            );
          })()}
          {!pending.creating &&
            handles(pending.shape, stageW, stageH).map(([key, p]) => {
              const x = p.x * stageW;
              const y = p.y * stageH;
              if (key === 'm')
                return <rect key={key} x={x - 7} y={y - 7} width={14} height={14} transform={`rotate(45 ${x} ${y})`} fill={ACCENT} stroke="#0d0e11" strokeWidth={2} />;
              if (key === 'c')
                return (
                  <g key={key}>
                    <circle cx={x} cy={y} r={7} fill="#0d0e11" stroke={ACCENT} strokeWidth={2} />
                    <path d={`M${x - 4} ${y}H${x + 4}M${x} ${y - 4}V${y + 4}`} stroke={ACCENT} strokeWidth={1.5} />
                  </g>
                );
              const loose = (key === 'a' || key === 'b') && lineEnds(pending.shape).length > 0 && isLoose(p);
              return loose ? (
                <circle key={key} cx={x} cy={y} r={9} fill="#0d0e11" stroke="#ff8a65" strokeWidth={2.5} strokeDasharray="3 2.5" />
              ) : (
                <circle key={key} cx={x} cy={y} r={9} fill={ACCENT} stroke="#0d0e11" strokeWidth={2.5} />
              );
            })}
        </g>
      )}
      {active && (() => {
        const txt = active.label ?? `x ${fraction(clamp(active.p.x, 0, 1))} · y ${fraction(clamp(active.p.y, 0, 1))}`;
        const w = txt.length * 7.4 + 16;
        let x = active.p.x * stageW + 16;
        let y = active.p.y * stageH - 40;
        if (x + w > stageW) x = active.p.x * stageW - w - 16;
        if (y < 0) y = active.p.y * stageH + 18;
        return (
          <g>
            {active.hit && <circle cx={active.hit.x * stageW} cy={active.hit.y * stageH} r={13} fill="none" stroke={ACCENT} strokeWidth={2} />}
            <rect x={x} y={y} width={w} height={24} rx={6} fill="#0d0e11" stroke={ACCENT} />
            <text x={x + w / 2} y={y + 12} className="cm-readout" textAnchor="middle" dominantBaseline="central">
              {txt}
            </text>
          </g>
        );
      })()}
    </svg>
  );

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
              Draw
            </button>
          </div>
          <div className="cm-tools">
            <span className="cm-count mono" aria-live="polite">
              <b>{shown?.cells.length ?? 0}</b> cell{shown?.cells.length === 1 ? '' : 's'}
            </span>
            <button type="button" className="cm-icon-btn" disabled={!history.length && !pending} onClick={undo} aria-label="Undo layout change" title="Undo">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
            </button>
          </div>
        </div>

        {mode === 'draw' && (
          <div className="cm-drawbar" role="toolbar" aria-label="Drawing tools">
            {TOOLS.map((t) => (
              <button key={t} type="button" className="cm-tool" aria-pressed={tool === t} onClick={() => setTool(t)} title={`Draw a ${TOOL_NAMES[t]}`}>
                <ToolIcon tool={t} />
                <span>{t === 'rect' ? 'Box' : TOOL_NAMES[t][0].toUpperCase() + TOOL_NAMES[t].slice(1)}</span>
              </button>
            ))}
            <span className="cm-sep" />
            <button type="button" className="cm-tool" aria-pressed={ruler} onClick={() => setRuler((r) => !r)} title="Show ruler">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true"><rect x="2.5" y="8" width="19" height="8" rx="1" /><path d="M6.5 8v3M10.5 8v4.5M14.5 8v3M18.5 8v4.5" /></svg>
              <span>Ruler</span>
            </button>
            <button type="button" className="cm-tool" aria-pressed={snapOn} onClick={() => setSnapOn((s) => !s)} title="Snap line ends to edge points">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3v8a6 6 0 0 0 12 0V3" /><path d="M6 7h4M14 7h4" /></svg>
              <span>Snap</span>
            </button>
            <div className="cm-seg cm-density" role="group" aria-label="Snap point spacing">
              {[2, 4, 8].map((d) => (
                <button key={d} type="button" className="mono" aria-pressed={density === d} disabled={!snapOn} onClick={() => setDensity(d)}>
                  1/{d}
                </button>
              ))}
            </div>
            <button type="button" className="cm-tool cm-clear" onClick={clearLines} title="Clear all lines" disabled={!shapes.length && !pending}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
              <span>Clear</span>
            </button>
          </div>
        )}

        <div ref={boxRef} className="cm-box" style={{ height: boxH || undefined }}>
          <div className={`cm-frame${showRuler ? ' has-ruler' : ''}`}>
            {showRuler && stageW > 0 && (
              <>
                <svg className="cm-ruler cm-ruler-top" width={stageW} height={RULER} viewBox={`0 0 ${stageW} ${RULER}`} aria-hidden="true">
                  {ticks(stageW).map(({ i, v, l }) => (
                    <g key={i}>
                      <path d={`M${v} ${RULER}v${-l}`} stroke="#4a505c" />
                      {i % 4 === 0 && i > 0 && i < 16 && (
                        <text x={v + 3} y={10} className="cm-ruler-label">{fraction(i / 16)}</text>
                      )}
                    </g>
                  ))}
                  {active && <path d={`M${clamp(active.p.x, 0, 1) * stageW - 5} 14L${clamp(active.p.x, 0, 1) * stageW + 5} 14L${clamp(active.p.x, 0, 1) * stageW} ${RULER}Z`} fill={ACCENT} />}
                </svg>
                <svg className="cm-ruler cm-ruler-left" width={RULER} height={stageH} viewBox={`0 0 ${RULER} ${stageH}`} aria-hidden="true">
                  {ticks(stageH).map(({ i, v, l }) => (
                    <g key={i}>
                      <path d={`M${RULER} ${v}h${-l}`} stroke="#4a505c" />
                      {i % 4 === 0 && i > 0 && i < 16 && (
                        <text x={10} y={v + 3} className="cm-ruler-label" transform={`rotate(-90 10 ${v + 3})`}>{fraction(i / 16)}</text>
                      )}
                    </g>
                  ))}
                  {active && <path d={`M14 ${clamp(active.p.y, 0, 1) * stageH - 5}L14 ${clamp(active.p.y, 0, 1) * stageH + 5}L${RULER} ${clamp(active.p.y, 0, 1) * stageH}Z`} fill={ACCENT} />}
                </svg>
              </>
            )}
            <div
              ref={stageRef}
              className={`cm-stage${transparent ? ' checker' : ''}${mode === 'draw' ? ' is-draw' : ''}`}
              style={{ width: stageW, height: stageH }}
              tabIndex={0}
              role="application"
              aria-label={
                mode === 'draw'
                  ? 'Collage canvas. Drag to draw a shape, then adjust its handles and confirm.'
                  : 'Collage canvas. Tap a cell to select it, drag to move its photo, pinch or scroll to zoom.'
              }
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                photoDrag.current = null;
                drawCancel();
              }}
              onKeyDown={(e) => {
                if (sel === null || !selImg || mode !== 'photos') return;
                const step = e.shiftKey ? 20 : 4;
                const b = boxOf(sel);
                const mid = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
                const keys: Record<string, () => void> = {
                  ArrowLeft: () => panCell(sel, -step, 0),
                  ArrowRight: () => panCell(sel, step, 0),
                  ArrowUp: () => panCell(sel, 0, -step),
                  ArrowDown: () => panCell(sel, 0, step),
                  '+': () => zoomCell(sel, mid, 1.1),
                  '=': () => zoomCell(sel, mid, 1.1),
                  '-': () => zoomCell(sel, mid, 1 / 1.1),
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
                const k = cellIndexAt(local(e));
                addFiles(Array.from(e.dataTransfer.files), k >= 0 ? k : null);
              }}
            >
              <canvas ref={canvasRef} />
              {overlay}
              {mode === 'photos' &&
                base &&
                base.cells.map((c, k) => {
                  if (slots[k]?.img && images[slots[k].img!]) return null;
                  const b = boxOf(k);
                  if (!b.w) return null;
                  const small = Math.min(b.w, b.h) < 64;
                  return (
                    <button
                      key={k}
                      type="button"
                      className={`cm-add${small ? ' is-small' : ''}`}
                      style={{ left: c.anchor.x * stageW, top: c.anchor.y * stageH }}
                      onClick={() => {
                        if (swapFrom !== null) {
                          tapCell(k);
                          return;
                        }
                        setSelected(k);
                        pickFor(k);
                      }}
                      aria-label={`Add photo to cell ${k + 1}`}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                    </button>
                  );
                })}
            </div>
          </div>
        </div>

        <div className={`cm-cellbar${pending && !pending.creating ? ' is-pending' : ''}`} key={`n${nudge}`} data-nudge={nudge > 0 || undefined}>
          {mode === 'draw' ? (
            pending && !pending.creating ? (
              <div className="cm-pendbar">
                <p className="cm-hint">
                  <b>Adjusting {TOOL_NAMES[pending.shape.type]}.</b>{' '}
                  {pending.shape.type === 'curve'
                    ? 'Drag the ends, or the diamond to bend it.'
                    : pending.shape.type === 'line'
                      ? 'Drag either end, or the line to move it.'
                      : 'Drag the handles to resize, or the middle to move it.'}
                  {pendingLoose && ' Dashed ends are loose: they stretch to the nearest line or edge when you confirm.'}
                </p>
                <div className="cm-pendbtns">
                  {pending.index >= 0 && (
                    <button type="button" className="btn btn-ghost cm-small" onClick={() => setPending(null)}>Cancel</button>
                  )}
                  <button type="button" className="btn btn-ghost cm-small" onClick={deletePending}>{pending.index >= 0 ? 'Delete' : 'Discard'}</button>
                  <button type="button" className="btn btn-primary cm-small" onClick={confirmPending}>Confirm</button>
                </div>
              </div>
            ) : (
              <p className="cm-hint">
                Pick a shape and drag on the canvas, then adjust it and press Confirm. Line ends snap to the yellow edge points. Tap a line to edit it again.{' '}
                <button type="button" className="cm-link" onClick={() => changeMode('photos')}>Done drawing</button>
              </p>
            )
          ) : swapFrom !== null ? (
            <p className="cm-hint">
              Tap another cell to swap photos.{' '}
              <button type="button" className="cm-link" onClick={() => setSwapFrom(null)}>Cancel</button>
            </p>
          ) : sel !== null && selImg && selView ? (
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
                    zoomCell(sel, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, Math.exp(Number(e.target.value)) / selView.zoom);
                  }}
                  aria-label="Zoom selected photo"
                />
              </label>
              <div className="cm-selbtns">
                <button type="button" className="btn btn-ghost cm-small" onClick={() => pickFor(sel)}>Replace</button>
                <button type="button" className="btn btn-ghost cm-small" disabled={cellCount < 2} onClick={() => setSwapFrom(sel)}>Swap</button>
                <button type="button" className="btn btn-ghost cm-small" onClick={() => updateSlot(sel, (s) => ({ ...s, view: DEFAULT_VIEW }))}>Fit</button>
                <button type="button" className="btn btn-ghost cm-small" onClick={() => removePhoto(sel)}>Remove</button>
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
          <span className="cm-label mono">templates by photo count</span>
          <div className="cm-chips" role="group" aria-label="Filter templates by photo count">
            <button type="button" className="cm-chip mono" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
            {GROUPS.map((g) => (
              <button key={g} type="button" className="cm-chip mono" aria-pressed={filter === g} onClick={() => setFilter(g)} disabled={!groupCount(g)}>
                {g === 7 ? '7+' : g}
                <small>{groupCount(g)}</small>
              </button>
            ))}
          </div>
          <div className="cm-tgroups">
            {groups.map((g) => (
              <div key={g} className="cm-tgroup">
                <div className="cm-tgroup-title mono">{g === 7 ? '7 or more photos' : `${g} photos`}</div>
                <div className="cm-templates">
                  {TEMPLATES.filter((t) => groupOf(counts[t.id]) === g && counts[t.id] >= 2).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="cm-tpl"
                      aria-pressed={templateId === t.id}
                      aria-label={`${t.name}, ${counts[t.id]} photos`}
                      title={t.name}
                      onClick={() => applyTemplate(t)}
                    >
                      <svg viewBox={`-2 -2 ${thumbW + 4} ${thumbH + 4}`} width={thumbW + 4} height={thumbH + 4} aria-hidden="true">
                        <rect className="cm-tpl-fill" x={0} y={0} width={thumbW} height={thumbH} rx={1} />
                        {t.shapes.map((s, i) => (
                          <path key={i} className="cm-tpl-line" d={shapePath(s, thumbW, thumbH)} />
                        ))}
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn-ghost cm-draw-own" onClick={startDrawing}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
            Draw your own
          </button>
        </div>

        <button type="button" className="btn btn-primary" onClick={() => pickFor(null)} disabled={filled >= cellCount && cellCount > 0} title={filled >= cellCount ? 'Every cell has a photo' : undefined}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          {filled >= cellCount && cellCount > 0 ? 'Every cell has a photo' : `Add photos (${cellCount - filled} free)`}
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
          {outW} × {outH} px · {filled} of {cellCount} cells filled
          {empty > 0 && filled > 0 && <div className="cm-warn">Empty cells export as background.</div>}
          {transparent && format === 'jpeg' && <div className="cm-warn">JPG can't be transparent, so the background will be white. Pick PNG to keep it.</div>}
        </div>

        {note && (
          <p className="cm-error" role="alert">
            {note}
          </p>
        )}

        <div className="cm-actions">
          <button type="button" className="btn btn-primary" disabled={busy || filled === 0 || !!pending} onClick={onDownload}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            {busy ? 'Preparing…' : `Download ${ext.toUpperCase()}`}
          </button>
          {shareable && (
            <button type="button" className="btn btn-ghost" disabled={busy || filled === 0 || !!pending} onClick={onShare}>
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

function ToolIcon({ tool }: { tool: Tool }) {
  const common = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (tool) {
    case 'line':
      return <svg {...common}><path d="M5 19 19 5" /><circle cx="5" cy="19" r="1.6" fill="currentColor" /><circle cx="19" cy="5" r="1.6" fill="currentColor" /></svg>;
    case 'curve':
      return <svg {...common}><path d="M4 19C6 6 18 6 20 19" /></svg>;
    case 'oval':
      return <svg {...common}><ellipse cx="12" cy="12" rx="9.5" ry="6" /></svg>;
    case 'circle':
      return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
    case 'rect':
      return <svg {...common}><rect x="4" y="5.5" width="16" height="13" rx="1" /></svg>;
  }
}
