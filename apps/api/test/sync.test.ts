import { randomUUID } from 'node:crypto';
import { addDays, businessDateOf } from '@cablenet/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createHarness, Harness } from './support/harness';
import { balance, customerWithSubscription, expectBooksBalance, idem, invoicesOf, pay, runBilling, setupSociety, today } from './support/finance';

interface Outcome {
  opId: string;
  status: string;
  originalStatus?: string;
  flags: string[];
  error?: { code: string; message: string };
  result?: Record<string, unknown> | null;
}

/**
 * Offline sync gate (DEVELOPMENT_ROADMAP Phase 6): airplane-mode collection → reconnect →
 * exactly-once posting; duplicate replay; reassignment while offline; out-of-order operations.
 */
describe('offline sync', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof createAgent>>;
  let other: Awaited<ReturnType<typeof createAgent>>;
  let societyMine: string;
  let societyTheirs: string;
  const c: { id: string }[] = [];
  let seq = 0;

  const newCustomer = async (society: string) => (await customerWithSubscription(h, society, { monthlyRate: '400' })).customer;

  const paymentOp = (customerId: string, amount: string, extra: Partial<{ opId: string; createdAt: string; offline: boolean; payload: Record<string, unknown> }> = {}) => ({
    opId: extra.opId ?? randomUUID(),
    type: 'PAYMENT_CREATE' as const,
    seq: ++seq,
    createdAt: extra.createdAt ?? new Date().toISOString(),
    offline: extra.offline ?? true,
    payload: { customerId, amount, mode: 'CASH', provisionalRef: `P-${agent.code}-${String(seq).padStart(6, '0')}`, visitId: randomUUID(), ...extra.payload },
  });

  const push = async (token: string, ops: object[], deviceTime = new Date().toISOString()) => {
    const res = await h.as(token).post('/api/v1/sync/push', { deviceTime, ops });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as { serverTime: string; clockSkewSeconds: number; results: Outcome[] };
  };

  const pull = async (token: string, etag?: string) => {
    const res = await h.as(token).get(`/api/v1/sync/pull${etag ? `?etag=${encodeURIComponent(etag)}` : ''}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data;
  };

  const paymentsFor = async (customerId: string) =>
    h.db.selectFrom('payments').selectAll().where('customerId', '=', customerId).orderBy('createdAt').execute();

  beforeAll(async () => {
    h = await createHarness();
    agent = await createAgent(h, 'SY1', 'Sync Agent');
    other = await createAgent(h, 'SY2', 'Other Agent');
    societyMine = await setupSociety(h, 'Sync Mine', agent.id);
    societyTheirs = await setupSociety(h, 'Sync Theirs', other.id);
    for (let i = 0; i < 4; i++) c.push(await newCustomer(societyMine));
    c.push(await newCustomer(societyTheirs)); // c[4] belongs to the other agent
    await runBilling(h); // 3 months x 400 = 1200 due each
  });
  afterAll(() => h.close());

  describe('pull', () => {
    it('contains exactly the agent’s customers with what the app shows offline', async () => {
      const snap = await pull(agent.token);
      expect(snap.unchanged).toBe(false);
      expect(snap.customers.map((x: { id: string }) => x.id).sort()).toEqual(c.slice(0, 4).map((x) => x.id).sort());
      const first = snap.customers.find((x: { id: string }) => x.id === c[0]!.id);
      expect(first).toMatchObject({ outstanding: '1200.00', monthlyRate: '400.00', assignment: 'PRIMARY', temporaryUntil: null, status: 'ACTIVE' });
      expect(first.openInvoices).toHaveLength(3);
      expect(first.openInvoices[0]).toMatchObject({ balance: '400.00' });
      expect(snap.agent).toMatchObject({ id: agent.id, code: 'SY1' });
      expect(snap.nextProvisionalSeq).toBe(1);
      expect(snap.staleAfterHours).toBe(12);
      expect(snap.day.expectedToday).toBe('4800.00');
    });

    it('answers "unchanged" for the same etag and a new snapshot after a change', async () => {
      const a = await pull(agent.token);
      const b = await pull(agent.token, a.etag);
      expect(b).toMatchObject({ unchanged: true, etag: a.etag });
      await pay(h, h.superAdminToken, c[3]!.id, '400').expect(201);
      const after = await pull(agent.token, a.etag);
      expect(after.unchanged).toBe(false);
      expect(after.customers.find((x: { id: string }) => x.id === c[3]!.id).outstanding).toBe('800.00');
    });

    it('is for agents only', async () => {
      expect((await h.as(h.superAdminToken).get('/api/v1/sync/pull')).status).toBe(403);
      expect((await h.as(h.superAdminToken).post('/api/v1/sync/push', { deviceTime: new Date().toISOString(), ops: [paymentOp(c[0]!.id, '1')] })).status).toBe(403);
    });
  });

  describe('push', () => {
    it('posts an offline payment once, with receipt, provisional reference and the visit', async () => {
      const op = paymentOp(c[0]!.id, '400');
      const r = (await push(agent.token, [op])).results[0]!;
      expect(r).toMatchObject({ opId: op.opId, status: 'APPLIED', flags: [] });
      expect(r.result).toMatchObject({ status: 'CONFIRMED', provisionalRef: op.payload.provisionalRef, remainingOutstanding: '800.00' });
      expect(r.result!.receiptNumber).toMatch(/^RCPT\//);
      expect((r.result!.allocations as unknown[]).length).toBe(1);

      const [p] = await paymentsFor(c[0]!.id);
      expect(p).toMatchObject({ clientTxnId: op.opId, recordedOffline: true, provisionalRef: op.payload.provisionalRef, collectedBy: agent.id, source: 'AGENT_COLLECTION' });
      const visit = await h.db.selectFrom('visits').selectAll().where('clientId', '=', op.payload.visitId).executeTakeFirstOrThrow();
      expect(visit).toMatchObject({ outcome: 'PARTIAL_PAYMENT', paymentId: p!.id, recordedOffline: true });
      expect((await pull(agent.token)).nextProvisionalSeq).toBeGreaterThan(seq - 1);
    });

    it('replaying the same operation never posts twice and returns the original result', async () => {
      const op = paymentOp(c[1]!.id, '1200');
      const first = (await push(agent.token, [op])).results[0]!;
      // The phone lost the response and sends the batch again, now with a new entry behind it.
      const again = await push(agent.token, [op, paymentOp(c[1]!.id, '50')]);
      expect(again.results[0]).toMatchObject({ status: 'DUPLICATE', originalStatus: 'APPLIED', result: first.result });
      expect(again.results[1]!.status).toBe('APPLIED');
      const rows = await paymentsFor(c[1]!.id);
      expect(rows.map((p) => p.amount)).toEqual(['1200.00', '50.00']);
      expect((await balance(h, c[1]!.id)).advance).toBe('50.00');
    });

    it('simultaneous retries of one operation post exactly once', async () => {
      const op = paymentOp(c[2]!.id, '400');
      const all = await Promise.all([1, 2, 3, 4].map(() => push(agent.token, [op])));
      const statuses = all.map((r) => r.results[0]!.status).sort();
      expect(statuses).toEqual(['APPLIED', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE']);
      const ids = new Set(all.map((r) => (r.results[0]!.result as { paymentId: string }).paymentId));
      expect(ids.size).toBe(1);
      expect((await paymentsFor(c[2]!.id)).filter((p) => p.clientTxnId === op.opId)).toHaveLength(1);
      expect(await h.db.selectFrom('syncOperations').select('opId').where('opId', '=', op.opId).execute()).toHaveLength(1);
    });

    it('applies a batch in device order even when it arrives shuffled', async () => {
      const cust = await newCustomer(societyMine);
      await runBilling(h);
      const tasks = await h.as(agent.token).post(`/api/v1/customers/${cust.id}/follow-ups`, { dueDate: today(), title: 'Call back' }).expect(201);
      const visit = { opId: randomUUID(), type: 'VISIT_CREATE', seq: ++seq, createdAt: new Date().toISOString(), offline: true, payload: { customerId: cust.id, outcome: 'WILL_PAY_LATER', promisedAmount: '400', promisedDate: addDays(today(), 2) } };
      const payment = paymentOp(cust.id, '400');
      const done = { opId: randomUUID(), type: 'FOLLOWUP_DONE', seq: ++seq, createdAt: new Date().toISOString(), offline: true, payload: { followUpId: tasks.body.data.id } };
      const res = await push(agent.token, [done, payment, visit]);
      expect(res.results.map((r) => r.opId)).toEqual([visit.opId, payment.opId, done.opId]);
      expect(res.results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
      // The payment fulfilled the promise made in the earlier visit.
      const promise = await h.db.selectFrom('interactions').selectAll().where('customerId', '=', cust.id).executeTakeFirstOrThrow();
      expect(promise.status).toBe('COMPLETED');
      // Closing an already-closed follow-up is not an error.
      const again = { ...done, opId: randomUUID(), seq: ++seq };
      expect((await push(agent.token, [again])).results[0]).toMatchObject({ status: 'APPLIED', result: { alreadyClosed: true } });
    });

    it('an older payment synced after newer ones still lands on the oldest bill and the books balance', async () => {
      const cust = await newCustomer(societyMine);
      await runBilling(h);
      await pay(h, h.superAdminToken, cust.id, '400').expect(201); // office, today
      const lateAt = new Date(Date.now() - 26 * 3600_000);
      const late = paymentOp(cust.id, '400', { createdAt: lateAt.toISOString() });
      const r = (await push(agent.token, [late])).results[0]!;
      // Still this agent's customer, so no review is needed; the payment keeps its real (earlier) date.
      expect(r).toMatchObject({ status: 'APPLIED', flags: [] });
      expect(r.result).toMatchObject({ paymentDate: businessDateOf(lateAt), remainingOutstanding: '400.00' });
      const inv = await invoicesOf(h, cust.id);
      expect(inv.map((i) => i.status)).toEqual(['PAID', 'PAID', 'UNPAID']);
      await expectBooksBalance(h);
    });

    it('reassignment while offline: the payment is posted, attributed to the collector and queued for review', async () => {
      const cust = await newCustomer(societyMine);
      await runBilling(h);
      expect((await pull(agent.token)).customers.some((x: { id: string }) => x.id === cust.id)).toBe(true);
      const collectedAt = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 20));
      await h.as(h.superAdminToken).post('/api/v1/assignments/permanent', { agentId: other.id, customerIds: [cust.id], reason: 'Route change' }).expect(200);

      const op = paymentOp(cust.id, '1200', { createdAt: collectedAt });
      const r = (await push(agent.token, [op])).results[0]!;
      expect(r).toMatchObject({ status: 'NEEDS_REVIEW', flags: ['REASSIGNED_BEFORE_SYNC'] });
      // Held for the office: recorded against the collector, not yet in the books, and the
      // answer does not reveal the (no longer assigned) customer's balance (security review M-4).
      expect(r.result).toMatchObject({ status: 'PENDING_VERIFICATION', receiptNumber: null, remainingOutstanding: null, remainingAdvance: null });
      const [p] = await paymentsFor(cust.id);
      expect(p).toMatchObject({ collectedBy: agent.id, status: 'PENDING_VERIFICATION', reviewFlags: ['REASSIGNED_BEFORE_SYNC'] });
      expect((await balance(h, cust.id)).outstanding).toBe('1200.00');
      const own = await h.as(agent.token).get(`/api/v1/payments/${p!.id}`).expect(200);
      expect(own.body.data).toMatchObject({ limited: true, customerBalance: null });
      await h.as(h.superAdminToken).post(`/api/v1/payments/${p!.id}/verify`, { note: 'Agent confirmed collection' }, idem()).expect(200);
      expect((await balance(h, cust.id)).outstanding).toBe('0.00');

      // The phone had not synced yet, so the agent collected again after the move: still posted, flagged.
      const after = (await push(agent.token, [paymentOp(cust.id, '25')])).results[0]!;
      expect(after).toMatchObject({ status: 'NEEDS_REVIEW', flags: ['NOT_ASSIGNED_AT_COLLECTION'] });

      // Gone from the agent's next pull, visible to the new agent.
      expect((await pull(agent.token)).customers.some((x: { id: string }) => x.id === cust.id)).toBe(false);
      expect((await pull(other.token)).customers.some((x: { id: string }) => x.id === cust.id)).toBe(true);

      // Office review queue.
      const queue = await h.as(h.superAdminToken).get('/api/v1/sync/review').expect(200);
      const item = (queue.body.data as { opId: string; agentName: string; amount: string; flags: string[] }[]).find((i) => i.opId === op.opId);
      expect(item).toMatchObject({ agentName: 'Sync Agent', amount: '1200.00', flags: ['REASSIGNED_BEFORE_SYNC'] });
      expect((await h.as(agent.token).get('/api/v1/sync/review')).status).toBe(403);
      await h.as(h.superAdminToken).post(`/api/v1/sync/review/${op.opId}`, { note: 'Checked with agent' }).expect(200);
      const open = await h.as(h.superAdminToken).get('/api/v1/sync/review').expect(200);
      expect((open.body.data as { opId: string }[]).some((i) => i.opId === op.opId)).toBe(false);
      expect((await h.as(h.superAdminToken).post(`/api/v1/sync/review/${op.opId}`, {})).status).toBe(409);
    });

    it('a customer the agent never had is rejected, nothing is posted, and replays say the same', async () => {
      const op = paymentOp(c[4]!.id, '400');
      const r = (await push(agent.token, [op])).results[0]!;
      expect(r).toMatchObject({ status: 'REJECTED', error: { code: 'CUSTOMER_NOT_ASSIGNED' } });
      expect(await paymentsFor(c[4]!.id)).toHaveLength(0);
      expect((await push(agent.token, [op])).results[0]).toMatchObject({ status: 'DUPLICATE', originalStatus: 'REJECTED', error: { code: 'CUSTOMER_NOT_ASSIGNED' } });
      const queue = await h.as(h.superAdminToken).get('/api/v1/sync/review').expect(200);
      expect((queue.body.data as { opId: string; status: string }[]).find((i) => i.opId === op.opId)?.status).toBe('REJECTED');
    });

    it('invalid entries are rejected one by one without blocking the rest of the batch', async () => {
      const bad = paymentOp(c[3]!.id, '0');
      const tooBig = paymentOp(c[3]!.id, '500000');
      const noRef = paymentOp(c[3]!.id, '100', { payload: { mode: 'UPI' } });
      const good = paymentOp(c[3]!.id, '100');
      const res = await push(agent.token, [bad, tooBig, noRef, good]);
      expect(res.results.map((r) => r.status)).toEqual(['REJECTED', 'REJECTED', 'REJECTED', 'APPLIED']);
      expect(res.results.map((r) => r.error?.code)).toEqual(['VALIDATION_FAILED', 'AMOUNT_TOO_LARGE', 'VALIDATION_FAILED', undefined]);
    });

    it('a phone clock that is days off is corrected and flagged', async () => {
      const cust = await newCustomer(societyMine);
      await runBilling(h);
      const threeDays = 3 * 24 * 3600_000;
      const phoneNow = Date.now() - threeDays;
      const op = paymentOp(cust.id, '400', { createdAt: new Date(phoneNow).toISOString() });
      const res = await push(agent.token, [op], new Date(phoneNow).toISOString());
      expect(res.clockSkewSeconds).toBeGreaterThan(3 * 24 * 3600 - 60);
      expect(res.results[0]).toMatchObject({ status: 'NEEDS_REVIEW', flags: ['CLOCK_SKEW'], result: { paymentDate: today() } });
      const row = await h.db.selectFrom('syncOperations').selectAll().where('opId', '=', op.opId).executeTakeFirstOrThrow();
      expect(Math.abs(row.effectiveAt.getTime() - Date.now())).toBeLessThan(30_000);
    });

    it('a second identical cash entry around the same time is posted but flagged as a possible duplicate', async () => {
      const cust = await newCustomer(societyMine);
      await runBilling(h);
      await push(agent.token, [paymentOp(cust.id, '400')]);
      const r = (await push(agent.token, [paymentOp(cust.id, '400')])).results[0]!;
      expect(r).toMatchObject({ status: 'NEEDS_REVIEW', flags: ['POSSIBLE_DUPLICATE'] });
      expect(await paymentsFor(cust.id)).toHaveLength(2);
    });

    it('another user cannot replay or read an operation id', async () => {
      const op = paymentOp(c[0]!.id, '10');
      await push(agent.token, [op]);
      const r = (await push(other.token, [{ ...op, payload: { ...op.payload, customerId: c[4]!.id } }])).results[0]!;
      expect(r).toMatchObject({ status: 'REJECTED', error: { code: 'OP_ID_CONFLICT' } });
      expect(r.result).toBeUndefined();
    });

    it('the stored history cannot be edited, only reviewed', async () => {
      const row = await h.db.selectFrom('syncOperations').select('opId').limit(1).executeTakeFirstOrThrow();
      await expect(h.db.updateTable('syncOperations').set({ status: 'REJECTED' }).where('opId', '=', row.opId).execute()).rejects.toThrow(/immutable/);
      await expect(h.db.deleteFrom('syncOperations').where('opId', '=', row.opId).execute()).rejects.toThrow();
      await expectBooksBalance(h);
    });
  });
});
