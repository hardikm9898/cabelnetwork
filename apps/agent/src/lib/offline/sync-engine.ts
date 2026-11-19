import type { SyncOpOutcome, SyncPullResponse, SyncPushRequest, SyncPushResponse } from '@cablenet/contracts';
import type { LocalStore, OutboxOp } from './store';

export interface Transport {
  pull(etag?: string): Promise<SyncPullResponse>;
  push(body: SyncPushRequest): Promise<SyncPushResponse>;
}

export interface SyncStatus {
  running: boolean;
  /** Phone time of the last complete push + pull. */
  lastSyncAt: string | null;
  lastError: string | null;
  /** Consecutive failed attempts (for back-off). */
  failures: number;
  /** Earliest phone time (ms) for the next automatic attempt. */
  nextAttemptAt: number;
}

const BATCH = 50;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * 60_000;

/** Delay before automatic retry number `failures` (5 s, 10 s, 20 s … up to 5 min). */
export const backoffMs = (failures: number) => (failures <= 0 ? 0 : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - 1)));

/**
 * Moves entries from the outbox to the server and the server's view back to the phone.
 *
 * Exactly once: every entry keeps its id across retries and the server stores the outcome per id,
 * so a lost response is harmless — the next attempt gets DUPLICATE with the original result.
 * An entry stays PENDING until the server has answered for it; nothing is ever dropped silently.
 */
export class SyncEngine {
  private status: SyncStatus = { running: false, lastSyncAt: null, lastError: null, failures: 0, nextAttemptAt: 0 };
  private inFlight: Promise<boolean> | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly store: LocalStore,
    private readonly transport: Transport,
    private readonly userId: () => string | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getStatus = () => this.status;
  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Entries of the signed-in user still waiting for the server. */
  pending(): OutboxOp[] {
    const me = this.userId();
    return this.store.getOps().filter((o) => o.state === 'PENDING' && o.userId === me);
  }

  /** True when an automatic attempt is allowed now (respects back-off after failures). */
  due(): boolean {
    return !this.status.running && this.now().getTime() >= this.status.nextAttemptAt;
  }

  /** Push, then pull. Concurrent callers share one run. Returns true on success. */
  sync(): Promise<boolean> {
    this.inFlight ??= this.run().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async run(): Promise<boolean> {
    if (!this.userId()) return false;
    this.set({ running: true });
    try {
      await this.push();
      await this.pull();
      await this.store.prune(this.now());
      this.set({ running: false, lastSyncAt: this.now().toISOString(), lastError: null, failures: 0, nextAttemptAt: 0 });
      return true;
    } catch (e) {
      const failures = this.status.failures + 1;
      this.set({
        running: false,
        lastError: e instanceof Error ? e.message : String(e),
        failures,
        nextAttemptAt: this.now().getTime() + backoffMs(failures),
      });
      return false;
    }
  }

  /** Sends waiting entries in device order. Throws on network/server failure (entries stay PENDING). */
  async push(): Promise<void> {
    for (;;) {
      const batch = this.pending().slice(0, BATCH);
      if (batch.length === 0) return;
      // Count the attempt before sending, so a crash mid-request is still visible later.
      await this.store.updateOps(batch.map((o) => ({ ...o, attempts: o.attempts + 1 })));
      const res = await this.transport.push({
        deviceTime: this.now().toISOString(),
        ops: batch.map((o) => ({ opId: o.opId, type: o.type, seq: o.seq, createdAt: o.createdAt, offline: o.offline, payload: o.payload })),
      });
      const byId = new Map(res.results.map((r) => [r.opId, r]));
      const at = this.now().toISOString();
      const updated: OutboxOp[] = [];
      let retry = false;
      for (const op of batch) {
        const r = byId.get(op.opId);
        const current = this.store.getOp(op.opId)!;
        if (!r || r.status === 'RETRY') {
          retry = true;
          continue;
        }
        updated.push(applyOutcome(current, r, at));
      }
      await this.store.updateOps(updated);
      if (retry) throw new Error('The server asked to try again later');
    }
  }

  async pull(): Promise<void> {
    const me = this.userId();
    if (!me) return;
    const header = this.store.getHeader();
    const sameUser = header?.userId === me;
    const res = await this.transport.pull(sameUser ? header?.etag : undefined);
    const at = this.now().toISOString();
    if (res.unchanged) await this.store.markFresh(res.asOf, at);
    else await this.store.replaceSnapshot(res, me, at);
  }
}

/** Records the server's answer on the entry. */
export function applyOutcome(op: OutboxOp, r: SyncOpOutcome, at: string): OutboxOp {
  const state = r.status === 'DUPLICATE' ? (r.originalStatus ?? 'APPLIED') : (r.status as 'APPLIED' | 'NEEDS_REVIEW' | 'REJECTED');
  return {
    ...op,
    state,
    flags: r.flags ?? [],
    error: r.error,
    result: r.result ?? op.result ?? null,
    syncedAt: at,
  };
}
