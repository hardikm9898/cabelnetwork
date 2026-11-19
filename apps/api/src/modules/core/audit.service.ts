import { Injectable } from '@nestjs/common';
import type { Database } from '../../db/database';
import { requestContext } from '../../common/request-context';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Override the actor (e.g. failed login where no user is authenticated yet). */
  actorUserId?: string | null;
}

/**
 * Writes the append-only audit trail. Always call with the same transaction handle as the
 * change being audited, so the audit row commits or rolls back together with it.
 * Actor, IP, user agent, device and session are taken from the request context.
 */
@Injectable()
export class AuditService {
  async record(db: Database, entry: AuditEntry): Promise<void> {
    const ctx = requestContext.get();
    const user = ctx?.user;
    await db
      .insertInto('auditLogs')
      .values({
        actorUserId: entry.actorUserId !== undefined ? entry.actorUserId : (user?.id ?? null),
        actorRole: user?.role ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: entry.before === undefined ? null : JSON.stringify(entry.before),
        after: entry.after === undefined ? null : JSON.stringify(entry.after),
        reason: entry.reason ?? null,
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
        deviceId: user?.deviceId ?? null,
        sessionId: user?.sessionId ?? null,
      })
      .execute();
  }
}
