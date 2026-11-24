import { addDays } from './dates';

/**
 * Month-by-month payment calendar for one customer: which months are paid, part paid, still due
 * or not billed. Shared by the office site and the agent app so both show the same thing.
 */

/** One monthly (or multi-month) subscription bill. Money as "123.45" strings. */
export interface MonthBill {
  periodStart: string;
  periodEnd: string;
  total: string;
  paid: string;
  /** Latest payment date that went to this bill. */
  paidOn: string | null;
}

export type MonthState = 'PAID' | 'PARTIAL' | 'DUE' | 'NOT_BILLED' | 'UPCOMING';

export interface MonthCell {
  /** YYYY-MM */
  month: string;
  state: MonthState;
  /** The bill covering this month (a 3-month bill covers three cells). */
  bill: MonthBill | null;
  /** Months the bill covers (1 for a monthly bill). */
  billMonths: number;
}

const cents = (v: string) => Math.round(Number(v) * 100);

/** "2026-11" → "2026-12". */
export function nextMonth(month: string, by = 1): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + by;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function monthsBetween(fromMonth: string, toMonthExclusive: string): number {
  const [ay, am] = fromMonth.split('-').map(Number) as [number, number];
  const [by, bm] = toMonthExclusive.split('-').map(Number) as [number, number];
  return by * 12 + bm - (ay * 12 + am);
}

/** How many calendar months a bill period covers (1 Nov–30 Nov and 15 Nov–14 Dec are both 1). */
export function billMonths(b: Pick<MonthBill, 'periodStart' | 'periodEnd'>): number {
  return Math.max(1, monthsBetween(b.periodStart.slice(0, 7), addDays(b.periodEnd, 1).slice(0, 7)));
}

export function billState(b: MonthBill): Exclude<MonthState, 'NOT_BILLED' | 'UPCOMING'> {
  const total = cents(b.total);
  const paid = cents(b.paid);
  if (paid >= total) return 'PAID';
  return paid > 0 ? 'PARTIAL' : 'DUE';
}

/**
 * `count` months ending with `lastMonth` (YYYY-MM), oldest first. A month with no bill is
 * NOT_BILLED, or UPCOMING when it is after `today`'s month.
 */
export function monthCalendar(bills: readonly MonthBill[], lastMonth: string, count: number, today: string): MonthCell[] {
  const byMonth = new Map<string, MonthBill>();
  for (const b of bills) {
    const n = billMonths(b);
    for (let i = 0; i < n; i++) {
      const m = nextMonth(b.periodStart.slice(0, 7), i);
      if (!byMonth.has(m)) byMonth.set(m, b);
    }
  }
  const thisMonth = today.slice(0, 7);
  const cells: MonthCell[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const month = nextMonth(lastMonth, -i);
    const bill = byMonth.get(month) ?? null;
    cells.push({
      month,
      state: bill ? billState(bill) : month > thisMonth ? 'UPCOMING' : 'NOT_BILLED',
      bill,
      billMonths: bill ? billMonths(bill) : 0,
    });
  }
  return cells;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11" → "Nov" (or "Nov 2026" with the year). */
export function monthName(month: string, withYear = false): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return withYear ? `${MONTHS[m - 1]} ${y}` : MONTHS[m - 1]!;
}
