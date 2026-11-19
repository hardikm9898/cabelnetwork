import { randomUUID } from 'node:crypto';
import { addDays } from '@cablenet/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReceiptLinkSigner } from '../src/modules/collections/receipt-links';
import { createAgent, createHarness, Harness } from './support/harness';
import { customerWithSubscription, monthStart, pay, runBilling, setupSociety, today } from './support/finance';

const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

interface Item {
  id: string;
  status: string;
  outstanding: string;
  paidToday: string;
  overdue: boolean;
  dueToday: boolean;
  assignment: string;
  followUpDue: boolean;
  lastPaymentAmount: string | null;
}

describe('agent work list, my day, receipt links', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof createAgent>>;
  let other: Awaited<ReturnType<typeof createAgent>>;
  const c: { id: string }[] = [];

  beforeAll(async () => {
    h = await createHarness();
    agent = await createAgent(h, 'WL1', 'Work List Agent');
    other = await createAgent(h, 'WL2', 'Other Agent');
    const mine = await setupSociety(h, 'Mine Society', agent.id);
    const theirs = await setupSociety(h, 'Their Society', other.id);
    for (const s of [mine, mine, mine, mine, theirs]) c.push((await customerWithSubscription(h, s, { monthlyRate: '400' })).customer);
    await runBilling(h); // 3 months x 400 = 1200 each, oldest bills overdue
    await pay(h, agent.token, c[0]!.id, '1200').expect(201); // PAID today
    await pay(h, agent.token, c[1]!.id, '400').expect(201); // PARTIAL today
    await h.as(agent.token).post(`/api/v1/customers/${c[2]!.id}/visits`, { clientId: randomUUID(), outcome: 'NOT_AVAILABLE', followUpDate: today() }).expect(201);
    // c[3] untouched → PENDING
  });
  afterAll(() => h.close());

  const list = async (token: string, qs = '') => {
    const res = await h.as(token).get(`/api/v1/collections/today${qs}`).expect(200);
    return res.body.data as { today: string; counts: Record<string, number>; items: Item[] };
  };

  it('shows only the agent’s customers with today’s status', async () => {
    const l = await list(agent.token);
    expect(l.items.map((i) => i.id).sort()).toEqual(c.slice(0, 4).map((x) => x.id).sort());
    const by = Object.fromEntries(l.items.map((i) => [i.id, i]));
    expect(by[c[0]!.id]).toMatchObject({ status: 'PAID', outstanding: '0.00', paidToday: '1200.00', lastPaymentAmount: '1200.00' });
    expect(by[c[1]!.id]).toMatchObject({ status: 'PARTIAL', outstanding: '800.00', overdue: true });
    expect(by[c[2]!.id]).toMatchObject({ status: 'VISITED', followUpDue: true });
    expect(by[c[3]!.id]).toMatchObject({ status: 'PENDING', outstanding: '1200.00' });
    expect(l.counts).toMatchObject({ all: 4, paid: 1, partial: 1, pending: 1, follow_up: 1 });
  });

  it('filters, sorts and searches', async () => {
    expect((await list(agent.token, '?filter=paid')).items.map((i) => i.id)).toEqual([c[0]!.id]);
    expect((await list(agent.token, '?filter=follow_up')).items.map((i) => i.id)).toEqual([c[2]!.id]);
    const sorted = (await list(agent.token, '?sort=outstanding')).items.map((i) => i.outstanding);
    expect(sorted).toEqual(['1200.00', '1200.00', '800.00', '0.00']);
    const search = await list(agent.token, `?q=${encodeURIComponent('Mine Society')}`);
    expect(search.items).toHaveLength(4);
  });

  it('includes customers lent to the agent by temporary cover', async () => {
    await h
      .as(h.superAdminToken)
      .post('/api/v1/assignments/temporary', {
        fromAgentId: other.id,
        toAgentId: agent.id,
        scope: 'ALL_OF_AGENT',
        startsOn: today(),
        endsOn: addDays(today(), 1),
        reason: 'Cover',
      })
      .expect(201);
    const l = await list(agent.token);
    expect(l.items.find((i) => i.id === c[4]!.id)?.assignment).toBe('TEMPORARY');
    expect((await list(other.token)).items).toEqual([]);
  });

  it('admins must name the agent; agents cannot look at another agent’s list', async () => {
    expect((await h.as(h.superAdminToken).get('/api/v1/collections/today')).body.error.code).toBe('AGENT_REQUIRED');
    const viaAdmin = (await h.as(h.superAdminToken).get(`/api/v1/collections/today?agentId=${agent.id}`).expect(200)).body.data;
    expect(viaAdmin.counts.all).toBe(5);
    // agentId is ignored for agents: they always get their own list
    expect((await list(other.token, `?agentId=${agent.id}`)).items).toEqual([]);
  });

  it('my day adds up', async () => {
    const res = await h.as(agent.token).get('/api/v1/dashboard/me').expect(200);
    expect(res.body.data).toMatchObject({
      assignedCustomers: 5,
      temporaryCustomers: 1,
      collectedToday: '1600.00',
      byMode: { cash: '1600.00' },
      customersPaid: 1,
      customersPartiallyPaid: 1,
      customersNotAvailable: 1,
      cashInHand: '1600.00',
      totalOutstanding: '4400.00', // 0 + 800 + 1200 + 1200 + 1200
    });
    // expected = everything due/overdue at the start of today = outstanding now + collected today
    expect(res.body.data.expectedToday).toBe('6000.00');
    expect(res.body.data.remainingToday).toBe('4400.00');
  });

  it('receipt links open the PDF without signing in, and reject tampering', async () => {
    const p = await h.db.selectFrom('receipts').select('id').where('status', '=', 'ISSUED').executeTakeFirstOrThrow();
    const link = await h.as(agent.token).get(`/api/v1/receipts/${p.id}/link`).expect(200);
    const path = new URL(link.body.data.url).pathname;
    const pdf = await h.http().get(path).buffer(true).parse(binary as never);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await h.http().get(`${path.slice(0, -3)}AAA`)).status).toBe(404);
    expect((await h.as(other.token).get(`/api/v1/receipts/${p.id}/link`)).status).toBe(404);
  });

  it('links expire', () => {
    const s = new ReceiptLinkSigner('x'.repeat(40));
    const id = randomUUID();
    const { token } = s.sign(id, 1, Date.parse('2026-01-01T00:00:00Z'));
    expect(s.verify(token, Date.parse('2026-01-01T12:00:00Z'))).toBe(id);
    expect(s.verify(token, Date.parse('2026-01-03T00:00:00Z'))).toBeNull();
    expect(new ReceiptLinkSigner('y'.repeat(40)).verify(token, Date.parse('2026-01-01T12:00:00Z'))).toBeNull();
  });

  it('still balances', async () => {
    void monthStart;
    const r = await h.as(h.superAdminToken).post('/api/v1/reconciliation/run').expect(200);
    expect(r.body.data.customerMismatches).toEqual([]);
  });
});
