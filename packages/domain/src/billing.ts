import { addDays, isBusinessDate } from './dates';
import type { Paise } from './money';

/**
 * Billing-period rules (docs/FINANCIAL_LOGIC.md §4).
 *  - Periods are whole months aligned to the subscription's anchor day (1–28, so no clamping).
 *  - period_end = next period start − 1 day.
 *  - ADVANCE: invoice issued on period start; ARREARS: issued the day after period end.
 *  - Amount = monthly rate effective on period start × interval months (no proration).
 *  - A period whose start falls inside a suspension is not billed.
 */
export type BillingTiming = 'ADVANCE' | 'ARREARS';

export interface RateVersion {
  effectiveFrom: string;
  monthlyRate: Paise;
}

export interface DateRange {
  /** inclusive */
  from: string;
  /** inclusive; null = open-ended */
  to: string | null;
}

export interface BillingPeriod {
  start: string;
  end: string;
  billingDate: string;
  dueDate: string;
}

function parts(date: string): [number, number, number] {
  if (!isBusinessDate(date)) throw new RangeError(`Invalid date: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m!, d!];
}

const fmt = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Adds calendar months to a date whose day is ≤ 28 (always valid). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  if (d > 28) throw new RangeError('Period dates must fall on day 1–28');
  const idx = y * 12 + (m - 1) + months;
  return fmt(Math.floor(idx / 12), (idx % 12) + 1, d);
}

/** First anchor date on or after the start date. */
export function firstPeriodStart(startDate: string, anchorDay: number): string {
  if (anchorDay < 1 || anchorDay > 28) throw new RangeError('Anchor day must be 1–28');
  const [y, m, d] = parts(startDate);
  const candidate = fmt(y, m, anchorDay);
  return d <= anchorDay ? candidate : addMonths(candidate, 1);
}

/** Default anchor for a new subscription: its own start day (capped at 28) — no unbilled gap. */
export function defaultAnchorDay(startDate: string): number {
  return Math.min(parts(startDate)[2], 28);
}

export function periodAt(start: string, intervalMonths: number, timing: BillingTiming, dueDays: number): BillingPeriod {
  if (!Number.isInteger(intervalMonths) || intervalMonths < 1 || intervalMonths > 24) {
    throw new RangeError('Billing interval must be 1–24 months');
  }
  const next = addMonths(start, intervalMonths);
  const end = addDays(next, -1);
  const billingDate = timing === 'ADVANCE' ? start : next;
  return { start, end, billingDate, dueDate: addDays(billingDate, dueDays) };
}

/** The rate in force on a date (latest version with effectiveFrom ≤ date), or null. */
export function rateOn(rates: readonly RateVersion[], date: string): Paise | null {
  let best: RateVersion | null = null;
  for (const r of rates) {
    if (r.effectiveFrom <= date && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  }
  return best ? best.monthlyRate : null;
}

export function isSuspendedOn(suspensions: readonly DateRange[], date: string): boolean {
  return suspensions.some((s) => s.from <= date && (s.to === null || date <= s.to));
}

export interface SubscriptionTerms {
  nextPeriodStart: string;
  intervalMonths: number;
  timing: BillingTiming;
  dueDays: number;
  /** Last day of service (inclusive); periods starting after it are never billed. */
  endDate: string | null;
}

export type PlannedPeriod =
  | { action: 'BILL'; period: BillingPeriod; monthlyRate: Paise; amount: Paise }
  | { action: 'SKIP_SUSPENDED'; period: BillingPeriod }
  | { action: 'NO_RATE'; period: BillingPeriod };

/**
 * Every period that has become billable on or before `asOf`, in order. The caller persists
 * each result and moves its cursor to the following period start. Pure and deterministic,
 * so running it twice for the same state yields the same periods (idempotent scheduler).
 */
export function duePeriods(
  terms: SubscriptionTerms,
  rates: readonly RateVersion[],
  suspensions: readonly DateRange[],
  asOf: string,
  limit = 120,
): PlannedPeriod[] {
  const out: PlannedPeriod[] = [];
  let start = terms.nextPeriodStart;
  while (out.length < limit) {
    if (terms.endDate !== null && start > terms.endDate) break;
    const period = periodAt(start, terms.intervalMonths, terms.timing, terms.dueDays);
    if (period.billingDate > asOf) break;
    if (isSuspendedOn(suspensions, start)) {
      out.push({ action: 'SKIP_SUSPENDED', period });
    } else {
      const rate = rateOn(rates, start);
      if (rate === null) {
        out.push({ action: 'NO_RATE', period });
        break; // cannot bill further without a rate; surfaced as an alert
      }
      out.push({ action: 'BILL', period, monthlyRate: rate, amount: rate * BigInt(terms.intervalMonths) });
    }
    start = addMonths(start, terms.intervalMonths);
  }
  return out;
}

/** Indian financial year label for a date, e.g. 2026-11-18 → "2026-27", 2027-03-31 → "2026-27". */
export function fiscalYear(date: string): string {
  const [y, m] = parts(date);
  const startYear = m >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Human label for a billing period: "Nov 2026", "Jan–Mar 2027", or "15 Nov 2026 – 14 Dec 2026". */
export function periodLabel(start: string, end: string): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [sy, sm, sd] = parts(start);
  const [ey, em, ed] = parts(end);
  if (sd !== 1) return `${sd} ${names[sm - 1]} ${sy} – ${ed} ${names[em - 1]} ${ey}`;
  if (sy === ey && sm === em) return `${names[sm - 1]} ${sy}`;
  return sy === ey ? `${names[sm - 1]}–${names[em - 1]} ${ey}` : `${names[sm - 1]} ${sy}–${names[em - 1]} ${ey}`;
}
