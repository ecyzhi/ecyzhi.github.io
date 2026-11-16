import { useEffect, useMemo, useRef, useState } from 'react';
import {
  allZones,
  calendarInfo,
  humanIn,
  isoIn,
  localZone,
  parseInput,
  relative,
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

const ZONE_KEY = 'ts-out-zone';
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

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: number;
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

function CopyButton({ value, label }: { value: string; label: string }) {
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
    <button type="button" className="ts-copy" onClick={onClick} aria-label={`Copy ${label}`} disabled={!value}>
      {state === 'ok' ? 'Copied' : state === 'fail' ? 'Failed' : 'Copy'}
    </button>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="ts-row">
      <div className="ts-row-text">
        <div className="ts-row-label mono">{label}</div>
        <div className="ts-row-value mono">{value}</div>
        {hint && <div className="ts-row-hint">{hint}</div>}
      </div>
      <CopyButton value={value} label={label} />
    </div>
  );
}

function toPickFields(ms: number, tz: string) {
  const w = wallIn(ms, tz);
  const y = w.y >= 0 && w.y <= 9999 ? pad(w.y, 4) : String(w.y);
  return { date: `${y}-${pad(w.mo)}-${pad(w.d)}`, time: `${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}` };
}

export default function Timestamp() {
  const now = useNow();
  const local = useMemo(localZone, []);
  const zones = useMemo(() => {
    const at = Date.now();
    return allZones().map((z) => ({ id: z, label: z === local ? `${zoneLabel(z, at)} · yours` : zoneLabel(z, at) }));
  }, [local]);

  const [mode, setMode] = useState<'text' | 'pick'>('text');
  const [text, setText] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [unit, setUnit] = useState<Unit>('auto');
  const [pick, setPick] = useState(() => ({ ...toPickFields(Date.now(), localZone()), zone: localZone() }));
  const [outZone, setOutZone] = useState(() => {
    const stored = readStored(ZONE_KEY);
    if (stored && allZones().includes(stored)) return stored;
    // UTC and local already have their own rows, so start on a third zone.
    return localZone() === 'America/New_York' ? 'Europe/London' : 'America/New_York';
  });
  const [paused, setPaused] = useState<number | null>(null);

  useEffect(() => writeStored(ZONE_KEY, outZone), [outZone]);

  const parsed = useMemo(() => {
    if (mode === 'text') return parseInput(text, unit);
    const dm = /^(-?\d{1,6})-(\d{2})-(\d{2})$/.exec(pick.date);
    const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(pick.time || '00:00');
    if (!dm || !tm) return { ok: false as const, error: 'Pick a date and a time.' };
    const ms = wallToMs(
      { y: +dm[1], mo: +dm[2], d: +dm[3], h: +tm[1], mi: +tm[2], s: tm[3] ? +tm[3] : 0 },
      pick.zone,
    );
    return { ok: true as const, ms, note: `Wall time in ${pick.zone.replace(/_/g, ' ')}.` };
  }, [mode, text, unit, pick]);

  const ms = parsed.ok ? parsed.ms : null;

  const switchMode = (next: 'text' | 'pick') => {
    if (next === mode) return;
    if (next === 'pick' && ms !== null) setPick((p) => ({ ...p, ...toPickFields(ms, p.zone) }));
    if (next === 'text' && ms !== null) {
      setText(String(Math.floor(ms / 1000)));
      setUnit('auto');
    }
    setMode(next);
  };

  const loadMs = (value: number) => {
    setText(String(Math.floor(value / 1000)));
    setUnit('auto');
    setPick((p) => ({ ...p, ...toPickFields(value, p.zone) }));
  };

  const clock = paused ?? now;
  const clockSec = String(Math.floor(clock / 1000));

  let rows: { label: string; value: string; hint?: string }[] = [];
  let info: ReturnType<typeof calendarInfo> | null = null;
  if (ms !== null) {
    const secs = ms / 1000;
    const wholeSecs = Math.floor(secs);
    info = calendarInfo(wallIn(ms, local));
    rows = [
      { label: 'Unix seconds', value: String(wholeSecs) },
      { label: 'Unix milliseconds', value: String(Math.floor(ms)) },
      { label: 'ISO 8601 · UTC', value: isoIn(ms, 'UTC') },
      { label: 'ISO 8601 · your offset', value: isoIn(ms, local) },
      { label: 'UTC', value: humanIn(ms, 'UTC') },
      { label: `Your time · ${local.replace(/_/g, ' ')}`, value: humanIn(ms, local) },
      { label: 'Relative', value: relative(ms, now) },
    ];
  }

  return (
    <div className="ts">
      <section className="ts-clock card" aria-label="Current Unix time">
        <div className="ts-clock-text">
          <div className="ts-row-label mono">{paused ? 'paused' : 'now'} · unix seconds</div>
          <div className="ts-clock-num mono" aria-live="off">{clockSec}</div>
          <div className="ts-clock-sub mono">{humanIn(clock, local)}</div>
        </div>
        <div className="ts-clock-actions">
          <CopyButton value={clockSec} label="current Unix time" />
          <button type="button" className="ts-copy" onClick={() => setPaused(paused ? null : Date.now())}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className="ts-copy ts-copy-accent"
            onClick={() => {
              loadMs(clock);
            }}
          >
            Convert
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
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="1794823661 or 2026-11-16T10:07:41Z"
                />
              </label>
              <div className="ts-field">
                <span className="ts-label" id="ts-unit-label">Unit for numbers</span>
                <div className="ts-seg ts-seg-5" role="group" aria-labelledby="ts-unit-label">
                  {UNITS.map((u) => (
                    <button key={u.id} type="button" aria-pressed={unit === u.id} onClick={() => setUnit(u.id)}>
                      {u.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ts-quick">
                <button type="button" className="ts-copy" onClick={() => loadMs(Date.now())}>Now</button>
                <button type="button" className="ts-copy" onClick={() => setText('')}>Clear</button>
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
                <select
                  className="ts-input"
                  value={pick.zone}
                  onChange={(e) => setPick((p) => ({ ...p, zone: e.target.value }))}
                >
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>{z.label}</option>
                  ))}
                </select>
              </label>
              <div className="ts-quick">
                <button type="button" className="ts-copy" onClick={() => loadMs(Date.now())}>Now</button>
              </div>
            </>
          )}

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

              <div className="ts-zone">
                <label className="ts-field">
                  <span className="ts-label">Also show in</span>
                  <select className="ts-input" value={outZone} onChange={(e) => setOutZone(e.target.value)}>
                    {zones.map((z) => (
                      <option key={z.id} value={z.id}>{z.label}</option>
                    ))}
                  </select>
                </label>
                <div className="ts-rows">
                  <Row label={outZone.replace(/_/g, ' ')} value={humanIn(ms, outZone)} />
                  <Row label="ISO 8601 · that offset" value={isoIn(ms, outZone)} />
                </div>
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
    </div>
  );
}
