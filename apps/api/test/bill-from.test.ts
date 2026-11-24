import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackdateService } from '../src/modules/finance/backdate.service';
import { createAgent, createCustomer, createHarness, Harness } from './support/harness';
import { balance, customerWithSubscription, expectBooksBalance, invoicesOf, monthStart, runBilling, setupSociety, today } from './support/finance';

/** "Bill everyone from January" (owner's request 2026-11-24): bill-from moves unbilled subscriptions back. */
describe('bill-from', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('moves the start of unbilled customers back, bills every month at their charge, and leaves the rest alone', async () => {
    const agent = await createAgent(h, 'BF1');
    const society = await setupSociety(h, 'Bill From Nagar', agent.id);
    // Imported-style: billing starts next month, nothing billed yet; already paid ₹400 today.
    const { customer: fresh } = await customerWithSubscription(h, society, { monthlyRate: '400', startDate: monthStart(1) });
    await h.as(agent.token).post('/api/v1/payments', { clientTxnId: randomUUID(), customerId: fresh.id, amount: '400', paymentDate: today(), mode: 'CASH' }).expect(201);
    // Already billing (started last month and billed): not touched.
    const { customer: billing } = await customerWithSubscription(h, society, { monthlyRate: '300', startDate: monthStart(-1) });
    await runBilling(h);
    // No monthly charge at all: reported.
    const none = await createCustomer(h, society);

    const svc = h.app.get(BackdateService);
    const from = monthStart(-3);
    const plan = await svc.plan(from);
    const row = plan.change.find((r) => r.customerCode === fresh.customerCode);
    expect(row).toMatchObject({ monthlyRate: '400.00', periods: 4, amount: '1600.00' });
    expect(plan.skipped.find((s) => s.customerCode === billing.customerCode)?.reason).toContain('already billed');
    expect(plan.noCharge.map((c) => c.customerCode)).toContain(none.customerCode);
    // A dry run changes nothing.
    expect(await invoicesOf(h, fresh.id)).toHaveLength(0);

    const actor = { id: (await h.db.selectFrom('users').select('id').where('role', '=', 'SUPER_ADMIN').executeTakeFirstOrThrow()).id, role: 'SUPER_ADMIN' as const, fullName: 'Owner', sessionId: randomUUID(), deviceId: null, mustChangePassword: false };
    const res = await svc.apply(from, actor);
    expect(res.run.errors).toEqual([]);
    const bills = await invoicesOf(h, fresh.id);
    expect(bills.map((b) => [b.periodStart, b.total])).toEqual([
      [monthStart(-3), '400.00'],
      [monthStart(-2), '400.00'],
      [monthStart(-1), '400.00'],
      [monthStart(0), '400.00'],
    ]);
    // The ₹400 already paid goes to the oldest month.
    expect((await balance(h, fresh.id)).outstanding).toBe('1200.00');
    expect(bills[0]!.status).toBe('PAID');
    // The customer that was already billing keeps its bills.
    expect((await invoicesOf(h, billing.id)).map((b) => b.periodStart)).toEqual([monthStart(-1), monthStart(0)]);
    // Running it again changes nothing.
    expect((await svc.plan(from)).change.find((r) => r.customerCode === fresh.customerCode)).toBeUndefined();
    await expectBooksBalance(h);
  });
});
