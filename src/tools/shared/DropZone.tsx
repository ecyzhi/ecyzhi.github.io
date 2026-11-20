import { useEffect, useRef, useState } from 'react';

interface Props {
  onFile: (file: File) => void;
  error?: string | null;
  hint?: string;
  /** File picker filter. */
  accept?: string;
  /** MIME type prefixes taken from a paste or drop, e.g. ['image/', 'video/']. */
  kinds?: string[];
  title?: string;
  button?: string;
}

/** File picker that also takes drag-and-drop and pasted images. */
export default function DropZone({
  onFile,
  error,
  hint = 'JPG, PNG, WebP or GIF',
  accept = 'image/*',
  kinds = ['image/'],
  title = 'Drop an image here',
  button = 'Choose image',
}: Props) {
  const wanted = (f: File) => kinds.some((k) => f.type.startsWith(k));
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find(wanted);
      if (file) onFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onFile, kinds.join()]);

  return (
    <div
      className={`dropzone${over ? ' is-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = Array.from(e.dataTransfer.files).find(wanted) ?? e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="9" cy="9" r="2" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
      <p className="dz-title">{title}</p>
      <p className="dz-sub">or paste one, or</p>
      <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()}>
        {button}
      </button>
      <p className="dz-hint mono">{hint}</p>
      {error && (
        <p className="dz-error" role="alert">
          {error}
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
