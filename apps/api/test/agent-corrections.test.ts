import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createCustomer, createHarness, Harness } from './support/harness';
import { balance, customerWithSubscription, expectBooksBalance, idem, monthStart, runBilling, setupSociety, today } from './support/finance';

interface Outcome {
  opId: string;
  status: string;
  originalStatus?: string;
  error?: { code: string; message: string };
  result?: Record<string, unknown> | null;
}

/**
 * Agent's full access to their own customers (owner's request 2026-11-24): edit details, set the
 * monthly charge, delete a payment entered by mistake (the office sees it), month-by-month bills
 * and searchable box / MQ numbers on the phone.
 */
describe('agent corrections', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof createAgent>>;
  let other: Awaited<ReturnType<typeof createAgent>>;
  let mine: string;
  let theirs: string;
  let seq = 0;

  const op = (type: string, payload: Record<string, unknown>, opId = randomUUID()) => ({ opId, type, seq: ++seq, createdAt: new Date().toISOString(), offline: false, payload });
  const payOp = (customerId: string, amount: string, mode = 'CASH', extra: Record<string, unknown> = {}) =>
    op('PAYMENT_CREATE', { customerId, amount, mode, provisionalRef: `P-${agent.code}-${String(seq + 1).padStart(6, '0')}`, visitId: randomUUID(), ...extra });
  const push = async (ops: object[], token = agent.token) => {
    const res = await h.as(token).post('/api/v1/sync/push', { deviceTime: new Date().toISOString(), ops });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data.results as Outcome[];
  };
  const pull = async () => (await h.as(agent.token).get('/api/v1/sync/pull').expect(200)).body.data;
  const payment = (id: string) => h.db.selectFrom('payments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  beforeAll(async () => {
    h = await createHarness();
    agent = await createAgent(h, 'AC1', 'Ramesh Field');
    other = await createAgent(h, 'AC2', 'Other Field');
    mine = await setupSociety(h, 'Agent Corr Mine', agent.id);
    theirs = await setupSociety(h, 'Agent Corr Theirs', other.id);
  });
  afterAll(() => h.close());

  describe('edit customer', () => {
    it('the agent edits everything about their own customer, but not the society', async () => {
      const c = await createCustomer(h, mine);
      const res = await h
        .as(agent.token)
        .patch(`/api/v1/customers/${c.id}`, { name: 'Ramila Shah', customerCode: `${c.customerCode}A`, addressLine: 'B-402 Sunshine', stbNumber: '307070260711112222', mqNumber: '91081199', notes: 'Gate 2' })
        .expect(200);
      expect(res.body.data.customer).toMatchObject({ name: 'Ramila Shah', customerCode: `${c.customerCode}A`, addressLine: 'B-402 Sunshine', notes: 'Gate 2', activeConnections: [{ stbNumber: '307070260711112222', mqNumber: '91081199' }] });
      const moved = await h.as(agent.token).patch(`/api/v1/customers/${c.id}`, { societyId: theirs });
      expect(moved.status).toBe(403);
      expect(moved.body.error.code).toBe('SOCIETY_CHANGE_BY_OFFICE');
      // The office sees who changed it.
      const audit = await h.db.selectFrom('auditLogs').select(['actorUserId', 'action']).where('entityId', '=', c.id).where('action', '=', 'customer.update').execute();
      expect(audit.map((a) => a.actorUserId)).toContain(agent.id);
    });

    it("another agent's customer is not found", async () => {
      const c = await createCustomer(h, theirs);
      const res = await h.as(agent.token).patch(`/api/v1/customers/${c.id}`, { name: 'Nope' });
      expect(res.status).toBe(404);
    });
  });

  describe('monthly charge', () => {
    it('the agent changes the charge from the next bill; the office is notified', async () => {
      const { customer } = await customerWithSubscription(h, mine, { monthlyRate: '300' });
      await runBilling(h);
      const res = await h.as(agent.token).post(`/api/v1/customers/${customer.id}/monthly-charge`, { monthlyRate: '400' }).expect(200);
      expect(res.body.data.rates[0]).toMatchObject({ monthlyRate: '400.00', effectiveFrom: monthStart(1) });
      // Bills already made stay.
      expect((await balance(h, customer.id)).outstanding).toBe('900.00');
      const notes = (await h.as(h.superAdminToken).get('/api/v1/notifications').expect(200)).body.data as { type: string; body: string }[];
      expect(notes.find((n) => n.type === 'RATE_CHANGED_BY_AGENT')?.body).toContain('₹400.00/month');
      // The phone shows the current charge and the one coming.
      const onPhone = (await pull()).customers.find((x: { id: string }) => x.id === customer.id);
      expect(onPhone).toMatchObject({ monthlyRate: '300.00', upcomingRate: { monthlyRate: '400.00', from: monthStart(1) } });
      // Same charge again changes nothing.
      const same = await h.as(agent.token).post(`/api/v1/customers/${customer.id}/monthly-charge`, { monthlyRate: '400.00' }).expect(200);
      expect(same.body.data.rates).toHaveLength(2);
    });

    it('a customer without a plan starts billing next month', async () => {
      const c = await createCustomer(h, mine);
      const res = await h.as(agent.token).post(`/api/v1/customers/${c.id}/monthly-charge`, { monthlyRate: '250' }).expect(200);
      expect(res.body.data).toMatchObject({ startDate: monthStart(1), monthlyRate: '250.00' });
      const theirsC = await createCustomer(h, theirs);
      expect((await h.as(agent.token).post(`/api/v1/customers/${theirsC.id}/monthly-charge`, { monthlyRate: '250' })).status).toBe(404);
    });
  });

  describe('months and the phone snapshot', () => {
    it('month-by-month bills show paid, part paid and unpaid months; the phone gets boxes, MQ and bills', async () => {
      const { customer } = await customerWithSubscription(h, mine, { monthlyRate: '400' });
      await runBilling(h);
      await h.as(agent.token).post('/api/v1/payments', { clientTxnId: randomUUID(), customerId: customer.id, amount: '600', paymentDate: today(), mode: 'CASH' });
      const months = (await h.as(agent.token).get(`/api/v1/customers/${customer.id}/months`).expect(200)).body.data;
      expect(months.bills.map((b: { periodStart: string; paid: string }) => [b.periodStart, b.paid])).toEqual([
        [monthStart(-2), '400.00'],
        [monthStart(-1), '200.00'],
        [monthStart(0), '0.00'],
      ]);
      expect(months.bills[0].paidOn).toBeTruthy();

      const snap = await pull();
      const row = snap.customers.find((x: { id: string }) => x.id === customer.id);
      expect(row.stbNumbers).toEqual([`307070260700${customer.customerCode}`]);
      expect(row.bills).toHaveLength(3);
      expect(row.recentPayments[0]).toMatchObject({ amount: '600.00', canDelete: true, note: null });
    });
  });

  describe('delete a payment from the phone', () => {
    it('reverses a confirmed cash payment, restores the dues, and raises an alert for the office', async () => {
      const { customer } = await customerWithSubscription(h, mine, { monthlyRate: '400' });
      await runBilling(h);
      const p = payOp(customer.id, '400');
      const [created] = await push([p]);
      expect(created!.status).toBe('APPLIED');
      expect((await balance(h, customer.id)).outstanding).toBe('800.00');

      const del = op('PAYMENT_CANCEL', { customerId: customer.id, paymentOpId: p.opId, reason: 'Wrong customer' });
      const [res] = await push([del]);
      expect(res).toMatchObject({ status: 'APPLIED', result: { status: 'REVERSED', alreadyDone: false } });
      const paymentId = (created!.result as { paymentId: string }).paymentId;
      expect((await payment(paymentId)).status).toBe('REVERSED');
      expect((await balance(h, customer.id)).outstanding).toBe('1200.00');
      // Replay: same answer, nothing more happens.
      const [again] = await push([del]);
      expect(again!.status).toBe('DUPLICATE');

      const alerts = (await h.as(h.superAdminToken).get('/api/v1/system-alerts').expect(200)).body.data as { type: string; message: string; entityId: string }[];
      const alert = alerts.find((a) => a.type === 'PAYMENT_DELETED_BY_AGENT' && a.entityId === paymentId);
      expect(alert?.message).toContain('Ramesh Field deleted the ₹400.00 cash payment');
      expect(alert?.message).toContain('Wrong customer');
      const list = (await h.as(h.superAdminToken).get(`/api/v1/customers/${customer.id}/payments`).expect(200)).body.data;
      expect(list[0]).toMatchObject({ status: 'REVERSED', deletedByAgent: true, correctionNote: 'Deleted by agent: Wrong customer' });
      const all = (await h.as(h.superAdminToken).get(`/api/v1/payments?customerId=${customer.id}`).expect(200)).body.data;
      expect(all[0]).toMatchObject({ deletedByAgent: true });
      const receipt = await h.db.selectFrom('receipts').select('status').where('paymentId', '=', paymentId).executeTakeFirstOrThrow();
      expect(receipt.status).toBe('CANCELLED');
      // The phone shows it as deleted, no longer deletable.
      const row = (await pull()).customers.find((x: { id: string }) => x.id === customer.id);
      expect(row.recentPayments[0]).toMatchObject({ status: 'REVERSED', canDelete: false, note: 'Deleted by agent: Wrong customer' });
      await expectBooksBalance(h);
    });

    it('a payment and its deletion sent together (offline) both apply; an unverified UPI payment is marked failed', async () => {
      const { customer } = await customerWithSubscription(h, mine, { monthlyRate: '400' });
      const p = payOp(customer.id, '400', 'UPI', { reference: `UTR${Date.now()}` });
      const del = op('PAYMENT_CANCEL', { customerId: customer.id, paymentOpId: p.opId, reason: 'Entered twice' });
      const [a, b] = await push([p, del]);
      expect(a!.status).toBe('APPLIED');
      expect(b).toMatchObject({ status: 'APPLIED', result: { status: 'FAILED' } });
      expect((await payment((a!.result as { paymentId: string }).paymentId)).status).toBe('FAILED');
    });

    it('a deletion whose payment was refused does nothing; a deletion arriving before its payment waits', async () => {
      const { customer } = await customerWithSubscription(h, mine, { monthlyRate: '400' });
      const refused = payOp(customer.id, '99999999');
      const del = op('PAYMENT_CANCEL', { customerId: customer.id, paymentOpId: refused.opId, reason: 'Wrong amount' });
      const [a, b] = await push([refused, del]);
      expect(a!.status).toBe('REJECTED');
      expect(b).toMatchObject({ status: 'APPLIED', result: { status: 'NOT_CREATED' } });
      const early = op('PAYMENT_CANCEL', { customerId: customer.id, paymentOpId: randomUUID(), reason: 'Wrong amount' });
      const [c] = await push([early]);
      expect(c!.status).toBe('RETRY');
    });

    it('cash in a handover, or a payment collected by someone else, cannot be deleted by the agent', async () => {
      const { customer } = await customerWithSubscription(h, mine, { monthlyRate: '400' });
      await runBilling(h);
      const p = payOp(customer.id, '100');
      const [created] = await push([p]);
      const ho = await h.as(agent.token).post('/api/v1/cash/handovers', { declaredAmount: '0' }, idem());
      expect(ho.status, JSON.stringify(ho.body)).toBe(201);
      const [res] = await push([op('PAYMENT_CANCEL', { customerId: customer.id, paymentOpId: p.opId, reason: 'Wrong customer' })]);
      expect(res).toMatchObject({ status: 'REJECTED', error: { code: 'PAYMENT_HANDED_OVER' } });
      expect((await payment((created!.result as { paymentId: string }).paymentId)).status).toBe('CONFIRMED');

      const office = await h.as(h.superAdminToken).post('/api/v1/payments', { clientTxnId: randomUUID(), customerId: customer.id, amount: '50', paymentDate: today(), mode: 'CASH' }).expect(201);
      const [byOffice] = await push([op('PAYMENT_CANCEL', { customerId: customer.id, paymentId: office.body.data.id, reason: 'Not mine' })]);
      expect(byOffice).toMatchObject({ status: 'REJECTED', error: { code: 'PAYMENT_NOT_FOUND' } });
    });
  });
});
