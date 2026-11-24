import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { provisionalRef as provisionalRefSchema, type SyncCustomer, type SyncOpOutcome, type SyncPullResponse, type SyncPushRequest, type SyncSnapshot } from '@cablenet/contracts';
import { describe, expect, it } from 'vitest';
import { acknowledge, completeFollowUp, provisionalRef, recordPayment, recordVisit } from './actions';
import { MemoryKV } from './kv';
import { SqlDb, SqliteKV } from './kv-sqlite';
import { LocalStore } from './store';
import { backoffMs, SyncEngine, Transport } from './sync-engine';
import { buildList, counts, isStale, unsentToday } from './view';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const customer = (over: Partial<SyncCustomer> = {}): SyncCustomer => ({
  id: randomUUID(),
  customerCode: '500100',
  name: 'Test Customer',
  mobile: '9876543210',
  addressLine: '1, Test Society',
  landmark: null,
  society: 'Test Society',
  status: 'ACTIVE',
  assignment: 'PRIMARY',
  temporaryUntil: null,
  monthlyRate: '400.00',
  outstanding: '1200.00',
  advance: '0.00',
  oldestDueDate: '2026-09-11',
  nextDueDate: '2026-09-11',
  openInvoices: [{ id: randomUUID(), label: 'Sep 2026', dueDate: '2026-09-11', balance: '400.00' }],
  pendingVerification: '0.00',
  lastPaymentDate: null,
  lastPaymentAmount: null,
  paidToday: '0.00',
  lastVisitAt: null,
  lastVisitOutcome: null,
  recentPayments: [],
  recentVisits: [],
  ...over,
});

const snapshot = (customers: SyncCustomer[], over: Partial<SyncSnapshot> = {}): SyncSnapshot => ({
  unchanged: false,
  asOf: '2026-11-19T04:00:00.000Z',
  today: '2026-11-19',
  etag: randomUUID(),
  agent: { id: 'u1', code: 'AG1', name: 'Agent One' },
  business: { name: 'Cable Network', phone: null },
  nextProvisionalSeq: 1,
  staleAfterHours: 12,
  maxAmount: '100000.00',
  day: { expectedToday: '0.00', collectedToday: '0.00', remainingToday: '0.00', byMode: { cash: '0.00', upi: '0.00', other: '0.00' }, pendingVerification: '0.00', visitsToday: 0, customersNotAvailable: 0, cashInHand: '0.00', cashNotYetHandedOver: '0.00', pendingHandoverAmount: '0.00' },
  customers,
  followUps: [],
  ...over,
});

const actor = { userId: 'u1', agentCode: 'AG1' };
const NOON = new Date('2026-11-19T06:30:00.000Z'); // 12:00 IST

/** In-memory server with the API's rule: one outcome per op id, replays answer DUPLICATE. */
class FakeServer implements Transport {
  applied = new Map<string, SyncOpOutcome>();
  postings = 0;
  networkDown = false;
  loseNextResponse = false;
  rejectAmountsAbove = Infinity;
  retryOps = new Set<string>();
  snap: SyncSnapshot = snapshot([]);
  pulls = 0;

  async push(body: SyncPushRequest) {
    if (this.networkDown) throw new TypeError('Network request failed');
    const results: SyncOpOutcome[] = [...body.ops]
      .sort((a, b) => a.seq - b.seq)
      .map((op) => {
        const prior = this.applied.get(op.opId);
        if (prior) return { ...prior, status: 'DUPLICATE', originalStatus: prior.status as 'APPLIED' };
        if (this.retryOps.has(op.opId)) return { opId: op.opId, status: 'RETRY', flags: [] };
        const amount = Number((op.payload as { amount?: string }).amount ?? 0);
        const outcome: SyncOpOutcome =
          amount > this.rejectAmountsAbove
            ? { opId: op.opId, status: 'REJECTED', flags: [], error: { code: 'AMOUNT_TOO_LARGE', message: 'Too large' } }
            : { opId: op.opId, status: 'APPLIED', flags: [], result: { paymentId: `pay-${op.opId}`, status: 'CONFIRMED', paymentDate: '2026-11-19', provisionalRef: 'x', receiptId: 'r', receiptNumber: `RCPT/2026-27/${String(++this.postings).padStart(6, '0')}`, allocations: [], advanceCreated: '0.00', remainingOutstanding: '0.00', remainingAdvance: '0.00', visitId: null } };
        this.applied.set(op.opId, outcome);
        return outcome;
      });
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new TypeError('Network request failed'); // applied on the server, answer lost
    }
    return { serverTime: new Date().toISOString(), clockSkewSeconds: 0, results };
  }
  async pull(etag?: string): Promise<SyncPullResponse> {
    if (this.networkDown) throw new TypeError('Network request failed');
    this.pulls++;
    if (etag === this.snap.etag) return { unchanged: true, asOf: new Date().toISOString(), etag };
    return this.snap;
  }
}

const setup = async (kv = new MemoryKV()) => {
  const store = new LocalStore(kv);
  await store.load();
  const server = new FakeServer();
  let clock = NOON;
  const engine = new SyncEngine(store, server, () => 'u1', () => clock);
  return { store, server, engine, kv, setClock: (d: Date) => (clock = d) };
};

/** node:sqlite behind the same small interface as expo-sqlite (one connection, like the app). */
function nodeSqlite(): SqlDb {
  const db = new DatabaseSync(':memory:');
  // Each call yields first, as the native calls do, so concurrent writes really interleave.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    execAsync: async (s) => {
      await tick();
      db.exec(s);
    },
    runAsync: async (s, p) => {
      await tick();
      return db.prepare(s).run(...p);
    },
    getAllAsync: async <T>(s: string, p: (string | number | null)[]) => db.prepare(s).all(...p) as T[],
    getFirstAsync: async <T>(s: string, p: (string | number | null)[]) => (db.prepare(s).get(...p) as T | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------

describe('SQLite storage', () => {
  it('stores, reads and replaces values, and reports that plain SQLite is not encrypted', async () => {
    const kv = await SqliteKV.open(nodeSqlite(), 'a'.repeat(64));
    expect(kv.info()).toEqual({ engine: 'sqlite', encrypted: false });
    await kv.write([{ ns: 'c', key: '1', value: 'one' }, { ns: 'c', key: '2', value: 'two' }, { ns: 'o', key: '1', value: 'x' }]);
    await kv.write([{ ns: 'c', key: '1', value: 'uno' }, { ns: 'c', key: '2', delete: true }]);
    expect(await kv.all('c')).toEqual([{ key: '1', value: 'uno' }]);
    await kv.write([{ ns: 'c', clear: true }]);
    expect(await kv.all('c')).toEqual([]);
    expect(await kv.get('o', '1')).toBe('x');
  });

  it('a failed write changes nothing (all or nothing)', async () => {
    const kv = await SqliteKV.open(nodeSqlite(), 'b'.repeat(64));
    await kv.write([{ ns: 'c', key: '1', value: 'keep' }]);
    await expect(kv.write([{ ns: 'c', key: '1', value: 'new' }, { ns: 'c', key: '2', value: null as unknown as string }])).rejects.toThrow();
    expect(await kv.all('c')).toEqual([{ key: '1', value: 'keep' }]);
  });

  it("concurrent writes do not run inside another write's transaction", async () => {
    const kv = await SqliteKV.open(nodeSqlite(), 'c'.repeat(64));
    const many = (ns: string) => Array.from({ length: 30 }, (_, i) => ({ ns, key: String(i), value: ns + i }));
    await Promise.all([kv.write(many('a')), kv.write([{ ns: 'b', key: '1', value: null as unknown as string }]).catch(() => 'failed'), kv.write(many('c'))]);
    expect(await kv.all('a')).toHaveLength(30);
    expect(await kv.all('b')).toEqual([]);
    expect(await kv.all('c')).toHaveLength(30);
  });

  it('refuses a malformed key', async () => {
    await expect(SqliteKV.open(nodeSqlite(), 'short')).rejects.toThrow(/64 hex/);
  });
});

describe('local store', () => {
  it('a new snapshot removes customers that are no longer assigned; sign-out keeps unsent entries', async () => {
    const { store, kv } = await setup();
    const a = customer();
    const b = customer({ customerCode: '500101' });
    await store.replaceSnapshot(snapshot([a, b]), 'u1', NOON.toISOString());
    await recordPayment(store, actor, { customer: a, amount: '400', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    await store.replaceSnapshot(snapshot([a]), 'u1', NOON.toISOString());
    expect(store.getCustomers().map((c) => c.id)).toEqual([a.id]);

    await store.clearSnapshot();
    const reopened = new LocalStore(kv);
    await reopened.load();
    expect(reopened.getCustomers()).toEqual([]);
    expect(reopened.getHeader()).toBeNull();
    expect(reopened.getOps()).toHaveLength(1);
    expect(reopened.getOps()[0]!.state).toBe('PENDING');
  });

  it('numbers survive a restart and never go below the server floor (reinstall)', async () => {
    const { store, kv } = await setup();
    const c = customer();
    await store.replaceSnapshot(snapshot([c], { nextProvisionalSeq: 41 }), 'u1', NOON.toISOString());
    const p1 = await recordPayment(store, actor, { customer: c, amount: '1', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    expect(p1.label.provisionalRef).toBe('P-AG1-000041');
    const again = new LocalStore(kv);
    await again.load();
    const p2 = await recordPayment(again, actor, { customer: c, amount: '1', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    expect(p2.label.provisionalRef).toBe('P-AG1-000042');
    expect(p2.seq).toBe(p1.seq + 1);
    expect(provisionalRefSchema.safeParse(p2.label.provisionalRef).success).toBe(true);
  });

  it('a crash while saving loses nothing half-way: the entry and its number are both saved or both not', async () => {
    const kv = new MemoryKV();
    const { store } = await setup(kv);
    const c = customer();
    kv.failNextWrite = true;
    await expect(recordPayment(store, actor, { customer: c, amount: '1', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID })).rejects.toThrow();
    expect(store.getOps()).toEqual([]);
    const ok = await recordPayment(store, actor, { customer: c, amount: '1', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    expect(ok.label.provisionalRef).toBe('P-AG1-000001');
  });

  it('formats provisional references the way the server accepts them', () => {
    expect(provisionalRef('ag-01', 7)).toBe('P-AG01-000007');
    expect(provisionalRefSchema.safeParse(provisionalRef('AGNEW', 123456789)).success).toBe(true);
  });
});

describe('sync engine', () => {
  it('airplane mode: entries wait, retry with back-off, and post exactly once after reconnecting', async () => {
    const { store, server, engine, setClock } = await setup();
    const c = customer();
    server.snap = snapshot([c]);
    server.networkDown = true;
    const op = await recordPayment(store, actor, { customer: c, amount: '400', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });

    expect(await engine.sync()).toBe(false);
    expect(store.getOp(op.opId)).toMatchObject({ state: 'PENDING', attempts: 1 });
    expect(engine.getStatus()).toMatchObject({ failures: 1, nextAttemptAt: NOON.getTime() + 5_000 });
    expect(engine.due()).toBe(false);
    expect(await engine.sync()).toBe(false);
    expect(engine.getStatus().nextAttemptAt).toBe(NOON.getTime() + 10_000);

    server.networkDown = false;
    setClock(new Date(NOON.getTime() + 60_000));
    expect(engine.due()).toBe(true);
    expect(await engine.sync()).toBe(true);
    expect(store.getOp(op.opId)).toMatchObject({ state: 'APPLIED', result: { receiptNumber: 'RCPT/2026-27/000001' } });
    expect(server.postings).toBe(1);
    expect(engine.getStatus()).toMatchObject({ failures: 0, lastError: null });
    // Synced again later: nothing is sent twice.
    await engine.sync();
    expect(server.postings).toBe(1);
  });

  it('a lost response is harmless: the replay returns the original result', async () => {
    const { store, server, engine } = await setup();
    const c = customer();
    server.snap = snapshot([c]);
    const op = await recordPayment(store, actor, { customer: c, amount: '400', mode: 'CASH', reference: null, notes: null, offline: false, now: NOON, newId: randomUUID });
    server.loseNextResponse = true;
    expect(await engine.sync()).toBe(false);
    expect(store.getOp(op.opId)!.state).toBe('PENDING');
    expect(await engine.sync()).toBe(true);
    expect(store.getOp(op.opId)).toMatchObject({ state: 'APPLIED', result: { receiptNumber: 'RCPT/2026-27/000001' } });
    expect(server.postings).toBe(1);
  });

  it('sends in device order, keeps rejected entries until acknowledged, retries on request', async () => {
    const { store, server, engine, setClock } = await setup();
    const c = customer();
    server.snap = snapshot([c]);
    server.rejectAmountsAbove = 1000;
    const visit = await recordVisit(store, actor, { customer: c, visit: { outcome: 'NOT_AVAILABLE' }, offline: true, now: NOON, newId: randomUUID });
    const big = await recordPayment(store, actor, { customer: c, amount: '5000', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    const later = await recordPayment(store, actor, { customer: c, amount: '10', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    server.retryOps.add(later.opId);
    expect(await engine.sync()).toBe(false);
    expect([visit, big, later].map((o) => store.getOp(o.opId)!.state)).toEqual(['APPLIED', 'REJECTED', 'PENDING']);
    expect(store.getOp(big.opId)!.error).toEqual({ code: 'AMOUNT_TOO_LARGE', message: 'Too large' });

    server.retryOps.clear();
    setClock(new Date(NOON.getTime() + 60_000));
    expect(await engine.sync()).toBe(true);
    expect(store.getOp(later.opId)!.state).toBe('APPLIED');

    // Old finished entries are pruned; a rejected one stays until the agent acknowledges it.
    setClock(new Date(NOON.getTime() + 8 * 86_400_000));
    await engine.sync();
    expect(store.getOps().map((o) => o.opId)).toEqual([big.opId]);
    await acknowledge(store, big.opId, NOON);
    await engine.sync();
    expect(store.getOps()).toEqual([]);
  });

  it('never sends another user’s entries', async () => {
    const { store, server, engine } = await setup();
    const c = customer();
    server.snap = snapshot([c]);
    const theirs = await recordPayment(store, { userId: 'u2', agentCode: 'AG2' }, { customer: c, amount: '1', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    await engine.sync();
    expect(store.getOp(theirs.opId)!.state).toBe('PENDING');
    expect(server.applied.size).toBe(0);
  });

  it('skips the download when nothing changed', async () => {
    const { store, server, engine } = await setup();
    server.snap = snapshot([customer()]);
    await engine.sync();
    const first = store.getHeader()!;
    await engine.sync();
    expect(server.pulls).toBe(2);
    expect(store.getHeader()!.etag).toBe(first.etag);
    expect(store.getCustomers()).toHaveLength(1);
  });

  it('back-off grows to five minutes', () => {
    expect([0, 1, 2, 3, 10].map(backoffMs)).toEqual([0, 5_000, 10_000, 20_000, 300_000]);
  });
});

describe('screens derived from snapshot + unsent entries', () => {
  it('shows unsent collections without changing the server balance', async () => {
    const { store } = await setup();
    const full = customer({ outstanding: '400.00' });
    const part = customer({ outstanding: '1200.00', customerCode: '500101' });
    const visited = customer({ customerCode: '500102' });
    const untouched = customer({ customerCode: '500103' });
    await store.replaceSnapshot(snapshot([full, part, visited, untouched]), 'u1', NOON.toISOString());
    await recordPayment(store, actor, { customer: full, amount: '400', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    await recordPayment(store, actor, { customer: part, amount: '400', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    await recordVisit(store, actor, { customer: visited, visit: { outcome: 'NOT_AVAILABLE' }, offline: true, now: NOON, newId: randomUUID });

    const items = buildList(store.getCustomers(), store.getHeader(), store.getOps(), [], NOON);
    const by = Object.fromEntries(items.map((i) => [i.customerCode, i]));
    expect(by['500100']).toMatchObject({ todayStatus: 'PAID', unsentAmount: '400.00', outstanding: '400.00', waitingToSend: true });
    expect(by['500101']).toMatchObject({ todayStatus: 'PARTIAL', unsentAmount: '400.00', outstanding: '1200.00' });
    expect(by['500102']!.todayStatus).toBe('VISITED');
    expect(by['500103']!.todayStatus).toBe('PENDING');
    expect(counts(items)).toMatchObject({ all: 4, paid: 1, partial: 1, pending: 2, overdue: 4 });
    expect(unsentToday(store.getOps(), store.getHeader(), NOON)).toEqual({ count: 2, amount: '800.00' });
  });

  it('once sent and downloaded again, the snapshot is the only source', async () => {
    const { store, server, engine, setClock } = await setup();
    const c = customer({ outstanding: '400.00' });
    server.snap = snapshot([c]);
    await engine.sync();
    await recordPayment(store, actor, { customer: c, amount: '400', mode: 'CASH', reference: null, notes: null, offline: true, now: NOON, newId: randomUUID });
    server.snap = snapshot([{ ...c, outstanding: '0.00', paidToday: '400.00' }]);
    setClock(new Date(NOON.getTime() + 1000));
    await engine.sync();
    const [item] = buildList(store.getCustomers(), store.getHeader(), store.getOps(), [], new Date(NOON.getTime() + 2000));
    expect(item).toMatchObject({ todayStatus: 'PAID', unsentAmount: null, outstanding: '0.00' });
  });

  it('hides ended temporary cover, ignores yesterday’s "paid today", and honours follow-ups done offline', async () => {
    const { store } = await setup();
    const lent = customer({ assignment: 'TEMPORARY', temporaryUntil: new Date(NOON.getTime() - 1000).toISOString() });
    const paidYesterday = customer({ customerCode: '500200', paidToday: '400.00', outstanding: '0.00' });
    const fu = customer({ customerCode: '500300' });
    await store.replaceSnapshot(snapshot([lent, paidYesterday, fu], { today: '2026-11-18', followUps: [{ id: 'f1', customerId: fu.id, dueDate: '2026-11-19', title: 'Call' }] }), 'u1', NOON.toISOString());
    const h = store.getHeader()!;
    let items = buildList(store.getCustomers(), h, store.getOps(), h.followUps, NOON);
    expect(items.map((i) => i.customerCode).sort()).toEqual(['500200', '500300']);
    expect(items.find((i) => i.customerCode === '500200')!.todayStatus).toBe('CLEAR');
    expect(items.find((i) => i.customerCode === '500300')!.followUpDue).toBe(true);
    await completeFollowUp(store, actor, { followUpId: 'f1', customer: fu, offline: true, now: NOON, newId: randomUUID });
    items = buildList(store.getCustomers(), h, store.getOps(), h.followUps, NOON);
    expect(items.find((i) => i.customerCode === '500300')!.followUpDue).toBe(false);
  });

  it('warns when the data is older than the configured hours', async () => {
    const { store } = await setup();
    await store.replaceSnapshot(snapshot([]), 'u1', NOON.toISOString());
    expect(isStale(store.getHeader(), new Date(NOON.getTime() + 11 * 3_600_000))).toBe(false);
    expect(isStale(store.getHeader(), new Date(NOON.getTime() + 13 * 3_600_000))).toBe(true);
  });
});
