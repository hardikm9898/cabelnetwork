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
 *   import-customers <file.xlsx | -> [--cutover YYYY-MM-01] [--by <mobile>] [--commit]
 *                                              the office site's Excel import from the command line (same
 *                                              checks, dry run and reconciliation). Without --commit it only
 *                                              reports and saves nothing. "-" reads the workbook from stdin.
 *                                              --by: the super admin recorded as importer (default: the first)
 *   bill-from <YYYY-MM-01> [--by <mobile>] [--commit]
 *                                              start billing every customer from that month at their own
 *                                              monthly charge (only customers not billed yet), then bill
 *                                              every month up to today. Without --commit it only reports.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { importDryRunRequest, passwordPolicy } from '@cablenet/contracts';
import { normalizeIndianMobile } from '@cablenet/domain';
import { createDatabase, DATABASE, Database } from './db/database';
import { pendingMigrations, runMigrations } from './db/migrator';
import { AppModule } from './app.module';
import { loadConfig } from './config/env';
import { hashPassword } from './modules/auth/passwords';
import { BackdateService } from './modules/finance/backdate.service';
import { JobsService } from './modules/finance/jobs.service';
import { ReconciliationService } from './modules/finance/reconciliation.service';
import { ImportsService } from './modules/imports/imports.service';
import { requestContext } from './common/request-context';
import type { AuthUser } from './common/request-context';
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
          const user = await trx.selectFrom('users').select('id').where('mobile', '=', mobile.normalized).where('deletedAt', 'is', null).executeTakeFirst();
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
    case 'import-customers': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { cutover: { type: 'string' }, by: { type: 'string' }, commit: { type: 'boolean', default: false } },
      });
      const file = positionals[0];
      if (!file) throw new Error('Usage: import-customers <file.xlsx | -> [--cutover YYYY-MM-01] [--by <mobile>] [--commit]');
      const buffer = file === '-' ? readFileSync(0) : readFileSync(file);
      const cfg = { ...loadConfig(), JOBS_ENABLED: false, LOG_LEVEL: 'warn' as const };
      const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg), { logger: ['error', 'warn'] });
      try {
        const db = ctx.get<Database>(DATABASE);
        const by = values.by ? normalizeIndianMobile(values.by) : null;
        if (values.by && !by?.valid) throw new Error('--by must be a 10-digit mobile number');
        let q = db.selectFrom('users').select(['id', 'fullName', 'role']).where('role', '=', 'SUPER_ADMIN').where('status', '=', 'ACTIVE').where('deletedAt', 'is', null);
        if (by) q = q.where('mobile', '=', by.normalized);
        const admin = await q.orderBy('createdAt').executeTakeFirst();
        if (!admin) throw new Error(by ? 'No active super admin with that mobile number' : 'No active super admin: run create-super-admin first');
        const actor: AuthUser = { id: admin.id, role: admin.role, fullName: admin.fullName, sessionId: randomUUID(), deviceId: null, mustChangePassword: false };
        const imports = ctx.get(ImportsService);
        const name = file === '-' ? 'customers.xlsx' : basename(file);
        const ok = await requestContext.run({ requestId: randomUUID(), ip: null, userAgent: 'cli import-customers', user: actor }, () =>
          importFromCli(imports, { originalname: name, buffer, size: buffer.length }, values.cutover, values.commit === true, actor),
        );
        if (!ok) process.exitCode = 1;
      } finally {
        await ctx.close();
      }
      return;
    }
    case 'bill-from': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { by: { type: 'string' }, commit: { type: 'boolean', default: false } } });
      const from = positionals[0];
      if (!from) throw new Error('Usage: bill-from <YYYY-MM-01> [--by <mobile>] [--commit]');
      const cfg = { ...loadConfig(), JOBS_ENABLED: false, LOG_LEVEL: 'warn' as const };
      const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(cfg), { logger: ['error', 'warn'] });
      try {
        const db = ctx.get<Database>(DATABASE);
        const by = values.by ? normalizeIndianMobile(values.by) : null;
        if (values.by && !by?.valid) throw new Error('--by must be a 10-digit mobile number');
        let q = db.selectFrom('users').select(['id', 'fullName', 'role']).where('role', '=', 'SUPER_ADMIN').where('status', '=', 'ACTIVE').where('deletedAt', 'is', null);
        if (by) q = q.where('mobile', '=', by.normalized);
        const admin = await q.orderBy('createdAt').executeTakeFirst();
        if (!admin) throw new Error('No active super admin');
        const actor: AuthUser = { id: admin.id, role: admin.role, fullName: admin.fullName, sessionId: randomUUID(), deviceId: null, mustChangePassword: false };
        const svc = ctx.get(BackdateService);
        const rupees = (v: string) => `Rs ${Number(v).toLocaleString('en-IN')}`;
        const plan = await svc.plan(from);
        console.log(`\nBilling from ${plan.from} (today ${plan.today})`);
        console.log(`  customers to bill from ${plan.from}: ${plan.change.length}`);
        console.log(`  bills to raise up to today: ${plan.totalPeriods}, total ${rupees(plan.totalAmount)}`);
        const byRate = new Map<string, number>();
        for (const r of plan.change) byRate.set(r.monthlyRate ?? '-', (byRate.get(r.monthlyRate ?? '-') ?? 0) + 1);
        for (const [rate, n] of [...byRate].sort((a, b) => Number(a[0]) - Number(b[0]))) console.log(`    ${String(n).padStart(4)} customers at ${rupees(rate)}/month`);
        if (plan.skipped.length) {
          console.log(`\n  not changed: ${plan.skipped.length}`);
          for (const s of plan.skipped) console.log(`    ${s.customerCode} ${s.name}: ${s.reason}`);
        }
        if (plan.noCharge.length) {
          console.log(`\n  NOT BILLED, no monthly charge set (${plan.noCharge.length}); set the charge in the office site, then run this again:`);
          for (const s of plan.noCharge) console.log(`    ${s.customerCode} ${s.name}`);
        }
        if (!values.commit) {
          console.log('\nDry run: nothing changed. Run again with --commit to apply.');
          return;
        }
        const res = await requestContext.run({ requestId: randomUUID(), ip: null, userAgent: 'cli bill-from', user: actor }, () => svc.apply(from, actor));
        console.log(`\nDone: ${res.plan.change.length} customers now billed from ${from}; ${res.run.invoicesCreated} bills raised, ${res.run.periodsSkipped} skipped (suspended).`);
        if (res.run.errors.length) {
          console.log(`ERRORS: ${res.run.errors.length}`);
          for (const e of res.run.errors) console.log(`  ${e.subscriptionId}: ${e.message}`);
          process.exitCode = 1;
        }
      } finally {
        await ctx.close();
      }
      return;
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". Commands: migrate, create-super-admin, reset-password, run-jobs, verify-db, import-customers, bill-from`);
  }
}

/** Upload → checks → dry run (→ approve → commit), printing what the office site's Import page shows. */
async function importFromCli(
  imports: ImportsService,
  file: { originalname: string; buffer: Buffer; size: number },
  cutoverArg: string | undefined,
  commit: boolean,
  actor: AuthUser,
): Promise<boolean> {
  const rupees = (v: string) => `Rs ${Number(v).toLocaleString('en-IN')}`;
  let b = await imports.upload(file, actor);
  const s = b.summary;
  const societies = new Map<string, number>();
  for (const c of b.customers) societies.set(c.society, (societies.get(c.society) ?? 0) + 1);
  console.log(`\nWorkbook ${file.originalname}: ${s.customers} customers in ${societies.size} societies`);
  console.log(`  billed from cutover: ${s.billable} customers, ${rupees(s.monthlyTotal)} a month`);
  console.log(`  rate to decide (text such as AMP / BOSS / DC, or blank): ${s.pendingDecision} customers, imported without billing`);
  if (s.monthsFound.length) console.log(`  payment history: ${s.historyYear}, months ${s.monthsFound.join(', ')}, ${rupees(s.collections)} collected`);
  console.log('\nSocieties:');
  for (const [n, count] of [...societies].sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${String(count).padStart(4)}  ${n}`);

  const show = (severity: 'error' | 'warning') => {
    const list = b.issues.filter((i) => i.severity === severity);
    if (!list.length) return;
    console.log(`\n${severity === 'error' ? 'ERRORS (must be fixed)' : 'Warnings'}: ${list.length}`);
    for (const i of list) console.log(`  [${i.code}]${i.customerCode ? ` ${i.customerCode}` : ''}${i.row ? ` (row ${i.row})` : ''}: ${i.message}`);
  };
  show('error');
  show('warning');

  const cutover = cutoverArg ?? s.suggestedCutover;
  if (!cutover) {
    await imports.discard(b.id);
    console.log('\nGive the cutover month: --cutover YYYY-MM-01 (the first month the new system bills)');
    return false;
  }
  const req = importDryRunRequest.safeParse({ option: 'OPENING_BALANCE', cutoverDate: cutover });
  if (!req.success) {
    await imports.discard(b.id);
    console.log(`\n--cutover ${cutover}: ${req.error.issues[0]?.message}`);
    return false;
  }
  b = await imports.dryRun(b.id, req.data, actor);
  const r = b.report!;
  console.log(`\nDry run (Option B, opening balance; billing from ${cutover}): ${r.ok ? 'OK' : 'FAILED'}`);
  for (const l of r.lines) console.log(`  ${l.ok ? 'ok ' : 'XX '} ${l.check}: workbook ${l.excel}, system ${l.system}`);
  for (const i of r.blockingIssues) console.log(`  blocked by [${i.code}]${i.customerCode ? ` ${i.customerCode}` : ''}: ${i.message}`);
  console.log(`  would create: ${Object.entries(r.created).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing'}`);

  if (!r.ok || !commit) {
    await imports.discard(b.id);
    console.log(r.ok ? '\nNothing was saved. Run the same command with --commit to import.' : '\nNothing was saved. Fix the errors above and run it again.');
    return r.ok;
  }
  await imports.approve(b.id, b.dryRunHash!, actor);
  b = await imports.commit(b.id, actor);
  console.log(`\nIMPORTED (batch ${b.id}). It is listed in the office site under Import; customers with a rate to decide are under "Needs decision".`);
  return true;
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
