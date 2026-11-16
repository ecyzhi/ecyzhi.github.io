// Pure date helpers for the timestamp converter. No DOM, no React.

export type Unit = 'auto' | 's' | 'ms' | 'us' | 'ns';
export type ConcreteUnit = Exclude<Unit, 'auto'>;

export const UNIT_LABEL: Record<ConcreteUnit, string> = {
  s: 'seconds',
  ms: 'milliseconds',
  us: 'microseconds',
  ns: 'nanoseconds',
};

const FACTOR: Record<ConcreteUnit, number> = { s: 1000, ms: 1, us: 1e-3, ns: 1e-6 };

// Date can hold ±100,000,000 days around 1970.
const MAX_MS = 8.64e15;

export type ParseResult =
  | { ok: true; ms: number; note: string }
  | { ok: false; error: string }
  | { ok: false; empty: true };

/** Guess the unit of an integer timestamp from how many digits it has. */
export function guessUnit(intDigits: number): ConcreteUnit {
  if (intDigits <= 11) return 's';
  if (intDigits <= 14) return 'ms';
  if (intDigits <= 17) return 'us';
  return 'ns';
}

/** Turn what the user typed or pasted into epoch milliseconds. */
export function parseInput(raw: string, unit: Unit): ParseResult {
  const s = raw.trim();
  if (!s) return { ok: false, empty: true };

  const numeric = s.replace(/[\s,_]/g, '');
  if (/^[+-]?\d+(\.\d+)?$/.test(numeric)) {
    const digits = numeric.replace(/^[+-]/, '').split('.')[0].replace(/^0+(?=\d)/, '').length;
    const u = unit === 'auto' ? guessUnit(digits) : unit;
    const ms = Number(numeric) * FACTOR[u];
    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) return { ok: false, error: 'That number is too far from 1970 for a date.' };
    return { ok: true, ms, note: unit === 'auto' ? `Read as ${UNIT_LABEL[u]} (guessed from ${digits} digit${digits === 1 ? '' : 's'}).` : `Read as ${UNIT_LABEL[u]}.` };
  }

  if (/^now$/i.test(s)) return { ok: true, ms: Date.now(), note: 'The current time.' };

  let text = s;
  let note = 'Read as a date.';
  const isoLike = /^\d{4}-\d{2}-\d{2}/.test(text);
  if (isoLike) {
    // Safari only reads strict ISO 8601, so tidy the common variants first.
    text = text.replace(/^(\d{4}-\d{2}-\d{2})[ ]+(?=\d)/, '$1T');
    text = text.replace(/\s*(UTC|GMT|Z)$/i, 'Z');
    text = text.replace(/\s*([+-])(\d{2}):?(\d{2})$/, '$1$2:$3');
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      // A bare date would be read as UTC midnight; local midnight is what people mean.
      text += 'T00:00:00';
      note = 'Read as midnight, your local time.';
    } else if (/T[\d:.]+$/.test(text)) {
      note = 'No time zone given, so read as your local time.';
    }
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    return { ok: false, error: 'Not a timestamp or a date this browser can read. Try 1794823661 or 2026-11-16T10:07:41Z.' };
  }
  return { ok: true, ms, note };
}

// ---------- time zones ----------

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export interface Wall {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** The wall-clock reading of an instant in a time zone. */
export function wallIn(ms: number, tz: string): Wall {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  let y = Number(out.year);
  if (out.era && /^B/i.test(out.era)) y = 1 - y;
  const h = Number(out.hour);
  return { y, mo: Number(out.month), d: Number(out.day), h: h === 24 ? 0 : h, mi: Number(out.minute), s: Number(out.second) };
}

function utcFromWall(w: Wall) {
  const d = new Date(0);
  d.setUTCFullYear(w.y, w.mo - 1, w.d); // avoids Date.UTC mapping years 0-99 to 1900s
  d.setUTCHours(w.h, w.mi, w.s, 0);
  return d.getTime();
}

/** Offset of a zone from UTC at an instant, in minutes (east positive). */
export function offsetMinutes(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return Math.round((utcFromWall(wallIn(whole, tz)) - whole) / 60000);
}

/** The instant when the clock in a zone reads this wall time. */
export function wallToMs(w: Wall, tz: string): number {
  const guess = utcFromWall(w);
  const first = guess - offsetMinutes(guess, tz) * 60000;
  // A second pass settles times near a daylight-saving change.
  return guess - offsetMinutes(first, tz) * 60000;
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

function isoYear(y: number) {
  if (y >= 0 && y <= 9999) return pad(y, 4);
  return (y < 0 ? '-' : '+') + pad(y, 6);
}

export function formatOffset(min: number, z = false) {
  if (min === 0 && z) return 'Z';
  return `${min < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;
}

/** ISO 8601 with the zone's offset, like 2026-11-16T18:07:41+08:00. */
export function isoIn(ms: number, tz: string): string {
  const w = wallIn(ms, tz);
  const off = offsetMinutes(ms, tz);
  const frac = ((ms % 1000) + 1000) % 1000;
  const fracStr = frac ? `.${pad(Math.floor(frac), 3)}` : '';
  return `${isoYear(w.y)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${fracStr}${formatOffset(off, tz === 'UTC')}`;
}

const humanCache = new Map<string, Intl.DateTimeFormat>();
/** A readable date in a zone, in the visitor's own locale. */
export function humanIn(ms: number, tz: string): string {
  let f = humanCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
    humanCache.set(tz, f);
  }
  return f.format(new Date(ms));
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function relative(ms: number, now: number): string {
  const diff = (ms - now) / 1000;
  const a = Math.abs(diff);
  if (a < 1) return 'now';
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [86400 * 30.4375, 'day'],
    [86400 * 365.25, 'month'],
    [Infinity, 'year'],
  ];
  const sizes = [1, 60, 3600, 86400, 86400 * 30.4375, 86400 * 365.25];
  for (let i = 0; i < steps.length; i++) {
    if (a < steps[i][0]) return rtf.format(Math.trunc(diff / sizes[i]), steps[i][1]);
  }
  return '';
}

/** Day of year and ISO week for a wall date. */
export function calendarInfo(w: Wall) {
  const day = (y: number, mo: number, d: number) => utcFromWall({ y, mo, d, h: 0, mi: 0, s: 0 }) / 86400000;
  const today = day(w.y, w.mo, w.d);
  const dayOfYear = today - day(w.y, 1, 1) + 1;
  const dow = (((today + 4) % 7) + 7) % 7; // 0 = Sunday; 1970-01-01 was a Thursday
  const isoDow = dow === 0 ? 7 : dow;
  const thursday = today - isoDow + 4;
  const thursdayYear = new Date(thursday * 86400000).getUTCFullYear();
  const week = Math.floor((thursday - day(thursdayYear, 1, 1)) / 7) + 1;
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
  return { dayOfYear, week, weekYear: thursdayYear, weekday };
}

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const FALLBACK_ZONES = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', 'Africa/Johannesburg', 'Asia/Dubai',
  'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo',
  'Australia/Sydney', 'Pacific/Auckland',
];

export function allZones(): string[] {
  let list: string[] = [];
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) list = fn('timeZone');
  } catch {
    /* older browsers */
  }
  if (!list.length) list = FALLBACK_ZONES;
  const local = localZone();
  const set = new Set(list.filter((z) => z !== 'UTC'));
  set.add(local);
  set.delete('UTC');
  return ['UTC', ...Array.from(set).sort()];
}

export function zoneLabel(tz: string, at: number) {
  return `${tz.replace(/_/g, ' ')} (UTC${formatOffset(offsetMinutes(at, tz))})`;
}
