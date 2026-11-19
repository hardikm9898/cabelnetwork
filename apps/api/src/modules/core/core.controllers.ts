import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { z } from 'zod';
import { paginationQuery, uuid } from '@cablenet/contracts';
import { CurrentUser, Public, RequirePermissions } from '../../common/decorators';
import { Page } from '../../common/http';
import type { AuthUser } from '../../common/request-context';
import { ZodBody, ZodQuery } from '../../common/zod';
import type { Response } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/env';
import { DATABASE, Database } from '../../db/database';
import { JobsService } from '../finance/jobs.service';
import { NotificationsService } from './notifications.service';
import { SettingsService } from './settings.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly jobs: JobsService,
  ) {}

  /** Liveness: the process answers and the database is reachable. */
  @Public()
  @Get()
  async health() {
    await sql`SELECT 1`.execute(this.db);
    return { status: 'ok', time: new Date().toISOString() };
  }

  /**
   * Readiness for an uptime monitor: 503 when something needs a human. Only states and counts
   * (no business data), so it can be polled without signing in.
   */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, { ok: boolean; detail?: string | number }> = {};
    try {
      await sql`SELECT 1`.execute(this.db);
      checks.database = { ok: true };
    } catch {
      checks.database = { ok: false };
    }
    if (this.cfg.JOBS_ENABLED) {
      const last = this.jobs.lastTick();
      const ageS = last ? Math.round((Date.now() - last.at.getTime()) / 1000) : null;
      // A pass may be skipped while another instance holds the lock; allow three intervals plus start-up.
      checks.scheduler = { ok: !!last && last.ok && ageS! <= this.cfg.JOBS_INTERVAL_SECONDS * 3 + 60, detail: ageS ?? 'not run yet' };
    }
    if (checks.database.ok) {
      const r = await sql<{ critical: number; recon: string | null; reconAgeH: number | null }>`
        SELECT
          (SELECT count(*)::int FROM system_alerts WHERE resolved_at IS NULL AND severity = 'CRITICAL') AS critical,
          (SELECT status FROM job_runs WHERE job = 'reconciliation' ORDER BY started_at DESC LIMIT 1) AS recon,
          (SELECT extract(epoch FROM now() - max(started_at)) / 3600 FROM job_runs WHERE job = 'reconciliation' AND status = 'COMPLETED')::int AS recon_age_h
      `.execute(this.db);
      const x = r.rows[0]!;
      checks.criticalAlerts = { ok: x.critical === 0, detail: x.critical };
      if (this.cfg.JOBS_ENABLED) checks.nightlyReconciliation = { ok: x.recon !== 'FAILED' && (x.reconAgeH === null || x.reconAgeH <= 36), detail: x.recon ?? 'not run yet' };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', time: new Date().toISOString(), checks };
  }
}

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @RequirePermissions('settings:read')
  @Get()
  all() {
    return this.settings.getAll();
  }

  /** Body is the setting value itself; validated against the key's schema. */
  @RequirePermissions('settings:manage')
  @Put(':key')
  set(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() value: unknown) {
    return this.settings.set(key, value, user.id);
  }
}

const listNotificationsQuery = paginationQuery.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
const markReadBody = z.object({ ids: z.union([z.array(uuid).min(1).max(500), z.literal('all')]) });

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @RequirePermissions('notifications:read:own')
  @Get()
  async list(@CurrentUser() user: AuthUser, @ZodQuery(listNotificationsQuery) q: z.infer<typeof listNotificationsQuery>) {
    const { page, unread } = await this.notifications.listForUser(user.id, q.page, q.pageSize, q.unreadOnly);
    return new Page(page.items, { ...page.meta, unread });
  }

  @RequirePermissions('notifications:read:own')
  @Post('read')
  @HttpCode(200)
  async markRead(@CurrentUser() user: AuthUser, @ZodBody(markReadBody) body: z.infer<typeof markReadBody>) {
    return { updated: await this.notifications.markRead(user.id, body.ids) };
  }
}

const auditQuery = paginationQuery.extend({
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  actorUserId: uuid.optional(),
  action: z.string().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @RequirePermissions('audit:read')
  @Get()
  async list(@ZodQuery(auditQuery) q: z.infer<typeof auditQuery>) {
    let query = this.db.selectFrom('auditLogs as l').leftJoin('users as u', 'u.id', 'l.actorUserId');
    if (q.entityType) query = query.where('l.entityType', '=', q.entityType);
    if (q.entityId) query = query.where('l.entityId', '=', q.entityId);
    if (q.actorUserId) query = query.where('l.actorUserId', '=', q.actorUserId);
    if (q.action) query = query.where('l.action', 'like', `${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    if (q.from) query = query.where('l.occurredAt', '>=', new Date(q.from));
    if (q.to) query = query.where('l.occurredAt', '<', new Date(q.to));
    const [items, total] = await Promise.all([
      query
        .selectAll('l')
        .select('u.fullName as actorName')
        .orderBy('l.id', 'desc')
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page: q.page, pageSize: q.pageSize, total: Number(total.n) });
  }
}

