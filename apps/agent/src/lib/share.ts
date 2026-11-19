import { businessDateOf, formatDateIN, formatInr } from '@cablenet/domain';

/** Fields of the server's frozen receipt snapshot that the share message uses. */
export interface ReceiptSnapshot {
  business: { name: string };
  receiptNumber: string;
  payment: { amount: string; paymentDate: string; mode: string };
  customer: { code: string; name: string; mobile: string | null };
  allocations: { label: string; amount: string }[];
  advanceCreated: string;
  remainingOutstanding: string;
  remainingAdvance: string;
}

const modeName: Record<string, string> = { CASH: 'cash', UPI: 'UPI', BANK_TRANSFER: 'bank transfer', CHEQUE: 'cheque', OTHER: 'other' };

/** Text for the customer (English: receipts are formal documents). */
export function receiptMessage(s: ReceiptSnapshot, link?: string): string {
  const lines = [
    `${s.business.name} – Payment receipt ${s.receiptNumber}`,
    `${s.customer.name} (${s.customer.code})`,
    `Received ${formatInr(s.payment.amount)} on ${formatDateIN(s.payment.paymentDate)} by ${modeName[s.payment.mode] ?? s.payment.mode}`,
    ...s.allocations.map((a) => `• ${a.label}: ${formatInr(a.amount)}`),
    s.remainingOutstanding !== '0.00'
      ? `Balance due: ${formatInr(s.remainingOutstanding)}`
      : s.remainingAdvance !== '0.00'
        ? `Advance: ${formatInr(s.remainingAdvance)}`
        : 'All dues cleared. Thank you!',
  ];
  if (link) lines.push(`Receipt: ${link}`);
  return lines.join('\n');
}

/**
 * Text for a payment saved on the phone that has not reached the office yet (Q14 default:
 * shareable, clearly marked provisional). No balance is quoted: only the office calculates it.
 */
export function provisionalMessage(p: {
  business: string;
  provisionalRef: string;
  customerName: string;
  customerCode: string;
  amount: string;
  mode: string;
  collectedAt: string;
  agentName: string;
}): string {
  const at = new Date(p.collectedAt);
  return [
    `${p.business} – PROVISIONAL receipt ${p.provisionalRef}`,
    'Pending confirmation by the office.',
    `${p.customerName} (${p.customerCode})`,
    `Received ${formatInr(p.amount)} by ${modeName[p.mode] ?? p.mode} on ${formatDateIN(businessDateOf(at))} at ${istTime(at)}`,
    `Collected by ${p.agentName}`,
    'The final receipt will be sent once it is confirmed.',
  ].join('\n');
}

/** hh:mm in India time (fixed +05:30, no daylight saving). */
export function istTime(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
}

/** wa.me deep link; addresses the customer's own number when it is a valid Indian mobile. */
export function whatsappUrl(mobile: string | null, text: string): string {
  const to = mobile && /^[6-9]\d{9}$/.test(mobile) ? `91${mobile}` : '';
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

export const telUrl = (mobile: string) => `tel:${mobile}`;

/** Opens Google Maps search for the address (works without coordinates). */
export function mapsUrl(address: string, society: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${address}, ${society}`)}`;
}

/** Amount typed by the agent: digits with up to 2 decimals, > 0. */
export function isValidAmount(v: string): boolean {
  return /^\d{1,10}(\.\d{1,2})?$/.test(v) && !/^0+(\.0+)?$/.test(v);
}
