import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { addDays } from '@cablenet/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createHarness, Harness } from './support/harness';
import {
  balance,
  customerWithSubscription,
  expectBooksBalance,
  idem,
  invoicesOf,
  monthStart,
  pay,
  reconcile,
  runBilling,
  setupSociety,
  today,
} from './support/finance';

describe('payments, allocation and corrections', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof createAgent>>;
  let other: Awaited<ReturnType<typeof createAgent>>;
  let society: string;

  beforeAll(async () => {
    h = await createHarness();
    agent = await createAgent(h, 'PAY1', 'Field Agent');
    other = await createAgent(h, 'PAY2', 'Other Agent');
    society = await setupSociety(h, 'Payments Society', agent.id);
  });
  afterAll(() => h.close());

  it('E1: ₹1,000 against three ₹500 months settles the two oldest; receipt shows the allocation', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '500' });
    await runBilling(h);
    const res = await pay(h, agent.token, customer.id, '1000');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const p = res.body.data;
    expect(p).toMatchObject({ status: 'CONFIRMED', source: 'AGENT_COLLECTION', unallocated: '0.00', replayed: false });
    expect(p.receipt.receiptNumber).toMatch(/^RCPT\/\d{4}-\d{2}\/\d{6}$/);
    expect(p.receipt.snapshot).toMatchObject({
      previousOutstanding: '1500.00',
      remainingOutstanding: '500.00',
      remainingAdvance: '0.00',
      advanceCreated: '0.00',
      payment: { amount: '1000.00', collectedBy: 'Field Agent', mode: 'CASH' },
    });
    expect(p.receipt.snapshot.allocations.map((a: { amount: string }) => a.amount)).toEqual(['500.00', '500.00']);

    const inv = await invoicesOf(h, customer.id);
    expect(inv.map((i) => i.status)).toEqual(['PAID', 'PAID', 'UNPAID']);
    expect(await balance(h, customer.id, agent.token)).toMatchObject({ outstanding: '500.00', advance: '0.00' });
  });

  it('E2: overpayment becomes advance and is used automatically by the next bill', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '500', startDate: monthStart(0) });
    await runBilling(h);
    const res = await pay(h, h.superAdminToken, customer.id, '2000').expect(201);
    expect(res.body.data).toMatchObject({ source: 'ADMIN_COLLECTION', unallocated: '1500.00' });
    expect(res.body.data.receipt.snapshot).toMatchObject({ advanceCreated: '1500.00', remainingAdvance: '1500.00' });

    await runBilling(h, monthStart(1));
    const inv = await invoicesOf(h, customer.id);
    expect(inv.map((i) => [i.periodStart, i.status])).toEqual([
      [monthStart(0), 'PAID'],
      [monthStart(1), 'PAID'],
    ]);
    expect(await balance(h, customer.id)).toMatchObject({ outstanding: '0.00', advance: '1000.00' });
  });

  it('E3: several partial payments against one quarterly invoice', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '500', billingIntervalMonths: 3, startDate: monthStart(0) });
    await runBilling(h);
    await pay(h, agent.token, customer.id, '600').expect(201);
    expect((await invoicesOf(h, customer.id))[0]).toMatchObject({ amountPaid: '600.00', status: 'PARTIALLY_PAID' });
    await pay(h, agent.token, customer.id, '900').expect(201);
    expect((await invoicesOf(h, customer.id))[0]).toMatchObject({ amountPaid: '1500.00', status: 'PAID' });
  });

  it('E4 (workbook guide): ₹1,800 in month 3 clears months 1–3 at ₹600', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '600' });
    await runBilling(h);
    await pay(h, h.superAdminToken, customer.id, '1800').expect(201);
    expect((await invoicesOf(h, customer.id)).every((i) => i.status === 'PAID')).toBe(true);
    expect(await balance(h, customer.id)).toMatchObject({ balance: '0.00' });
  });

  it('a retried request with the same clientTxnId never posts twice, even when sent concurrently', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400' });
    await runBilling(h);
    const body = { clientTxnId: randomUUID(), customerId: customer.id, amount: '400', paymentDate: today(), mode: 'CASH' };
    const results = await Promise.all(Array.from({ length: 5 }, () => h.as(agent.token).post('/api/v1/payments', body)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(results.filter((r) => r.body.data.replayed === false)).toHaveLength(1);
    const rows = await h.db.selectFrom('ledgerEntries').select('id').where('customerId', '=', customer.id).where('type', '=', 'PAYMENT').execute();
    expect(rows).toHaveLength(1);

    const conflictRes = await h.as(agent.token).post('/api/v1/payments', { ...body, amount: '500' });
    expect(conflictRes.body.error.code).toBe('CLIENT_TXN_ID_CONFLICT');
  });

  it('flags a second identical payment within minutes as a possible duplicate (but keeps it)', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400' });
    await pay(h, agent.token, customer.id, '400').expect(201);
    const second = await pay(h, agent.token, customer.id, '400').expect(201);
    expect(second.body.data.reviewFlags).toEqual(['POSSIBLE_DUPLICATE']);
    const alerts = await h.as(h.superAdminToken).get('/api/v1/system-alerts').expect(200);
    expect(alerts.body.data.map((a: { entityId: string }) => a.entityId)).toContain(second.body.data.id);
  });

  it('agents can only collect from customers assigned to them, and not with future or old dates', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400' });
    expect((await pay(h, other.token, customer.id, '400')).status).toBe(404);
    expect((await pay(h, agent.token, customer.id, '400', { paymentDate: addDays(today(), 1) })).body.error.code).toBe('PAYMENT_DATE_IN_FUTURE');
    expect((await pay(h, agent.token, customer.id, '400', { paymentDate: addDays(today(), -30) })).body.error.code).toBe('PAYMENT_DATE_TOO_OLD');
    expect((await pay(h, agent.token, customer.id, '0.10', { amount: 0.1 })).status).toBe(400); // floats rejected
    expect((await pay(h, agent.token, customer.id, '1000000')).body.error.code).toBe('AMOUNT_TOO_LARGE');

    // Temporary cover: the covering agent may collect; the original agent may not.
    await h
      .as(h.superAdminToken)
      .post('/api/v1/assignments/temporary', {
        fromAgentId: agent.id,
        toAgentId: other.id,
        scope: 'CUSTOMERS',
        customerIds: [customer.id],
        startsOn: today(),
        endsOn: today(),
        reason: 'Agent on leave',
      })
      .expect(201);
    expect((await pay(h, other.token, customer.id, '400')).status).toBe(201);
    expect((await pay(h, agent.token, customer.id, '400')).status).toBe(404);
  });

  it('agent UPI is pending until the office verifies it; pending money does not reduce the balance', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400', startDate: monthStart(0) });
    await runBilling(h);
    const noRef = await pay(h, agent.token, customer.id, '400', { mode: 'UPI' });
    expect(noRef.status).toBe(400);
    const res = await pay(h, agent.token, customer.id, '400', { mode: 'UPI', reference: 'UTR123456789' }).expect(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING_VERIFICATION', receipt: null });
    const b = await balance(h, customer.id);
    expect(b).toMatchObject({ outstanding: '400.00' });
    expect(b.pendingVerification).toHaveLength(1);

    const dupRef = await pay(h, h.superAdminToken, customer.id, '400', { mode: 'UPI', reference: 'utr123456789' });
    expect(dupRef.body.error.code).toBe('DUPLICATE_REFERENCE');
    expect((await h.as(agent.token).post(`/api/v1/payments/${res.body.data.id}/verify`, {}, idem())).status).toBe(403);

    const verified = await h.as(h.superAdminToken).post(`/api/v1/payments/${res.body.data.id}/verify`, { note: 'Seen in bank statement' }, idem()).expect(200);
    expect(verified.body.data).toMatchObject({ status: 'CONFIRMED', unallocated: '0.00' });
    expect(verified.body.data.receipt.receiptNumber).toMatch(/^RCPT\//);
    expect(await balance(h, customer.id)).toMatchObject({ outstanding: '0.00' });
    const notifications = await h.as(agent.token).get('/api/v1/notifications').expect(200);
    expect(notifications.body.data.map((n: { type: string }) => n.type)).toContain('PAYMENT_VERIFIED');
  });

  it('a bounced cheque is marked failed and never touches the ledger', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400', startDate: monthStart(0) });
    const res = await pay(h, h.superAdminToken, customer.id, '400', { mode: 'CHEQUE', reference: 'CHQ-000123' }).expect(201);
    expect(res.body.data.status).toBe('PENDING_VERIFICATION');
    await h.as(h.superAdminToken).post(`/api/v1/payments/${res.body.data.id}/fail`, { reason: 'Cheque bounced' }, idem()).expect(200);
    const entries = await h.db.selectFrom('ledgerEntries').select('id').where('paymentId', '=', res.body.data.id).execute();
    expect(entries).toEqual([]);
    // The cheque number can be reused for a re-presented cheque once the first failed.
    await pay(h, h.superAdminToken, customer.id, '400', { mode: 'CHEQUE', reference: 'CHQ-000123' }).expect(201);
  });

  it('reversal: invoices reopen, the receipt is cancelled, and FIFO re-applies remaining credit', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '500' });
    await runBilling(h);
    const wrong = await pay(h, agent.token, customer.id, '1000').expect(201);
    const later = await pay(h, h.superAdminToken, customer.id, '700').expect(201);
    expect(await balance(h, customer.id)).toMatchObject({ outstanding: '0.00', advance: '200.00' });

    expect((await h.as(agent.token).post(`/api/v1/payments/${wrong.body.data.id}/reverse`, { reason: 'Entered twice' }, idem())).status).toBe(403);
    const rev = await h
      .as(h.superAdminToken)
      .post(`/api/v1/payments/${wrong.body.data.id}/reverse`, { reason: 'Entered for the wrong customer' }, idem())
      .expect(200);
    expect(rev.body.data).toMatchObject({ status: 'REVERSED' });
    expect(rev.body.data.receipt.status).toBe('CANCELLED');

    // The ₹700 payment now covers the oldest month fully and ₹200 of the next.
    const inv = await invoicesOf(h, customer.id);
    expect(inv.map((i) => [i.amountPaid, i.status])).toEqual([
      ['500.00', 'PAID'],
      ['200.00', 'PARTIALLY_PAID'],
      ['0.00', 'UNPAID'],
    ]);
    expect(await balance(h, customer.id)).toMatchObject({ outstanding: '800.00', advance: '0.00' });
    const laterDetail = await h.as(h.superAdminToken).get(`/api/v1/payments/${later.body.data.id}`).expect(200);
    expect(laterDetail.body.data.unallocated).toBe('0.00');

    const again = await h.as(h.superAdminToken).post(`/api/v1/payments/${wrong.body.data.id}/reverse`, { reason: 'again' }, idem());
    expect(again.body.error.code).toBe('PAYMENT_NOT_CONFIRMED');

    const ledger = await h.as(h.superAdminToken).get(`/api/v1/customers/${customer.id}/ledger`).expect(200);
    expect(ledger.body.data.entries.map((e: { type: string }) => e.type)).toEqual(['CHARGE', 'CHARGE', 'CHARGE', 'PAYMENT', 'PAYMENT', 'REVERSAL']);
    expect(ledger.body.data.entries.at(-1).runningBalance).toBe('800.00');
  });

  it('concurrent payments for one customer stay consistent (row lock serialises them)', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '300', startDate: monthStart(-5) });
    await runBilling(h); // 6 months x 300 = 1800
    const results = await Promise.all(Array.from({ length: 12 }, () => pay(h, h.superAdminToken, customer.id, '200')));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await balance(h, customer.id)).toMatchObject({ outstanding: '0.00', advance: '600.00' });
    expect((await invoicesOf(h, customer.id)).every((i) => i.status === 'PAID')).toBe(true);
    const receipts = new Set(results.map((r) => r.body.data.receipt.receiptNumber));
    expect(receipts.size).toBe(12);
  });

  it('agents see only payments they collected; admins see all, with totals', async () => {
    const mine = await h.as(agent.token).get('/api/v1/payments?pageSize=100').expect(200);
    expect(mine.body.data.every((p: { collectedBy: string }) => p.collectedBy === agent.id)).toBe(true);
    const all = await h.as(h.superAdminToken).get(`/api/v1/payments?collectedBy=${agent.id}&status=CONFIRMED`).expect(200);
    expect(all.body.meta.totalAmount).toMatch(/^\d+\.\d{2}$/);
    // A payment collected by the covering agent for a customer that is no longer the agent's.
    const othersPayment = await h.db.selectFrom('payments').select('id').where('collectedBy', '=', other.id).executeTakeFirstOrThrow();
    expect((await h.as(agent.token).get(`/api/v1/payments/${othersPayment.id}`)).status).toBe(404);
  });

  it('receipts can be reissued (new number, old one cancelled, same figures)', async () => {
    const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400', startDate: monthStart(0) });
    await runBilling(h);
    const p = await pay(h, agent.token, customer.id, '400').expect(201);
    const old = p.body.data.receipt;
    const re = await h.as(h.superAdminToken).post(`/api/v1/receipts/${old.id}/reissue`, { reason: 'Customer lost the copy' }, idem()).expect(201);
    expect(re.body.data.receiptNumber).not.toBe(old.receiptNumber);
    expect(re.body.data.snapshot).toMatchObject({ reissueOf: old.receiptNumber, previousOutstanding: '400.00', remainingOutstanding: '0.00' });
    const oldNow = await h.as(h.superAdminToken).get(`/api/v1/receipts/${old.id}`).expect(200);
    expect(oldNow.body.data.status).toBe('CANCELLED');
    await expect(sql`UPDATE receipts SET snapshot = '{}'::jsonb WHERE id = ${old.id}`.execute(h.db)).rejects.toThrow(/immutable/);
  });

  it('financial history cannot be edited or deleted in the database', async () => {
    const p = await h.db.selectFrom('payments').select('id').where('status', '=', 'CONFIRMED').executeTakeFirstOrThrow();
    await expect(sql`UPDATE payments SET amount = 1 WHERE id = ${p.id}`.execute(h.db)).rejects.toThrow(/immutable/);
    await expect(sql`DELETE FROM payments WHERE id = ${p.id}`.execute(h.db)).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE ledger_entries SET amount = 1`.execute(h.db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM allocations`.execute(h.db)).rejects.toThrow(/append-only/);
  });

  it('the books balance; tampering is detected by reconciliation', async () => {
    await expectBooksBalance(h);
    // Simulate a bug: an allocation written without updating the invoice cache.
    const inv = await h.db.selectFrom('invoices').select(['id', 'customerId']).where('status', '=', 'UNPAID').executeTakeFirstOrThrow();
    const cred = await h.db.selectFrom('payments').select('id').where('customerId', '=', inv.customerId).where('status', '=', 'CONFIRMED').executeTakeFirst();
    const credId = cred?.id ?? (await h.db.selectFrom('payments').select('id').where('status', '=', 'CONFIRMED').executeTakeFirstOrThrow()).id;
    await h.db.insertInto('allocations').values({ customerId: inv.customerId, paymentId: credId, invoiceId: inv.id, amount: '1.00' }).execute();
    const r = await reconcile(h);
    expect(r.invoiceCacheMismatches.length).toBeGreaterThan(0);
  });
});
