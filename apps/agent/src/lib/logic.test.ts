import { describe, expect, it } from 'vitest';
import { dictionaries, englishKeys, translate } from './i18n';
import { isValidAmount, mapsUrl, receiptMessage, whatsappUrl } from './share';

describe('translations', () => {
  it('Gujarati covers every English string', () => {
    const missing = englishKeys.filter((k) => !dictionaries.gu[k]);
    expect(missing).toEqual([]);
    expect(Object.keys(dictionaries.gu).filter((k) => !englishKeys.includes(k as never))).toEqual([]);
  });
  it('falls back to English', () => {
    expect(translate('gu', 'collectPayment')).toBe('પેમેન્ટ લો');
    expect(translate('en', 'collectPayment')).toBe('Collect payment');
  });
});

describe('sharing', () => {
  const snap = {
    business: { name: 'Demo Cable' },
    receiptNumber: 'RCPT/2026-27/000042',
    payment: { amount: '1000.00', paymentDate: '2026-11-19', mode: 'CASH' },
    customer: { code: '322760', name: 'Budhabhai', mobile: '9998659339' },
    allocations: [
      { label: 'Sep 2026', amount: '500.00' },
      { label: 'Oct 2026', amount: '500.00' },
    ],
    advanceCreated: '0.00',
    remainingOutstanding: '500.00',
    remainingAdvance: '0.00',
  };
  it('builds the receipt message with Indian formatting and the link', () => {
    const m = receiptMessage(snap, 'https://x/r/abc');
    expect(m).toContain('Received ₹1,000.00 on 19-11-2026 by cash');
    expect(m).toContain('• Sep 2026: ₹500.00');
    expect(m).toContain('Balance due: ₹500.00');
    expect(m.endsWith('Receipt: https://x/r/abc')).toBe(true);
    expect(receiptMessage({ ...snap, remainingOutstanding: '0.00' })).toContain('All dues cleared');
  });
  it('addresses WhatsApp only to valid Indian mobiles', () => {
    expect(whatsappUrl('9998659339', 'hi')).toBe('https://wa.me/919998659339?text=hi');
    expect(whatsappUrl('999837003', 'hi')).toBe('https://wa.me/?text=hi');
    expect(whatsappUrl(null, 'a b')).toBe('https://wa.me/?text=a%20b');
    expect(mapsUrl('1 Laxmi Nagar', 'Gota')).toContain('query=1%20Laxmi%20Nagar%2C%20Gota');
  });
  it('accepts only positive amounts with up to 2 decimals', () => {
    for (const ok of ['1', '400', '1500.5', '0.01']) expect(isValidAmount(ok)).toBe(true);
    for (const bad of ['', '0', '0.00', '1.234', 'abc', '-5', '1e3']) expect(isValidAmount(bad)).toBe(false);
  });
});
