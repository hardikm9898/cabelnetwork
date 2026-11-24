import { describe, expect, it } from 'vitest';
import { billMonths, monthCalendar, monthName, nextMonth } from '../src/months';

const bill = (periodStart: string, periodEnd: string, total: string, paid: string, paidOn: string | null = null) => ({ periodStart, periodEnd, total, paid, paidOn });

describe('month-by-month calendar', () => {
  it('marks paid, part paid, unpaid, not billed and coming months', () => {
    const cells = monthCalendar(
      [bill('2026-08-01', '2026-08-31', '400.00', '400.00', '2026-08-05'), bill('2026-09-01', '2026-09-30', '400.00', '150.00'), bill('2026-10-01', '2026-10-31', '400.00', '0.00')],
      '2026-12',
      6,
      '2026-11-24',
    );
    expect(cells.map((c) => [c.month, c.state])).toEqual([
      ['2026-07', 'NOT_BILLED'],
      ['2026-08', 'PAID'],
      ['2026-09', 'PARTIAL'],
      ['2026-10', 'DUE'],
      ['2026-11', 'NOT_BILLED'],
      ['2026-12', 'UPCOMING'],
    ]);
    expect(cells[1]!.bill?.paidOn).toBe('2026-08-05');
  });

  it('a 3-month bill covers three months; mid-month periods belong to their start month', () => {
    expect(billMonths(bill('2027-01-01', '2027-03-31', '1200', '0'))).toBe(3);
    expect(billMonths(bill('2026-11-15', '2026-12-14', '400', '0'))).toBe(1);
    const cells = monthCalendar([bill('2027-01-01', '2027-03-31', '1200.00', '1200.00')], '2027-03', 3, '2027-03-10');
    expect(cells.map((c) => [c.state, c.billMonths])).toEqual([
      ['PAID', 3],
      ['PAID', 3],
      ['PAID', 3],
    ]);
  });

  it('month helpers cross the year boundary', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('2027-01', -1)).toBe('2026-12');
    expect(monthName('2026-11')).toBe('Nov');
    expect(monthName('2026-11', true)).toBe('Nov 2026');
  });
});
