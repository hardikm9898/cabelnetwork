/**
 * Business dates are calendar dates (YYYY-MM-DD) in the business time zone
 * Asia/Kolkata (UTC+05:30, no daylight saving). Instants are stored in UTC.
 */
export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 330 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isBusinessDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function parts(date: string): [number, number, number] {
  if (!isBusinessDate(date)) throw new RangeError(`Invalid business date: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  return [y!, m!, d!];
}

/** The UTC instant at which the given IST calendar date begins (00:00 IST). */
export function startOfBusinessDay(date: string): Date {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
}

/** The IST calendar date (YYYY-MM-DD) that contains the given instant. */
export function businessDateOf(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Converts an inclusive IST date span [from, to] into the half-open instant range
 * [from 00:00 IST, (to + 1 day) 00:00 IST) used by assignment validity ranges.
 */
export function businessDaySpanToInstants(from: string, to: string): { start: Date; end: Date } {
  parts(from);
  parts(to);
  if (to < from) throw new RangeError('End date is before start date');
  return { start: startOfBusinessDay(from), end: startOfBusinessDay(addDays(to, 1)) };
}
