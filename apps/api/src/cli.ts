/**
 * Operational commands.
 *   migrate                                   apply pending SQL migrations
 *   create-super-admin --mobile <m> --name <n> create the first super admin
 *                                              (password from env BOOTSTRAP_PASSWORD; must change at first login)
 *   run-jobs                                  one scheduler pass now (billing, suspensions, reminders,
 *                                              daily reconciliation); same as the in-process timer
 *   reset-password --mobile <m>               emergency reset (e.g. the only super admin forgot): sets
 *                                              BOOTSTRAP_PASSWORD as a temporary password, unlocks the
 *                                              account and signs out all its sessions
 *   verify-db                                 migrations, row counts and the financial invariants as JSON;
 *                                              exit code 1 if anything is wrong (used by the restore drill)
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { passwordPolicy } from '@cablenet/contracts';
import { normalizeIndianMobile } from '@cablenet/domain';
import { createDatabase } from './db/database';
import { pendingMigrations, runMigrations } from './db/migrator';
import { AppModule } from './app.module';
import { loadConfig } from './config/env';
import { hashPassword } from './modules/auth/passwords';
import { JobsService } from './modules/finance/jobs.service';
import { ReconciliationService } from './modules/finance/reconciliation.service';
import { sql } from 'kysely';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  switch (command) {
    case 'migrate': {
      const res = await runMigrations(url, undefined, (m) => console.log(m));
      console.log(`migrations: ${res.applied.length} applied, ${res.skipped.length} already up to date`);
      return;
    }
    case 'create-super-admin': {
      const { values } = parseArgs({ args: rest, options: { mobile: { type: 'string' }, name: { type: 'string' } } });
      const mobile = normalizeIndianMobile(values.mobile);
      if (!mobile?.valid || !values.name) throw new Error('Usage: create-super-admin --mobile <10-digit> --name "<full name>"');
      const password = process.env.BOOTSTRAP_PASSWORD ?? '';
      const check = passwordPolicy.safeParse(password);
      if (!check.success) throw new Error(`BOOTSTRAP_PASSWORD: ${check.error.issues[0]?.message}`);

      const db = createDatabase(url, 1);
      try {
        await db.transaction().execute(async (trx) => {
          const existing = await trx
            .selectFrom('users')
            .select('id')
            .where('role', '=', 'SUPER_ADMIN')
            .executeTakeFirst();
          if (existing) throw new Error('A super admin already exists; create further admins from the app');
          const user = await trx
            .insertInto('users')
            .values({
              fullName: values.name!,
              mobile: mobile.normalized,
              passwordHash: await hashPassword(password),
              role: 'SUPER_ADMIN',
              mustChangePassword: true,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('auditLogs')
            .values({ action: 'user.bootstrap_super_admin', entityType: 'user', entityId: user.id, reason: 'CLI bootstrap' })
            .execute();
          console.log(`super admin created: ${user.id}`);
        });
      } finally {
        await db.destroy();
      }
      return;
    }
    case 'run-jobs': {
      const cfg = { ...loadConfig(), JOBS_ENABLED: false, LOG_LEVEL: 'warn' as const };
      const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg), { logger: ['error', 'warn'] });
      try {
        console.log(JSON.stringify(await ctx.get(JobsService).tick(), null, 2));
      } finally {
        await ctx.close();
      }
      return;
    }
    case 'reset-password': {
      const { values } = parseArgs({ args: rest, options: { mobile: { type: 'string' } } });
      const mobile = normalizeIndianMobile(values.mobile);
      if (!mobile?.valid) throw new Error('Usage: reset-password --mobile <10-digit>');
      const password = process.env.BOOTSTRAP_PASSWORD ?? '';
      const check = passwordPolicy.safeParse(password);
      if (!check.success) throw new Error(`BOOTSTRAP_PASSWORD: ${check.error.issues[0]?.message}`);
      const db = createDatabase(url, 1);
      try {
        await db.transaction().execute(async (trx) => {
          const user = await trx.selectFrom('users').select('id').where('mobile', '=', mobile.normalized).executeTakeFirst();
          if (!user) throw new Error('No user with that mobile number');
          await trx
            .updateTable('users')
            .set({ passwordHash: await hashPassword(password), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null })
            .where('id', '=', user.id)
            .execute();
          await trx.updateTable('sessions').set({ revokedAt: sql<Date>`now()`, revokeReason: 'cli_password_reset' }).where('userId', '=', user.id).where('revokedAt', 'is', null).execute();
          await trx.insertInto('auditLogs').values({ action: 'user.password_reset_cli', entityType: 'user', entityId: user.id, reason: 'CLI emergency reset' }).execute();
        });
        console.log('password reset; sign in with BOOTSTRAP_PASSWORD and choose a new password');
      } finally {
        await db.destroy();
      }
      return;
    }
    case 'verify-db': {
      const pending = await pendingMigrations(url);
      const db = createDatabase(url, 2);
      let counts: Record<string, string>;
      try {
        const r = await sql<Record<string, string>>`
          SELECT
            (SELECT count(*) FROM users)::text AS users,
            (SELECT count(*) FROM customers)::text AS customers,
            (SELECT count(*) FROM customer_subscriptions WHERE status <> 'ENDED')::text AS live_subscriptions,
            (SELECT count(*) FROM invoices)::text AS invoices,
            (SELECT count(*) FROM payments)::text AS payments,
            (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'CONFIRMED')::text AS confirmed_payment_total,
            (SELECT count(*) FROM ledger_entries)::text AS ledger_entries,
            (SELECT coalesce(sum(amount), 0) FROM ledger_entries)::text AS ledger_total,
            (SELECT count(*) FROM allocations)::text AS allocations,
            (SELECT count(*) FROM receipts)::text AS receipts,
            (SELECT count(*) FROM cash_handovers)::text AS cash_handovers,
            (SELECT count(*) FROM sync_operations)::text AS sync_operations,
            (SELECT count(*) FROM audit_logs)::text AS audit_logs
        `.execute(db);
        counts = r.rows[0]!;
      } finally {
        await db.destroy();
      }
      const cfg = { ...loadConfig(), JOBS_ENABLED: false, LOG_LEVEL: 'warn' as const };
      const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg), { logger: ['error', 'warn'] });
      try {
        const rec = await ctx.get(ReconciliationService).run();
        const reconciliation = {
          checkedCustomers: rec.checkedCustomers,
          customerMismatches: rec.customerMismatches.length,
          invoiceCacheMismatches: rec.invoiceCacheMismatches.length,
          overAllocatedCredits: rec.overAllocatedCredits.length,
        };
        const ok = pending.length === 0 && reconciliation.customerMismatches + reconciliation.invoiceCacheMismatches + reconciliation.overAllocatedCredits === 0;
        console.log(JSON.stringify({ ok, pendingMigrations: pending, counts, reconciliation }, null, 2));
        if (!ok) process.exitCode = 1;
      } finally {
        await ctx.close();
      }
      return;
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". Commands: migrate, create-super-admin, reset-password, run-jobs, verify-db`);
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
