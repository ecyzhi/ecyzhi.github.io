import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { downloadBlob } from '../shared/image';
import { byYear, calculate, type LoanKind, type Row } from './loan';
import './loan.css';

const CURRENCIES = [
  { code: 'MYR', name: 'Malaysian ringgit' },
  { code: 'SGD', name: 'Singapore dollar' },
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' },
  { code: 'GBP', name: 'British pound' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'HKD', name: 'Hong Kong dollar' },
  { code: 'CNY', name: 'Chinese yuan' },
  { code: 'JPY', name: 'Japanese yen' },
  { code: 'IDR', name: 'Indonesian rupiah' },
  { code: 'THB', name: 'Thai baht' },
  { code: 'PHP', name: 'Philippine peso' },
  { code: 'INR', name: 'Indian rupee' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STORE_KEY = 'tool:loan:v1';
const MAX_YEARS = 50;

interface Inputs {
  kind: LoanKind;
  currency: string;
  price: string;
  down: string;
  downMode: 'percent' | 'amount';
  rate: string;
  years: string;
  months: string;
  extra: string;
  startMonth: number; // 0-11
  startYear: number;
}

type Preset = Pick<Inputs, 'price' | 'down' | 'downMode' | 'rate' | 'years' | 'months'>;

const PRESETS: Record<LoanKind, Preset> = {
  reducing: { price: '500,000', down: '10', downMode: 'percent', rate: '4', years: '30', months: '0' },
  flat: { price: '100,000', down: '10', downMode: 'percent', rate: '2.8', years: '9', months: '0' },
};

function defaults(): Inputs {
  const now = new Date();
  return {
    kind: 'reducing',
    currency: 'MYR',
    extra: '',
    startMonth: now.getMonth(),
    startYear: now.getFullYear(),
    ...PRESETS.reducing,
  };
}

function load(): Inputs {
  const base = defaults();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Inputs>;
    const merged = { ...base, ...saved };
    if (merged.kind !== 'reducing' && merged.kind !== 'flat') merged.kind = 'reducing';
    if (!CURRENCIES.some((c) => c.code === merged.currency)) merged.currency = 'MYR';
    return merged;
  } catch {
    return base;
  }
}

/** "1,234.5" → 1234.5; empty or junk → NaN. */
function num(s: string): number {
  const clean = s.replace(/[,\s]/g, '');
  if (clean === '' || clean === '.') return NaN;
  return Number(clean);
}

/** Thousands separators for display in an input, keeping what the user typed after the point. */
function group(s: string): string {
  const clean = s.replace(/[,\s]/g, '');
  if (!/^\d*\.?\d*$/.test(clean) || clean === '') return s;
  const [int, dec] = clean.split('.');
  const intFmt = (int || '0').replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec === undefined ? intFmt : `${intFmt}.${dec}`;
}

function makeFormatter(currency: string) {
  const make = (display: 'narrowSymbol' | 'symbol', digits?: number) => {
    const opts: Intl.NumberFormatOptions = { style: 'currency', currency, currencyDisplay: display };
    if (digits !== undefined) {
      opts.minimumFractionDigits = digits;
      opts.maximumFractionDigits = digits;
    }
    return new Intl.NumberFormat('en-MY', opts);
  };
  let full: Intl.NumberFormat;
  let whole: Intl.NumberFormat;
  try {
    full = make('narrowSymbol');
    whole = make('narrowSymbol', 0);
  } catch {
    full = make('symbol');
    whole = make('symbol', 0);
  }
  const digits = full.resolvedOptions().maximumFractionDigits ?? 2;
  const plain = new Intl.NumberFormat('en-MY', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const plainWhole = new Intl.NumberFormat('en-MY', { maximumFractionDigits: 0 });
  return {
    money: (n: number) => full.format(n),
    plain: (n: number) => plain.format(n),
    plainRound: (n: number) => plainWhole.format(n),
    round: (n: number) => whole.format(n),
    digits,
    symbol: full.formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency,
  };
}

function monthLabel(startMonth: number, startYear: number, offset: number) {
  const idx = startMonth + offset;
  return `${MONTHS[((idx % 12) + 12) % 12]} ${startYear + Math.floor(idx / 12)}`;
}

function shortLabel(startMonth: number, startYear: number, offset: number) {
  const idx = startMonth + offset;
  return `${MONTHS[((idx % 12) + 12) % 12]} ’${String(startYear + Math.floor(idx / 12)).slice(-2)}`;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function duration(months: number) {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y && m) return `${plural(y, 'year')} ${plural(m, 'month')}`;
  if (y) return plural(y, 'year');
  return plural(m, 'month');
}

export default function LoanCalculator() {
  const [inp, setInp] = useState<Inputs>(defaults);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<'year' | 'month'>('year');
  const uid = useId();

  useEffect(() => {
    setInp(load());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(inp));
    } catch {
      /* private mode: nothing to keep */
    }
  }, [inp, ready]);

  const set = <K extends keyof Inputs>(k: K, v: Inputs[K]) => setInp((p) => ({ ...p, [k]: v }));

  const switchKind = (kind: LoanKind) => {
    setInp((p) => {
      if (p.kind === kind) return p;
      const prev = PRESETS[p.kind];
      const untouched = (Object.keys(prev) as (keyof Preset)[]).every((k) => p[k] === prev[k]);
      // Swap in sensible numbers for the new loan type unless the user has typed their own.
      return untouched ? { ...p, kind, ...PRESETS[kind] } : { ...p, kind };
    });
  };

  const fmt = useMemo(() => makeFormatter(inp.currency), [inp.currency]);

  const price = num(inp.price);
  const downRaw = num(inp.down);
  const downAmt = !(downRaw > 0) ? 0 : inp.downMode === 'percent' ? (price * downRaw) / 100 : downRaw;
  const principal = price - downAmt;
  const rate = num(inp.rate);
  const yrs = num(inp.years) || 0;
  const mos = num(inp.months) || 0;
  const term = Math.round(yrs * 12 + mos);
  const extra = num(inp.extra) || 0;

  const errors: string[] = [];
  if (!(price > 0)) errors.push('Enter the price or loan amount.');
  else if (!(principal > 0)) errors.push('The down payment covers the whole price, so there is nothing to borrow.');
  if (!(rate >= 0)) errors.push('Enter the interest rate.');
  else if (rate > 100) errors.push('The interest rate looks too high. Enter it as a yearly percentage, such as 4.2.');
  if (!(term >= 1)) errors.push('Set the loan term.');
  else if (term > MAX_YEARS * 12) errors.push(`Keep the term at ${MAX_YEARS} years or less.`);

  const result = useMemo(
    () => (errors.length ? null : calculate({ kind: inp.kind, principal, rate, months: term, extra: inp.kind === 'reducing' ? extra : 0 })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [errors.length, inp.kind, principal, rate, term, extra],
  );

  const years = useMemo(() => (result ? byYear(result.rows) : []), [result]);

  const downloadCsv = () => {
    if (!result) return;
    const d = fmt.digits;
    const lines = [
      ['Month', 'Date', 'Payment', 'Principal', 'Interest', 'Balance'].join(','),
      ...result.rows.map((r) =>
        [r.month, monthLabel(inp.startMonth, inp.startYear, r.month - 1), r.payment.toFixed(d), r.principal.toFixed(d), r.interest.toFixed(d), r.balance.toFixed(d)].join(','),
      ),
    ];
    downloadBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }), `loan-schedule-${inp.currency.toLowerCase()}.csv`);
  };

  const thisYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 16 }, (_, i) => thisYear - 5 + i);
  if (!yearOptions.includes(inp.startYear)) yearOptions.unshift(inp.startYear);

  const moneyField = (key: 'price' | 'extra', label: string, hint?: string) => (
    <div className="ln-field">
      <label className="ln-label" htmlFor={`${uid}-${key}`}>
        {label}
        {hint && <span className="ln-hint">{hint}</span>}
      </label>
      <div className="ln-input">
        <span className="ln-affix mono">{fmt.symbol}</span>
        <input
          id={`${uid}-${key}`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={inp[key]}
          placeholder="0"
          onChange={(e) => set(key, e.target.value)}
          onBlur={(e) => set(key, group(e.target.value))}
        />
      </div>
    </div>
  );

  const paidOff = result ? monthLabel(inp.startMonth, inp.startYear, result.rows.length - 1) : '';
  const savedMonths = result ? result.baseMonths - result.rows.length : 0;
  const savedInterest = result ? result.baseInterest - result.totalInterest : 0;
  const interestShare = result ? result.totalInterest / result.totalPaid : 0;

  return (
    <div className="ln">
      <form className="ln-panel" onSubmit={(e) => e.preventDefault()} aria-label="Loan details">
        <div className="ln-field">
          <span className="ln-label" id={`${uid}-kind`}>Loan type</span>
          <div className="ln-seg" role="group" aria-labelledby={`${uid}-kind`}>
            <button type="button" aria-pressed={inp.kind === 'reducing'} onClick={() => switchKind('reducing')}>
              Reducing balance
            </button>
            <button type="button" aria-pressed={inp.kind === 'flat'} onClick={() => switchKind('flat')}>
              Flat rate
            </button>
          </div>
          <p className="ln-note">
            {inp.kind === 'reducing'
              ? 'Home loans, personal loans and most mortgages. Interest is charged on what you still owe.'
              : 'Car hire purchase. Interest is charged on the full amount for the whole term.'}
          </p>
        </div>

        <div className="ln-field">
          <label className="ln-label" htmlFor={`${uid}-cur`}>Currency</label>
          <select id={`${uid}-cur`} value={inp.currency} onChange={(e) => set('currency', e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.name}
              </option>
            ))}
          </select>
        </div>

        {moneyField('price', inp.kind === 'flat' ? 'Car price' : 'Price or loan amount')}

        <div className="ln-field">
          <label className="ln-label" htmlFor={`${uid}-down`}>
            Down payment<span className="ln-hint">optional</span>
          </label>
          <div className="ln-split">
            <div className="ln-input">
              {inp.downMode === 'amount' && <span className="ln-affix mono">{fmt.symbol}</span>}
              <input
                id={`${uid}-down`}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={inp.down}
                placeholder="0"
                onChange={(e) => set('down', e.target.value)}
                onBlur={(e) => set('down', group(e.target.value))}
              />
              {inp.downMode === 'percent' && <span className="ln-affix ln-affix-end mono">%</span>}
            </div>
            <div className="ln-seg ln-seg-sm" role="group" aria-label="Down payment as">
              <button type="button" aria-pressed={inp.downMode === 'percent'} onClick={() => set('downMode', 'percent')}>
                %
              </button>
              <button type="button" aria-pressed={inp.downMode === 'amount'} onClick={() => set('downMode', 'amount')}>
                {fmt.symbol}
              </button>
            </div>
          </div>
        </div>

        <div className="ln-field">
          <label className="ln-label" htmlFor={`${uid}-rate`}>
            Interest rate<span className="ln-hint">{inp.kind === 'flat' ? 'flat, per year' : 'per year'}</span>
          </label>
          <div className="ln-input">
            <input
              id={`${uid}-rate`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={inp.rate}
              placeholder="0"
              onChange={(e) => set('rate', e.target.value)}
            />
            <span className="ln-affix ln-affix-end mono">%</span>
          </div>
        </div>

        <div className="ln-field">
          <span className="ln-label" id={`${uid}-term`}>Loan term</span>
          <div className="ln-split ln-split-even" role="group" aria-labelledby={`${uid}-term`}>
            <div className="ln-input">
              <input
                aria-label="Years"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={inp.years}
                placeholder="0"
                onChange={(e) => set('years', e.target.value)}
              />
              <span className="ln-affix ln-affix-end mono">yrs</span>
            </div>
            <div className="ln-input">
              <input
                aria-label="Months"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={inp.months}
                placeholder="0"
                onChange={(e) => set('months', e.target.value)}
              />
              <span className="ln-affix ln-affix-end mono">mos</span>
            </div>
          </div>
        </div>

        <div className="ln-field">
          <span className="ln-label" id={`${uid}-start`}>First payment</span>
          <div className="ln-split ln-split-even" role="group" aria-labelledby={`${uid}-start`}>
            <select aria-label="Month" value={inp.startMonth} onChange={(e) => set('startMonth', Number(e.target.value))}>
              {MONTHS.map((m, i) => (
                <option key={m} value={i}>
                  {m}
                </option>
              ))}
            </select>
            <select aria-label="Year" value={inp.startYear} onChange={(e) => set('startYear', Number(e.target.value))}>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>

        {inp.kind === 'reducing' && moneyField('extra', 'Extra each month', 'optional')}
      </form>

      <div className="ln-out">
        {errors.length > 0 || !result ? (
          <div className="ln-card ln-empty" role="status">
            {errors.map((e) => (
              <p key={e}>{e}</p>
            ))}
          </div>
        ) : (
          <>
            <section className="ln-card ln-summary" aria-live="polite" aria-label="Result">
              <p className="ln-eyebrow mono">monthly payment</p>
              <p className="ln-big mono">{fmt.money(result.monthly)}</p>
              {extra > 0 && inp.kind === 'reducing' && (
                <p className="ln-sub">
                  You pay {fmt.money(result.monthly + extra)} with the extra {fmt.money(extra)}.
                </p>
              )}

              <div className="ln-bar" aria-hidden="true">
                <span className="ln-bar-p" style={{ width: `${(1 - interestShare) * 100}%` }} />
                <span className="ln-bar-i" style={{ width: `${interestShare * 100}%` }} />
              </div>

              <dl className="ln-stats">
                <div>
                  <dt>
                    <i className="ln-dot ln-dot-p" />
                    Loan amount
                  </dt>
                  <dd className="mono">{fmt.money(principal)}</dd>
                </div>
                <div>
                  <dt>
                    <i className="ln-dot ln-dot-i" />
                    Total interest
                  </dt>
                  <dd className="mono">{fmt.money(result.totalInterest)}</dd>
                </div>
                <div>
                  <dt>Total paid</dt>
                  <dd className="mono">{fmt.money(result.totalPaid)}</dd>
                </div>
                <div>
                  <dt>Paid off</dt>
                  <dd className="mono">
                    {paidOff}
                    <span className="ln-dd-sub">{duration(result.rows.length)}</span>
                  </dd>
                </div>
                {downAmt > 0 && (
                  <div>
                    <dt>Down payment</dt>
                    <dd className="mono">{fmt.money(downAmt)}</dd>
                  </div>
                )}
                {inp.kind === 'flat' && (
                  <div>
                    <dt>Effective rate</dt>
                    <dd className="mono">
                      {result.effectiveRate.toFixed(2)}%<span className="ln-dd-sub">per year, reducing</span>
                    </dd>
                  </div>
                )}
              </dl>

              {savedInterest > 0.005 && (
                <p className="ln-saved">
                  The extra payment saves <strong className="mono">{fmt.money(savedInterest)}</strong> in interest
                  {savedMonths > 0 && (
                    <>
                      {' '}
                      and finishes <strong>{duration(savedMonths)}</strong> early
                    </>
                  )}
                  .
                </p>
              )}
            </section>

            <BalanceChart rows={result.rows} fmt={fmt} startMonth={inp.startMonth} startYear={inp.startYear} />

            <section className="ln-card ln-table-card" aria-labelledby={`${uid}-sched`}>
              <div className="ln-table-head">
                <h2 id={`${uid}-sched`}>
                  Schedule <span className="ln-unit mono">{fmt.symbol}</span>
                </h2>
                <div className="ln-seg ln-seg-sm" role="group" aria-label="Show schedule by">
                  <button type="button" aria-pressed={view === 'year'} onClick={() => setView('year')}>
                    Yearly
                  </button>
                  <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>
                    Monthly
                  </button>
                </div>
              </div>
              <div className="ln-table-scroll" tabIndex={0} aria-label="Payment schedule">
                <table className="ln-table">
                  <thead>
                    <tr>
                      <th scope="col">{view === 'year' ? 'Year' : 'Month'}</th>
                      <th scope="col" className="ln-col-paid">Paid</th>
                      <th scope="col">Principal</th>
                      <th scope="col">Interest</th>
                      <th scope="col">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="mono">
                    {view === 'year'
                      ? years.map((y) => {
                          const first = (y.year - 1) * 12;
                          const last = Math.min(y.year * 12, result.rows.length) - 1;
                          return (
                            <tr key={y.year}>
                              <th scope="row">
                                {y.year}
                                <span className="ln-period">
                                  {shortLabel(inp.startMonth, inp.startYear, first)} – {shortLabel(inp.startMonth, inp.startYear, last)}
                                </span>
                              </th>
                              <td className="ln-col-paid">{fmt.plainRound(y.payment)}</td>
                              <td>{fmt.plainRound(y.principal)}</td>
                              <td>{fmt.plainRound(y.interest)}</td>
                              <td>{fmt.plainRound(y.balance)}</td>
                            </tr>
                          );
                        })
                      : result.rows.map((r) => (
                          <tr key={r.month}>
                            <th scope="row">
                              {r.month}
                              <span className="ln-period">{monthLabel(inp.startMonth, inp.startYear, r.month - 1)}</span>
                            </th>
                            <td className="ln-col-paid">{fmt.plain(r.payment)}</td>
                            <td>{fmt.plain(r.principal)}</td>
                            <td>{fmt.plain(r.interest)}</td>
                            <td>{fmt.plain(r.balance)}</td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              </div>
              <button type="button" className="btn btn-ghost ln-csv" onClick={downloadCsv}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
                </svg>
                Download CSV
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

interface ChartProps {
  rows: Row[];
  fmt: ReturnType<typeof makeFormatter>;
  startMonth: number;
  startYear: number;
}

const W = 600;
const H = 220;

function BalanceChart({ rows, fmt, startMonth, startYear }: ChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const { balancePath, balanceArea, interestPath, cumInterest, max } = useMemo(() => {
    const start = rows.length ? rows[0].balance + rows[0].principal : 0;
    const cum: number[] = [];
    let acc = 0;
    for (const r of rows) cum.push((acc += r.interest));
    const top = Math.max(start, acc) || 1;
    const n = rows.length;
    const x = (i: number) => (n <= 0 ? 0 : (i / n) * W);
    const y = (v: number) => H - (v / top) * H;
    let bp = `M0 ${y(start).toFixed(1)}`;
    let ip = `M0 ${H}`;
    rows.forEach((r, i) => {
      bp += `L${x(i + 1).toFixed(1)} ${y(r.balance).toFixed(1)}`;
      ip += `L${x(i + 1).toFixed(1)} ${y(cum[i]).toFixed(1)}`;
    });
    return { balancePath: bp, balanceArea: `${bp}L${W} ${H}L0 ${H}Z`, interestPath: ip, cumInterest: cum, max: top };
  }, [rows]);

  const n = rows.length;
  const pick = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || !n) return;
    const t = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    setHover(Math.min(n - 1, Math.max(0, Math.round(t * n) - 1)));
  };

  const totalYears = Math.ceil(n / 12);
  const step = totalYears > 20 ? 10 : totalYears > 8 ? 5 : totalYears > 3 ? 2 : 1;
  const ticks: number[] = [];
  for (let yr = step; yr * 12 < n; yr += step) ticks.push(yr);

  const shown = hover ?? n - 1;
  const hx = n ? ((shown + 1) / n) * 100 : 0;

  return (
    <section className="ln-card ln-chart-card" aria-label="Balance over time">
      <div className="ln-chart-read">
        <span className="mono ln-chart-when">{n ? monthLabel(startMonth, startYear, shown) : ''}</span>
        <span>
          <i className="ln-dot ln-dot-p" />
          Balance <b className="mono">{n ? fmt.round(rows[shown].balance) : ''}</b>
        </span>
        <span>
          <i className="ln-dot ln-dot-i" />
          Interest so far <b className="mono">{n ? fmt.round(cumInterest[shown]) : ''}</b>
        </span>
      </div>
      <div
        className="ln-chart"
        ref={boxRef}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1={H / 2} x2={W} y2={H / 2} className="ln-grid" />
          <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} className="ln-axis" />
          <path d={balanceArea} className="ln-area" />
          <path d={balancePath} className="ln-line-p" />
          <path d={interestPath} className="ln-line-i" />
        </svg>
        <span className="ln-cursor" style={{ left: `${hx}%` }} aria-hidden="true" />
        <span className="ln-ymax mono">{fmt.round(max)}</span>
      </div>
      <div className="ln-xaxis mono" aria-hidden="true">
        <span style={{ left: 0 }}>{startYear}</span>
        {ticks.map((t) => (
          <span key={t} style={{ left: `${((t * 12) / n) * 100}%` }}>
            {startYear + t}
          </span>
        ))}
      </div>
    </section>
  );
}
