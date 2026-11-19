import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { DB } from './schema';

// `date` columns are calendar dates in the business time zone. Never let pg turn them into
// JS Dates (which would apply the server's local time zone): keep 'YYYY-MM-DD' strings.
types.setTypeParser(types.builtins.DATE, (v) => v);

export type Database = Kysely<DB>;
export const DATABASE = Symbol('DATABASE');

export function createDatabase(connectionString: string, poolMax = 10): Database {
  const pool = new Pool({ connectionString, max: poolMax, application_name: 'cablenet-api' });
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
