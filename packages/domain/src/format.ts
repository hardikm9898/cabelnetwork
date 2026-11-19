import { fromPaise, toPaise } from './money';

/**
 * Display formatting only (no arithmetic on the value beyond exact normalisation).
 * "123456.5" → "₹1,23,456.50" using Indian digit grouping.
 */
export function formatInr(value: string | null | undefined, opts: { symbol?: boolean } = {}): string {
  if (value === null || value === undefined || value === '') return '';
  const normalised = fromPaise(toPaise(value));
  const neg = normalised.startsWith('-');
  const [rupees, paise] = (neg ? normalised.slice(1) : normalised).split('.') as [string, string];
  const grouped = rupees.length > 3 ? `${rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${rupees.slice(-3)}` : rupees;
  return `${neg ? '-' : ''}${opts.symbol === false ? '' : '₹'}${grouped}.${paise}`;
}

/** 2026-11-18 → 18-11-2026 (other strings are returned unchanged). */
export function formatDateIN(date: string | null | undefined): string {
  if (!date) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}` : date;
}
