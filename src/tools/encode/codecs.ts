// Pure text codecs for the encode & decode tool. Everything runs in the browser.

export type Format = 'base64' | 'url' | 'html';
export type Direction = 'encode' | 'decode';

export interface Options {
  /** Base64: use the URL-safe alphabet (- and _) and drop the = padding. */
  urlSafe: boolean;
  /** URL: encode a whole URL (keeps : / ? & = #) instead of a single component. */
  wholeUrl: boolean;
  /** URL: write spaces as + and read + as a space (HTML form encoding). */
  plusSpace: boolean;
  /** HTML: also turn every non-ASCII character into a numeric entity. */
  htmlAll: boolean;
}

export const DEFAULT_OPTIONS: Options = { urlSafe: false, wholeUrl: false, plusSpace: false, htmlAll: false };

export type Result =
  | { kind: 'text'; text: string }
  | { kind: 'binary'; bytes: Uint8Array; mime: string | null }
  | { kind: 'error'; message: string };

const utf8 = new TextEncoder();

// ---------- Base64 ----------

export function bytesToBase64(bytes: Uint8Array, urlSafe = false): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  const b64 = btoa(bin);
  return urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
}

/** Accepts standard or URL-safe Base64, with or without padding, whitespace, or a data: URL prefix. */
export function base64ToBytes(input: string): { bytes: Uint8Array; mime: string | null } {
  let s = input.trim();
  let mime: string | null = null;
  const dataUrl = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(s);
  if (dataUrl) {
    mime = dataUrl[1] || null;
    s = s.slice(dataUrl[0].length);
  }
  s = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bad = /[^A-Za-z0-9+/=]/.exec(s);
  if (bad) throw new Error(`"${bad[0]}" at position ${bad.index + 1} isn't a Base64 character.`);
  if (/=[^=]/.test(s) || /={3,}$/.test(s)) throw new Error('Padding (=) can only appear at the end.');
  s = s.replace(/=+$/, '');
  if (s.length % 4 === 1) throw new Error('The length is off by one character, so part of it is missing.');
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

/** Decodes bytes as UTF-8, or returns null when they aren't valid UTF-8 text. */
export function bytesToText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Control characters other than tab, newline and carriage return mean it's probably binary.
    if (/[\u0000-\u0008\u000E-\u001F]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

// ---------- URL ----------

function urlEncode(s: string, o: Options): string {
  let out = o.wholeUrl ? encodeURI(s) : encodeURIComponent(s);
  if (!o.wholeUrl) {
    // encodeURIComponent leaves !'()* alone; RFC 3986 reserves them, so encode them too.
    out = out.replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  return o.plusSpace ? out.replace(/%20/g, '+') : out;
}

function urlDecode(s: string, o: Options): string {
  const src = o.plusSpace ? s.replace(/\+/g, ' ') : s;
  try {
    return o.wholeUrl ? decodeURI(src) : decodeURIComponent(src);
  } catch {
    const m = /%(?![0-9A-Fa-f]{2})/.exec(src);
    if (m) throw new Error(`"%" at position ${m.index + 1} isn't followed by two hex digits.`);
    throw new Error('The %-escapes don\'t form valid UTF-8 text.');
  }
}

// ---------- HTML entities ----------

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function htmlEncode(s: string, o: Options): string {
  let out = s.replace(/[&<>"']/g, (c) => HTML_ESC[c]);
  if (o.htmlAll) {
    out = out.replace(/[^\x00-\x7F]/gu, (c) => `&#${c.codePointAt(0)};`);
  }
  return out;
}

function htmlDecode(s: string): string {
  // A <textarea>'s content is parsed as text with entities resolved, so tags stay as text and nothing runs.
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  return ta.value;
}

// ---------- Run ----------

export function run(format: Format, dir: Direction, input: string, o: Options): Result {
  if (input === '') return { kind: 'text', text: '' };
  try {
    if (format === 'base64') {
      if (dir === 'encode') return { kind: 'text', text: bytesToBase64(utf8.encode(input), o.urlSafe) };
      const { bytes, mime } = base64ToBytes(input);
      const text = bytesToText(bytes);
      return text === null ? { kind: 'binary', bytes, mime } : { kind: 'text', text };
    }
    if (format === 'url') {
      return { kind: 'text', text: dir === 'encode' ? urlEncode(input, o) : urlDecode(input, o) };
    }
    return { kind: 'text', text: dir === 'encode' ? htmlEncode(input, o) : htmlDecode(input) };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

export function utf8Length(s: string): number {
  return utf8.encode(s).length;
}

/** Guess a file extension for decoded bytes from their MIME type or magic number. */
export function sniff(bytes: Uint8Array, mime: string | null): { mime: string; ext: string } {
  const b = bytes;
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { mime: 'image/png', ext: 'png' };
  if (starts(0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', ext: 'jpg' };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { mime: 'image/gif', ext: 'gif' };
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return { mime: 'image/webp', ext: 'webp' };
  if (starts(0x25, 0x50, 0x44, 0x46)) return { mime: 'application/pdf', ext: 'pdf' };
  if (starts(0x50, 0x4b, 0x03, 0x04)) return { mime: 'application/zip', ext: 'zip' };
  if (starts(0x1f, 0x8b)) return { mime: 'application/gzip', ext: 'gz' };
  if (mime) {
    const sub = mime.split('/')[1]?.split('+')[0];
    return { mime, ext: sub && /^[a-z0-9.-]{1,10}$/i.test(sub) ? sub.replace('jpeg', 'jpg') : 'bin' };
  }
  return { mime: 'application/octet-stream', ext: 'bin' };
}

export function hexPreview(bytes: Uint8Array, max = 64): string {
  const parts: string[] = [];
  for (let i = 0; i < Math.min(bytes.length, max); i++) parts.push(bytes[i].toString(16).padStart(2, '0'));
  return parts.join(' ') + (bytes.length > max ? ' …' : '');
}
