import type { KV, KvWrite, StorageInfo } from './kv';

type Param = string | number | null;

/** The part of expo-sqlite's SQLiteDatabase used here (also implemented over node:sqlite in tests). */
export interface SqlDb {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: Param[]): Promise<unknown>;
  getAllAsync<T>(source: string, params: Param[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params: Param[]): Promise<T | null>;
}

/**
 * Key-value table in SQLite. With SQLCipher (development/production builds) the file is
 * encrypted with a random 256-bit key kept in the Android Keystore; `PRAGMA cipher_version`
 * tells whether that is really the case (Expo Go has plain SQLite, where `PRAGMA key` is ignored).
 */
export class SqliteKV implements KV {
  /** Writes run one after another on this connection (see `write`). */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly db: SqlDb,
    private readonly storage: StorageInfo,
  ) {}

  /** `keyHex`: 64 hex characters (raw key, no passphrase derivation). */
  static async open(db: SqlDb, keyHex: string): Promise<SqliteKV> {
    if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('Database key must be 64 hex characters');
    await db.execAsync(`PRAGMA key = "x'${keyHex}'";`);
    const cipher = await db.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version', []).catch(() => null);
    // Reading the schema fails here if the file was encrypted with another key.
    await db.getFirstAsync('SELECT count(*) AS n FROM sqlite_master', []);
    await db.execAsync('PRAGMA journal_mode = WAL;');
    await db.execAsync('CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key)) WITHOUT ROWID;');
    const encrypted = !!cipher?.cipher_version;
    return new SqliteKV(db, { engine: encrypted ? 'sqlcipher' : 'sqlite', encrypted });
  }

  async all(ns: string) {
    return this.db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM kv WHERE ns = ?', [ns]);
  }

  async get(ns: string, key: string) {
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE ns = ? AND key = ?', [ns, key]);
    return row?.value ?? null;
  }

  /**
   * All or nothing, on the connection that holds the encryption key. (expo-sqlite's
   * withExclusiveTransactionAsync opens a second connection that has no key, so with SQLCipher
   * every write failed with "file is not a database".) Writes are queued so that one write's
   * statements never run inside another's transaction.
   */
  write(ops: KvWrite[]): Promise<void> {
    if (ops.length === 0) return Promise.resolve();
    const run = this.queue.then(() => this.writeNow(ops));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writeNow(ops: KvWrite[]) {
    await this.db.execAsync('BEGIN IMMEDIATE;');
    try {
      for (const op of ops) {
        if ('clear' in op) await this.db.runAsync('DELETE FROM kv WHERE ns = ?', [op.ns]);
        else if ('delete' in op) await this.db.runAsync('DELETE FROM kv WHERE ns = ? AND key = ?', [op.ns, op.key]);
        else await this.db.runAsync('INSERT INTO kv (ns, key, value) VALUES (?, ?, ?) ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value', [op.ns, op.key, op.value]);
      }
      await this.db.execAsync('COMMIT;');
    } catch (e) {
      await this.db.execAsync('ROLLBACK;').catch(() => undefined);
      throw e;
    }
  }

  info() {
    return this.storage;
  }
}
