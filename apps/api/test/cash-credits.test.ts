import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createHarness, Harness, login, nextMobile, PASSWORD } from './support/harness';
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

describe('cash handover, credits, refunds, opening balances, idempotency', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof createAgent>>;
  let society: string;
  let admin: string;

  beforeAll(async () => {
    h = await createHarness();
    agent = await createAgent(h, 'CASH1', 'Cash Agent');
    society = await setupSociety(h, 'Cash Society', agent.id);
    const mobile = nextMobile();
    await h
      .as(h.superAdminToken)
      .post('/api/v1/users', { fullName: 'Office Admin', mobile, role: 'ADMIN', temporaryPassword: 'Temp1234' })
      .expect(201);
    const temp = await login(h.http, mobile, 'Temp1234');
    await h.as(temp).post('/api/v1/auth/change-password', { currentPassword: 'Temp1234', newPassword: PASSWORD }).expect(204);
    admin = await login(h.http, mobile, PASSWORD);
  });
  afterAll(() => h.close());

  describe('cash handover and reconciliation', () => {
    let handoverId: string;

    it('cash in hand counts only cash; UPI never enters it', async () => {
      const a = await customerWithSubscription(h, society, { monthlyRate: '400', startDate: monthStart(0) });
      const b = await customerWithSubscription(h, society, { monthlyRate: '300', startDate: monthStart(0) });
      await runBilling(h);
      await pay(h, agent.token, a.customer.id, '400').expect(201);
      await pay(h, agent.token, b.customer.id, '300').expect(201);
      await pay(h, agent.token, b.customer.id, '250', { mode: 'UPI', reference: 'UTR-CASH-TEST-1' }).expect(201);

      const me = await h.as(agent.token).get('/api/v1/cash/me').expect(200);
      expect(me.body.data).toMatchObject({
        cashInHand: '700.00',
        cashNotYetHandedOver: '700.00',
        paymentsNotYetHandedOver: 2,
        day: { date: today(), cashCollected: '700.00', upiCollected: '0.00', pendingVerification: '250.00', payments: 3 },
      });
    });

    it('agent submits a handover; a second one waits until the first is settled', async () => {
      const res = await h.as(agent.token).post('/api/v1/cash/handovers', { declaredAmount: '700' }, idem());
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ expectedAmount: '700.00', declaredAmount: '700.00', status: 'SUBMITTED', paymentCount: 2 });
      handoverId = res.body.data.id;
      const again = await h.as(agent.token).post('/api/v1/cash/handovers', { declaredAmount: '0' }, idem());
      expect(again.body.error.code).toBe('HANDOVER_PENDING');
      const admins = await h.as(admin).get('/api/v1/notifications').expect(200);
      expect(admins.body.data.map((n: { type: string }) => n.type)).toContain('CASH_HANDOVER_SUBMITTED');
    });

    it('a cash payment inside a pending handover cannot be reversed', async () => {
      const item = await h.as(admin).get(`/api/v1/cash/handovers/${handoverId}`).expect(200);
      const res = await h.as(admin).post(`/api/v1/payments/${item.body.data.items[0].paymentId}/reverse`, { reason: 'test' }, idem());
      expect(res.body.error.code).toBe('PAYMENT_IN_PENDING_HANDOVER');
    });

    it('a short handover needs a reason, is recorded with the difference, and leaves the shortage on the agent', async () => {
      const noReason = await h.as(admin).post(`/api/v1/cash/handovers/${handoverId}/confirm`, { receivedAmount: '650' }, idem());
      expect(noReason.body.error.code).toBe('MISMATCH_REASON_REQUIRED');
      const res = await h
        .as(admin)
        .post(`/api/v1/cash/handovers/${handoverId}/confirm`, { receivedAmount: '650', mismatchReason: 'Agent says ₹50 note missing' }, idem())
        .expect(200);
      expect(res.body.data).toMatchObject({ status: 'CONFIRMED', receivedAmount: '650.00', difference: '-50.00' });

      const summary = await h.as(admin).get(`/api/v1/cash/agents/${agent.id}`).expect(200);
      expect(summary.body.data).toMatchObject({ cashInHand: '50.00', cashNotYetHandedOver: '0.00' });
      const alerts = await h.as(admin).get('/api/v1/system-alerts').expect(200);
      expect(alerts.body.data.map((a: { type: string }) => a.type)).toContain('CASH_MISMATCH');

      await h.as(admin).post('/api/v1/cash/adjustments', { agentId: agent.id, amount: '50', kind: 'RECOVERY', reason: 'Agent paid the ₹50' }, idem()).expect(201);
      expect((await h.as(agent.token).get('/api/v1/cash/me').expect(200)).body.data.cashInHand).toBe('0.00');
    });

    it('a rejected handover puts its payments back into "not yet handed over"', async () => {
      const c = await customerWithSubscription(h, society, { monthlyRate: '200', startDate: monthStart(0) });
      await pay(h, agent.token, c.customer.id, '200').expect(201);
      const sub = await h.as(agent.token).post('/api/v1/cash/handovers', { declaredAmount: '200' }, idem()).expect(201);
      await h.as(admin).post(`/api/v1/cash/handovers/${sub.body.data.id}/reject`, { reason: 'Counted with the wrong bundle' }, idem()).expect(200);
      const me = await h.as(agent.token).get('/api/v1/cash/me').expect(200);
      expect(me.body.data).toMatchObject({ cashInHand: '200.00', cashNotYetHandedOver: '200.00', paymentsNotYetHandedOver: 1 });
      const list = await h.as(agent.token).get('/api/v1/cash/handovers').expect(200);
      expect(list.body.data.map((x: { status: string }) => x.status)).toEqual(['REJECTED', 'CONFIRMED']);
    });

    it('agents cannot confirm handovers or see other agents’ cash', async () => {
      expect((await h.as(agent.token).post(`/api/v1/cash/handovers/${handoverId}/confirm`, { receivedAmount: '0' }, idem())).status).toBe(403);
      expect((await h.as(agent.token).get('/api/v1/cash/agents')).status).toBe(403);
    });
  });

  describe('credits, debits, refunds', () => {
    it('a targeted discount settles its own invoice; admins are limited, super admin is not', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '500' });
      await runBilling(h);
      const inv = await invoicesOf(h, customer.id);
      const res = await h
        .as(admin)
        .post(`/api/v1/customers/${customer.id}/credits`, { kind: 'DISCOUNT', amount: '100', targetInvoiceId: inv[2]!.id, reason: 'Festival offer' }, idem());
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const after = await invoicesOf(h, customer.id);
      expect(after.map((i) => i.amountPaid)).toEqual(['0.00', '0.00', '100.00']);
      expect(await balance(h, customer.id)).toMatchObject({ outstanding: '1400.00' });

      const big = await h.as(admin).post(`/api/v1/customers/${customer.id}/credits`, { kind: 'CREDIT_ADJUSTMENT', amount: '5000', reason: 'Goodwill' }, idem());
      expect(big.body.error.code).toBe('APPROVAL_REQUIRED');
      await h
        .as(h.superAdminToken)
        .post(`/api/v1/customers/${customer.id}/credits`, { kind: 'CREDIT_ADJUSTMENT', amount: '1600', reason: 'Service outage compensation' }, idem())
        .expect(201);
      expect(await balance(h, customer.id)).toMatchObject({ outstanding: '0.00', advance: '200.00' });
    });

    it('a debit adjustment is a separate bill, and existing advance pays it at once', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '300', startDate: monthStart(0) });
      await runBilling(h);
      await pay(h, h.superAdminToken, customer.id, '500').expect(201);
      const res = await h
        .as(admin)
        .post(`/api/v1/customers/${customer.id}/debits`, { amount: '150', description: 'Reconnection fee', reason: 'Reconnected after cut' }, idem())
        .expect(201);
      expect(res.body.data).toMatchObject({ kind: 'DEBIT_ADJUSTMENT', total: '150.00' });
      expect(await balance(h, customer.id)).toMatchObject({ outstanding: '0.00', advance: '50.00' });
    });

    it('refunds only from available advance', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '300', startDate: monthStart(0) });
      await runBilling(h);
      await pay(h, h.superAdminToken, customer.id, '1000').expect(201);
      const tooMuch = await h.as(admin).post(`/api/v1/customers/${customer.id}/refunds`, { amount: '800', mode: 'CASH', reason: 'Leaving area' }, idem());
      expect(tooMuch.body.error.code).toBe('INSUFFICIENT_ADVANCE');
      await h.as(admin).post(`/api/v1/customers/${customer.id}/refunds`, { amount: '700', mode: 'CASH', reason: 'Leaving area' }, idem()).expect(201);
      expect(await balance(h, customer.id)).toMatchObject({ balance: '0.00' });
      const pmt = await h.db.selectFrom('payments').select('id').where('customerId', '=', customer.id).executeTakeFirstOrThrow();
      const rev = await h.as(h.superAdminToken).post(`/api/v1/payments/${pmt.id}/reverse`, { reason: 'test' }, idem());
      expect(rev.body.error.code).toBe('PAYMENT_REFUNDED');
    });

    it('opening balance due is settled before any month (oldest debt first), once per customer', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400', startDate: monthStart(0) });
      await runBilling(h);
      await h
        .as(admin)
        .post(`/api/v1/customers/${customer.id}/opening-balance`, { amount: '600', asOf: monthStart(-1), reason: 'Brought forward from Excel' }, idem())
        .expect(201);
      await pay(h, h.superAdminToken, customer.id, '700').expect(201);
      const inv = await invoicesOf(h, customer.id);
      const opening = inv.find((i) => i.kind === 'OPENING_BALANCE')!;
      const month = inv.find((i) => i.kind === 'SUBSCRIPTION')!;
      expect(opening).toMatchObject({ amountPaid: '600.00', status: 'PAID' });
      expect(month).toMatchObject({ amountPaid: '100.00', status: 'PARTIALLY_PAID' });
      const again = await h.as(admin).post(`/api/v1/customers/${customer.id}/opening-balance`, { amount: '-50', asOf: today(), reason: 'again' }, idem());
      expect(again.body.error.code).toBe('OPENING_BALANCE_EXISTS');
    });

    it('opening advance is used by the next bill', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400', startDate: monthStart(1) });
      await h
        .as(admin)
        .post(`/api/v1/customers/${customer.id}/opening-balance`, { amount: '-1000', asOf: today(), reason: 'Advance from Excel' }, idem())
        .expect(201);
      await runBilling(h, monthStart(1));
      expect((await invoicesOf(h, customer.id))[0]).toMatchObject({ status: 'PAID' });
      expect(await balance(h, customer.id)).toMatchObject({ advance: '600.00' });
    });

    it('reversing a discount re-opens what it paid', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '200', startDate: monthStart(0) });
      await runBilling(h);
      const credit = await h
        .as(admin)
        .post(`/api/v1/customers/${customer.id}/credits`, { kind: 'DISCOUNT', amount: '200', reason: 'Wrongly granted' }, idem())
        .expect(201);
      expect(await balance(h, customer.id)).toMatchObject({ outstanding: '0.00' });
      await h.as(admin).post(`/api/v1/credits/${credit.body.data.id}/reverse`, { reason: 'Not eligible' }, idem()).expect(200);
      expect(await balance(h, customer.id)).toMatchObject({ outstanding: '200.00' });
    });
  });

  describe('Idempotency-Key on financial commands', () => {
    it('is required, replays the stored result, and rejects reuse with a different body', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '100', startDate: monthStart(0) });
      const url = `/api/v1/customers/${customer.id}/debits`;
      const body = { amount: '50', description: 'Cable repair', reason: 'Visit charge' };
      const missing = await h.as(admin).post(url, body);
      expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

      const key = { 'Idempotency-Key': randomUUID() };
      const first = await h.as(admin).post(url, body, key).expect(201);
      const replay = await h.as(admin).post(url, body, key).expect(201);
      expect(replay.body.data.id).toBe(first.body.data.id);
      const debits = await h.db.selectFrom('invoices').select('id').where('customerId', '=', customer.id).where('kind', '=', 'DEBIT_ADJUSTMENT').execute();
      expect(debits).toHaveLength(1);

      const reused = await h.as(admin).post(url, { ...body, amount: '60' }, key);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('a failed request releases its key so the client can retry', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '100', startDate: monthStart(0) });
      const key = { 'Idempotency-Key': randomUUID() };
      const url = `/api/v1/customers/${customer.id}/refunds`;
      const fail = await h.as(admin).post(url, { amount: '10', mode: 'CASH', reason: 'No advance yet' }, key);
      expect(fail.body.error.code).toBe('INSUFFICIENT_ADVANCE');
      await pay(h, h.superAdminToken, customer.id, '10').expect(201);
      await h.as(admin).post(url, { amount: '10', mode: 'CASH', reason: 'No advance yet' }, key).expect(201);
    });
  });

  it('customer list shows balances and filters/sorts by outstanding', async () => {
    const res = await h.as(h.superAdminToken).get('/api/v1/customers?balance=OUTSTANDING&sort=-outstanding&pageSize=100').expect(200);
    const amounts = res.body.data.map((c: { outstanding: string }) => Number(c.outstanding));
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts.every((a: number) => a > 0)).toBe(true);
    expect([...amounts].sort((x, y) => y - x)).toEqual(amounts);
    const min = await h.as(h.superAdminToken).get('/api/v1/customers?minOutstanding=1000').expect(200);
    expect(min.body.data.every((c: { outstanding: string }) => Number(c.outstanding) >= 1000)).toBe(true);
    const adv = await h.as(h.superAdminToken).get('/api/v1/customers?balance=ADVANCE').expect(200);
    expect(adv.body.data.every((c: { advance: string }) => Number(c.advance) > 0)).toBe(true);
  });

  it('the books balance', async () => {
    await expectBooksBalance(h);
  });
});
