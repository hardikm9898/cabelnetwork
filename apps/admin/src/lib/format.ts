import { businessDateOf, formatDateIN, formatInr } from '@cablenet/domain';

/** Display helpers only. All money arithmetic happens in the API. */
export const inr = (v: string | null | undefined) => (v === null || v === undefined ? '—' : formatInr(v));
export const date = (v: string | null | undefined) => (v ? formatDateIN(v.slice(0, 10)) : '—');
export const dateTime = (v: string | Date | null | undefined) =>
  v
    ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';
export const today = () => businessDateOf(new Date());
export const monthStart = () => `${today().slice(0, 8)}01`;
/** ENUM_VALUE → "Enum value", keeping acronyms (UPI, STB, MQ, GST) upper-case. */
export const label = (v: string | null | undefined) =>
  v
    ? v
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^\w/, (c) => c.toUpperCase())
        .replace(/\b(upi|stb|mq|gst)\b/gi, (m) => m.toUpperCase())
    : '—';
/** Sign-aware: positive balance = owes, negative = advance. */
export const isPositive = (v: string | null | undefined) => !!v && !v.startsWith('-') && !/^0(\.0+)?$/.test(v);
