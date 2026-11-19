import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { addDays } from '@cablenet/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createHarness, Harness } from './support/harness';
import { customerWithSubscription, idem, monthStart, pay, runBilling, setupSociety, today } from './support/finance';

/** supertest parser that keeps binary bodies (xlsx/pdf) as a Buffer. */
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('dashboard, reports, field operations', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof createAgent>>;
  let other: Awaited<ReturnType<typeof createAgent>>;
  let society: string;
  let customers: { id: string }[] = [];

  beforeAll(async () => {
    h = await createHarness();
    agent = await createAgent(h, 'REP1', 'Report Agent');
    other = await createAgent(h, 'REP2', 'Other Agent');
    society = await setupSociety(h, 'Report Society', agent.id);
    const otherSociety = await setupSociety(h, 'Other Society', other.id);
    for (const [s, rate] of [
      [society, '400'],
      [society, '300'],
      [society, '500'],
      [otherSociety, '250'],
    ] as const) {
      customers.push((await customerWithSubscription(h, s, { monthlyRate: rate })).customer);
    }
    await runBilling(h);
    await pay(h, agent.token, customers[0]!.id, '1200').expect(201); // fully paid
    await pay(h, agent.token, customers[1]!.id, '500').expect(201); // partial
    await pay(h, agent.token, customers[2]!.id, '200', { mode: 'UPI', reference: 'UTR-REP-1' }).expect(201); // pending
    await pay(h, other.token, customers[3]!.id, '1000').expect(201); // advance 250
  });
  afterAll(() => h.close());

  describe('field operations', () => {
    it('a visit with a promise creates a promise-to-pay and a follow-up for the agent', async () => {
      const clientId = randomUUID();
      const body = { clientId, outcome: 'WILL_PAY_LATER', promisedAmount: '900', promisedDate: addDays(today(), 3), notes: 'Salary on 21st' };
      const res = await h.as(agent.token).post(`/api/v1/customers/${customers[2]!.id}/visits`, body).expect(201);
      expect(res.body.data.replayed).toBe(false);
      const replay = await h.as(agent.token).post(`/api/v1/customers/${customers[2]!.id}/visits`, body).expect(201);
      expect(replay.body.data).toMatchObject({ id: res.body.data.id, replayed: true });

      const tasks = await h.as(agent.token).get('/api/v1/follow-ups').expect(200);
      expect(tasks.body.data.map((t: { customerId: string }) => t.customerId)).toContain(customers[2]!.id);
      const theirs = await h.as(other.token).get('/api/v1/follow-ups?scope=all').expect(200);
      expect(theirs.body.data).toEqual([]);

      const promises = await h.as(h.superAdminToken).get(`/api/v1/interactions?customerId=${customers[2]!.id}`).expect(200);
      expect(promises.body.data[0]).toMatchObject({ status: 'PROMISE_TO_PAY', expectedAmount: '900.00', channel: 'VISIT' });
    });

    it('an agent cannot record a visit for another agent’s customer; outcome rules are validated', async () => {
      expect((await h.as(other.token).post(`/api/v1/customers/${customers[0]!.id}/visits`, { clientId: randomUUID(), outcome: 'NOT_AVAILABLE' })).status).toBe(404);
      const noPayment = await h.as(agent.token).post(`/api/v1/customers/${customers[0]!.id}/visits`, { clientId: randomUUID(), outcome: 'PAYMENT_COLLECTED' });
      expect(noPayment.status).toBe(400);
    });

    it('a confirmed payment completes the open promise and closes its follow-up', async () => {
      const ia = await h
        .as(h.superAdminToken)
        .post(`/api/v1/customers/${customers[1]!.id}/interactions`, {
          channel: 'CALL',
          interactionType: 'PAYMENT_PROMISE',
          expectedAmount: '400',
          promiseDate: addDays(today(), 2),
          notes: 'Will pay on Friday',
        })
        .expect(201);
      expect(ia.body.data.status).toBe('PROMISE_TO_PAY');
      const balanceBefore = await h.as(h.superAdminToken).get(`/api/v1/customers/${customers[1]!.id}/balance`).expect(200);
      expect(balanceBefore.body.data.outstanding).toBe('400.00'); // a promise is not money

      await pay(h, h.superAdminToken, customers[1]!.id, '400').expect(201);
      const after = await h.as(h.superAdminToken).get(`/api/v1/interactions?customerId=${customers[1]!.id}`).expect(200);
      expect(after.body.data[0]).toMatchObject({ status: 'COMPLETED' });
      expect(after.body.data[0].resolvedPaymentId).toBeTruthy();
      const open = await h.as(h.superAdminToken).get(`/api/v1/follow-ups?scope=all&customerId=${customers[1]!.id}`).expect(200);
      expect(open.body.data).toEqual([]);
    });

    it('agents complete their own follow-ups only', async () => {
      const t = await h.as(h.superAdminToken).post(`/api/v1/customers/${customers[3]!.id}/follow-ups`, { dueDate: today(), title: 'Ask about box' }).expect(201);
      expect((await h.as(agent.token).post(`/api/v1/follow-ups/${t.body.data.id}/complete`, {})).status).toBe(404);
      await h.as(h.superAdminToken).post(`/api/v1/follow-ups/${t.body.data.id}/complete`, { note: 'Done' }).expect(200);
    });
  });

  describe('dashboard', () => {
    it('every figure matches an independent SQL calculation', async () => {
      const res = await h.as(h.superAdminToken).get('/api/v1/dashboard').expect(200);
      const { kpis, agentPerformance, ageing, paymentModes } = res.body.data;
      const truth = (
        await sql<Record<string, string>>`
          SELECT
            (SELECT coalesce(sum(greatest(b, 0)), 0) FROM (SELECT sum(amount) b FROM ledger_entries GROUP BY customer_id) x) AS outstanding,
            (SELECT coalesce(sum(greatest(-b, 0)), 0) FROM (SELECT sum(amount) b FROM ledger_entries GROUP BY customer_id) x) AS advance,
            (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'CONFIRMED' AND date_trunc('month', payment_date) = date_trunc('month', ${today()}::date)) AS month_collection,
            (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'CONFIRMED' AND payment_date = ${today()}::date) AS today_collection,
            (SELECT coalesce(sum(amount), 0) FROM ledger_entries WHERE type = 'CHARGE' AND entry_date BETWEEN ${monthStart(0)}::date AND ${today()}::date) AS billed,
            (SELECT count(*) FROM customers WHERE status IN ('ACTIVE','SUSPENDED')) AS active,
            (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'PENDING_VERIFICATION') AS pending
        `.execute(h.db)
      ).rows[0]!;
      const n = (v: string) => Number(v).toFixed(2);
      expect(kpis.totalOutstanding).toBe(n(truth.outstanding!));
      expect(kpis.totalAdvance).toBe(n(truth.advance!));
      expect(kpis.monthCollection).toBe(n(truth.monthCollection!));
      expect(kpis.todayCollection).toBe(n(truth.todayCollection!));
      expect(kpis.periodBilled).toBe(n(truth.billed!));
      expect(kpis.activeCustomers).toBe(Number(truth.active));
      expect(kpis.pendingVerificationAmount).toBe(n(truth.pending!));
      expect(kpis.agentCashInHand).toBe('2700.00'); // agents' cash only: 1200 + 500 (REP1) + 1000 (REP2)

      const a1 = agentPerformance.find((a: { agentCode: string }) => a.agentCode === 'REP1');
      expect(a1).toMatchObject({ assignedCustomers: 3, actualCollection: '1700.00', cashInHand: '1700.00' });
      const ageingTotal = ageing.reduce((s: number, b: { amount: string }) => s + Number(b.amount), 0).toFixed(2);
      const openTotal = (await sql<{ v: string }>`SELECT coalesce(sum(total - amount_paid),0) v FROM invoices WHERE status IN ('UNPAID','PARTIALLY_PAID')`.execute(h.db)).rows[0]!.v;
      expect(ageingTotal).toBe(n(openTotal));
      expect(paymentModes.map((m: { mode: string }) => m.mode)).toEqual(['CASH']);
    });

    it('filters by agent: only that agent’s customers and collections', async () => {
      const res = await h.as(h.superAdminToken).get(`/api/v1/dashboard?agentId=${other.id}`).expect(200);
      expect(res.body.data.kpis).toMatchObject({ activeCustomers: 1, monthCollection: '1000.00', totalAdvance: '250.00', agentCashInHand: '1000.00' });
      expect(res.body.data.agentPerformance).toHaveLength(1);
    });

    it('is not available to agents', async () => {
      expect((await h.as(agent.token).get('/api/v1/dashboard')).status).toBe(403);
      expect((await h.as(agent.token).get('/api/v1/reports')).status).toBe(403);
    });
  });

  describe('reports', () => {
    it('lists 18 reports', async () => {
      const res = await h.as(h.superAdminToken).get('/api/v1/reports').expect(200);
      expect(res.body.data).toHaveLength(18);
    });

    it('every report runs as JSON and exports to Excel and PDF', async () => {
      const list = (await h.as(h.superAdminToken).get('/api/v1/reports').expect(200)).body.data as { key: string; formats: string[]; requiresCustomer: boolean }[];
      for (const r of list) {
        const qs = r.requiresCustomer ? `customerId=${customers[1]!.id}&` : '';
        const json = await h.as(h.superAdminToken).get(`/api/v1/reports/${r.key}?${qs}from=${monthStart(-3)}&to=${addDays(today(), 31)}`);
        expect(json.status, `${r.key}: ${JSON.stringify(json.body)}`).toBe(200);
        expect(Array.isArray(json.body.data.rows)).toBe(true);
        const xlsx = await h.as(h.superAdminToken).get(`/api/v1/reports/${r.key}?${qs}format=xlsx`).buffer(true).parse(binary as never);
        expect(xlsx.status, r.key).toBe(200);
        expect(xlsx.headers['content-type']).toContain('spreadsheetml');
        expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
        if (r.formats.includes('pdf')) {
          const pdf = await h.as(h.superAdminToken).get(`/api/v1/reports/${r.key}?${qs}format=pdf`).buffer(true).parse(binary as never);
          expect(pdf.status, r.key).toBe(200);
          expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
        }
      }
    });

    it('outstanding report: sorted, searchable, paginated, with totals matching the ledger', async () => {
      const res = await h.as(h.superAdminToken).get('/api/v1/reports/outstanding?pageSize=2').expect(200);
      const d = res.body.data;
      expect(d.meta.total).toBe(1); // only customers[2] still owes (customers[1] paid off its promise above)
      const amounts = d.rows.map((r: { outstanding: string }) => Number(r.outstanding));
      expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
      const truth = (await sql<{ v: string }>`SELECT sum(b) v FROM (SELECT sum(amount) b FROM ledger_entries GROUP BY customer_id) x WHERE b > 0`.execute(h.db)).rows[0]!.v;
      expect(d.totals.outstanding).toBe(Number(truth).toFixed(2));
      const search = await h.as(h.superAdminToken).get(`/api/v1/reports/outstanding?q=${encodeURIComponent('Report Society')}`).expect(200);
      expect(search.body.data.meta.total).toBe(1);
      const bad = await h.as(h.superAdminToken).get('/api/v1/reports/outstanding?sort=password');
      expect(bad.body.error.code).toBe('INVALID_SORT');
    });

    it('customer ledger report requires a customer and shows the running balance', async () => {
      expect((await h.as(h.superAdminToken).get('/api/v1/reports/customer-ledger')).body.error.code).toBe('CUSTOMER_REQUIRED');
      const res = await h.as(h.superAdminToken).get(`/api/v1/reports/customer-ledger?customerId=${customers[0]!.id}`).expect(200);
      expect(res.body.data.rows.at(-1).runningBalance).toBe('0.00');
      expect(res.body.data.totals).toEqual({ debit: '1200.00', credit: '1200.00' });
    });

    it('daily collection equals the confirmed payments of the day', async () => {
      const res = await h.as(h.superAdminToken).get('/api/v1/reports/daily-collection').expect(200);
      expect(res.body.data.totals.amount).toBe('3100.00');
      expect(res.body.data.rows.every((r: { receiptNumber: string }) => /^RCPT\//.test(r.receiptNumber))).toBe(true);
    });
  });

  it('receipt PDF is downloadable by admins and by the collecting agent only', async () => {
    const p = await h.db.selectFrom('receipts as r').innerJoin('payments as p', 'p.id', 'r.paymentId').select(['r.id', 'p.collectedBy']).where('p.collectedBy', '=', agent.id).executeTakeFirstOrThrow();
    const pdf = await h.as(agent.token).get(`/api/v1/receipts/${p.id}/pdf`).buffer(true).parse(binary as never);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await h.as(other.token).get(`/api/v1/receipts/${p.id}/pdf`)).status).toBe(404);
  });

  it('the books balance and the idempotent commands still work with field-ops wired in', async () => {
    const r = await h.as(h.superAdminToken).post('/api/v1/reconciliation/run').expect(200);
    expect(r.body.data.customerMismatches).toEqual([]);
    expect((await h.as(h.superAdminToken).post(`/api/v1/customers/${customers[0]!.id}/debits`, { amount: '10', description: 'x', reason: 'test' }, idem())).status).toBe(201);
  });
});
