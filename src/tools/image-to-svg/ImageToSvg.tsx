import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DropZone from '../shared/DropZone';
import { baseName, downloadBlob, formatBytes, loadImageFile, type LoadedImage } from '../shared/image';
import type { Background, Mode, TraceOptions } from './trace';
import type { TraceRequest, TraceResponse } from './trace.worker';
import '../shared/tool.css';
import './image-to-svg.css';

// ----- settings -----

interface Settings {
  mode: Mode;
  colors: number; // colour mode
  lineColors: number; // line art: fewer colours means fewer, cleaner lines
  autoThreshold: boolean;
  threshold: number;
  background: Record<Mode, Background>;
  ink: string;
  lineWidth: number;
  lineFill: boolean;
  resolution: number;
  cleanup: number; // 0–100
  simplify: number; // trace px
  smooth: number; // 0–1
  blur: number; // trace px
  denoise: number; // 0–100, edge-preserving
}

const DEFAULTS: Settings = {
  mode: 'color',
  colors: 8,
  lineColors: 6,
  autoThreshold: true,
  threshold: 128,
  background: { color: 'original', bw: 'white', line: 'white' },
  ink: '#000000',
  lineWidth: 1.5,
  lineFill: false,
  resolution: 1000,
  cleanup: 25,
  simplify: 1,
  smooth: 0.6,
  blur: 0,
  denoise: 50,
};

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'color', label: 'Colour', hint: 'Flat colour shapes, like a poster or illustration.' },
  { value: 'bw', label: 'B & W', hint: 'One colour on a background. Good for logos, signatures and scans.' },
  { value: 'line', label: 'Line art', hint: 'Outlines traced along colour changes and borders.' },
];

const BACKGROUNDS: { value: Background; label: string }[] = [
  { value: 'original', label: 'Keep' },
  { value: 'transparent', label: 'None' },
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
];

const RESOLUTIONS = [
  { value: 500, label: 'Low · fastest, smallest file' },
  { value: 1000, label: 'Medium' },
  { value: 1600, label: 'High' },
  { value: 2400, label: 'Very high · slow on phones' },
];

const MIN_ZOOM = 1;
const MAX_ZOOM = 16;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function traceSize(img: LoadedImage, maxSide: number) {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  return { w: Math.max(1, Math.round(img.width * s)), h: Math.max(1, Math.round(img.height * s)) };
}

/** Speck size in trace pixels for the clean-up slider: quadratic, up to 0.2% of the image. */
function minAreaFor(cleanup: number, w: number, h: number) {
  const t = cleanup / 100;
  return Math.round(t * t * 0.002 * w * h);
}

function toOptions(s: Settings, img: LoadedImage, w: number, h: number): TraceOptions {
  const bg = s.background[s.mode];
  return {
    mode: s.mode,
    colors: s.mode === 'line' ? s.lineColors : s.colors,
    threshold: s.autoThreshold ? null : s.threshold,
    blur: s.blur,
    denoise: s.denoise,
    minArea: minAreaFor(s.cleanup, w, h),
    simplify: s.simplify,
    smooth: s.smooth,
    // Width is per 1000 px of the long side, so changing detail keeps the look.
    lineWidth: (s.lineWidth * Math.max(w, h)) / 1000,
    lineFill: s.lineFill,
    // "Keep" only makes sense when colours are drawn.
    background: bg === 'original' && s.mode !== 'color' && !(s.mode === 'line' && s.lineFill) ? 'transparent' : bg,
    ink: s.ink,
    outWidth: img.width,
    outHeight: img.height,
  };
}

interface Result {
  svg: string;
  url: string;
  bytes: number;
  shapes: number;
  palette: string[];
  threshold?: number;
  ms: number;
}

// ----- worker -----

/** Runs one trace at a time. A new request stops the running one, so sliders stay responsive. */
function useTracer(onResponse: (r: TraceResponse) => void) {
  const worker = useRef<Worker | null>(null);
  const busy = useRef(false);
  const handler = useRef(onResponse);
  handler.current = onResponse;

  const spawn = useCallback(() => {
    const w = new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<TraceResponse>) => {
      if (e.data.type !== 'progress') busy.current = false;
      handler.current(e.data);
    };
    w.onerror = (e) => {
      e.preventDefault();
      busy.current = false;
      handler.current({ id: -1, type: 'error', message: e.message || 'worker failed' });
    };
    return w;
  }, []);

  const run = useCallback(
    (req: TraceRequest) => {
      if (busy.current && worker.current) {
        worker.current.terminate();
        worker.current = null;
      }
      if (!worker.current) worker.current = spawn();
      busy.current = true;
      worker.current.postMessage(req, [req.data.buffer]);
    },
    [spawn]
  );

  useEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = null;
    },
    []
  );
  return run;
}

// ----- component -----

export default function ImageToSvg() {
  const [img, setImg] = useState<LoadedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [result, setResult] = useState<Result | null>(null);
  const [stage, setStageText] = useState<string | null>(null);
  const [show, setShow] = useState<'svg' | 'original'>('svg');
  const [copied, setCopied] = useState(false);
  const [shareable, setShareable] = useState(false);

  const jobId = useRef(0);
  const pixels = useRef(new Map<number, ImageData>());

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => ({ ...s, [key]: value }));

  useEffect(() => {
    try {
      const probe = new File(['<svg/>'], 'probe.svg', { type: 'image/svg+xml' });
      setShareable(!!navigator.canShare && navigator.canShare({ files: [probe] }));
    } catch {
      setShareable(false);
    }
  }, []);

  // Free object URLs when they're replaced or the tool unmounts.
  useEffect(() => () => {
    if (img) URL.revokeObjectURL(img.url);
  }, [img]);
  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  const openFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const loaded = await loadImageFile(file, file.name || 'image');
      pixels.current.clear();
      setResult(null);
      setShow('svg');
      setImg(loaded);
    } catch {
      setError("Couldn't open that file. Try a JPG, PNG or WebP image.");
    }
  }, []);

  const onResponse = useCallback((r: TraceResponse) => {
    if (r.id !== jobId.current && r.id !== -1) return; // a stale job
    if (r.type === 'progress') {
      setStageText(r.stage);
      return;
    }
    setStageText(null);
    if (r.type === 'error') {
      setError("Tracing failed. Try a lower detail level or fewer colours.");
      return;
    }
    setError(null);
    const blob = new Blob([r.svg], { type: 'image/svg+xml' });
    setResult({
      svg: r.svg,
      url: URL.createObjectURL(blob),
      bytes: blob.size,
      shapes: r.shapes,
      palette: r.palette,
      threshold: r.threshold,
      ms: r.ms,
    });
  }, []);

  const run = useTracer(onResponse);

  // Pixels at the chosen trace resolution, drawn once per image and size.
  const getPixels = useCallback((image: LoadedImage, maxSide: number) => {
    const cached = pixels.current.get(maxSide);
    if (cached) return cached;
    const { w, h } = traceSize(image, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image.el, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    pixels.current.set(maxSide, data);
    return data;
  }, []);

  // Re-trace shortly after settings stop changing.
  useEffect(() => {
    if (!img) return;
    const timer = setTimeout(() => {
      let data: ImageData;
      try {
        data = getPixels(img, settings.resolution);
      } catch {
        setError('This image is too large for your browser. Try a lower detail level.');
        return;
      }
      const id = ++jobId.current;
      setStageText('Starting');
      run({
        id,
        width: data.width,
        height: data.height,
        data: new Uint8ClampedArray(data.data), // a copy, so the cached pixels survive the transfer
        options: toOptions(settings, img, data.width, data.height),
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [img, settings, getPixels, run]);

  const fileName = img ? `${baseName(img.name)}.svg` : 'image.svg';

  const onDownload = () => {
    if (!result) return;
    downloadBlob(new Blob([result.svg], { type: 'image/svg+xml' }), fileName);
  };

  const onCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.svg);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Couldn't copy. Use Download instead.");
    }
  };

  const onShare = async () => {
    if (!result) return;
    try {
      await navigator.share({ files: [new File([result.svg], fileName, { type: 'image/svg+xml' })] });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setError('Sharing failed. Use Download instead.');
    }
  };

  const changeMode = (mode: Mode) =>
    setSettings((s) => {
      // Light lines on a black background by default, dark lines otherwise.
      const bg = s.background[mode];
      const ink = bg === 'black' && s.ink === '#000000' ? '#ffffff' : bg !== 'black' && s.ink === '#ffffff' ? '#000000' : s.ink;
      return { ...s, mode, ink };
    });

  const changeBackground = (bg: Background) =>
    setSettings((s) => {
      const ink = bg === 'black' && s.ink === '#000000' ? '#ffffff' : bg !== 'black' && s.ink === '#ffffff' ? '#000000' : s.ink;
      return { ...s, ink, background: { ...s.background, [s.mode]: bg } };
    });

  const { mode } = settings;
  const disabled = !img;
  const keepAllowed = mode === 'color' || (mode === 'line' && settings.lineFill);
  const bg = settings.background[mode] === 'original' && !keepAllowed ? 'transparent' : settings.background[mode];
  const size = img ? traceSize(img, settings.resolution) : null;
  const bgClass = show === 'svg' && result ? (bg === 'white' ? ' on-white' : bg === 'black' ? ' on-black' : '') : '';

  return (
    <div className="vs">
      <div className="vs-stage-card">
        {img ? (
          <>
            <div className="vs-toolbar">
              <div className="vs-seg vs-seg-sm" role="group" aria-label="Preview">
                <button type="button" aria-pressed={show === 'svg'} onClick={() => setShow('svg')}>
                  Vector
                </button>
                <button type="button" aria-pressed={show === 'original'} onClick={() => setShow('original')}>
                  Original
                </button>
              </div>
              <span className="vs-status mono" aria-live="polite">
                {stage ? (
                  <>
                    <span className="vs-spinner" aria-hidden="true" />
                    {stage.toLowerCase()}…
                  </>
                ) : result ? (
                  `traced in ${result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(1)} s`}`
                ) : null}
              </span>
            </div>
            <Viewer
              key={img.url}
              src={show === 'svg' ? result?.url ?? null : img.url}
              aspect={img.width / img.height}
              className={`checker${bgClass}`}
              label={show === 'svg' ? 'Traced SVG preview' : 'Original image'}
            />
            <div className="vs-meta mono">
              <span className="vs-file" title={img.name}>
                {img.name} · {img.width} × {img.height}
              </span>
              <span className="vs-hint">pinch or scroll to zoom · drag to move</span>
            </div>
          </>
        ) : (
          <div className="vs-empty">
            <DropZone onFile={openFile} error={error} />
          </div>
        )}
      </div>

      <aside className="vs-panel" aria-label="Trace settings">
        <fieldset className="vs-field" disabled={disabled}>
          <legend className="vs-label mono">style</legend>
          <div className="vs-seg vs-seg-3">
            {MODES.map((m) => (
              <button key={m.value} type="button" aria-pressed={mode === m.value} onClick={() => changeMode(m.value)}>
                {m.label}
              </button>
            ))}
          </div>
          <p className="vs-help">{MODES.find((m) => m.value === mode)!.hint}</p>
        </fieldset>

        {mode !== 'bw' && (
          <Slider
            id="vs-colors"
            label={mode === 'line' ? 'colour steps' : 'colours'}
            value={mode === 'line' ? settings.lineColors : settings.colors}
            display={String(mode === 'line' ? settings.lineColors : settings.colors)}
            min={2}
            max={mode === 'line' ? 16 : 32}
            step={1}
            disabled={disabled}
            onChange={(v) => set(mode === 'line' ? 'lineColors' : 'colors', v)}
            help={mode === 'line' ? 'More steps trace more colour changes, so you get more lines.' : undefined}
          />
        )}

        {mode === 'bw' && (
          <div className="vs-field">
            <label htmlFor="vs-threshold" className="vs-label mono vs-row">
              <span>threshold</span>
              <span className="vs-val">
                {settings.autoThreshold ? `auto${result?.threshold != null ? ` · ${result.threshold}` : ''}` : settings.threshold}
              </span>
            </label>
            <div className="vs-inline">
              <input
                id="vs-threshold"
                type="range"
                min={1}
                max={254}
                step={1}
                disabled={disabled}
                value={settings.autoThreshold ? result?.threshold ?? 128 : settings.threshold}
                onChange={(e) => setSettings((s) => ({ ...s, autoThreshold: false, threshold: Number(e.target.value) }))}
              />
              <button
                type="button"
                className="vs-chip"
                aria-pressed={settings.autoThreshold}
                disabled={disabled}
                onClick={() => set('autoThreshold', true)}
              >
                Auto
              </button>
            </div>
            <p className="vs-help">Pixels darker than this become the shape.</p>
          </div>
        )}

        {mode === 'line' && (
          <>
            <Slider
              id="vs-width"
              label="line width"
              value={settings.lineWidth}
              display={settings.lineWidth.toFixed(1)}
              min={0.5}
              max={8}
              step={0.5}
              disabled={disabled}
              onChange={(v) => set('lineWidth', v)}
            />
            <label className="vs-check">
              <input
                type="checkbox"
                checked={settings.lineFill}
                disabled={disabled}
                onChange={(e) => set('lineFill', e.target.checked)}
              />
              <span>Keep colours under the lines</span>
            </label>
          </>
        )}

        <fieldset className="vs-field" disabled={disabled}>
          <legend className="vs-label mono">background</legend>
          <div className="vs-seg vs-seg-4">
            {BACKGROUNDS.map((b) => (
              <button
                key={b.value}
                type="button"
                aria-pressed={bg === b.value}
                disabled={b.value === 'original' && !keepAllowed}
                onClick={() => changeBackground(b.value)}
              >
                {b.label}
              </button>
            ))}
          </div>
          {mode === 'color' && bg !== 'original' && (
            <p className="vs-help">Replaces the colour around the edges of the image.</p>
          )}
        </fieldset>

        {mode !== 'color' && (
          <div className="vs-field">
            <label htmlFor="vs-ink" className="vs-label mono vs-row">
              <span>{mode === 'line' ? 'line colour' : 'shape colour'}</span>
              <span className="vs-val">{settings.ink}</span>
            </label>
            <input
              id="vs-ink"
              className="vs-color"
              type="color"
              value={settings.ink}
              disabled={disabled}
              onChange={(e) => set('ink', e.target.value)}
            />
          </div>
        )}

        <Slider
          id="vs-denoise"
          label="smooth texture"
          value={settings.denoise}
          display={settings.denoise === 0 ? 'off' : `${settings.denoise}%`}
          min={0}
          max={100}
          step={5}
          disabled={disabled}
          onChange={(v) => set('denoise', v)}
          help="Flattens grain and shading into clean areas while keeping outlines sharp. Raise it if you see lots of dots."
        />

        <details className="vs-more">
          <summary className="mono">fine-tune</summary>
          <div className="vs-more-body">
            <div className="vs-field">
              <label htmlFor="vs-res" className="vs-label mono vs-row">
                <span>detail</span>
                {size && (
                  <span className="vs-val">
                    {size.w} × {size.h}
                  </span>
                )}
              </label>
              <select
                id="vs-res"
                value={settings.resolution}
                disabled={disabled}
                onChange={(e) => set('resolution', Number(e.target.value))}
              >
                {RESOLUTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <Slider
              id="vs-cleanup"
              label="remove specks"
              value={settings.cleanup}
              display={settings.cleanup === 0 ? 'off' : `${settings.cleanup}%`}
              min={0}
              max={100}
              step={1}
              disabled={disabled}
              onChange={(v) => set('cleanup', v)}
              help="Merges small spots into what surrounds them."
            />
            <Slider
              id="vs-simplify"
              label="simplify paths"
              value={settings.simplify}
              display={settings.simplify.toFixed(2)}
              min={0.25}
              max={4}
              step={0.05}
              disabled={disabled}
              onChange={(v) => set('simplify', v)}
              help="Higher means fewer points and a smaller file."
            />
            <Slider
              id="vs-smooth"
              label="smooth corners"
              value={settings.smooth}
              display={settings.smooth === 0 ? 'sharp' : `${Math.round(settings.smooth * 100)}%`}
              min={0}
              max={1}
              step={0.05}
              disabled={disabled}
              onChange={(v) => set('smooth', v)}
            />
            <Slider
              id="vs-blur"
              label="blur first"
              value={settings.blur}
              display={settings.blur === 0 ? 'off' : `${settings.blur} px`}
              min={0}
              max={4}
              step={1}
              disabled={disabled}
              onChange={(v) => set('blur', v)}
              help="Plain blur. Usually smooth texture works better, since blur also softens outlines."
            />
          </div>
        </details>

        <div className="vs-result">
          <div className="vs-result-name">{img ? fileName : 'No image yet'}</div>
          <div className="vs-result-text">
            {result ? (
              <>
                {formatBytes(result.bytes)} · {result.shapes.toLocaleString()} {mode === 'line' ? 'lines' : 'shapes'}
              </>
            ) : img ? (
              'Tracing…'
            ) : (
              'Your SVG details show here.'
            )}
          </div>
          {result && result.palette.length > 0 && (
            <div className="vs-swatches" aria-label="Colours used">
              {result.palette.slice(0, 32).map((c) => (
                <span key={c} className="vs-swatch" style={{ background: c }} title={c} />
              ))}
            </div>
          )}
        </div>

        {img && error && (
          <p className="vs-error" role="alert">
            {error}
          </p>
        )}

        <div className="vs-actions">
          <button type="button" className="btn btn-primary" disabled={!result} onClick={onDownload}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            Download SVG
          </button>
          <div className="vs-secondary">
            <button type="button" className="btn btn-ghost" disabled={!result} onClick={onCopy}>
              {copied ? 'Copied' : 'Copy code'}
            </button>
            {shareable ? (
              <button type="button" className="btn btn-ghost" disabled={!result} onClick={onShare}>
                Share
              </button>
            ) : (
              <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => setSettings(DEFAULTS)}>
                Reset
              </button>
            )}
          </div>
          <div className="vs-secondary">
            {shareable && (
              <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => setSettings(DEFAULTS)}>
                Reset
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              style={shareable ? undefined : { gridColumn: '1 / -1' }}
              disabled={disabled}
              onClick={() => {
                jobId.current++;
                setStageText(null);
                setImg(null);
                setResult(null);
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

// ----- slider -----

interface SliderProps {
  id: string;
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (v: number) => void;
  help?: string;
}

function Slider({ id, label, value, display, min, max, step, disabled, onChange, help }: SliderProps) {
  return (
    <div className="vs-field">
      <label htmlFor={id} className="vs-label mono vs-row">
        <span>{label}</span>
        <span className="vs-val">{display}</span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {help && <p className="vs-help">{help}</p>}
    </div>
  );
}

// ----- zoomable preview -----

interface ViewerProps {
  src: string | null;
  aspect: number;
  className: string;
  label: string;
}

interface View {
  z: number;
  x: number; // offset of the image centre from the stage centre, stage px
  y: number;
}

/**
 * Pan and zoom preview. The image is laid out at the committed zoom so the
 * browser redraws the SVG sharply, and a CSS scale covers the gap while a
 * gesture is still moving.
 */
function Viewer({ src, aspect, className, label }: ViewerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ z: 1, x: 0, y: 0 });
  const [committed, setCommitted] = useState(1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Image size at zoom 1: fit inside the stage with a small margin.
  const fit = useMemo(() => {
    const pad = 0.94;
    const w = Math.min(box.w * pad, box.h * pad * aspect);
    return { w, h: w / aspect };
  }, [box, aspect]);

  const clampView = useCallback(
    (v: View): View => {
      const z = clamp(v.z, MIN_ZOOM, MAX_ZOOM);
      const lx = Math.max(0, (fit.w * z - box.w) / 2 + box.w * 0.25);
      const ly = Math.max(0, (fit.h * z - box.h) / 2 + box.h * 0.25);
      return z === 1 ? { z, x: 0, y: 0 } : { z, x: clamp(v.x, -lx, lx), y: clamp(v.y, -ly, ly) };
    },
    [fit, box]
  );

  const zoomAt = useCallback(
    (px: number, py: number, factor: number) =>
      setView((v) => {
        const z = clamp(v.z * factor, MIN_ZOOM, MAX_ZOOM);
        const f = z / v.z;
        return clampView({ z, x: px - (px - v.x) * f, y: py - (py - v.y) * f });
      }),
    [clampView]
  );
  const panBy = useCallback((dx: number, dy: number) => setView((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy })), [clampView]);

  // Settle the layout zoom once the gesture pauses.
  useEffect(() => {
    if (view.z === committed) return;
    const t = setTimeout(() => setCommitted(view.z), 180);
    return () => clearTimeout(t);
  }, [view.z, committed]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  // Mouse and pen: drag to pan. Touch is handled by the native listeners below,
  // because iOS Safari doesn't reliably honour touch-action and cancels pointers.
  const last = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* optional */
    }
    last.current = local(e);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!last.current) return;
    const cur = local(e);
    panBy(cur.x - last.current.x, cur.y - last.current.y);
    last.current = cur;
  };
  const onPointerUp = () => {
    last.current = null;
  };

  // Touch: at 100% one finger scrolls the page as usual; once zoomed in it
  // pans. Two fingers always pinch-zoom the preview, never the page.
  const gesture = useRef({ panBy, zoomAt, z: view.z });
  gesture.current = { panBy, zoomAt, z: view.z };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let prev: { x: number; y: number }[] = [];
    let owned = false; // whether this touch sequence belongs to the preview
    const points = (e: TouchEvent) => {
      const r = el.getBoundingClientRect();
      return Array.from(e.touches)
        .slice(0, 2)
        .map((t) => ({ x: t.clientX - r.left - r.width / 2, y: t.clientY - r.top - r.height / 2 }));
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length >= 2 || gesture.current.z > 1) owned = true;
      if (owned) e.preventDefault();
      prev = points(e);
    };
    const onMove = (e: TouchEvent) => {
      if (!owned) return;
      e.preventDefault();
      const cur = points(e);
      const { panBy: pan, zoomAt: zoom } = gesture.current;
      if (cur.length === 1 && prev.length === 1) {
        pan(cur[0].x - prev[0].x, cur[0].y - prev[0].y);
      } else if (cur.length === 2 && prev.length === 2) {
        const midPrev = { x: (prev[0].x + prev[1].x) / 2, y: (prev[0].y + prev[1].y) / 2 };
        const midCur = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 };
        const dPrev = Math.hypot(prev[0].x - prev[1].x, prev[0].y - prev[1].y);
        const dCur = Math.hypot(cur[0].x - cur[1].x, cur[0].y - cur[1].y);
        if (dPrev > 0) zoom(midCur.x, midCur.y, dCur / dPrev);
        pan(midCur.x - midPrev.x, midCur.y - midPrev.y);
      }
      prev = cur;
    };
    const onEnd = (e: TouchEvent) => {
      prev = points(e);
      if (e.touches.length === 0) owned = false;
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
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2, Math.exp(-delta * 0.002));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 80 : 24;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => panBy(step, 0),
      ArrowRight: () => panBy(-step, 0),
      ArrowUp: () => panBy(0, step),
      ArrowDown: () => panBy(0, -step),
      '+': () => zoomAt(0, 0, 1.25),
      '=': () => zoomAt(0, 0, 1.25),
      '-': () => zoomAt(0, 0, 0.8),
      '0': () => setView({ z: 1, x: 0, y: 0 }),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const lw = fit.w * committed;
  const lh = fit.h * committed;
  const s = view.z / committed;

  return (
    <div className="vs-viewer-wrap">
      <div
        ref={ref}
        className={`vs-viewer ${className}${view.z > 1 ? ' is-zoomed' : ''}`}
        tabIndex={0}
        role="img"
        aria-label={`${label}. Pinch or scroll to zoom, drag to move. Plus and minus zoom, 0 resets.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={(e) => {
          const p = local(e);
          if (view.z > 1) setView({ z: 1, x: 0, y: 0 });
          else zoomAt(p.x, p.y, 3);
        }}
      >
        {src && fit.w > 0 && (
          <img
            src={src}
            alt=""
            draggable={false}
            style={{
              width: lw,
              height: lh,
              left: box.w / 2 - lw / 2,
              top: box.h / 2 - lh / 2,
              transform: `translate(${view.x}px, ${view.y}px) scale(${s})`,
            }}
          />
        )}
      </div>
      <div className="vs-zoom">
        <button type="button" aria-label="Zoom out" disabled={view.z <= 1} onClick={() => zoomAt(0, 0, 0.67)}>
          −
        </button>
        <button type="button" className="mono" aria-label="Fit to view" onClick={() => setView({ z: 1, x: 0, y: 0 })}>
          {Math.round(view.z * 100)}%
        </button>
        <button type="button" aria-label="Zoom in" disabled={view.z >= MAX_ZOOM} onClick={() => zoomAt(0, 0, 1.5)}>
          +
        </button>
      </div>
    </div>
  );
}
