// Shared helpers for the in-browser media tools. Everything stays on the device.

export interface LoadedImage {
  el: HTMLImageElement;
  url: string;
  name: string;
  width: number;
  height: number;
}

export async function loadImageFile(file: File | Blob, name = 'image'): Promise<LoadedImage> {
  const url = URL.createObjectURL(file);
  const el = new Image();
  el.decoding = 'async';
  el.src = url;
  try {
    await el.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('decode');
  }
  if (!el.naturalWidth || !el.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new Error('decode');
  }
  return { el, url, name, width: el.naturalWidth, height: el.naturalHeight };
}

export function baseName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').trim();
  return stem.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60) || 'image';
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), type, quality)
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function canShareFiles(): boolean {
  try {
    const probe = new File([new Blob()], 'probe.png', { type: 'image/png' });
    return typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
