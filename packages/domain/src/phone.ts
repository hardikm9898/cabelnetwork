export interface NormalizedPhone {
  /** Digits only; a recognisable +91 / leading-0 prefix is removed. */
  normalized: string;
  /** True when it is a valid 10-digit Indian mobile (starts with 6–9). */
  valid: boolean;
}

/**
 * Normalises an Indian mobile number. Never invents digits: an invalid number is
 * returned as its digits with valid=false so the caller can flag it.
 */
export function normalizeIndianMobile(raw: string | number | null | undefined): NormalizedPhone | null {
  if (raw === null || raw === undefined) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return { normalized: digits, valid: /^[6-9]\d{9}$/.test(digits) };
}
