import { describe, expect, it } from 'vitest';
import { date, inr, isPositive, label } from './format';

describe('display formatting', () => {
  it('shows money with ₹ and Indian grouping, dates as dd-mm-yyyy', () => {
    expect(inr('152330.5')).toBe('₹1,52,330.50');
    expect(inr(null)).toBe('—');
    expect(date('2026-11-18')).toBe('18-11-2026');
    expect(date('2026-11-18T10:00:00Z')).toBe('18-11-2026');
    expect(label('PENDING_VERIFICATION')).toBe('Pending verification');
    expect(label('UPI')).toBe('UPI');
    expect(label('BANK_TRANSFER')).toBe('Bank transfer');
    expect(isPositive('0.00')).toBe(false);
    expect(isPositive('-5.00')).toBe(false);
    expect(isPositive('5.00')).toBe(true);
  });
});
