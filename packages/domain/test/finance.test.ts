import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  defaultAnchorDay,
  duePeriods,
  firstPeriodStart,
  fiscalYear,
  formatDateIN,
  formatInr,
  fromPaise,
  OpenCredit,
  OpenInvoice,
  periodAt,
  periodLabel,
  planAllocation,
  rateOn,
  splitBalance,
  SubscriptionTerms,
  toPaise,
} from '../src';

describe('money', () => {
  it.each([
    ['1500', 150000n],
    ['1500.5', 150050n],
    ['1500.50', 150050n],
    ['0.01', 1n],
    ['-20.00', -2000n],
    [400, 40000n],
  ])('toPaise(%s) = %s', (input, paise) => {
    expect(toPaise(input)).toBe(paise);
  });

  it.each(['1.234', 'abc', '', '1e3', '١٢٣', '12,000', '0.1.2'])('rejects %s', (input) => {
    expect(() => toPaise(input)).toThrow(RangeError);
  });

  it('rejects fractional numbers (must be strings)', () => {
    expect(() => toPaise(0.1)).toThrow(RangeError);
  });

  it('round-trips without floating point error', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }), (p) => {
        expect(toPaise(fromPaise(p))).toBe(p);
      }),
    );
    // 0.1 + 0.2 style sums stay exact
    expect(fromPaise(toPaise('0.10') + toPaise('0.20'))).toBe('0.30');
  });

  it('splits a balance into outstanding / advance', () => {
    expect(splitBalance(50000n)).toEqual({ outstanding: 50000n, advance: 0n });
    expect(splitBalance(-150000n)).toEqual({ outstanding: 0n, advance: 150000n });
  });
});

describe('billing periods', () => {
  it('adds months on the anchor day across year ends', () => {
    expect(addMonths('2026-11-01', 3)).toBe('2027-02-01');
    expect(addMonths('2026-12-28', 1)).toBe('2027-01-28');
    expect(addMonths('2027-02-01', -2)).toBe('2026-12-01');
    expect(() => addMonths('2026-01-31', 1)).toThrow(RangeError);
  });

  it('finds the first anchor date on or after the start', () => {
    expect(firstPeriodStart('2026-11-01', 1)).toBe('2026-11-01');
    expect(firstPeriodStart('2026-11-18', 1)).toBe('2026-12-01');
    expect(firstPeriodStart('2026-11-18', 20)).toBe('2026-11-20');
    expect(defaultAnchorDay('2026-11-18')).toBe(18);
    expect(defaultAnchorDay('2026-01-31')).toBe(28);
  });

  it('computes period end, billing date and due date', () => {
    expect(periodAt('2026-11-01', 1, 'ADVANCE', 10)).toEqual({
      start: '2026-11-01',
      end: '2026-11-30',
      billingDate: '2026-11-01',
      dueDate: '2026-11-11',
    });
    expect(periodAt('2027-01-01', 3, 'ADVANCE', 10).end).toBe('2027-03-31');
    expect(periodAt('2026-11-01', 1, 'ARREARS', 7)).toMatchObject({ billingDate: '2026-12-01', dueDate: '2026-12-08' });
  });

  it('picks the rate effective on the period start (history preserved)', () => {
    const rates = [
      { effectiveFrom: '2026-01-01', monthlyRate: 40000n },
      { effectiveFrom: '2026-12-01', monthlyRate: 45000n },
    ];
    expect(rateOn(rates, '2025-12-31')).toBeNull();
    expect(rateOn(rates, '2026-11-01')).toBe(40000n);
    expect(rateOn(rates, '2026-12-01')).toBe(45000n);
  });

  const terms = (over: Partial<SubscriptionTerms> = {}): SubscriptionTerms => ({
    nextPeriodStart: '2026-09-01',
    intervalMonths: 1,
    timing: 'ADVANCE',
    dueDays: 10,
    endDate: null,
    ...over,
  });

  it('monthly: catches up every missed month, nothing in the future', () => {
    const plan = duePeriods(terms(), [{ effectiveFrom: '2026-01-01', monthlyRate: 40000n }], [], '2026-11-18');
    expect(plan.map((p) => [p.action, p.period.start])).toEqual([
      ['BILL', '2026-09-01'],
      ['BILL', '2026-10-01'],
      ['BILL', '2026-11-01'],
    ]);
  });

  it('3-month (₹500 → ₹1,500) and 4-month (₹600 → ₹2,400) cycles', () => {
    const q = duePeriods(terms({ intervalMonths: 3, nextPeriodStart: '2026-10-01' }), [{ effectiveFrom: '2026-01-01', monthlyRate: 50000n }], [], '2026-11-18');
    expect(q).toEqual([
      {
        action: 'BILL',
        monthlyRate: 50000n,
        amount: 150000n,
        period: { start: '2026-10-01', end: '2026-12-31', billingDate: '2026-10-01', dueDate: '2026-10-11' },
      },
    ]);
    const f = duePeriods(terms({ intervalMonths: 4, nextPeriodStart: '2026-11-01' }), [{ effectiveFrom: '2026-01-01', monthlyRate: 60000n }], [], '2026-11-01');
    expect(f[0]).toMatchObject({ action: 'BILL', amount: 240000n, period: { end: '2027-02-28' } });
  });

  it('custom interval (5 months) and arrears timing', () => {
    const plan = duePeriods(
      terms({ intervalMonths: 5, timing: 'ARREARS', nextPeriodStart: '2026-01-01' }),
      [{ effectiveFrom: '2026-01-01', monthlyRate: 30000n }],
      [],
      '2026-11-18',
    );
    // Jan–May billed on 1 Jun, Jun–Oct billed on 1 Nov; Nov–Mar not yet ended.
    expect(plan.map((p) => [p.period.start, p.period.billingDate, p.action === 'BILL' && p.amount])).toEqual([
      ['2026-01-01', '2026-06-01', 150000n],
      ['2026-06-01', '2026-11-01', 150000n],
    ]);
  });

  it('skips periods starting during a suspension and resumes after reactivation', () => {
    const plan = duePeriods(
      terms(),
      [{ effectiveFrom: '2026-01-01', monthlyRate: 40000n }],
      [{ from: '2026-09-15', to: '2026-10-20' }],
      '2026-11-18',
    );
    expect(plan.map((p) => [p.action, p.period.start])).toEqual([
      ['BILL', '2026-09-01'],
      ['SKIP_SUSPENDED', '2026-10-01'],
      ['BILL', '2026-11-01'],
    ]);
  });

  it('applies a rate change only from the next period start (old periods unchanged)', () => {
    const plan = duePeriods(
      terms(),
      [
        { effectiveFrom: '2026-01-01', monthlyRate: 40000n },
        { effectiveFrom: '2026-10-15', monthlyRate: 45000n },
      ],
      [],
      '2026-11-18',
    );
    expect(plan.map((p) => (p.action === 'BILL' ? p.amount : null))).toEqual([40000n, 40000n, 45000n]);
  });

  it('stops at the subscription end date and reports a missing rate', () => {
    expect(duePeriods(terms({ endDate: '2026-10-05' }), [{ effectiveFrom: '2026-01-01', monthlyRate: 1n }], [], '2026-11-18')).toHaveLength(2);
    const noRate = duePeriods(terms(), [{ effectiveFrom: '2026-10-01', monthlyRate: 40000n }], [], '2026-11-18');
    expect(noRate.map((p) => p.action)).toEqual(['NO_RATE']);
  });

  it('labels periods and fiscal years', () => {
    expect(periodLabel('2026-11-01', '2026-11-30')).toBe('Nov 2026');
    expect(periodLabel('2027-01-01', '2027-03-31')).toBe('Jan–Mar 2027');
    expect(periodLabel('2026-11-01', '2027-02-28')).toBe('Nov 2026–Feb 2027');
    expect(periodLabel('2026-11-15', '2026-12-14')).toBe('15 Nov 2026 – 14 Dec 2026');
    expect(fiscalYear('2026-11-18')).toBe('2026-27');
    expect(fiscalYear('2027-03-31')).toBe('2026-27');
    expect(fiscalYear('2027-04-01')).toBe('2027-28');
  });
});

describe('FIFO allocation', () => {
  const inv = (id: string, rupees: number): OpenInvoice => ({ id, remaining: BigInt(rupees) * 100n });
  const cr = (ref: string, rupees: number, targetInvoiceId?: string): OpenCredit => ({
    ref,
    remaining: BigInt(rupees) * 100n,
    targetInvoiceId,
  });

  it('E1: ₹1,000 against Jan/Feb/Mar ₹500 each settles Jan and Feb', () => {
    expect(planAllocation([cr('p1', 1000)], [inv('jan', 500), inv('feb', 500), inv('mar', 500)])).toEqual([
      { creditRef: 'p1', invoiceId: 'jan', amount: 50000n },
      { creditRef: 'p1', invoiceId: 'feb', amount: 50000n },
    ]);
  });

  it('E2: ₹2,000 against ₹500 due leaves ₹1,500 unallocated (advance)', () => {
    expect(planAllocation([cr('p1', 2000)], [inv('nov', 500)])).toEqual([{ creditRef: 'p1', invoiceId: 'nov', amount: 50000n }]);
  });

  it('E3: two partial payments on one invoice', () => {
    expect(planAllocation([cr('p1', 600), cr('p2', 900)], [inv('q1', 1500)])).toEqual([
      { creditRef: 'p1', invoiceId: 'q1', amount: 60000n },
      { creditRef: 'p2', invoiceId: 'q1', amount: 90000n },
    ]);
  });

  it('a targeted discount settles its own invoice before FIFO', () => {
    expect(planAllocation([cr('pay', 500), cr('disc', 100, 'feb')], [inv('jan', 500), inv('feb', 500)])).toEqual([
      { creditRef: 'disc', invoiceId: 'feb', amount: 10000n },
      { creditRef: 'pay', invoiceId: 'jan', amount: 50000n },
    ]);
  });

  const arbCredits = fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 8 });
  const arbInvoices = fc.array(fc.integer({ min: 0, max: 5000 }), { maxLength: 8 });

  it('invariants: conservation, no over-allocation, strict oldest-first', () => {
    fc.assert(
      fc.property(arbCredits, arbInvoices, (cs, is) => {
        const credits = cs.map((v, i) => cr(`c${i}`, v));
        const invoices = is.map((v, i) => inv(`i${i}`, v));
        const plan = planAllocation(credits, invoices);

        const byCredit = new Map<string, bigint>();
        const byInvoice = new Map<string, bigint>();
        for (const a of plan) {
          expect(a.amount > 0n).toBe(true);
          byCredit.set(a.creditRef, (byCredit.get(a.creditRef) ?? 0n) + a.amount);
          byInvoice.set(a.invoiceId, (byInvoice.get(a.invoiceId) ?? 0n) + a.amount);
        }
        for (const c of credits) expect((byCredit.get(c.ref) ?? 0n) <= c.remaining).toBe(true);
        for (const i of invoices) expect((byInvoice.get(i.id) ?? 0n) <= i.remaining).toBe(true);

        const totalCredit = credits.reduce((s, c) => s + c.remaining, 0n);
        const totalDue = invoices.reduce((s, i) => s + i.remaining, 0n);
        const allocated = plan.reduce((s, a) => s + a.amount, 0n);
        expect(allocated).toBe(totalCredit < totalDue ? totalCredit : totalDue);

        // FIFO: an invoice receives money only if every older invoice is fully paid.
        invoices.forEach((invoice, idx) => {
          if ((byInvoice.get(invoice.id) ?? 0n) > 0n) {
            for (const older of invoices.slice(0, idx)) {
              expect(byInvoice.get(older.id) ?? 0n).toBe(older.remaining);
            }
          }
        });
      }),
    );
  });

  it('is deterministic and never allocates from an empty pool', () => {
    expect(planAllocation([], [inv('a', 100)])).toEqual([]);
    expect(planAllocation([cr('c', 100)], [])).toEqual([]);
    expect(() => planAllocation([cr('c', -1)], [])).toThrow(RangeError);
  });
});

describe('display formatting', () => {
  it('formats rupees with Indian grouping', () => {
    expect(formatInr('123456.5')).toBe('₹1,23,456.50');
    expect(formatInr('12345678')).toBe('₹1,23,45,678.00');
    expect(formatInr('999')).toBe('₹999.00');
    expect(formatInr('-1500')).toBe('-₹1,500.00');
    expect(formatInr('0')).toBe('₹0.00');
    expect(formatInr(null)).toBe('');
    expect(formatDateIN('2026-11-18')).toBe('18-11-2026');
  });
});
