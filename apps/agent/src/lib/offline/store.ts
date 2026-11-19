import type { SyncCustomer, SyncOpResultData, SyncOpType, SyncSnapshot } from '@cablenet/contracts';
import type { KV, KvWrite } from './kv';

/** Where an entry recorded on this phone stands. */
export type OpState = 'PENDING' | 'APPLIED' | 'NEEDS_REVIEW' | 'REJECTED';

export interface OutboxOp {
  opId: string;
  /** Device-wide counter; operations are sent and applied in this order. */
  seq: number;
  type: SyncOpType;
  createdAt: string;
  /** The phone had no connection when the agent saved it. */
  offline: boolean;
  payload: Record<string, unknown>;
  /** Who recorded it; only that user's session may send it. */
  userId: string;
  state: OpState;
  attempts: number;
  flags: string[];
  error?: { code: string; message: string };
  result?: SyncOpResultData | null;
  /** Phone time the server's answer arrived. */
  syncedAt?: string;
  /** Agent dismissed a rejected entry. */
  acknowledgedAt?: string;
  /** Shown in lists without needing the snapshot. */
  label: { customerId?: string; customerName?: string; customerCode?: string; amount?: string; mode?: string; provisionalRef?: string };
}

export type SnapshotHeader = Omit<SyncSnapshot, 'customers'> & {
  /** Phone time of the last successful download (used for "out of date" warnings). */
  pulledAt: string;
  userId: string;
};

const NS = { customer: 'customer', op: 'op', meta: 'meta' } as const;

/**
 * Local data: the last snapshot of the agent's customers and the outbox of entries made on this
 * phone. Everything is kept in memory for instant screens and written through to storage.
 */
export class LocalStore {
  private header: SnapshotHeader | null = null;
  private customers = new Map<string, SyncCustomer>();
  private ops = new Map<string, OutboxOp>();
  private counters = { opSeq: 0, provisional: 0 };
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(readonly kv: KV) {}

  async load() {
    const [meta, customers, ops] = await Promise.all([this.kv.all(NS.meta), this.kv.all(NS.customer), this.kv.all(NS.op)]);
    const m = new Map(meta.map((r) => [r.key, r.value]));
    this.header = m.has('snapshot') ? (JSON.parse(m.get('snapshot')!) as SnapshotHeader) : null;
    this.counters = m.has('counters') ? { ...this.counters, ...(JSON.parse(m.get('counters')!) as typeof this.counters) } : this.counters;
    this.customers = new Map(customers.map((r) => { const c = JSON.parse(r.value) as SyncCustomer; return [c.id, c]; }));
    this.ops = new Map(ops.map((r) => { const o = JSON.parse(r.value) as OutboxOp; return [o.opId, o]; }));
    this.changed();
  }

  // --- subscription (React useSyncExternalStore) ---
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // --- snapshot ---
  getHeader() {
    return this.header;
  }
  getCustomers(): SyncCustomer[] {
    return [...this.customers.values()];
  }
  getCustomer(id: string) {
    return this.customers.get(id) ?? null;
  }

  /** Replaces the whole snapshot in one write (customers no longer assigned disappear). */
  async replaceSnapshot(snap: SyncSnapshot, userId: string, pulledAt: string) {
    const { customers, ...rest } = snap;
    const header: SnapshotHeader = { ...rest, pulledAt, userId };
    const counters = { ...this.counters, provisional: Math.max(this.counters.provisional, snap.nextProvisionalSeq - 1) };
    const writes: KvWrite[] = [
      { ns: NS.customer, clear: true },
      ...customers.map((c) => ({ ns: NS.customer, key: c.id, value: JSON.stringify(c) })),
      { ns: NS.meta, key: 'snapshot', value: JSON.stringify(header) },
      { ns: NS.meta, key: 'counters', value: JSON.stringify(counters) },
    ];
    await this.kv.write(writes);
    this.header = header;
    this.customers = new Map(customers.map((c) => [c.id, c]));
    this.counters = counters;
    this.changed();
  }

  /** "Nothing changed" answer: the data is confirmed current as of now. */
  async markFresh(asOf: string, pulledAt: string) {
    if (!this.header) return;
    const header = { ...this.header, asOf, pulledAt };
    await this.kv.write([{ ns: NS.meta, key: 'snapshot', value: JSON.stringify(header) }]);
    this.header = header;
    this.changed();
  }

  /** Sign-out or session ended: customer data leaves the phone; unsent entries stay (they are money). */
  async clearSnapshot() {
    await this.kv.write([
      { ns: NS.customer, clear: true },
      { ns: NS.meta, key: 'snapshot', delete: true },
    ]);
    this.header = null;
    this.customers.clear();
    this.changed();
  }

  // --- outbox ---
  getOps(): OutboxOp[] {
    return [...this.ops.values()].sort((a, b) => a.seq - b.seq);
  }
  getOp(opId: string) {
    return this.ops.get(opId) ?? null;
  }

  /**
   * Saves new entries with their sequence numbers and (for payments) provisional receipt numbers
   * in the same write as the counters, so a number is never handed out twice.
   */
  async add(build: (next: { seq: () => number; provisional: () => number }) => OutboxOp[]) {
    const counters = { ...this.counters };
    const ops = build({ seq: () => ++counters.opSeq, provisional: () => ++counters.provisional });
    await this.kv.write([
      ...ops.map((o) => ({ ns: NS.op, key: o.opId, value: JSON.stringify(o) })),
      { ns: NS.meta, key: 'counters', value: JSON.stringify(counters) },
    ]);
    this.counters = counters;
    for (const o of ops) this.ops.set(o.opId, o);
    this.changed();
    return ops;
  }

  async updateOps(ops: OutboxOp[]) {
    if (ops.length === 0) return;
    await this.kv.write(ops.map((o) => ({ ns: NS.op, key: o.opId, value: JSON.stringify(o) })));
    for (const o of ops) this.ops.set(o.opId, o);
    this.changed();
  }

  /** Drops finished entries older than `keepDays` (they are on the server and in later snapshots). */
  async prune(now: Date, keepDays = 7) {
    const cutoff = now.getTime() - keepDays * 86_400_000;
    const gone = this.getOps().filter(
      (o) => (o.state === 'APPLIED' || o.state === 'NEEDS_REVIEW' || (o.state === 'REJECTED' && o.acknowledgedAt)) && new Date(o.syncedAt ?? o.createdAt).getTime() < cutoff,
    );
    if (gone.length === 0) return 0;
    await this.kv.write(gone.map((o) => ({ ns: NS.op, key: o.opId, delete: true as const })));
    for (const o of gone) this.ops.delete(o.opId);
    this.changed();
    return gone.length;
  }

  getCounters() {
    return { ...this.counters };
  }
}
