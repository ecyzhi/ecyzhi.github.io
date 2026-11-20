import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import DropZone from '../shared/DropZone';
import { baseName, canShareFiles, canvasToBlob, downloadBlob, formatBytes } from '../shared/image';
import { AsciiEngine, CHARSETS, PAPER, FONT_FAMILY, CELL_W, CELL_H, pickVideoType, ramp, rowsFor, toHtml, toText, type CharsetId, type Ink, type Paper, type Settings } from './ascii';
import '../shared/tool.css';
import './ascii.css';

interface Media {
  kind: 'image' | 'video';
  el: HTMLImageElement | HTMLVideoElement;
  url: string;
  name: string;
  w: number;
  h: number;
}

type Show = 'ascii' | 'original';

interface Recording {
  progress: number;
  elapsed: number;
}

interface Recorded {
  blob: Blob;
  ext: 'mp4' | 'webm';
}

const CHARSET_OPTIONS: { value: CharsetId; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'detailed', label: 'Detailed' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'custom', label: 'Custom' },
];
const INK_OPTIONS: { value: Ink; label: string }[] = [
  { value: 'mono', label: 'Mono' },
  { value: 'colour', label: 'Colour' },
  { value: 'green', label: 'Green' },
  { value: 'amber', label: 'Amber' },
];

const COLS_MIN = 20;
const COLS_MAX = 300;
const PNG_MAX = 4096;
const VIDEO_MAX = 1920;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const even = (n: number) => Math.max(2, Math.ceil(n / 2) * 2);

function fmtTime(t: number) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function fontReady() {
  try {
    await Promise.race([document.fonts.load(`500 16px ${FONT_FAMILY}`), new Promise((r) => setTimeout(r, 1500))]);
  } catch {
    /* a fallback monospace font still works */
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const el = new Image();
  el.decoding = 'async';
  el.src = url;
  return el.decode().then(() => {
    if (!el.naturalWidth) throw new Error('decode');
    return el;
  });
}

function loadVideo(url: string, host: HTMLElement): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.loop = true;
    v.preload = 'auto';
    // iPhone Safari only decodes frames for videos in the page, so it sits there, hidden.
    host.appendChild(v);
    const fail = () => {
      v.remove();
      reject(new Error('decode'));
    };
    v.onloadeddata = () => (v.videoWidth ? resolve(v) : fail());
    v.onerror = fail;
    v.src = url;
    v.load();
  });
}

export default function AsciiArt() {
  const [media, setMedia] = useState<Media | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(() => ({
    cols: typeof window !== 'undefined' && window.innerWidth < 640 ? 80 : 120,
    charset: 'standard',
    custom: ' .oO0@',
    ink: 'mono',
    paper: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    invert: false,
    contrast: 1,
    brightness: 0,
  }));
  const [show, setShow] = useState<Show>('ascii');
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareable, setShareable] = useState(false);
  const [sound, setSound] = useState(true);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [videoType, setVideoType] = useState<ReturnType<typeof pickVideoType>>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const engine = useRef<AsciiEngine | null>(null);
  const dirty = useRef(true);
  const recCanvas = useRef<HTMLCanvasElement | null>(null);
  const recState = useRef<{ rec: MediaRecorder; cancelled: boolean; start: number; size: { w: number; h: number }; font: number; cleanup: () => void } | null>(null);
  const audio = useRef<{ ctx: AudioContext; src: MediaElementAudioSourceNode; el: HTMLMediaElement } | null>(null);

  const live = useRef({ media, settings, show, stage });
  live.current = { media, settings, show, stage };

  useEffect(() => {
    setShareable(canShareFiles());
    setVideoType(pickVideoType());
  }, []);

  // Free the file and any hidden video when the media changes or the tool closes.
  useEffect(
    () => () => {
      if (!media) return;
      if (media.kind === 'video') {
        const v = media.el as HTMLVideoElement;
        v.pause();
        v.removeAttribute('src');
        v.load();
        v.remove();
      }
      URL.revokeObjectURL(media.url);
    },
    [media]
  );

  const grid = media ? { cols: settings.cols, rows: rowsFor(settings.cols, media.w, media.h) } : null;

  // ----- rendering -----

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const { media: m, settings: s, show: sh, stage: st } = live.current;
    if (!canvas || !m || !st.w) return;
    const eng = (engine.current ??= new AsciiEngine());
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rec = recState.current;

    const ready = m.kind === 'image' || (m.el as HTMLVideoElement).readyState >= 2;
    if (!ready) return;

    if (sh === 'ascii' || rec) eng.sampleFrom(m.el, m.w, m.h, s);

    if (rec && recCanvas.current) eng.draw(recCanvas.current, rec.font, s, rec.size);

    if (sh === 'ascii') {
      const g = eng.grid!;
      const font = Math.min(st.w / (g.cols * CELL_W), st.h / (g.rows * CELL_H)) * dpr;
      eng.draw(canvas, font, s);
    } else {
      const k = Math.min(st.w / m.w, st.h / m.h) * dpr;
      const w = Math.max(1, Math.round(m.w * k));
      const h = Math.max(1, Math.round(m.h * k));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(m.el, 0, 0, w, h);
    }
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
  }, []);

  // One loop: redraws when something changed, or when the video shows a new frame.
  useEffect(() => {
    if (!media) return;
    let raf = 0;
    let lastT = -1;
    let lastUi = 0;
    const v = media.kind === 'video' ? (media.el as HTMLVideoElement) : null;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const t = v ? v.currentTime : 0;
      if (dirty.current || t !== lastT) {
        dirty.current = false;
        lastT = t;
        render();
      }
      if (v && now - lastUi > 200) {
        lastUi = now;
        setTime(v.currentTime);
        const rec = recState.current;
        if (rec) {
          const d = v.duration;
          setRecording({ progress: Number.isFinite(d) && d > 0 ? clamp(v.currentTime / d, 0, 1) : 0, elapsed: (performance.now() - rec.start) / 1000 });
        }
      }
    };
    raf = requestAnimationFrame(loop);
    let onSeeked: (() => void) | undefined;
    let onPlay: (() => void) | undefined;
    let onPause: (() => void) | undefined;
    if (v) {
      onSeeked = () => (dirty.current = true);
      onPlay = () => setPlaying(true);
      onPause = () => setPlaying(false);
      v.addEventListener('seeked', onSeeked);
      v.addEventListener('play', onPlay);
      v.addEventListener('pause', onPause);
      setPlaying(!v.paused);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (v) {
        v.removeEventListener('seeked', onSeeked!);
        v.removeEventListener('play', onPlay!);
        v.removeEventListener('pause', onPause!);
      }
    };
  }, [media, render]);

  useEffect(() => {
    dirty.current = true;
  }, [settings, show, stage]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setStage({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [media]);

  // ----- opening files -----

  const openFile = useCallback(async (file: File) => {
    setError(null);
    const isVideo = file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|mkv)$/i.test(file.name);
    const url = URL.createObjectURL(file);
    try {
      await fontReady();
      let next: Media;
      if (isVideo) {
        const v = await loadVideo(url, hostRef.current!);
        next = { kind: 'video', el: v, url, name: file.name || 'video', w: v.videoWidth, h: v.videoHeight };
        v.play().catch(() => {
          /* autoplay refused: the play button starts it */
        });
      } else {
        const el = await loadImage(url);
        next = { kind: 'image', el, url, name: file.name || 'image', w: el.naturalWidth, h: el.naturalHeight };
      }
      setRecorded(null);
      setShow('ascii');
      setTime(0);
      dirty.current = true;
      setMedia(next);
    } catch {
      URL.revokeObjectURL(url);
      setError(
        isVideo
          ? "Couldn't play that video here. Try an MP4 (H.264) or WebM file."
          : "Couldn't open that file. Try a JPG, PNG, WebP or GIF image, or an MP4 or WebM video."
      );
    }
  }, []);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => ({ ...s, [key]: value }));

  // ----- video transport -----

  const video = media?.kind === 'video' ? (media.el as HTMLVideoElement) : null;
  const duration = video && Number.isFinite(video.duration) ? video.duration : 0;

  const togglePlay = () => {
    if (!video || recording) return;
    if (video.paused) video.play().catch(() => setError('The browser blocked playback. Tap play again.'));
    else video.pause();
  };

  const seek = (t: number) => {
    if (!video || recording) return;
    video.currentTime = t;
    setTime(t);
  };

  // ----- exports -----

  const stem = media ? baseName(media.name) : 'ascii';

  /** Samples the current picture or frame with the current settings. */
  const currentGrid = () => {
    const m = live.current.media;
    if (!m) throw new Error('no media');
    const eng = (engine.current ??= new AsciiEngine());
    return { eng, grid: eng.sampleFrom(m.el, m.w, m.h, settings) };
  };

  const pngFont = (g: { cols: number; rows: number }) => clamp(PNG_MAX / Math.max(g.cols * CELL_W, g.rows * CELL_H), 6, 24);
  const pngSize = grid ? AsciiEngine.size(grid, pngFont(grid)) : null;

  const exportPng = async () => {
    const { eng, grid: g } = currentGrid();
    const out = document.createElement('canvas');
    eng.draw(out, pngFont(g), settings);
    dirty.current = true;
    return canvasToBlob(out);
  };

  const onDownloadPng = async () => {
    setBusy(true);
    setError(null);
    try {
      downloadBlob(await exportPng(), `${stem}-ascii.png`);
    } catch {
      setError('Export failed. Try fewer columns.');
    } finally {
      setBusy(false);
    }
  };

  const onSharePng = async () => {
    setBusy(true);
    try {
      const blob = await exportPng();
      await navigator.share({ files: [new File([blob], `${stem}-ascii.png`, { type: 'image/png' })] });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setError('Sharing failed. Use Download instead.');
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async () => {
    setError(null);
    try {
      const text = toText(currentGrid().grid);
      dirty.current = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Older browsers: copy through a hidden text box.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Couldn't copy. Use Download .txt instead.");
    }
  };

  const onDownloadText = () => {
    const text = toText(currentGrid().grid);
    dirty.current = true;
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${stem}-ascii.txt`);
  };

  const onDownloadHtml = () => {
    const html = toHtml(currentGrid().grid, settings, `${stem} ascii`);
    dirty.current = true;
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${stem}-ascii.html`);
  };

  // ----- video recording: plays the video once in real time, drawing ASCII frames into a recorded canvas -----

  const videoFont = (g: { cols: number; rows: number }, m: Media) => {
    const target = clamp(Math.max(m.w, m.h), 1080, VIDEO_MAX);
    return Math.max(4, target / Math.max(g.cols * CELL_W, g.rows * CELL_H));
  };
  const videoSize = (g: { cols: number; rows: number }, m: Media) => {
    const s = AsciiEngine.size(g, videoFont(g, m));
    return { w: even(s.w), h: even(s.h) };
  };

  const stopRecording = (cancel: boolean) => {
    const r = recState.current;
    if (!r) return;
    r.cancelled = cancel;
    if (r.rec.state !== 'inactive') r.rec.stop();
    else r.cleanup();
  };

  const startRecording = async () => {
    if (!video || !media || !grid || !videoType || recState.current) return;
    setError(null);
    setRecorded(null);
    const v = video;
    const size = videoSize(grid, media);
    const font = videoFont(grid, media);
    const canvas = (recCanvas.current ??= document.createElement('canvas'));
    canvas.width = size.w;
    canvas.height = size.h;

    // Everything up to play() runs straight from the tap, so phones allow playback with sound.
    let audioDest: MediaStreamAudioDestinationNode | null = null;
    if (sound) {
      try {
        if (!audio.current || audio.current.el !== v) {
          const ctx = audio.current?.ctx ?? new AudioContext();
          audio.current = { ctx, src: ctx.createMediaElementSource(v), el: v };
        }
        void audio.current.ctx.resume();
        audioDest = audio.current.ctx.createMediaStreamDestination();
        audio.current.src.connect(audioDest);
      } catch {
        audioDest = null;
      }
    }

    try {
      v.pause();
      v.loop = false;
      // Start on a blank frame; the loop draws real frames as the video plays.
      const c2d = canvas.getContext('2d')!;
      c2d.fillStyle = PAPER[settings.paper];
      c2d.fillRect(0, 0, size.w, size.h);

      const stream = canvas.captureStream(30);
      audioDest?.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      const rec = new MediaRecorder(stream, {
        mimeType: videoType.mime,
        videoBitsPerSecond: Math.round(clamp(size.w * size.h * 30 * 0.12, 2_000_000, 12_000_000)),
      });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const onEnded = () => stopRecording(false);
      const cleanup = () => {
        v.removeEventListener('ended', onEnded);
        stream.getTracks().forEach((t) => t.stop());
        if (audioDest && audio.current) {
          try {
            audio.current.src.disconnect(audioDest);
          } catch {
            /* already disconnected */
          }
        }
        v.pause();
        v.muted = true;
        v.loop = true;
        const st = recState.current;
        recState.current = null;
        setRecording(null);
        dirty.current = true;
        if (st && !st.cancelled && chunks.length) {
          const type = videoType.mime.split(';')[0];
          setRecorded({ blob: new Blob(chunks, { type }), ext: videoType.ext });
        } else if (st && !st.cancelled) {
          setError('Recording failed in this browser. Try Chrome, Edge or Safari.');
        }
      };
      rec.onstop = cleanup;
      rec.onerror = () => {
        setError('Recording failed. Try fewer columns or a shorter video.');
        stopRecording(true);
      };
      v.addEventListener('ended', onEnded);

      v.currentTime = 0;
      v.muted = !audioDest;
      recState.current = { rec, cancelled: false, start: performance.now(), size, font, cleanup };
      setRecording({ progress: 0, elapsed: 0 });
      rec.start(1000);
      try {
        await v.play();
      } catch (err) {
        // Playback with sound refused: record silently instead.
        if (!audioDest) throw err;
        v.muted = true;
        await v.play();
      }
    } catch {
      setError("Couldn't start recording in this browser.");
      if (recState.current) stopRecording(true);
      else {
        v.muted = true;
        v.loop = true;
      }
    }
  };

  // Stop a recording if the tool unmounts.
  useEffect(() => () => stopRecording(true), []);

  const saveVideo = () => {
    if (recorded) downloadBlob(recorded.blob, `${stem}-ascii.${recorded.ext}`);
  };

  const shareVideo = async () => {
    if (!recorded) return;
    try {
      const file = new File([recorded.blob], `${stem}-ascii.${recorded.ext}`, { type: recorded.blob.type });
      if (!navigator.canShare?.({ files: [file] })) {
        saveVideo();
        return;
      }
      await navigator.share({ files: [file] });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setError('Sharing failed. Use Download instead.');
    }
  };

  const reset = () => {
    stopRecording(true);
    setMedia(null);
    setRecorded(null);
    setError(null);
    setPlaying(false);
  };

  const disabled = !media;
  const locked = !!recording;
  const vSize = grid && media ? videoSize(grid, media) : null;
  const chars = ramp(settings);

  const label = media?.kind === 'video' ? 'video' : 'image';

  return (
    <div className="as">
      <div ref={hostRef} className="as-host" aria-hidden="true" />
      <div className="as-stage-card">
        {media ? (
          <>
            <div className="as-toolbar">
              <div className="as-seg as-seg-sm" role="group" aria-label="Preview">
                <button type="button" aria-pressed={show === 'ascii'} onClick={() => setShow('ascii')}>
                  ASCII
                </button>
                <button type="button" aria-pressed={show === 'original'} onClick={() => setShow('original')} disabled={locked}>
                  Original
                </button>
              </div>
              <span className="as-dims mono">
                {grid!.cols} × {grid!.rows} chars
              </span>
            </div>

            <div ref={stageRef} className="as-stage" role="img" aria-label={show === 'ascii' ? `ASCII art of ${media.name}` : `Original ${label}`}>
              <canvas ref={canvasRef} onClick={togglePlay} />
              {recording && (
                <div className="as-rec mono" role="status">
                  <span className="as-rec-dot" aria-hidden="true" /> recording · {Math.round(recording.progress * 100)}%
                </div>
              )}
            </div>

            {video && (
              <div className="as-transport">
                <button
                  type="button"
                  className="as-icon-btn"
                  aria-label={playing ? 'Pause' : 'Play'}
                  title={playing ? 'Pause' : 'Play'}
                  onClick={togglePlay}
                  disabled={locked}
                >
                  {playing ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" /></svg>
                  )}
                </button>
                <input
                  type="range"
                  className="as-scrub"
                  min={0}
                  max={duration || 1}
                  step={0.01}
                  value={Math.min(time, duration || 1)}
                  disabled={locked || !duration}
                  aria-label="Position"
                  aria-valuetext={fmtTime(time)}
                  onChange={(e) => seek(Number(e.target.value))}
                />
                <span className="as-time mono">
                  {fmtTime(time)} / {fmtTime(duration)}
                </span>
              </div>
            )}

            <div className="as-meta mono">
              <span className="as-file" title={media.name}>
                {media.name} · {media.w} × {media.h}
              </span>
              {video && <span className="as-hint">tap the picture to play or pause</span>}
            </div>
          </>
        ) : (
          <div className="as-empty">
            <DropZone
              onFile={openFile}
              error={error}
              accept="image/*,video/*"
              kinds={['image/', 'video/']}
              title="Drop an image or video here"
              button="Choose file"
              hint="JPG, PNG, WebP, GIF · MP4, MOV, WebM"
            />
          </div>
        )}
      </div>

      <aside className="as-panel" aria-label="ASCII settings">
        <div className="as-field">
          <label htmlFor="as-cols" className="as-label mono as-row">
            <span>width</span>
            <span className="as-val">{settings.cols} characters</span>
          </label>
          <input
            id="as-cols"
            type="range"
            min={COLS_MIN}
            max={COLS_MAX}
            step={1}
            value={settings.cols}
            disabled={disabled || locked}
            onChange={(e) => set('cols', Number(e.target.value))}
          />
          <div className="as-scale mono" aria-hidden="true">
            <span>chunky</span>
            <span>detailed</span>
          </div>
        </div>

        <fieldset className="as-field" disabled={disabled}>
          <legend className="as-label mono">characters</legend>
          <div className="as-seg as-seg-3">
            {CHARSET_OPTIONS.map((o) => (
              <button key={o.value} type="button" aria-pressed={settings.charset === o.value} onClick={() => set('charset', o.value)}>
                {o.label}
              </button>
            ))}
          </div>
          {settings.charset === 'custom' ? (
            <label className="as-custom">
              <span className="as-help">Type characters from light to dense. The first one is used for the emptiest parts.</span>
              <input
                type="text"
                className="as-input mono"
                value={settings.custom}
                maxLength={80}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                onChange={(e) => set('custom', e.target.value)}
              />
            </label>
          ) : (
            <div className="as-ramp mono" aria-label="Characters used, light to dense">
              {settings.charset === 'detailed' ? `${CHARSETS.detailed.slice(0, 28)}…` : `“${chars}”`}
            </div>
          )}
        </fieldset>

        <fieldset className="as-field" disabled={disabled}>
          <legend className="as-label mono">colour</legend>
          <div className="as-seg as-seg-4">
            {INK_OPTIONS.map((o) => (
              <button key={o.value} type="button" aria-pressed={settings.ink === o.value} onClick={() => set('ink', o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="as-field" disabled={disabled}>
          <legend className="as-label mono">background</legend>
          <div className="as-seg">
            {(['dark', 'light'] as Paper[]).map((p) => (
              <button key={p} type="button" aria-pressed={settings.paper === p} onClick={() => set('paper', p)}>
                <span className={`as-swatch as-swatch-${p}`} aria-hidden="true" />
                {p === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
          <label className="as-check">
            <input type="checkbox" checked={settings.invert} onChange={(e) => set('invert', e.target.checked)} />
            <span>Invert brightness</span>
          </label>
        </fieldset>

        <fieldset className="as-field as-adjust" disabled={disabled}>
          <legend className="as-label mono">adjust</legend>
          <label className="as-mini">
            <span className="mono">contrast</span>
            <input
              type="range"
              min={0.5}
              max={3}
              step={0.05}
              value={settings.contrast}
              aria-label="Contrast"
              onChange={(e) => set('contrast', Number(e.target.value))}
            />
            <span className="mono as-mini-val">{settings.contrast.toFixed(1)}</span>
          </label>
          <label className="as-mini">
            <span className="mono">brightness</span>
            <input
              type="range"
              min={-0.5}
              max={0.5}
              step={0.01}
              value={settings.brightness}
              aria-label="Brightness"
              onChange={(e) => set('brightness', Number(e.target.value))}
            />
            <span className="mono as-mini-val">{settings.brightness > 0 ? '+' : ''}{Math.round(settings.brightness * 100)}</span>
          </label>
          <button
            type="button"
            className="as-link"
            disabled={settings.contrast === 1 && settings.brightness === 0}
            onClick={() => setSettings((s) => ({ ...s, contrast: 1, brightness: 0 }))}
          >
            Reset
          </button>
        </fieldset>

        <div className="as-export">
          <div className="as-label mono">export</div>

          <div className="as-result">
            <div className="as-result-name">{media ? `${stem}-ascii` : 'Nothing yet'}</div>
            <div className="as-result-text">
              {grid && pngSize
                ? `${grid.cols} × ${grid.rows} characters · PNG ${pngSize.w} × ${pngSize.h}${video ? ' (current frame)' : ''}`
                : 'Add an image or video to start.'}
            </div>
          </div>

          {media && error && (
            <p className="as-error" role="alert">
              {error}
            </p>
          )}

          <button type="button" className="btn btn-primary" disabled={disabled || busy || locked} onClick={onDownloadPng}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            {busy ? 'Preparing…' : 'Download PNG'}
          </button>
          {shareable && (
            <button type="button" className="btn btn-ghost" disabled={disabled || busy || locked} onClick={onSharePng}>
              Share or save to photos
            </button>
          )}

          <div className="as-text-actions">
            <button type="button" className="btn btn-ghost" disabled={disabled || locked} onClick={onCopy}>
              {copied ? 'Copied' : 'Copy text'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={disabled || locked} onClick={onDownloadText}>
              .txt
            </button>
            <button type="button" className="btn btn-ghost" disabled={disabled || locked} onClick={onDownloadHtml} title="A web page with the art, keeping colours">
              .html
            </button>
          </div>

          {video && (
            <div className="as-video">
              {!videoType ? (
                <p className="as-help">This browser can't record video. Try Chrome, Edge, Firefox or Safari 14.1 or later.</p>
              ) : recording ? (
                <>
                  <div className="as-progress" role="progressbar" aria-label="Recording" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(recording.progress * 100)}>
                    <div style={{ width: `${recording.progress * 100}%` }} />
                  </div>
                  <p className="as-help">
                    Recording in real time, {fmtTime(recording.elapsed)} of {fmtTime(duration)}. Keep this tab open and on screen.
                  </p>
                  <button type="button" className="btn btn-ghost" onClick={() => stopRecording(true)}>
                    Cancel recording
                  </button>
                </>
              ) : recorded ? (
                <>
                  <div className="as-result">
                    <div className="as-result-name">
                      {stem}-ascii.{recorded.ext}
                    </div>
                    <div className="as-result-text">
                      {vSize ? `${vSize.w} × ${vSize.h} · ` : ''}
                      {formatBytes(recorded.blob.size)}
                    </div>
                  </div>
                  <button type="button" className="btn btn-primary" onClick={saveVideo}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
                    Download {recorded.ext.toUpperCase()}
                  </button>
                  {shareable && (
                    <button type="button" className="btn btn-ghost" onClick={shareVideo}>
                      Share or save video
                    </button>
                  )}
                  <button type="button" className="as-link" onClick={() => setRecorded(null)}>
                    Record again
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-ghost as-rec-btn" onClick={startRecording}>
                    <span className="as-rec-dot" aria-hidden="true" />
                    Record {videoType.ext.toUpperCase()} video
                  </button>
                  <label className="as-check as-check-sm">
                    <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
                    <span>Include sound</span>
                  </label>
                  <p className="as-help">
                    {vSize ? `${vSize.w} × ${vSize.h}, ` : ''}plays the whole video once ({fmtTime(duration)}) and records it as ASCII.
                  </p>
                </>
              )}
            </div>
          )}

          <button type="button" className="btn btn-ghost" disabled={disabled} onClick={reset}>
            New file
          </button>
        </div>
      </aside>
    </div>
  );
}
