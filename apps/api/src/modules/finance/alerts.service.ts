import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DATABASE, Database } from '../../db/database';
import { conflict, notFound } from '../../common/errors';
import { Page } from '../../common/http';
import { AuditService } from '../core/audit.service';
import { NotificationsService } from '../core/notifications.service';

export interface AlertInput {
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  entityType?: string;
  entityId?: string;
  message: string;
  details?: unknown;
}

/** Things an admin must look at (reconciliation mismatches, suspicious payments, cash differences). */
@Injectable()
export class AlertsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** Raises an alert unless an identical unresolved one already exists; notifies admins. */
  async raise(db: Database, a: AlertInput): Promise<boolean> {
    const existing = await db
      .selectFrom('systemAlerts')
      .select('id')
      .where('type', '=', a.type)
      .where(sql<boolean>`entity_id IS NOT DISTINCT FROM ${a.entityId ?? null}`)
      .where('resolvedAt', 'is', null)
      .executeTakeFirst();
    if (existing) return false;
    await db
      .insertInto('systemAlerts')
      .values({
        type: a.type,
        severity: a.severity,
        entityType: a.entityType ?? null,
        entityId: a.entityId ?? null,
        message: a.message,
        details: a.details === undefined ? null : JSON.stringify(a.details),
      })
      .execute();
    const admins = await db
      .selectFrom('users')
      .select('id')
      .where('role', 'in', ['ADMIN', 'SUPER_ADMIN'])
      .where('status', '=', 'ACTIVE')
      .execute();
    await this.notifications.notify(
      db,
      admins.map((u) => u.id),
      { type: `ALERT_${a.type}`, title: a.severity === 'CRITICAL' ? 'Critical alert' : 'Needs attention', body: a.message, data: { entityType: a.entityType, entityId: a.entityId } },
    );
    return true;
  }

  /** Closes open alerts of a type for an entity once the cause is fixed (e.g. a rate was added). */
  async resolveOpen(db: Database, type: string, entityId: string, resolution: string, actorId: string): Promise<void> {
    await db
      .updateTable('systemAlerts')
      .set({ resolvedAt: sql<Date>`now()`, resolvedBy: actorId, resolution })
      .where('type', '=', type)
      .where('entityId', '=', entityId)
      .where('resolvedAt', 'is', null)
      .execute();
  }

  async list(filter: { open?: boolean; page: number; pageSize: number }) {
    let q = this.db.selectFrom('systemAlerts');
    if (filter.open) q = q.where('resolvedAt', 'is', null);
    const [items, total] = await Promise.all([
      q.selectAll().orderBy('createdAt', 'desc').limit(filter.pageSize).offset((filter.page - 1) * filter.pageSize).execute(),
      q.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page: filter.page, pageSize: filter.pageSize, total: Number(total.n) });
  }

  async resolve(id: string, resolution: string, actorId: string) {
    return this.db.transaction().execute(async (trx) => {
      const a = await trx.selectFrom('systemAlerts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!a) throw notFound('ALERT_NOT_FOUND', 'Alert not found');
      if (a.resolvedAt) throw conflict('ALERT_ALREADY_RESOLVED', 'Alert already resolved');
      const updated = await trx
        .updateTable('systemAlerts')
        .set({ resolvedAt: sql<Date>`now()`, resolvedBy: actorId, resolution })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'alert.resolved', entityType: 'system_alert', entityId: id, reason: resolution });
      return updated;
    });
  }
}
