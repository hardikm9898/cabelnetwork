import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';
import { balance, customerWithSubscription, expectBooksBalance, idem, invoicesOf, monthStart, pay, runBilling, setupSociety } from './support/finance';

const live = (bills: { status: string; periodStart: string; total: string; amountPaid: string }[]) =>
  bills.filter((b) => b.status !== 'CANCELLED').map((b) => [b.periodStart, b.total, b.amountPaid]);

/** Change the charge of months already billed (owner's question 2026-11-24). */
describe('re-bill from a month', () => {
  let h: Harness;
  let society: string;
  beforeAll(async () => {
    h = await createHarness();
    society = await setupSociety(h, 'Rebill Nagar');
  });
  afterAll(() => h.close());
  const sa = () => h.as(h.superAdminToken);

  it('cancels the bills from that month, bills them again at the new charge, and re-applies what was paid', async () => {
    const { customer, subscription } = await customerWithSubscription(h, society, { monthlyRate: '400' });
    await runBilling(h);
    await pay(h, h.superAdminToken, customer.id, '500').expect(201);
    // A later rate (e.g. imported for next month) is replaced too.
    await sa().post(`/api/v1/subscriptions/${subscription.id}/rates`, { monthlyRate: '450', effectiveFrom: monthStart(1), reason: 'Next month' }).expect(201);

    const res = await sa().post(`/api/v1/subscriptions/${subscription.id}/rebill`, { effectiveFrom: monthStart(-2), monthlyRate: '300', reason: 'Agreed lower rate' }, idem()).expect(200);
    expect(res.body.data).toMatchObject({ cancelled: 3, created: 3, from: monthStart(-2) });
    expect(res.body.data.subscription.rates.map((r: { monthlyRate: string }) => r.monthlyRate)).toEqual(['300.00']);
    expect(live(await invoicesOf(h, customer.id))).toEqual([
      [monthStart(-2), '300.00', '300.00'],
      [monthStart(-1), '300.00', '200.00'],
      [monthStart(0), '300.00', '0.00'],
    ]);
    expect((await balance(h, customer.id)).outstanding).toBe('400.00');
    await expectBooksBalance(h);
  });

  it('bills again months whose bills were cancelled by hand (nothing was billed after "Start billing")', async () => {
    const { customer, subscription } = await customerWithSubscription(h, society, { monthlyRate: '400' });
    await runBilling(h);
    for (const b of await invoicesOf(h, customer.id)) {
      await sa().post(`/api/v1/invoices/${b.id}/cancel`, { reason: 'Wrong rate' }, idem()).expect(200);
    }
    await runBilling(h);
    expect(live(await invoicesOf(h, customer.id))).toEqual([]); // the old behaviour: nothing comes back
    await sa().post(`/api/v1/subscriptions/${subscription.id}/rebill`, { effectiveFrom: monthStart(-2), monthlyRate: '350', reason: 'Correct rate' }, idem()).expect(200);
    expect(live(await invoicesOf(h, customer.id)).map((b) => [b[0], b[1]])).toEqual([
      [monthStart(-2), '350.00'],
      [monthStart(-1), '350.00'],
      [monthStart(0), '350.00'],
    ]);
  });

  it('can start earlier than the current billing start', async () => {
    const { customer, subscription } = await customerWithSubscription(h, society, { monthlyRate: '400', startDate: monthStart(-1) });
    await runBilling(h);
    const res = await sa().post(`/api/v1/subscriptions/${subscription.id}/rebill`, { effectiveFrom: monthStart(-3), monthlyRate: '200', reason: 'Was connected earlier' }, idem()).expect(200);
    expect(res.body.data.subscription.startDate).toBe(monthStart(-3));
    expect(live(await invoicesOf(h, customer.id)).map((b) => b[0])).toEqual([monthStart(-3), monthStart(-2), monthStart(-1), monthStart(0)]);
    await expectBooksBalance(h);
  });
});
