import { addDays, addMonths } from '@cablenet/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsService } from '../src/modules/finance/jobs.service';
import { createHarness, Harness } from './support/harness';
import {
  balance,
  customerWithSubscription,
  expectBooksBalance,
  idem,
  invoicesOf,
  monthStart,
  pay,
  runBilling,
  setupSociety,
  today,
} from './support/finance';

describe('subscription billing engine', () => {
  let h: Harness;
  let society: string;
  beforeAll(async () => {
    h = await createHarness();
    society = await setupSociety(h, 'Billing Society');
  });
  afterAll(() => h.close());

  it('monthly: bills every due month once, and re-running (even concurrently) never duplicates', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400' });
    const runs = await Promise.all([runBilling(h), runBilling(h), runBilling(h)]);
    expect(runs.reduce((s, r) => s + r.invoicesCreated, 0)).toBe(3);
    expect((await runBilling(h)).invoicesCreated).toBe(0);

    const inv = await invoicesOf(h, customer.id);
    expect(inv.map((i) => [i.periodStart, i.total, i.status])).toEqual([
      [monthStart(-2), '400.00', 'UNPAID'],
      [monthStart(-1), '400.00', 'UNPAID'],
      [monthStart(0), '400.00', 'UNPAID'],
    ]);
    expect(await balance(h, customer.id)).toMatchObject({ outstanding: '1200.00', advance: '0.00' });
  });

  it('3-month cycle: ₹500/month billed as one ₹1,500 invoice', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '500', billingIntervalMonths: 3, startDate: monthStart(0) });
    await runBilling(h);
    const [inv] = await invoicesOf(h, customer.id);
    expect(inv).toMatchObject({ total: '1500.00', periodStart: monthStart(0) });
    const detail = await h.as(h.superAdminToken).get(`/api/v1/invoices/${inv!.id}`).expect(200);
    expect(detail.body.data).toMatchObject({ periodEnd: addDays(monthStart(3), -1) });
    expect(detail.body.data.items[0]).toMatchObject({ months: 3, unitRate: '500.00', amount: '1500.00' });
  });

  it('4-month cycle: ₹600/month billed as ₹2,400', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '600', billingIntervalMonths: 4, startDate: monthStart(0) });
    await runBilling(h);
    expect((await invoicesOf(h, customer.id)).map((i) => i.total)).toEqual(['2400.00']);
  });

  it('custom 5-month cycle billed in arrears: nothing until the period has ended', async () => {
    const { customer } = await customerWithSubscription(h, society, {
      monthlyRate: '300',
      billingIntervalMonths: 5,
      billingTiming: 'ARREARS',
      startDate: monthStart(-4),
    });
    await runBilling(h);
    expect(await invoicesOf(h, customer.id)).toEqual([]);
    await runBilling(h, monthStart(1)); // first day after the 5-month period
    expect((await invoicesOf(h, customer.id)).map((i) => [i.periodStart, i.total])).toEqual([[monthStart(-4), '1500.00']]);
  });

  it('a new subscription starting mid-month is billed from its own start day (no unbilled gap)', async () => {
    const start = addDays(monthStart(0), 9); // the 10th of this month
    const { subscription } = await customerWithSubscription(h, society, { monthlyRate: '350', startDate: start });
    expect(subscription).toMatchObject({ billingAnchorDay: 10, nextPeriodStart: start });
  });

  it('rate change applies only to future periods; billed invoices never change', async () => {
    const { customer, subscription } = await customerWithSubscription(h, society, { monthlyRate: '400' });
    await runBilling(h);
    const tooEarly = await h
      .as(h.superAdminToken)
      .post(`/api/v1/subscriptions/${subscription.id}/rates`, { monthlyRate: '450', effectiveFrom: monthStart(-1), reason: 'Price revision' });
    expect(tooEarly.body.error.code).toBe('PERIOD_ALREADY_BILLED');
    await h
      .as(h.superAdminToken)
      .post(`/api/v1/subscriptions/${subscription.id}/rates`, { monthlyRate: '450', effectiveFrom: monthStart(1), reason: 'Price revision' })
      .expect(201);
    await runBilling(h, monthStart(1));
    expect((await invoicesOf(h, customer.id)).map((i) => i.total)).toEqual(['400.00', '400.00', '400.00', '450.00']);
    const sub = await h.as(h.superAdminToken).get(`/api/v1/customers/${customer.id}/subscription`).expect(200);
    expect(sub.body.data.rates.map((r: { monthlyRate: string }) => r.monthlyRate)).toEqual(['450.00', '400.00']);
  });

  it('suspension skips the periods that start while suspended; reactivation resumes billing', async () => {
    const { customer, subscription } = await customerWithSubscription(h, society, { monthlyRate: '300' });
    await h
      .as(h.superAdminToken)
      .post(`/api/v1/subscriptions/${subscription.id}/suspensions`, { fromDate: addDays(monthStart(-1), -3), reason: 'Customer travelling' })
      .expect(201);
    const c1 = await h.as(h.superAdminToken).get(`/api/v1/customers/${customer.id}`).expect(200);
    expect(c1.body.data.status).toBe('SUSPENDED');

    expect((await runBilling(h)).periodsSkipped).toBeGreaterThanOrEqual(2);
    expect((await invoicesOf(h, customer.id)).map((i) => i.periodStart)).toEqual([monthStart(-2)]);

    const overlap = await h
      .as(h.superAdminToken)
      .post(`/api/v1/subscriptions/${subscription.id}/suspensions`, { fromDate: today(), reason: 'Again' });
    expect(overlap.body.error.code).toBe('SUSPENSION_OVERLAP');

    await h.as(h.superAdminToken).post(`/api/v1/subscriptions/${subscription.id}/reactivate`, { reason: 'Back home' }).expect(200);
    const c2 = await h.as(h.superAdminToken).get(`/api/v1/customers/${customer.id}`).expect(200);
    expect(c2.body.data.status).toBe('ACTIVE');
    await runBilling(h, monthStart(1));
    expect((await invoicesOf(h, customer.id)).map((i) => i.periodStart)).toEqual([monthStart(-2), monthStart(1)]);
  });

  it('a missing rate pauses billing for that customer and raises an alert', async () => {
    const { customer, subscription } = await customerWithSubscription(h, society, { monthlyRate: '0', billingMode: 'MANUAL' });
    // The API always records a rate at the start date, so a gap can only come from imported
    // data. Simulate that: the subscription now starts a month before its first rate.
    const early = addMonths(monthStart(-2), -1);
    await sql`UPDATE customer_subscriptions SET billing_mode = 'AUTO', start_date = ${early}::date, next_period_start = ${early}::date WHERE id = ${subscription.id}`.execute(h.db);
    await runBilling(h);
    expect(await invoicesOf(h, customer.id)).toEqual([]);
    const alerts = await h.as(h.superAdminToken).get('/api/v1/system-alerts').expect(200);
    expect(alerts.body.data.map((a: { type: string; entityId: string }) => [a.type, a.entityId])).toContainEqual(['NO_RATE_FOR_PERIOD', subscription.id]);

    // Paused: further runs do not retry it; adding a rate resumes billing from the stuck period.
    expect((await runBilling(h)).errors).toEqual([]);
    await h
      .as(h.superAdminToken)
      .post(`/api/v1/subscriptions/${subscription.id}/rates`, { monthlyRate: '150', effectiveFrom: addMonths(monthStart(-2), -1), reason: 'Rate confirmed' })
      .expect(201);
    await runBilling(h);
    expect((await invoicesOf(h, customer.id)).map((i) => i.total)).toEqual(['150.00', '0.00', '0.00', '0.00']);
  });

  it('manual billing mode: admin raises invoices; overlapping periods are refused', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '250', billingMode: 'MANUAL' });
    await runBilling(h);
    expect(await invoicesOf(h, customer.id)).toEqual([]);
    const res = await h
      .as(h.superAdminToken)
      .post(`/api/v1/customers/${customer.id}/invoices`, { periodStart: monthStart(-2), months: 2 }, idem());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ total: '500.00', periodEnd: addDays(monthStart(0), -1) });
    const overlap = await h.as(h.superAdminToken).post(`/api/v1/customers/${customer.id}/invoices`, { periodStart: monthStart(-1), months: 1 }, idem());
    expect(overlap.body.error.code).toBe('PERIOD_ALREADY_BILLED');
  });

  it('automatic subscriptions refuse manual invoices', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '250' });
    const res = await h.as(h.superAdminToken).post(`/api/v1/customers/${customer.id}/invoices`, { periodStart: monthStart(0), months: 1 }, idem());
    expect(res.body.error.code).toBe('SUBSCRIPTION_IS_AUTO');
  });

  it('cancelling a partly paid invoice re-applies the money to the next open invoice', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '500' });
    await runBilling(h);
    await pay(h, h.superAdminToken, customer.id, '300').expect(201);
    const [first, second] = await invoicesOf(h, customer.id);
    expect(first).toMatchObject({ amountPaid: '300.00', status: 'PARTIALLY_PAID' });

    await h.as(h.superAdminToken).post(`/api/v1/invoices/${first!.id}/cancel`, { reason: 'Billed in error' }, idem()).expect(200);
    const after = await invoicesOf(h, customer.id);
    expect(after.find((i) => i.id === first!.id)).toMatchObject({ status: 'CANCELLED', amountPaid: '0.00' });
    expect(after.find((i) => i.id === second!.id)).toMatchObject({ amountPaid: '300.00', status: 'PARTIALLY_PAID' });
    expect(await balance(h, customer.id)).toMatchObject({ outstanding: '700.00' });
    const again = await h.as(h.superAdminToken).post(`/api/v1/invoices/${first!.id}/cancel`, { reason: 'twice' }, idem());
    expect(again.body.error.code).toBe('INVOICE_ALREADY_CANCELLED');
  });

  it('deactivating a customer ends the subscription: no further bills, dues remain', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400', startDate: monthStart(-1) });
    await runBilling(h);
    await h.as(h.superAdminToken).post(`/api/v1/customers/${customer.id}/deactivate`, { reason: 'Disconnected' }).expect(200);
    await runBilling(h, monthStart(1));
    expect(await invoicesOf(h, customer.id)).toHaveLength(2);
    expect(await balance(h, customer.id)).toMatchObject({ outstanding: '800.00' });
    const sub = await h.as(h.superAdminToken).get(`/api/v1/customers/${customer.id}/subscription`).expect(200);
    expect(sub.body.data).toMatchObject({ status: 'ENDED', endDate: today() });
  });

  it('refuses to bill far into the future', async () => {
    const res = await h.as(h.superAdminToken).post('/api/v1/billing/runs', { asOf: addDays(today(), 60) });
    expect(res.body.error.code).toBe('AS_OF_TOO_FAR');
  });

  it('the scheduler tick bills due work and reconciles once per day', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '200', startDate: monthStart(0) });
    const jobs = h.app.get(JobsService);
    const first = await jobs.tick();
    expect((first.billing as { invoicesCreated: number }).invoicesCreated).toBeGreaterThanOrEqual(1);
    expect(first.reconciliation).toMatchObject({ customerMismatches: [] });
    const second = await jobs.tick();
    expect(second.billing).toBeUndefined();
    expect(second.reconciliation).toBe('already ran today');
    expect(await invoicesOf(h, customer.id)).toHaveLength(1);
  });

  it('the books balance after everything above', async () => {
    await expectBooksBalance(h);
  });

  it('invoices and their items cannot be altered or deleted', async () => {
    const inv = await h.db.selectFrom('invoices').select('id').where('status', '!=', 'CANCELLED').executeTakeFirstOrThrow();
    await expect(sql`UPDATE invoices SET total = 1 WHERE id = ${inv.id}`.execute(h.db)).rejects.toThrow(/immutable/);
    await expect(sql`DELETE FROM invoices WHERE id = ${inv.id}`.execute(h.db)).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE invoice_items SET amount = 1`.execute(h.db)).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE subscription_rates SET monthly_rate = 1`.execute(h.db)).rejects.toThrow(/append-only/);
  });
});
