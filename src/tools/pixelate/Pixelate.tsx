import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import DropZone from '../shared/DropZone';
import { baseName, canShareFiles, canvasToBlob, downloadBlob, loadImageFile, type LoadedImage } from '../shared/image';
import { Pixelator, type Stroke } from './pixelate';
import '../shared/tool.css';
import './pixelate.css';

type Mode = 'whole' | 'brush';
type Tool = 'paint' | 'erase';

/** zoom 1 = image fits the stage; ox, oy = image centre offset from stage centre, in stage px. */
interface View {
  zoom: number;
  ox: number;
  oy: number;
}

const FIT: View = { zoom: 1, ox: 0, oy: 0 };
const MIN_ZOOM = 0.5;
const FIT_PAD = 0.96;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Slider ranges and defaults, all in image pixels, from the image's longest side. */
function ranges(longest: number) {
  const blockMax = Math.max(4, Math.min(256, Math.floor(longest / 4)));
  const brushMin = Math.max(2, Math.round(longest / 250));
  const brushMax = Math.max(brushMin + 1, Math.round(longest / 2));
  return {
    blockMin: 2,
    blockMax,
    block: clamp(Math.round(longest / 60), 4, blockMax),
    brushMin,
    brushMax,
    brush: clamp(Math.round(longest / 10), brushMin, brushMax),
  };
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range';
};

export default function Pixelate() {
  const [img, setImg] = useState<LoadedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('whole');
  const [tool, setTool] = useState<Tool>('paint');
  const [block, setBlock] = useState(12);
  const [brush, setBrush] = useState(80);
  const [view, setView] = useState<View>(FIT);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [hist, setHist] = useState({ undo: 0, redo: 0, brushed: false });
  const [compare, setCompare] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shareable, setShareable] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Pixelator | null>(null);
  const strokes = useRef<Stroke[]>([]);
  const redoStack = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const space = useRef(false);
  const frame = useRef(0);

  const eng = engine.current;
  const range = ranges(eng ? Math.max(eng.w, eng.h) : 1000);
  const fit = eng && stage.w ? Math.min(stage.w / eng.w, stage.h / eng.h) * FIT_PAD : 1;
  const scale = fit * view.zoom;
  const maxZoom = Math.max(4, 24 / fit); // up to 24 screen px per image pixel

  // Latest values for the native listeners and the draw loop.
  const live = useRef({ view, stage, scale, fit, maxZoom, mode, tool, brush, compare });
  live.current = { view, stage, scale, fit, maxZoom, mode, tool, brush, compare };

  useEffect(() => setShareable(canShareFiles()), []);

  useEffect(() => () => {
    if (img) URL.revokeObjectURL(img.url);
  }, [img]);

  const openFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const loaded = await loadImageFile(file, file.name || 'image');
      const p = new Pixelator(loaded);
      const r = ranges(Math.max(p.w, p.h));
      p.setBlock(r.block);
      p.replay([]);
      engine.current = p;
      strokes.current = [];
      redoStack.current = [];
      current.current = null;
      setBlock(r.block);
      setBrush(r.brush);
      setView(FIT);
      setHist({ undo: 0, redo: 0, brushed: false });
      setImg(loaded);
    } catch {
      setError("Couldn't open that file. Try a JPG, PNG or WebP image.");
    }
  }, []);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setStage({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [img]);

  // ----- drawing -----

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const p = engine.current;
    const { stage: st, view: v, scale: s, compare: cmp } = live.current;
    if (!canvas || !p || !st.w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cw = Math.round(st.w * dpr);
    const ch = Math.round(st.h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Crisp pixels once zoomed past 1:1, smooth when shrunk to fit.
    ctx.imageSmoothingEnabled = s * dpr < 1;
    ctx.imageSmoothingQuality = 'high';
    const dw = p.w * s;
    const dh = p.h * s;
    ctx.drawImage(cmp ? p.source : p.result, st.w / 2 + v.ox - dw / 2, st.h / 2 + v.oy - dh / 2, dw, dh);
  }, []);

  /** Redraws on the next frame; `recompose` also rebuilds the result image first. */
  const pending = useRef(false);
  const schedule = useCallback(
    (recompose: boolean) => {
      if (recompose) pending.current = true;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const p = engine.current;
        if (p && pending.current) {
          p.compose(live.current.mode === 'whole');
          pending.current = false;
        }
        draw();
      });
    },
    [draw]
  );

  // New block size: re-pixelate and replay the strokes on the new grid.
  useEffect(() => {
    const p = engine.current;
    if (!p) return;
    const f = requestAnimationFrame(() => {
      p.setBlock(block);
      p.replay(strokes.current);
      schedule(true);
    });
    return () => cancelAnimationFrame(f);
  }, [img, block, schedule]);

  useEffect(() => schedule(true), [mode, schedule]);
  useEffect(() => schedule(false), [view, stage, compare, schedule]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // ----- view -----

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    // px, py: stage px relative to the stage centre.
    setView((v) => {
      const zoom = clamp(v.zoom * factor, MIN_ZOOM, live.current.maxZoom);
      const f = zoom / v.zoom;
      return { zoom, ox: px - (px - v.ox) * f, oy: py - (py - v.oy) * f };
    });
  }, []);

  const panBy = useCallback((dx: number, dy: number) => {
    const p = engine.current;
    if (!p) return;
    setView((v) => {
      const { stage: st, fit: ft } = live.current;
      const s = ft * v.zoom;
      const lx = (p.w * s) / 2 + st.w / 2 - 24;
      const ly = (p.h * s) / 2 + st.h / 2 - 24;
      return { ...v, ox: clamp(v.ox + dx, -lx, lx), oy: clamp(v.oy + dy, -ly, ly) };
    });
  }, []);

  /** Stage px (from the stage's top left) → image px. */
  const toImage = (x: number, y: number) => {
    const p = engine.current!;
    const { stage: st, view: v, scale: s } = live.current;
    return { x: (x - st.w / 2 - v.ox) / s + p.w / 2, y: (y - st.h / 2 - v.oy) / s + p.h / 2 };
  };

  // ----- strokes -----

  const syncHist = useCallback(() => {
    setHist({ undo: strokes.current.length, redo: redoStack.current.length, brushed: !!engine.current?.hasBrushed() });
  }, []);

  const beginStroke = (x: number, y: number) => {
    const p = engine.current;
    if (!p) return;
    const pt = toImage(x, y);
    const s: Stroke = { kind: live.current.tool, r: live.current.brush / 2, pts: [pt.x, pt.y] };
    current.current = s;
    strokes.current.push(s);
    redoStack.current = [];
    p.segment(s, pt.x, pt.y, pt.x, pt.y);
    schedule(true);
  };

  const extendStroke = (x: number, y: number) => {
    const s = current.current;
    const p = engine.current;
    if (!s || !p) return;
    const pt = toImage(x, y);
    const n = s.pts.length;
    const lx = s.pts[n - 2];
    const ly = s.pts[n - 1];
    if (Math.hypot(pt.x - lx, pt.y - ly) < Math.max(1, s.r * 0.2)) return;
    s.pts.push(pt.x, pt.y);
    p.segment(s, lx, ly, pt.x, pt.y);
    schedule(true);
  };

  const endStroke = () => {
    if (!current.current) return;
    current.current = null;
    syncHist();
  };

  /** Drops the stroke in progress, e.g. when a second finger turns it into a pinch. */
  const cancelStroke = () => {
    const s = current.current;
    const p = engine.current;
    if (!s || !p) return;
    current.current = null;
    strokes.current = strokes.current.filter((x) => x !== s);
    p.replay(strokes.current);
    schedule(true);
    syncHist();
  };

  const replayAll = useCallback(() => {
    engine.current?.replay(strokes.current);
    schedule(true);
    syncHist();
  }, [schedule, syncHist]);

  const undo = useCallback(() => {
    const s = strokes.current.pop();
    if (!s) return;
    redoStack.current.push(s);
    replayAll();
  }, [replayAll]);

  const redo = useCallback(() => {
    const s = redoStack.current.pop();
    if (!s) return;
    strokes.current.push(s);
    replayAll();
  }, [replayAll]);

  const clearBrush = () => {
    if (!engine.current?.hasBrushed()) return;
    strokes.current.push({ kind: 'clear', r: 0, pts: [] });
    redoStack.current = [];
    replayAll();
  };

  // ----- pointer (mouse and pen) -----

  const drag = useRef<{ id: number; type: 'pan' | 'paint'; x: number; y: number } | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Touch is handled by the native listeners below; iOS Safari doesn't reliably
  // honour `touch-action: none` with pointer events.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' || drag.current) return;
    const pt = local(e);
    const pan = live.current.mode === 'whole' || e.button === 1 || e.button === 2 || space.current;
    if (!pan && e.button !== 0) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* gestures still work without capture */
    }
    stageRef.current?.focus({ preventScroll: true });
    drag.current = { id: e.pointerId, type: pan ? 'pan' : 'paint', ...pt };
    if (pan) setPanning(true);
    else beginStroke(pt.x, pt.y);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const pt = local(e);
    setCursor(pt);
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.type === 'pan') panBy(pt.x - d.x, pt.y - d.y);
    else extendStroke(pt.x, pt.y);
    d.x = pt.x;
    d.y = pt.y;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (d.type === 'paint') endStroke();
  };

  // ----- touch: one finger paints (or pans in whole mode), two fingers pinch and pan -----

  const handlers = useRef({ beginStroke, extendStroke, endStroke, cancelStroke, panBy, zoomAt });
  handlers.current = { beginStroke, extendStroke, endStroke, cancelStroke, panBy, zoomAt };

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let state: 'paint' | 'pan' | 'pinch' | 'done' | null = null;
    let last: { x: number; y: number }[] = [];
    const points = (e: TouchEvent) => {
      const r = el.getBoundingClientRect();
      return Array.from(e.touches)
        .slice(0, 2)
        .map((t) => ({ x: t.clientX - r.left, y: t.clientY - r.top }));
    };
    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      el.focus({ preventScroll: true });
      const cur = points(e);
      const h = handlers.current;
      if (cur.length === 1 && state === null) {
        if (live.current.mode === 'brush') {
          state = 'paint';
          h.beginStroke(cur[0].x, cur[0].y);
          setCursor(cur[0]);
        } else {
          state = 'pan';
        }
      } else if (cur.length >= 2) {
        if (state === 'paint') h.cancelStroke();
        state = 'pinch';
        setCursor(null);
      }
      last = cur;
    };
    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      const cur = points(e);
      const h = handlers.current;
      if (state === 'paint' && cur.length === 1) {
        h.extendStroke(cur[0].x, cur[0].y);
        setCursor(cur[0]);
      } else if (state === 'pan' && cur.length === 1 && last.length === 1) {
        h.panBy(cur[0].x - last[0].x, cur[0].y - last[0].y);
      } else if (state === 'pinch' && cur.length === 2 && last.length === 2) {
        const { stage: st } = live.current;
        const midPrev = { x: (last[0].x + last[1].x) / 2, y: (last[0].y + last[1].y) / 2 };
        const midCur = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 };
        const dPrev = Math.hypot(last[0].x - last[1].x, last[0].y - last[1].y);
        const dCur = Math.hypot(cur[0].x - cur[1].x, cur[0].y - cur[1].y);
        if (dPrev > 0) h.zoomAt(midCur.x - st.w / 2, midCur.y - st.h / 2, dCur / dPrev);
        h.panBy(midCur.x - midPrev.x, midCur.y - midPrev.y);
      }
      last = cur;
    };
    const onEnd = (e: TouchEvent) => {
      const cur = points(e);
      if (cur.length === 0) {
        if (state === 'paint') handlers.current.endStroke();
        state = null;
        setCursor(null);
      } else if (state === 'pinch') {
        // Lifting one finger of a pinch shouldn't start painting.
        state = 'done';
      }
      last = cur;
    };
    const blockGesture = (e: Event) => e.preventDefault();
    const opts = { passive: false } as const;
    el.addEventListener('touchstart', onStart, opts);
    el.addEventListener('touchmove', onMove, opts);
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('gesturestart', blockGesture, opts);
    el.addEventListener('gesturechange', blockGesture, opts);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('gesturestart', blockGesture);
      el.removeEventListener('gesturechange', blockGesture);
    };
  }, [img]);

  // Wheel zoom around the pointer.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2, Math.exp(-delta * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, img]);

  // Keyboard: undo/redo, brush size, Space to pan.
  useEffect(() => {
    if (!img) return;
    const onDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        redo();
      } else if (!mod && (e.key === '[' || e.key === ']')) {
        const r = ranges(Math.max(engine.current!.w, engine.current!.h));
        setBrush((b) => clamp(Math.round(b * (e.key === ']' ? 1.15 : 1 / 1.15)), r.brushMin, r.brushMax));
      } else if (e.key === ' ' && document.activeElement === stageRef.current) {
        e.preventDefault();
        space.current = true;
        setPanning(true);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && space.current) {
        space.current = false;
        if (drag.current?.type !== 'pan') setPanning(false);
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [img, undo, redo]);

  const onStageKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 80 : 24;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => panBy(step, 0),
      ArrowRight: () => panBy(-step, 0),
      ArrowUp: () => panBy(0, step),
      ArrowDown: () => panBy(0, -step),
      '+': () => zoomAt(0, 0, 1.25),
      '=': () => zoomAt(0, 0, 1.25),
      '-': () => zoomAt(0, 0, 1 / 1.25),
      '0': () => setView(FIT),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  // ----- export -----

  const fileName = img ? `${baseName(img.name)}-pixelated.png` : 'pixelated.png';

  const exportBlob = async () => {
    const p = engine.current;
    if (!p) throw new Error('no image');
    p.compose(mode === 'whole');
    return canvasToBlob(p.result);
  };

  const onDownload = async () => {
    setBusy(true);
    try {
      downloadBlob(await exportBlob(), fileName);
    } catch {
      setError('Export failed. Try a smaller image.');
    } finally {
      setBusy(false);
    }
  };

  const onShare = async () => {
    setBusy(true);
    try {
      const blob = await exportBlob();
      await navigator.share({ files: [new File([blob], fileName, { type: 'image/png' })] });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setError('Sharing failed. Use Download instead.');
    } finally {
      setBusy(false);
    }
  };

  const disabled = !img;
  const brushMode = mode === 'brush';
  const ring = Math.max(4, brush * scale);
  const sliderLog = (v: number) => Math.log(v);

  return (
    <div className="px">
      <div className="px-stage-card">
        {img && eng ? (
          <>
            <div
              ref={stageRef}
              className={`px-stage checker${brushMode && !panning ? ' is-brush' : ''}${panning ? ' is-panning' : ''}`}
              tabIndex={0}
              role="application"
              aria-label={
                brushMode
                  ? 'Image. Drag to paint pixelation. Right-drag, Space and drag, or two fingers to move. Scroll or pinch to zoom.'
                  : 'Image. Drag to move, scroll or pinch to zoom. Arrow keys move, plus and minus zoom, 0 fits.'
              }
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => setCursor(null)}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={onStageKey}
            >
              <canvas ref={canvasRef} />
              {brushMode && cursor && !panning && (
                <div className="px-cursor" style={{ width: ring, height: ring, left: cursor.x - ring / 2, top: cursor.y - ring / 2 }} />
              )}
              {compare && <div className="px-badge mono">original</div>}
            </div>
            <div className="px-meta mono">
              <span className="px-file" title={img.name}>
                {img.name} · {eng.w} × {eng.h}
                {eng.scaled ? ` (from ${img.width} × ${img.height})` : ''}
              </span>
              <div className="px-zoom">
                <button type="button" aria-label="Zoom out" onClick={() => zoomAt(0, 0, 1 / 1.25)}>
                  −
                </button>
                <button type="button" aria-label="Fit to view" title="Fit to view" onClick={() => setView(FIT)}>
                  {Math.round(scale * 100)}%
                </button>
                <button type="button" aria-label="Zoom in" onClick={() => zoomAt(0, 0, 1.25)}>
                  +
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="px-empty">
            <DropZone onFile={openFile} error={error} />
          </div>
        )}
      </div>

      <aside className="px-panel" aria-label="Pixelate settings">
        <fieldset className="px-field" disabled={disabled}>
          <legend className="px-label mono">pixelate</legend>
          <div className="px-seg">
            <button type="button" aria-pressed={mode === 'whole'} onClick={() => setMode('whole')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="1" /><path d="M4 12h16M12 4v16" /></svg>
              Whole image
            </button>
            <button type="button" aria-pressed={mode === 'brush'} onClick={() => setMode('brush')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 9.2 12z" /><path d="M9 14.5c-1.7 0-3 1.3-3 3 0 1.2-.8 2.2-2 2.5 1 .7 2.2 1 3.5 1 2.5 0 4.5-2 4.5-4.5z" /></svg>
              Brush
            </button>
          </div>
        </fieldset>

        <div className="px-field">
          <label htmlFor="px-block" className="px-label mono px-row">
            <span>intensity</span>
            <span className="px-val">{block} px blocks</span>
          </label>
          <input
            id="px-block"
            type="range"
            min={sliderLog(range.blockMin)}
            max={sliderLog(range.blockMax)}
            step={0.01}
            disabled={disabled}
            value={sliderLog(block)}
            aria-valuetext={`${block} pixel blocks`}
            onChange={(e) => setBlock(Math.round(Math.exp(Number(e.target.value))))}
          />
          <div className="px-scale mono" aria-hidden="true">
            <span>subtle</span>
            <span>strong</span>
          </div>
        </div>

        {brushMode && (
          <>
            <fieldset className="px-field" disabled={disabled}>
              <legend className="px-label mono">brush</legend>
              <div className="px-seg">
                <button type="button" aria-pressed={tool === 'paint'} onClick={() => setTool('paint')}>
                  Paint
                </button>
                <button type="button" aria-pressed={tool === 'erase'} onClick={() => setTool('erase')}>
                  Erase
                </button>
              </div>
            </fieldset>

            <div className="px-field">
              <label htmlFor="px-brush" className="px-label mono px-row">
                <span>brush size</span>
                <span className="px-val">{brush} px</span>
              </label>
              <input
                id="px-brush"
                type="range"
                min={sliderLog(range.brushMin)}
                max={sliderLog(range.brushMax)}
                step={0.01}
                disabled={disabled}
                value={sliderLog(brush)}
                aria-valuetext={`${brush} pixels`}
                onChange={(e) => setBrush(Math.round(Math.exp(Number(e.target.value))))}
              />
            </div>

            <div className="px-history">
              <button type="button" className="btn btn-ghost" disabled={disabled || !hist.undo} onClick={undo} title="Undo (Ctrl+Z)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
                Undo
              </button>
              <button type="button" className="btn btn-ghost" disabled={disabled || !hist.redo} onClick={redo} title="Redo (Ctrl+Shift+Z)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></svg>
                Redo
              </button>
              <button type="button" className="btn btn-ghost" disabled={disabled || !hist.brushed} onClick={clearBrush}>
                Clear
              </button>
            </div>
            {img && !hist.brushed && <p className="px-note">Paint over the parts you want to hide, like faces, plates or names.</p>}
          </>
        )}

        <button
          type="button"
          className="btn btn-ghost px-compare"
          disabled={disabled}
          aria-pressed={compare}
          onPointerDown={(e) => {
            e.preventDefault();
            setCompare(true);
          }}
          onPointerUp={() => setCompare(false)}
          onPointerLeave={() => setCompare(false)}
          onPointerCancel={() => setCompare(false)}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              setCompare(true);
            }
          }}
          onKeyUp={() => setCompare(false)}
          onBlur={() => setCompare(false)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
          Hold to see original
        </button>

        <div className="px-result">
          <div className="px-result-name">{img ? fileName : 'No image yet'}</div>
          <div className="px-result-text">{eng ? `${eng.w} × ${eng.h} px · PNG` : 'Add an image to start.'}</div>
        </div>

        {img && error && (
          <p className="px-error" role="alert">
            {error}
          </p>
        )}

        <div className="px-actions">
          <button type="button" className="btn btn-primary" disabled={disabled || busy} onClick={onDownload}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            {busy ? 'Preparing…' : 'Download PNG'}
          </button>
          {shareable && (
            <button type="button" className="btn btn-ghost" disabled={disabled || busy} onClick={onShare}>
              Share or save to photos
            </button>
          )}
          <div className="px-secondary">
            <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => setView(FIT)}>
              Fit view
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() => {
                engine.current = null;
                setImg(null);
                setError(null);
                setCursor(null);
              }}
            >
              New image
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
