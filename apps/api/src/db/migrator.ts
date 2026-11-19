import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

/** Locates apps/api/db/migrations from both src/ (dev, tests) and dist/src/ (built). */
function findMigrationsDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`db/migrations not found above ${start}`);
}

export const MIGRATIONS_DIR = findMigrationsDir(__dirname);

/** Migration files not yet applied (or the whole list if the table does not exist yet). */
export async function pendingMigrations(connectionString: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  const client = new Client({ connectionString, application_name: 'cablenet-migration-check' });
  await client.connect();
  try {
    const exists = await client.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations') AS t`);
    if (!exists.rows[0]?.t) return files;
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    return files.filter((f) => !applied.has(f));
  } finally {
    await client.end();
  }
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies `db/migrations/NNNN_name.sql` files in order, each in its own transaction.
 * Already-applied files are verified by checksum: editing an applied migration is an error
 * (write a new migration instead). A session advisory lock prevents concurrent runners.
 */
export async function runMigrations(
  connectionString: string,
  dir = MIGRATIONS_DIR,
  log: (msg: string) => void = () => undefined,
): Promise<MigrationResult> {
  const client = new Client({ connectionString, application_name: 'cablenet-migrator' });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['cablenet:migrations']);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const sqlText = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sqlText.replace(/\r\n/g, '\n')).digest('hex');
      const existing = applied.get(file);
      if (existing) {
        if (existing !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        }
        result.skipped.push(file);
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['cablenet:migrations']).catch(() => undefined);
    await client.end();
  }
}
