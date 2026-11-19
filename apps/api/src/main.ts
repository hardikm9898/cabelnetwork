import { createApp } from './app.factory';
import { loadConfig } from './config/env';
import { pendingMigrations } from './db/migrator';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  // Fail fast instead of serving requests against an out-of-date schema.
  const pending = await pendingMigrations(cfg.DATABASE_URL);
  if (pending.length > 0) {
    throw new Error(`Database has ${pending.length} pending migration(s): ${pending.join(', ')}. Run "pnpm --filter @cablenet/api db:migrate" first.`);
  }
  const app = await createApp(cfg);
  await app.listen(cfg.PORT);
}

bootstrap().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
