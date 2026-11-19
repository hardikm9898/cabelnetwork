/**
 * The phone's local storage, reduced to namespaced key → JSON text. All offline logic (snapshot,
 * outbox, counters) is written against this, so it runs unchanged on SQLite (phone), browser
 * storage (web test build) and memory (unit tests).
 */
export type KvWrite = { ns: string; key: string; value: string } | { ns: string; key: string; delete: true } | { ns: string; clear: true };

export interface StorageInfo {
  engine: 'sqlcipher' | 'sqlite' | 'browser' | 'memory';
  /** True only when the data file is actually encrypted (SQLCipher present and keyed). */
  encrypted: boolean;
}

export interface KV {
  all(ns: string): Promise<{ key: string; value: string }[]>;
  get(ns: string, key: string): Promise<string | null>;
  /** Applies every write or none. */
  write(ops: KvWrite[]): Promise<void>;
  info(): StorageInfo;
}

export class MemoryKV implements KV {
  private readonly data = new Map<string, Map<string, string>>();
  /** Tests: make the next write fail (simulates a crash before commit). */
  failNextWrite = false;

  private ns(ns: string) {
    let m = this.data.get(ns);
    if (!m) this.data.set(ns, (m = new Map()));
    return m;
  }
  async all(ns: string) {
    return [...this.ns(ns)].map(([key, value]) => ({ key, value }));
  }
  async get(ns: string, key: string) {
    return this.ns(ns).get(key) ?? null;
  }
  async write(ops: KvWrite[]) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated storage failure');
    }
    // Stage, then apply, so a failure part-way leaves nothing changed.
    const staged = new Map([...this.data].map(([k, v]) => [k, new Map(v)]));
    for (const op of ops) {
      let m = staged.get(op.ns);
      if (!m) staged.set(op.ns, (m = new Map()));
      if ('clear' in op) m.clear();
      else if ('delete' in op) m.delete(op.key);
      else m.set(op.key, op.value);
    }
    this.data.clear();
    for (const [k, v] of staged) this.data.set(k, v);
  }
  info(): StorageInfo {
    return { engine: 'memory', encrypted: false };
  }
}
