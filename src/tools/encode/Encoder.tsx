import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadBlob } from '../shared/image';
import {
  DEFAULT_OPTIONS,
  bytesToBase64,
  hexPreview,
  run,
  sniff,
  utf8Length,
  type Direction,
  type Format,
  type Options,
  type Result,
} from './codecs';
import '../shared/tool.css';
import './encode.css';

const FORMATS: { id: Format; label: string }[] = [
  { id: 'base64', label: 'Base64' },
  { id: 'url', label: 'URL' },
  { id: 'html', label: 'HTML' },
];

const PLACEHOLDER: Record<Format, Record<Direction, string>> = {
  base64: { encode: 'Type or paste text, or choose a file…', decode: 'Paste Base64 or a data: URL…' },
  url: { encode: 'Type or paste text, e.g. a search query…', decode: 'Paste text with %20-style escapes…' },
  html: { encode: 'Type or paste text, e.g. <a href="x">Tom & Jerry</a>', decode: 'Paste text with entities like &amp;lt; or &amp;#169;' },
};

const MAX_FILE = 5 * 1024 * 1024;

interface PickedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or no clipboard permission: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="ed-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="ed-switch" aria-hidden="true" />
      <span className="ed-toggle-text">
        <span className="ed-toggle-label">{label}</span>
        <span className="ed-toggle-hint">{hint}</span>
      </span>
    </label>
  );
}

export default function Encoder() {
  const [format, setFormat] = useState<Format>('base64');
  const [dir, setDir] = useState<Direction>('encode');
  const [opts, setOpts] = useState<Options>(DEFAULT_OPTIONS);
  const [input, setInput] = useState('');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [dataUrl, setDataUrl] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [canPaste, setCanPaste] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setCanPaste(typeof navigator !== 'undefined' && !!navigator.clipboard && typeof navigator.clipboard.readText === 'function');
  }, []);

  const result: Result = useMemo(() => {
    if (file) {
      const b64 = bytesToBase64(file.bytes, opts.urlSafe && !dataUrl);
      return { kind: 'text', text: dataUrl ? `data:${file.type || 'application/octet-stream'};base64,${b64}` : b64 };
    }
    return run(format, dir, input, opts);
  }, [file, dataUrl, format, dir, input, opts]);

  const outputText = result.kind === 'text' ? result.text : '';

  // Object URL for binary previews (images) and downloads.
  const binary = useMemo(() => (result.kind === 'binary' ? { ...sniff(result.bytes, result.mime), bytes: result.bytes } : null), [result]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!binary || !binary.mime.startsWith('image/')) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([binary.bytes as BlobPart], { type: binary.mime }));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [binary]);

  useEffect(() => setCopied(false), [outputText]);

  const pickFormat = (f: Format) => {
    setFormat(f);
    if (f !== 'base64') setFile(null);
  };
  const pickDir = (d: Direction) => {
    setDir(d);
    if (d === 'decode') setFile(null);
  };
  const setOpt = <K extends keyof Options>(k: K, v: Options[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const onSwap = () => {
    if (result.kind !== 'text' || file) return;
    setInput(result.text);
    setDir(dir === 'encode' ? 'decode' : 'encode');
  };

  const onCopy = async () => {
    if (!outputText) return;
    setCopied(await copyText(outputText));
  };

  const onPaste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setFile(null);
      setInput(t);
    } catch {
      inputRef.current?.focus();
    }
  };

  const onClear = () => {
    setInput('');
    setFile(null);
    setFileError(null);
    inputRef.current?.focus();
  };

  const loadFile = async (f: File) => {
    setFileError(null);
    if (f.size > MAX_FILE) {
      setFileError(`${f.name} is ${formatBytes(f.size)}. Files up to ${formatBytes(MAX_FILE)} work here.`);
      return;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    setFormat('base64');
    setDir('encode');
    setFile({ name: f.name, type: f.type, bytes });
  };

  const onDownloadBinary = () => {
    if (!binary) return;
    downloadBlob(new Blob([binary.bytes as BlobPart], { type: binary.mime }), `decoded.${binary.ext}`);
  };

  const onDownloadText = () => {
    if (!outputText) return;
    const name = file ? `${file.name}.${dataUrl ? 'datauri' : 'b64'}.txt` : `${format}-${dir}d.txt`;
    downloadBlob(new Blob([outputText], { type: 'text/plain;charset=utf-8' }), name);
  };

  const inLen = file ? file.bytes.length : input.length;
  const inMeta = file ? formatBytes(file.bytes.length) : `${input.length.toLocaleString()} chars · ${formatBytes(utf8Length(input))}`;
  const outMeta =
    result.kind === 'text'
      ? `${result.text.length.toLocaleString()} chars · ${formatBytes(utf8Length(result.text))}`
      : result.kind === 'binary'
        ? formatBytes(result.bytes.length)
        : '';

  const showFileButton = format === 'base64' && dir === 'encode';

  return (
    <div className="ed">
      <div className="ed-bar card">
        <div className="ed-group">
          <span className="ed-label mono" id="ed-format-label">format</span>
          <div className="ed-seg ed-seg-3" role="group" aria-labelledby="ed-format-label">
            {FORMATS.map((f) => (
              <button key={f.id} type="button" aria-pressed={format === f.id} onClick={() => pickFormat(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="ed-group">
          <span className="ed-label mono" id="ed-dir-label">direction</span>
          <div className="ed-seg" role="group" aria-labelledby="ed-dir-label">
            <button type="button" aria-pressed={dir === 'encode'} onClick={() => pickDir('encode')}>
              Encode
            </button>
            <button type="button" aria-pressed={dir === 'decode'} onClick={() => pickDir('decode')}>
              Decode
            </button>
          </div>
        </div>
        <div className="ed-group ed-opts">
          <span className="ed-label mono">options</span>
          {format === 'base64' && file && (
            <Toggle checked={dataUrl} onChange={setDataUrl} label="Data URL" hint="Prefix with data:type;base64," />
          )}
          {format === 'base64' && !(file && dataUrl) && (
            <Toggle
              checked={opts.urlSafe}
              onChange={(v) => setOpt('urlSafe', v)}
              label="URL-safe"
              hint={dir === 'encode' ? 'Use - and _, drop = padding' : 'Both alphabets are always read'}
            />
          )}
          {format === 'url' && (
            <>
              <Toggle
                checked={opts.wholeUrl}
                onChange={(v) => setOpt('wholeUrl', v)}
                label="Whole URL"
                hint="Keep : / ? & = # as they are"
              />
              <Toggle checked={opts.plusSpace} onChange={(v) => setOpt('plusSpace', v)} label="Spaces as +" hint="Form-style query strings" />
            </>
          )}
          {format === 'html' && (
            <Toggle
              checked={opts.htmlAll}
              onChange={(v) => setOpt('htmlAll', v)}
              label="Escape non-ASCII"
              hint={dir === 'encode' ? 'é → &#233;, emoji too' : 'Named and numeric entities are always read'}
            />
          )}
        </div>
      </div>

      <div className="ed-panes">
        <section className="ed-pane card" aria-labelledby="ed-in-label">
          <header className="ed-pane-head">
            <label htmlFor="ed-input" id="ed-in-label" className="ed-label mono">
              input
            </label>
            <div className="ed-pane-tools">
              {showFileButton && (
                <button type="button" className="ed-chip" onClick={() => fileRef.current?.click()}>
                  File…
                </button>
              )}
              {canPaste && (
                <button type="button" className="ed-chip" onClick={onPaste}>
                  Paste
                </button>
              )}
              <button type="button" className="ed-chip" onClick={onClear} disabled={!inLen}>
                Clear
              </button>
            </div>
          </header>
          {file ? (
            <div className="ed-file">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
              </svg>
              <div className="ed-file-text">
                <div className="ed-file-name">{file.name}</div>
                <div className="ed-file-sub mono">
                  {file.type || 'unknown type'} · {formatBytes(file.bytes.length)}
                </div>
              </div>
              <button type="button" className="ed-chip" onClick={() => setFile(null)}>
                Remove
              </button>
            </div>
          ) : (
            <textarea
              id="ed-input"
              ref={inputRef}
              className="ed-text mono"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onDragOver={(e) => {
                if (showFileButton && e.dataTransfer.types.includes('Files')) e.preventDefault();
              }}
              onDrop={(e) => {
                const f = e.dataTransfer.files?.[0];
                if (f && showFileButton) {
                  e.preventDefault();
                  void loadFile(f);
                }
              }}
              placeholder={PLACEHOLDER[format][dir]}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
            />
          )}
          <footer className="ed-pane-foot mono">
            <span>{inMeta}</span>
            {fileError && (
              <span className="ed-error" role="alert">
                {fileError}
              </span>
            )}
          </footer>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadFile(f);
              e.target.value = '';
            }}
          />
        </section>

        <div className="ed-swap-wrap">
          <button
            type="button"
            className="ed-swap"
            onClick={onSwap}
            disabled={result.kind !== 'text' || !!file || !outputText}
            aria-label="Use output as input and flip direction"
            title="Use output as input and flip direction"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 4v16M3 16l4 4 4-4" />
              <path d="M17 20V4M13 8l4-4 4 4" />
            </svg>
          </button>
        </div>

        <section className="ed-pane card" aria-labelledby="ed-out-label">
          <header className="ed-pane-head">
            <label htmlFor="ed-output" id="ed-out-label" className="ed-label mono">
              output
            </label>
            <div className="ed-pane-tools">
              {result.kind === 'text' && (
                <>
                  <button type="button" className="ed-chip" onClick={onDownloadText} disabled={!outputText}>
                    Save .txt
                  </button>
                  <button type="button" className={`ed-chip ed-chip-accent${copied ? ' is-done' : ''}`} onClick={onCopy} disabled={!outputText}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </>
              )}
            </div>
          </header>

          {result.kind === 'binary' && binary ? (
            <div className="ed-binary">
              {previewUrl && <img src={previewUrl} alt="Decoded image preview" className="ed-binary-img checker" />}
              <div>
                <p className="ed-binary-title">This decodes to a file, not text.</p>
                <p className="ed-binary-sub mono">
                  {binary.mime} · {formatBytes(binary.bytes.length)}
                </p>
              </div>
              <code className="ed-hex mono">{hexPreview(binary.bytes)}</code>
              <button type="button" className="btn btn-primary" onClick={onDownloadBinary}>
                Download decoded.{binary.ext}
              </button>
            </div>
          ) : result.kind === 'error' ? (
            <div className="ed-err-box" role="alert">
              <p className="ed-err-title">Can’t {dir} this</p>
              <p className="ed-err-msg">{result.message}</p>
            </div>
          ) : (
            <textarea
              id="ed-output"
              className="ed-text mono"
              value={outputText}
              readOnly
              placeholder="Result appears here as you type."
              spellCheck={false}
            />
          )}
          <footer className="ed-pane-foot mono">
            <span>{outMeta}</span>
          </footer>
        </section>
      </div>
    </div>
  );
}
