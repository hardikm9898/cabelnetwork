import type { KV, KvWrite, StorageInfo } from './kv';

/**
 * Web build (used only for automated tests in a browser): browser storage, not encrypted.
 * The phone uses kv-open.native.ts (SQLite / SQLCipher).
 */
class BrowserKV implements KV {
  private readonly prefix = 'cc.kv:';
  private k(ns: string, key: string) {
    return `${this.prefix}${ns}:${key}`;
  }
  async all(ns: string) {
    const start = `${this.prefix}${ns}:`;
    const out: { key: string; value: string }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)!;
      if (name.startsWith(start)) out.push({ key: name.slice(start.length), value: localStorage.getItem(name)! });
    }
    return out;
  }
  async get(ns: string, key: string) {
    return localStorage.getItem(this.k(ns, key));
  }
  async write(ops: KvWrite[]) {
    for (const op of ops) {
      if ('clear' in op) for (const { key } of await this.all(op.ns)) localStorage.removeItem(this.k(op.ns, key));
      else if ('delete' in op) localStorage.removeItem(this.k(op.ns, op.key));
      else localStorage.setItem(this.k(op.ns, op.key), op.value);
    }
  }
  info(): StorageInfo {
    return { engine: 'browser', encrypted: false };
  }
}

export async function openKV(): Promise<KV> {
  return new BrowserKV();
}
