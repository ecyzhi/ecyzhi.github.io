import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  abbr,
  allZones,
  calendarInfo,
  cityOf,
  formatOffset,
  humanIn,
  isoIn,
  localZone,
  offsetMinutes,
  parseInput,
  relative,
  searchZones,
  wallIn,
  wallToMs,
  zoneLabel,
  type Unit,
} from './time';
import './timestamp.css';

const UNITS: { id: Unit; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 's', label: 's' },
  { id: 'ms', label: 'ms' },
  { id: 'us', label: 'µs' },
  { id: 'ns', label: 'ns' },
];

const BOARD_KEY = 'ts-board-zones';
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function readStored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older Safari: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
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

/** The current time, refreshed on every animation frame (about 30 times a second) so milliseconds run live. */
function useLiveNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last >= 33) {
        last = t;
        setNow(Date.now());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return now;
}

function CopyButton({ value, label, text = 'Copy' }: { value: string; label: string; text?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(value);
    setState(ok ? 'ok' : 'fail');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1400);
  };
  return (
    <button type="button" className="ts-copy" onClick={onClick} aria-label={text === 'Copy' ? `Copy ${label}` : `${text}, ${label}`} disabled={!value}>
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Failed' : text}
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="ts-row">
      <div className="ts-row-text">
        <div className="ts-row-label mono">{label}</div>
        <div className="ts-row-value mono">{value}</div>
      </div>
      <CopyButton value={value} label={label} />
    </div>
  );
}

type ZoneOption = { id: string; label: string };

type ZoneOptions = { zones: ZoneOption[]; ensureAll: () => void };

/**
 * Labels for every time zone ("Asia/Tokyo · JST, UTC+09:00"). Building all 400-odd
 * at once blocks a phone for half a second, so they are built a few at a time while
 * the browser is idle, and all at once only if a zone list is opened before that.
 */
function useZoneOptions(zoneIds: string[], local: string): ZoneOptions {
  const built = useRef<ZoneOption[]>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);

  const label = useCallback(
    (z: string, at: number) => (z === local ? `${zoneLabel(z, at)} · yours` : zoneLabel(z, at)),
    [local],
  );

  const ensureAll = useCallback(() => {
    if (built.current.length >= zoneIds.length) return;
    const at = Date.now();
    for (let i = built.current.length; i < zoneIds.length; i++) built.current.push({ id: zoneIds[i], label: label(zoneIds[i], at) });
    setZones(built.current.slice());
  }, [zoneIds, label]);

  useEffect(() => {
    const ric: (cb: (d: { timeRemaining: () => number }) => void) => number =
      window.requestIdleCallback ?? ((cb) => window.setTimeout(() => cb({ timeRemaining: () => 8 }), 50));
    const cancel: (id: number) => void = window.cancelIdleCallback ?? window.clearTimeout;
    let id = 0;
    const step = (d: { timeRemaining: () => number }) => {
      const at = Date.now();
      while (built.current.length < zoneIds.length && d.timeRemaining() > 2) {
        const z = zoneIds[built.current.length];
        built.current.push({ id: z, label: label(z, at) });
      }
      if (built.current.length < zoneIds.length) id = ric(step);
      else setZones(built.current.slice());
    };
    id = ric(step);
    return () => cancel(id);
  }, [zoneIds, label]);

  return useMemo(() => ({ zones, ensureAll }), [zones, ensureAll]);
}

// Memoised so the 400-odd options don't re-render on every clock tick.
const ZoneSelect = memo(function ZoneSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ZoneOptions;
  onChange: (z: string) => void;
}) {
  const { zones, ensureAll } = options;
  // Until the full list is ready, show just the chosen zone.
  const list = zones.length ? zones : [{ id: value, label: zoneLabel(value, Date.now()) }];
  return (
    <select
      className="ts-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={ensureAll}
      onPointerDown={ensureAll}
    >
      {list.map((z) => (
        <option key={z.id} value={z.id}>
          {z.label}
        </option>
      ))}
    </select>
  );
});

function toPickFields(ms: number, tz: string) {
  const w = wallIn(ms, tz);
  const y = w.y >= 0 && w.y <= 9999 ? pad(w.y, 4) : String(w.y);
  return { date: `${y}-${pad(w.mo)}-${pad(w.d)}`, time: `${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}` };
}

const dayFmtCache = new Map<string, Intl.DateTimeFormat>();
function dayLabel(ms: number, tz: string) {
  let f = dayFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'long' });
    dayFmtCache.set(tz, f);
  }
  return f.format(new Date(ms));
}

function diffLabel(min: number) {
  if (min === 0) return 'same as you';
  const a = Math.abs(min);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `${h ? `${h}h` : ''}${m ? `${h ? ' ' : ''}${m}m` : ''} ${min > 0 ? 'ahead' : 'behind'}`;
}

function defaultBoard(local: string) {
  const picks = [local, 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
  return Array.from(new Set(picks));
}

// Memoised: while live it gets the time rounded to the second, so it redraws once a
// second rather than on every clock tick.
const ZoneBoard = memo(function ZoneBoard({
  ms,
  local,
  zoneIds,
  zoneOptions,
  isLive,
  onSetMs,
  onFreeze,
  onGoLive,
}: {
  ms: number;
  local: string;
  zoneIds: string[];
  zoneOptions: ZoneOptions;
  isLive: boolean;
  onSetMs: (ms: number) => void;
  onFreeze: () => void;
  onGoLive: () => void;
}) {
  const [fromZone, setFromZone] = useState(local);
  const [board, setBoard] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(readStored(BOARD_KEY) || 'null');
      if (Array.isArray(stored) && stored.length) {
        const valid = stored.filter((z): z is string => typeof z === 'string' && zoneIds.includes(z));
        if (valid.length) return valid;
      }
    } catch {
      /* ignore */
    }
    return defaultBoard(local);
  });
  const [query, setQuery] = useState('');
  useEffect(() => writeStored(BOARD_KEY, JSON.stringify(board)), [board]);

  const results = useMemo(
    () => searchZones(query, zoneIds, Date.now()).filter((z) => !board.includes(z)),
    // `ms` is left out on purpose: results only need to change as the query does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, zoneIds, board],
  );

  const add = (z: string) => {
    setBoard((b) => (b.includes(z) ? b : [...b, z]));
    setQuery('');
  };
  const remove = (z: string) => setBoard((b) => (b.length > 1 ? b.filter((x) => x !== z) : b));
  const move = (z: string, dir: -1 | 1) =>
    setBoard((b) => {
      const i = b.indexOf(z);
      const j = i + dir;
      if (j < 0 || j >= b.length) return b;
      const next = b.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  // Set the date and/or the time as read in zone z; the other part keeps its current value there.
  const setWall = (z: string, part: { date?: string; time?: string }) => {
    const w = { ...wallIn(ms, z) };
    if (part.date !== undefined) {
      const dm = /^(-?\d{1,6})-(\d{2})-(\d{2})$/.exec(part.date);
      if (!dm) return;
      Object.assign(w, { y: +dm[1], mo: +dm[2], d: +dm[3] });
    }
    if (part.time !== undefined) {
      const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(part.time);
      if (!tm) return;
      Object.assign(w, { h: +tm[1], mi: +tm[2], s: tm[3] ? +tm[3] : 0 });
    }
    onSetMs(wallToMs(w, z));
  };
  const onFromZone = useCallback((z: string) => setFromZone(z), []);
  const from = toPickFields(ms, fromZone);

  const localOff = offsetMinutes(ms, local);

  return (
    <section className="ts-panel card ts-board" aria-labelledby="ts-board-title">
      <div className="ts-board-head">
        <div>
          <h2 id="ts-board-title" className="ts-h2">Time zone converter</h2>
          <p className="ts-note">Set a date and time in one zone to see it everywhere, or follow the current time live.</p>
        </div>
      </div>

      <div className="ts-from">
        <label className="ts-field ts-from-zone">
          <span className="ts-label">Convert from</span>
          <ZoneSelect value={fromZone} options={zoneOptions} onChange={onFromZone} />
        </label>
        <label className="ts-field">
          <span className="ts-label">Date</span>
          <input
            className="ts-input mono"
            type="date"
            value={from.date}
            onFocus={onFreeze}
            onChange={(e) => setWall(fromZone, { date: e.target.value })}
          />
        </label>
        <label className="ts-field">
          <span className="ts-label">Time</span>
          <input
            className="ts-input mono"
            type="time"
            step={1}
            value={from.time}
            onFocus={onFreeze}
            onChange={(e) => setWall(fromZone, { time: e.target.value })}
          />
        </label>
        <div className="ts-from-actions">
          <button
            type="button"
            className={isLive ? 'ts-copy ts-live is-on' : 'ts-copy ts-live'}
            aria-pressed={isLive}
            onClick={isLive ? onFreeze : onGoLive}
          >
            <span className="ts-dot" aria-hidden="true"></span>
            {isLive ? 'Live' : 'Now'}
          </button>
        </div>
      </div>

      <div className="ts-search">
        <label className="ts-field">
          <span className="ts-label">Add a zone by city, abbreviation or offset</span>
          <input
            className="ts-input"
            type="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
            placeholder="Tokyo, PST, CET, +5:30…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) {
                e.preventDefault();
                add(results[0]);
              }
              if (e.key === 'Escape') setQuery('');
            }}
          />
        </label>
        {query.trim() && (
          <ul className="ts-results-list" role="listbox" aria-label="Matching time zones">
            {results.length ? (
              results.map((z) => (
                <li key={z}>
                  <button type="button" className="ts-result" onClick={() => add(z)}>
                    <span className="ts-abbr mono">{abbr(z, ms)}</span>
                    <span className="ts-result-name">{cityOf(z)}</span>
                    <span className="ts-result-meta mono">
                      {z} · UTC{formatOffset(offsetMinutes(ms, z))}
                    </span>
                  </button>
                </li>
              ))
            ) : (
              <li className="ts-result-none">No zone matches that.</li>
            )}
          </ul>
        )}
      </div>

      <ul className="ts-zones">
        {board.map((z, i) => {
          const w = wallIn(ms, z);
          const off = offsetMinutes(ms, z);
          return (
            <li key={z} className={z === local ? 'ts-zone-row is-local' : 'ts-zone-row'}>
              <div className="ts-zone-info">
                <div className="ts-zone-title">
                  <span className="ts-abbr mono">{abbr(z, ms)}</span>
                  <span className="ts-zone-city">{cityOf(z)}</span>
                  {z === local && <span className="ts-you mono">you</span>}
                </div>
                <div className="ts-zone-meta mono">
                  {dayLabel(ms, z)} · UTC{formatOffset(off)} · {z === local ? z : diffLabel(off - localOff)}
                </div>
              </div>
              <div className="ts-zone-edit">
                <input
                  className="ts-zone-time mono"
                  type="time"
                  step={1}
                  aria-label={`Time in ${cityOf(z)}`}
                  value={`${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`}
                  onFocus={onFreeze}
                  onChange={(e) => setWall(z, { time: e.target.value })}
                />
                <input
                  className="ts-zone-date mono"
                  type="date"
                  aria-label={`Date in ${cityOf(z)}`}
                  value={toPickFields(ms, z).date}
                  onFocus={onFreeze}
                  onChange={(e) => setWall(z, { date: e.target.value })}
                />
              </div>
              <div className="ts-zone-tools">
                <button type="button" className="ts-mini" aria-label={`Move ${cityOf(z)} up`} disabled={i === 0} onClick={() => move(z, -1)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>
                </button>
                <button type="button" className="ts-mini" aria-label={`Remove ${cityOf(z)}`} disabled={board.length < 2} onClick={() => remove(z)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
});

export default function Timestamp() {
  const now = useLiveNow();
  const local = useMemo(localZone, []);
  const zoneIds = useMemo(allZones, []);
  const zoneOptions = useZoneOptions(zoneIds, local);

  const [mode, setMode] = useState<'text' | 'pick'>('text');
  // Live: the converter follows the current time until you type, pick or edit something.
  const [live, setLive] = useState(true);
  const [text, setText] = useState(() => String(Date.now()));
  const [unit, setUnit] = useState<Unit>('auto');
  const [pick, setPick] = useState(() => ({ ...toPickFields(Date.now(), localZone()), zone: localZone() }));
  const [paused, setPaused] = useState<number | null>(null);

  const isLive = live && mode === 'text';

  const parsed = useMemo(() => {
    if (mode === 'text') {
      if (isLive) return { ok: true as const, ms: now, note: 'Live: following the current time. Type or paste to convert something else.' };
      return parseInput(text, unit);
    }
    const dm = /^(-?\d{1,6})-(\d{2})-(\d{2})$/.exec(pick.date);
    const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(pick.time || '00:00');
    if (!dm || !tm) return { ok: false as const, error: 'Pick a date and a time.' };
    const ms = wallToMs({ y: +dm[1], mo: +dm[2], d: +dm[3], h: +tm[1], mi: +tm[2], s: tm[3] ? +tm[3] : 0 }, pick.zone);
    return { ok: true as const, ms, note: `Wall time in ${pick.zone.replace(/_/g, ' ')} (${abbr(pick.zone, ms)}).` };
  }, [mode, isLive, now, text, unit, pick]);

  const ms = parsed.ok ? parsed.ms : null;

  const loadMs = useCallback((value: number) => {
    const whole = Math.floor(value);
    setText(String(whole));
    setUnit('auto');
    setLive(false);
    setPick((p) => ({ ...p, ...toPickFields(whole, p.zone) }));
  }, []);

  // Kept stable (reading the latest values from refs) so the memoised zone board
  // doesn't redraw on every clock tick.
  const latest = useRef({ isLive, now });
  latest.current = { isLive, now };
  const freeze = useCallback(() => {
    if (latest.current.isLive) loadMs(latest.current.now);
  }, [loadMs]);

  const goLive = useCallback(() => {
    setMode('text');
    setUnit('auto');
    setLive(true);
  }, []);

  const switchMode = (next: 'text' | 'pick') => {
    if (next === mode) return;
    if (next === 'pick' && ms !== null) {
      setPick((p) => ({ ...p, ...toPickFields(ms, p.zone) }));
      if (isLive) loadMs(ms);
    }
    if (next === 'text' && ms !== null) {
      setText(String(Math.floor(ms)));
      setUnit('auto');
    }
    setMode(next);
  };

  const onPickZone = useCallback((z: string) => setPick((p) => ({ ...p, zone: z })), []);

  const clock = paused ?? now;
  const clockMs = String(Math.floor(clock));
  const clockSec = String(Math.floor(clock / 1000));

  let rows: { label: string; value: string }[] = [];
  let info: ReturnType<typeof calendarInfo> | null = null;
  if (ms !== null) {
    info = calendarInfo(wallIn(ms, local));
    rows = [
      { label: 'Unix milliseconds', value: String(Math.floor(ms)) },
      { label: 'Unix seconds', value: String(Math.floor(ms / 1000)) },
      { label: 'ISO 8601 · UTC', value: isoIn(ms, 'UTC') },
      { label: `ISO 8601 · ${abbr(local, ms)}`, value: isoIn(ms, local) },
      { label: 'UTC', value: humanIn(ms, 'UTC') },
      { label: `Your time · ${local.replace(/_/g, ' ')}`, value: humanIn(ms, local) },
      { label: 'Relative', value: isLive ? 'now' : relative(ms, now) },
    ];
  }

  return (
    <div className="ts">
      <section className="ts-clock card" aria-label="Current Unix time">
        <div className="ts-clock-text">
          <div className="ts-row-label mono">{paused ? 'paused' : 'now'} · unix milliseconds</div>
          <div className="ts-clock-num mono" aria-live="off">{clockMs}</div>
          <div className="ts-clock-sub mono">
            {clockSec} s · {humanIn(clock, local)}
          </div>
        </div>
        <div className="ts-clock-actions">
          <CopyButton value={clockMs} label="current Unix time in milliseconds" text="Copy ms" />
          <CopyButton value={clockSec} label="current Unix time in seconds" text="Copy s" />
          <button type="button" className="ts-copy" onClick={() => setPaused(paused ? null : Date.now())}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </section>

      <div className="ts-grid">
        <section className="ts-panel card" aria-label="Input">
          <div className="ts-seg ts-seg-2" role="group" aria-label="Input type">
            <button type="button" aria-pressed={mode === 'text'} onClick={() => switchMode('text')}>
              Timestamp or text
            </button>
            <button type="button" aria-pressed={mode === 'pick'} onClick={() => switchMode('pick')}>
              Pick a date
            </button>
          </div>

          {mode === 'text' ? (
            <>
              <label className="ts-field">
                <span className="ts-label">Paste a Unix timestamp or a date</span>
                <input
                  className="ts-input mono"
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={isLive ? String(Math.floor(now)) : text}
                  onFocus={freeze}
                  onChange={(e) => {
                    setLive(false);
                    setText(e.target.value);
                  }}
                  placeholder="1794823661000 or 2026-11-16 10:07 PST"
                />
              </label>
              <div className="ts-field">
                <span className="ts-label" id="ts-unit-label">Unit for numbers</span>
                <div className="ts-seg ts-seg-5" role="group" aria-labelledby="ts-unit-label">
                  {UNITS.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      aria-pressed={unit === u.id}
                      onClick={() => {
                        freeze();
                        setUnit(u.id);
                      }}
                    >
                      {u.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="ts-pick">
                <label className="ts-field">
                  <span className="ts-label">Date</span>
                  <input
                    className="ts-input mono"
                    type="date"
                    value={pick.date}
                    onChange={(e) => setPick((p) => ({ ...p, date: e.target.value }))}
                  />
                </label>
                <label className="ts-field">
                  <span className="ts-label">Time</span>
                  <input
                    className="ts-input mono"
                    type="time"
                    step={1}
                    value={pick.time}
                    onChange={(e) => setPick((p) => ({ ...p, time: e.target.value }))}
                  />
                </label>
              </div>
              <label className="ts-field">
                <span className="ts-label">In time zone</span>
                <ZoneSelect value={pick.zone} options={zoneOptions} onChange={onPickZone} />
              </label>
            </>
          )}

          <div className="ts-quick">
            <button type="button" className={isLive ? 'ts-copy ts-live is-on' : 'ts-copy ts-live'} aria-pressed={isLive} onClick={isLive ? freeze : goLive}>
              <span className="ts-dot" aria-hidden="true"></span>
              {isLive ? 'Live' : 'Go live'}
            </button>
            {mode === 'text' && (
              <button
                type="button"
                className="ts-copy"
                onClick={() => {
                  setLive(false);
                  setText('');
                }}
              >
                Clear
              </button>
            )}
          </div>

          <p className={parsed.ok ? 'ts-note' : 'ts-note ts-error'} role="status">
            {parsed.ok ? parsed.note : 'error' in parsed ? parsed.error : 'Type or paste something to convert.'}
          </p>
        </section>

        <section className="ts-panel card ts-results" aria-label="Results">
          {ms === null ? (
            <p className="ts-empty">Results show here.</p>
          ) : (
            <>
              <div className="ts-rows">
                {rows.map((r) => (
                  <Row key={r.label} {...r} />
                ))}
              </div>
              {info && (
                <dl className="ts-facts">
                  <div>
                    <dt className="mono">weekday</dt>
                    <dd>{info.weekday}</dd>
                  </div>
                  <div>
                    <dt className="mono">day of year</dt>
                    <dd>{info.dayOfYear}</dd>
                  </div>
                  <div>
                    <dt className="mono">ISO week</dt>
                    <dd>
                      {info.weekYear}-W{pad(info.week)}
                    </dd>
                  </div>
                </dl>
              )}
            </>
          )}
        </section>
      </div>

      {ms !== null && (
        <ZoneBoard
          ms={isLive ? Math.floor(ms / 1000) * 1000 : ms}
          local={local}
          zoneIds={zoneIds}
          zoneOptions={zoneOptions}
          isLive={isLive}
          onSetMs={loadMs}
          onFreeze={freeze}
          onGoLive={goLive}
        />
      )}
    </div>
  );
}
