import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import { businessDateOf } from '@cablenet/domain';
import { APP_CONFIG, AppConfig } from '../../config/env';
import { DATABASE, Database } from '../../db/database';
import { NotificationsService } from '../core/notifications.service';
import { AlertsService } from './alerts.service';
import { BillingService } from './billing.service';
import { ReconciliationService } from './reconciliation.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * In-process scheduler. Every job is an idempotent sweep, so a simple periodic tick is
 * enough: a missed tick is caught up by the next one. A PostgreSQL advisory lock makes sure
 * only one API instance runs jobs at a time. (pg-boss was planned; it is not needed while
 * all jobs are sweeps — see SYSTEM_ARCHITECTURE §8.)
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Last completed pass (for /health/ready). */
  private last: { at: Date; ok: boolean; error: string | null } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    private readonly billing: BillingService,
    private readonly subscriptions: SubscriptionsService,
    private readonly reconciliation: ReconciliationService,
    private readonly notifications: NotificationsService,
    private readonly alerts: AlertsService,
  ) {}

  /** Scheduler heartbeat: when the last pass ran and whether it succeeded. */
  lastTick() {
    return this.last;
  }

  onApplicationBootstrap(): void {
    if (!this.cfg.JOBS_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.JOBS_INTERVAL_SECONDS * 1000);
    setTimeout(() => void this.tick(), 5_000).unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over all jobs. Public so the CLI and tests can trigger it. */
  async tick(now = new Date()): Promise<Record<string, unknown>> {
    if (this.running) return { skipped: 'already running' };
    this.running = true;
    try {
      return await this.db.connection().execute(async (conn) => {
        const { rows } = await sql<{ locked: boolean }>`SELECT pg_try_advisory_lock(hashtext('cablenet:jobs')) AS locked`.execute(conn);
        if (!rows[0]?.locked) return { skipped: 'another instance holds the job lock' };
        try {
          const today = businessDateOf(now);
          const out: Record<string, unknown> = {};
          out.suspensionStatus = await this.subscriptions.syncStatus(this.db);
          if (await this.billing.hasDueWork(today)) out.billing = await this.billing.run(today, 'SCHEDULED', null);
          out.tempAssignments = await this.notifyTempAssignments(today);
          out.reconciliation = await this.daily('reconciliation', today, () => this.reconciliation.run());
          this.last = { at: new Date(), ok: true, error: null };
          return out;
        } finally {
          await sql`SELECT pg_advisory_unlock(hashtext('cablenet:jobs'))`.execute(conn);
        }
      });
    } catch (err) {
      this.logger.error({ err }, 'job tick failed');
      this.last = { at: new Date(), ok: false, error: (err as Error).message };
      // A failing scheduler means bills or the nightly check may be missing: tell a human.
      await this.alerts
        .raise(this.db, { type: 'JOB_FAILED', severity: 'CRITICAL', message: `Scheduled jobs failed: ${(err as Error).message}`.slice(0, 500) })
        .catch(() => undefined);
      return { error: (err as Error).message };
    } finally {
      this.running = false;
    }
  }

  /** Runs `fn` at most once per business day (successful runs only). */
  private async daily<T>(job: string, today: string, fn: () => Promise<T>): Promise<T | 'already ran today'> {
    const done = await this.db
      .selectFrom('jobRuns')
      .select('id')
      .where('job', '=', job)
      .where('businessDate', '=', today)
      .where('status', '=', 'COMPLETED')
      .executeTakeFirst();
    if (done) return 'already ran today';
    const run = await this.db.insertInto('jobRuns').values({ job, businessDate: today }).returning('id').executeTakeFirstOrThrow();
    try {
      const result = await fn();
      await this.db
        .updateTable('jobRuns')
        .set({ status: 'COMPLETED', finishedAt: sql<Date>`now()`, detail: JSON.stringify(result) })
        .where('id', '=', run.id)
        .execute();
      return result;
    } catch (err) {
      await this.db
        .updateTable('jobRuns')
        .set({ status: 'FAILED', finishedAt: sql<Date>`now()`, detail: JSON.stringify({ error: (err as Error).message }) })
        .where('id', '=', run.id)
        .execute();
      throw err;
    }
  }

  /** Start/end reminders for temporary reassignments (access itself changes by date range). */
  private async notifyTempAssignments(today: string) {
    const starting = await this.db
      .updateTable('tempReassignments')
      .set({ startNotifiedAt: sql<Date>`now()` })
      .where('startNotifiedAt', 'is', null)
      .where('revokedAt', 'is', null)
      .where('startsOn', '<=', today)
      .where('endsOn', '>=', today)
      .returning(['id', 'toAgentId', 'fromAgentId', 'customerCount', 'endsOn'])
      .execute();
    for (const t of starting) {
      await this.notifications.notify(this.db, [t.toAgentId], {
        type: 'TEMP_ASSIGNMENT_STARTED',
        title: 'Temporary customers start today',
        body: `You are covering ${t.customerCount} extra customer(s) until ${t.endsOn}.`,
        data: { tempReassignmentId: t.id },
      });
    }
    const ending = await this.db
      .updateTable('tempReassignments')
      .set({ endNotifiedAt: sql<Date>`now()` })
      .where('endNotifiedAt', 'is', null)
      .where('revokedAt', 'is', null)
      .where('endsOn', '<', today)
      .returning(['id', 'toAgentId', 'fromAgentId', 'customerCount'])
      .execute();
    for (const t of ending) {
      await this.notifications.notify(this.db, [t.toAgentId, t.fromAgentId], {
        type: 'TEMP_ASSIGNMENT_ENDED',
        title: 'Temporary reassignment ended',
        body: `${t.customerCount} customer(s) are back with their regular agent.`,
        data: { tempReassignmentId: t.id },
      });
    }
    return { started: starting.length, ended: ending.length };
  }
}
