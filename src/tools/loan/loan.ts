/** Loan maths: reducing-balance (home, personal) and flat-rate (car hire purchase) loans. */

export type LoanKind = 'reducing' | 'flat';

export interface LoanInput {
  kind: LoanKind;
  principal: number; // amount financed
  rate: number; // % per year (nominal for reducing, flat for flat)
  months: number;
  extra: number; // extra paid on top each month (reducing only)
}

export interface Row {
  month: number; // 1-based
  payment: number;
  principal: number;
  interest: number;
  balance: number;
}

export interface LoanResult {
  monthly: number; // scheduled instalment, without extra
  totalInterest: number;
  totalPaid: number;
  rows: Row[];
  /** Effective annual rate (APR) for flat loans, else the nominal rate. */
  effectiveRate: number;
  /** Months and interest without the extra payment, for "saved" figures. */
  baseMonths: number;
  baseInterest: number;
}

const EPS = 0.005; // half a cent

/** Instalment for a reducing-balance loan. */
export function annuityPayment(principal: number, monthlyRate: number, months: number): number {
  if (months <= 0) return 0;
  if (monthlyRate === 0) return principal / months;
  return (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
}

function reducingSchedule(principal: number, r: number, months: number, monthly: number, extra: number): Row[] {
  const rows: Row[] = [];
  let bal = principal;
  // Cap at the scheduled term: extra payments only shorten it.
  for (let m = 1; m <= months && bal > EPS; m++) {
    const interest = bal * r;
    let pay = monthly + extra;
    // Final month, or extra clears it early: pay only what is owed.
    if (pay > bal + interest || m === months) pay = bal + interest;
    const principalPart = pay - interest;
    bal -= principalPart;
    if (Math.abs(bal) < EPS) bal = 0;
    rows.push({ month: m, payment: pay, principal: principalPart, interest, balance: bal });
  }
  return rows;
}

/**
 * Flat-rate loans charge interest on the original amount for the whole term.
 * Each instalment's interest share follows the Rule of 78, as Malaysian hire-purchase
 * agreements do: more interest early, less later.
 */
function flatSchedule(principal: number, totalInterest: number, months: number, monthly: number): Row[] {
  const rows: Row[] = [];
  const digits = (months * (months + 1)) / 2;
  let bal = principal;
  for (let m = 1; m <= months; m++) {
    const interest = (totalInterest * (months - m + 1)) / digits;
    const principalPart = monthly - interest;
    bal -= principalPart;
    if (Math.abs(bal) < EPS || m === months) bal = 0;
    rows.push({ month: m, payment: monthly, principal: principalPart, interest, balance: bal });
  }
  return rows;
}

/** Annual rate at which a reducing-balance loan would have the same instalment. */
export function effectiveAnnualRate(principal: number, monthly: number, months: number): number {
  if (principal <= 0 || months <= 0 || monthly * months <= principal + 1e-9) return 0;
  let lo = 0;
  let hi = 1; // 100% a month is far above any real loan
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (annuityPayment(principal, mid, months) > monthly) hi = mid;
    else lo = mid;
  }
  return ((lo + hi) / 2) * 12 * 100;
}

export function calculate(input: LoanInput): LoanResult | null {
  const { kind, principal, rate, months } = input;
  if (!(principal > 0) || !(months >= 1) || !(rate >= 0)) return null;
  const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.interest, 0);

  if (kind === 'flat') {
    const totalInterest = principal * (rate / 100) * (months / 12);
    const monthly = (principal + totalInterest) / months;
    const rows = flatSchedule(principal, totalInterest, months, monthly);
    return {
      monthly,
      totalInterest,
      totalPaid: principal + totalInterest,
      rows,
      effectiveRate: effectiveAnnualRate(principal, monthly, months),
      baseMonths: months,
      baseInterest: totalInterest,
    };
  }

  const r = rate / 100 / 12;
  const monthly = annuityPayment(principal, r, months);
  const extra = Math.max(0, input.extra || 0);
  const rows = reducingSchedule(principal, r, months, monthly, extra);
  const totalInterest = sum(rows);
  const base = extra > 0 ? reducingSchedule(principal, r, months, monthly, 0) : rows;
  return {
    monthly,
    totalInterest,
    totalPaid: principal + totalInterest,
    rows,
    effectiveRate: rate,
    baseMonths: base.length,
    baseInterest: extra > 0 ? sum(base) : totalInterest,
  };
}

export interface YearRow {
  year: number; // 1-based loan year
  principal: number;
  interest: number;
  payment: number;
  balance: number; // at year end
}

export function byYear(rows: Row[]): YearRow[] {
  const out: YearRow[] = [];
  for (const r of rows) {
    const y = Math.ceil(r.month / 12);
    let cur = out[out.length - 1];
    if (!cur || cur.year !== y) {
      cur = { year: y, principal: 0, interest: 0, payment: 0, balance: 0 };
      out.push(cur);
    }
    cur.principal += r.principal;
    cur.interest += r.interest;
    cur.payment += r.payment;
    cur.balance = r.balance;
  }
  return out;
}
