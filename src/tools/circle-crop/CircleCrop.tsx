import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import DropZone from '../shared/DropZone';
import {
  baseName,
  canShareFiles,
  canvasToBlob,
  downloadBlob,
  loadImageFile,
  type LoadedImage,
} from '../shared/image';
import './circle-crop.css';

type Shape = 'circle' | 'oval';

/**
 * Geometry is kept in "mask units": the mask is 1 unit wide (and 1/ratio tall),
 * so the framing survives stage resizes and maps straight onto the export.
 */
interface View {
  ox: number; // image centre offset from mask centre, in mask units
  oy: number;
  zoom: number; // 1 = image just covers the mask
  rot: number; // degrees
}

const DEFAULT_VIEW: View = { ox: 0, oy: 0, zoom: 1, rot: 0 };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 10;
const MASK_FILL = 0.8; // share of the stage the mask may use
const MAX_SIDE = 4096; // keeps exports inside mobile canvas limits
const SIZE_OPTIONS = [
  { value: '512', label: '512 px' },
  { value: '1024', label: '1024 px' },
  { value: '2048', label: '2048 px' },
  { value: 'original', label: 'Original resolution' },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function maskUnits(shape: Shape, ratio: number) {
  return { mw: 1, mh: shape === 'circle' ? 1 : 1 / ratio };
}

/** Image pixels → mask units, before zoom: the image just covers the mask. */
function coverScale(img: LoadedImage, shape: Shape, ratio: number) {
  const { mw, mh } = maskUnits(shape, ratio);
  return Math.max(mw / img.width, mh / img.height);
}

/** Mask size in stage pixels. */
function maskPixels(stageW: number, stageH: number, shape: Shape, ratio: number) {
  const r = shape === 'circle' ? 1 : ratio;
  const boxW = stageW * MASK_FILL;
  const boxH = stageH * MASK_FILL;
  const w = Math.min(boxW, boxH * r);
  return { w, h: w / r };
}

/** Output pixel size for a chosen size option. */
function outputSize(img: LoadedImage, shape: Shape, ratio: number, size: string, view: View) {
  const r = shape === 'circle' ? 1 : ratio;
  let w: number;
  if (size === 'original') {
    // Mask width measured in source pixels.
    w = 1 / (coverScale(img, shape, ratio) * view.zoom);
  } else {
    const side = Number(size);
    w = r >= 1 ? side : side * r;
  }
  let h = w / r;
  const longest = Math.max(w, h);
  if (longest > MAX_SIDE) {
    w *= MAX_SIDE / longest;
    h *= MAX_SIDE / longest;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** Draws the image as framed by `view` into a canvas the size of the mask. */
function renderCrop(canvas: HTMLCanvasElement, img: LoadedImage, shape: Shape, ratio: number, view: View, w: number, h: number) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.clip();
  const k = w; // px per mask unit
  ctx.translate(w / 2 + view.ox * k, h / 2 + view.oy * k);
  ctx.rotate((view.rot * Math.PI) / 180);
  const s = coverScale(img, shape, ratio) * view.zoom * k;
  ctx.scale(s, s);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.el, -img.width / 2, -img.height / 2);
  ctx.restore();
}

export default function CircleCrop() {
  const [img, setImg] = useState<LoadedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shape, setShape] = useState<Shape>('circle');
  const [ratio, setRatio] = useState(0.8); // oval width / height
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [size, setSize] = useState('1024');
  const [busy, setBusy] = useState(false);
  const [shareable, setShareable] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  useEffect(() => setShareable(canShareFiles()), []);

  // Free the previous object URL when the image changes or the tool unmounts.
  useEffect(() => () => {
    if (img) URL.revokeObjectURL(img.url);
  }, [img]);

  const openFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const loaded = await loadImageFile(file, file.name || 'image');
      setImg(loaded);
      setView(DEFAULT_VIEW);
    } catch {
      setError("Couldn't open that file. Try a JPG, PNG or WebP image.");
    }
  }, []);

  // Track the stage size.
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

  const mask = maskPixels(stage.w, stage.h, shape, ratio);
  const unit = mask.w; // stage px per mask unit

  // Draw the editor stage.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img || !stage.w) return;
    const frame = requestAnimationFrame(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(stage.w * dpr);
      canvas.height = Math.round(stage.h * dpr);
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, stage.w, stage.h);
      const cx = stage.w / 2;
      const cy = stage.h / 2;

      ctx.save();
      ctx.translate(cx + view.ox * unit, cy + view.oy * unit);
      ctx.rotate((view.rot * Math.PI) / 180);
      const s = coverScale(img, shape, ratio) * view.zoom * unit;
      ctx.scale(s, s);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img.el, -img.width / 2, -img.height / 2);
      ctx.restore();

      // Dim everything outside the mask.
      ctx.beginPath();
      ctx.rect(0, 0, stage.w, stage.h);
      ctx.ellipse(cx, cy, mask.w / 2, mask.h / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(8, 9, 12, 0.68)';
      ctx.fill('evenodd');

      ctx.beginPath();
      ctx.ellipse(cx, cy, mask.w / 2, mask.h / 2, 0, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#FFE14D';
      ctx.stroke();
    });
    return () => cancelAnimationFrame(frame);
  }, [img, view, shape, ratio, stage, unit, mask.w, mask.h]);

  // Live result thumbnail.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !img) return;
    const frame = requestAnimationFrame(() => {
      const r = shape === 'circle' ? 1 : ratio;
      const side = 128;
      const w = r >= 1 ? side : Math.round(side * r);
      const h = Math.round(w / r);
      renderCrop(canvas, img, shape, ratio, view, w, h);
    });
    return () => cancelAnimationFrame(frame);
  }, [img, view, shape, ratio]);

  const out = img ? outputSize(img, shape, ratio, size, view) : { w: 0, h: 0 };

  // ----- gestures -----

  const zoomAt = useCallback(
    (px: number, py: number, factor: number) => {
      // px, py: stage pixels relative to the stage centre.
      setView((v) => {
        const zoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const f = zoom / v.zoom;
        const ux = px / unit;
        const uy = py / unit;
        return { ...v, zoom, ox: ux - (ux - v.ox) * f, oy: uy - (uy - v.oy) * f };
      });
    },
    [unit]
  );

  const panBy = useCallback(
    (dx: number, dy: number) => {
      if (!unit) return;
      setView((v) => {
        // Keep the image from being dragged completely out of reach.
        const limit = img ? (0.5 * Math.hypot(img.width, img.height) * coverScale(img, shape, ratio) * v.zoom) + 0.5 : 5;
        return { ...v, ox: clamp(v.ox + dx / unit, -limit, limit), oy: clamp(v.oy + dy / unit, -limit, limit) };
      });
    },
    [unit, img, shape, ratio]
  );

  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; gestures still work without it */
    }
    pointers.current.set(e.pointerId, local(e));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const map = pointers.current;
    const prev = map.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    if (map.size === 1) {
      map.set(e.pointerId, cur);
      panBy(cur.x - prev.x, cur.y - prev.y);
      return;
    }
    // Two fingers: pinch to zoom around their midpoint, and pan with it.
    const [idA, idB] = Array.from(map.keys());
    const other = map.get(e.pointerId === idA ? idB : idA)!;
    const midPrev = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
    const midCur = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
    const dPrev = Math.hypot(prev.x - other.x, prev.y - other.y);
    const dCur = Math.hypot(cur.x - other.x, cur.y - other.y);
    map.set(e.pointerId, cur);
    if (dPrev > 0) zoomAt(midCur.x, midCur.y, dCur / dPrev);
    panBy(midCur.x - midPrev.x, midCur.y - midPrev.y);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
  };

  // Wheel zoom needs a non-passive listener so the page doesn't scroll.
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = (e.shiftKey ? 0.1 : 0.02) * unit;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => panBy(-step, 0),
      ArrowRight: () => panBy(step, 0),
      ArrowUp: () => panBy(0, -step),
      ArrowDown: () => panBy(0, step),
      '+': () => zoomAt(0, 0, 1.1),
      '=': () => zoomAt(0, 0, 1.1),
      '-': () => zoomAt(0, 0, 1 / 1.1),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  // ----- export -----

  const exportBlob = async () => {
    if (!img) throw new Error('no image');
    const c = document.createElement('canvas');
    renderCrop(c, img, shape, ratio, view, out.w, out.h);
    return canvasToBlob(c);
  };

  const fileName = img ? `${baseName(img.name)}-${shape}.png` : 'crop.png';

  const onDownload = async () => {
    setBusy(true);
    try {
      downloadBlob(await exportBlob(), fileName);
    } catch {
      setError('Export failed. Try a smaller output size.');
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

  const changeShape = (s: Shape) => setShape(s);

  const zoomPct = Math.round(view.zoom * 100);
  const disabled = !img;

  return (
    <div className="cc">
      <div className="cc-stage-card">
        {img ? (
          <>
            <div
              ref={stageRef}
              className="cc-stage checker"
              tabIndex={0}
              role="application"
              aria-label="Crop area. Drag to move the image, pinch or scroll to zoom. Arrow keys move, plus and minus zoom."
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
            >
              <canvas ref={canvasRef} />
            </div>
            <div className="cc-meta mono">
              <span className="cc-file" title={img.name}>
                {img.name} · {img.width} × {img.height}
              </span>
              <span className="cc-hint">drag to move · pinch or scroll to zoom</span>
            </div>
          </>
        ) : (
          <div className="cc-empty">
            <DropZone onFile={openFile} error={error} />
          </div>
        )}
      </div>

      <aside className="cc-panel" aria-label="Crop settings">
        <fieldset className="cc-field" disabled={disabled}>
          <legend className="cc-label mono">shape</legend>
          <div className="cc-seg">
            <button type="button" aria-pressed={shape === 'circle'} onClick={() => changeShape('circle')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>
              Circle
            </button>
            <button type="button" aria-pressed={shape === 'oval'} onClick={() => changeShape('oval')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><ellipse cx="12" cy="12" rx="6" ry="9" /></svg>
              Oval
            </button>
          </div>
        </fieldset>

        {shape === 'oval' && (
          <div className="cc-field">
            <label htmlFor="cc-ratio" className="cc-label mono cc-row">
              <span>oval shape</span>
              <span className="cc-val">{ratio >= 1 ? `${ratio.toFixed(2)} : 1 wide` : `1 : ${(1 / ratio).toFixed(2)} tall`}</span>
            </label>
            <input
              id="cc-ratio"
              type="range"
              min={-100}
              max={100}
              step={1}
              disabled={disabled}
              // Log scale so tall and wide feel symmetric: 0.4 … 1 … 2.5
              value={Math.round((Math.log(ratio) / Math.log(2.5)) * 100)}
              onChange={(e) => setRatio(Math.pow(2.5, Number(e.target.value) / 100))}
            />
          </div>
        )}

        <div className="cc-field">
          <label htmlFor="cc-zoom" className="cc-label mono cc-row">
            <span>zoom</span>
            <span className="cc-val">{zoomPct}%</span>
          </label>
          <input
            id="cc-zoom"
            type="range"
            min={Math.log(MIN_ZOOM)}
            max={Math.log(MAX_ZOOM)}
            step={0.01}
            disabled={disabled}
            value={Math.log(view.zoom)}
            onChange={(e) => {
              const zoom = Math.exp(Number(e.target.value));
              zoomAt(0, 0, zoom / view.zoom);
            }}
          />
        </div>

        <div className="cc-field">
          <label htmlFor="cc-rot" className="cc-label mono cc-row">
            <span>rotate</span>
            <span className="cc-val">{Math.round(view.rot)}°</span>
          </label>
          <div className="cc-rot">
            <input
              id="cc-rot"
              type="range"
              min={-180}
              max={180}
              step={1}
              disabled={disabled}
              value={view.rot}
              onChange={(e) => setView((v) => ({ ...v, rot: Number(e.target.value) }))}
            />
            <button
              type="button"
              className="cc-icon-btn"
              disabled={disabled}
              aria-label="Rotate 90 degrees clockwise"
              onClick={() => setView((v) => ({ ...v, rot: ((((v.rot + 90 + 180) % 360) + 360) % 360) - 180 }))}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
            </button>
          </div>
        </div>

        <div className="cc-field">
          <label htmlFor="cc-size" className="cc-label mono">output size</label>
          <select id="cc-size" value={size} disabled={disabled} onChange={(e) => setSize(e.target.value)}>
            {SIZE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="cc-result">
          <div className="cc-thumb checker">{img ? <canvas ref={previewRef} aria-label="Cropped result preview" role="img" /> : null}</div>
          <div className="cc-result-text">
            <div className="cc-result-name">{img ? fileName : 'No image yet'}</div>
            {img ? (
              <>
                {out.w} × {out.h} px · transparent background
              </>
            ) : (
              'Your PNG preview shows here.'
            )}
          </div>
        </div>

        {img && error && (
          <p className="cc-error" role="alert">
            {error}
          </p>
        )}

        <div className="cc-actions">
          <button type="button" className="btn btn-primary" disabled={disabled || busy} onClick={onDownload}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            {busy ? 'Preparing…' : 'Download PNG'}
          </button>
          {shareable && (
            <button type="button" className="btn btn-ghost" disabled={disabled || busy} onClick={onShare}>
              Share or save to photos
            </button>
          )}
          <div className="cc-secondary">
            <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => setView(DEFAULT_VIEW)}>
              Reset
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() => {
                setImg(null);
                setError(null);
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
