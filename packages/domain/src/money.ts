/**
 * Exact money arithmetic. Amounts are handled as integer **paise** (`bigint`) inside the
 * application and as decimal strings ("1500.00") at the edges (API JSON, PostgreSQL numeric).
 * Floating point is never used for money.
 */
export type Paise = bigint;

const AMOUNT_RE = /^(-)?(\d{1,10})(?:\.(\d{1,2}))?$/;

/** Parses "1500", "1500.5", "1500.50", "-20.00" (and safe integers) into paise. Throws on anything else. */
export function toPaise(value: string | number | bigint): Paise {
  if (typeof value === 'bigint') return value * 100n;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`Use a decimal string for non-integer amounts: ${value}`);
    return BigInt(value) * 100n;
  }
  const m = AMOUNT_RE.exec(value.trim());
  if (!m) throw new RangeError(`Invalid amount: "${value}"`);
  const paise = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -paise : paise;
}

/** Formats paise as a fixed 2-decimal string, e.g. 150050n → "1500.50". */
export function fromPaise(p: Paise): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const rupees = abs / 100n;
  const paise = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${rupees}.${paise}`;
}

export function isAmountString(value: string): boolean {
  return AMOUNT_RE.test(value.trim());
}

export const sumPaise = (values: Iterable<Paise>): Paise => {
  let total = 0n;
  for (const v of values) total += v;
  return total;
};

export const minPaise = (a: Paise, b: Paise): Paise => (a < b ? a : b);
export const maxPaise = (a: Paise, b: Paise): Paise => (a > b ? a : b);

/** Splits a signed ledger balance into the two figures shown to users. */
export function splitBalance(balance: Paise): { outstanding: Paise; advance: Paise } {
  return { outstanding: maxPaise(balance, 0n), advance: maxPaise(-balance, 0n) };
}
