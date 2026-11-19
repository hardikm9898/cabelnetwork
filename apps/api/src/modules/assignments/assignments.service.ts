import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { TemporaryReassignmentRequest } from '@cablenet/contracts';
import { addDays, businessDateOf, startOfBusinessDay } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import type { AssignmentSource } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { Page } from '../../common/http';
import { AuditService } from '../core/audit.service';
import { NotificationsService } from '../core/notifications.service';

export interface AssignmentChange {
  customerId: string;
  fromAgentId: string | null;
  toAgentId: string;
}

interface PrimaryRow {
  customerId: string;
  agentId: string;
  source: AssignmentSource;
  assignmentId: string;
}

export type TempStatus = 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'REVOKED';

/**
 * Customer ↔ agent assignment rules (docs/DATABASE_DESIGN.md §3):
 *  - Each customer has at most one PRIMARY assignment at a time (DB exclusion constraint).
 *  - PRIMARY follows the area's default owner (source AREA_DEFAULT) unless an admin pinned
 *    the customer to an agent (source MANUAL).
 *  - TEMPORARY assignments overlay PRIMARY for a date range and simply expire; the PRIMARY row
 *    is never touched, so the original agent resumes automatically.
 *  - History rows are never deleted; ranges can only be shortened (DB trigger).
 * All public methods that change data must run inside a transaction (`db` = trx).
 */
@Injectable()
export class AssignmentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Primitives
  // ---------------------------------------------------------------------------

  /** Row-locks customers in a stable order so concurrent assignment changes serialise. */
  async lockCustomers(db: Database, customerIds: string[]): Promise<void> {
    if (customerIds.length === 0) return;
    await db
      .selectFrom('customers')
      .select('id')
      .where('id', 'in', customerIds)
      .orderBy('id')
      .forUpdate()
      .execute();
  }

  async assertActiveAgent(db: Database, agentId: string): Promise<{ id: string; fullName: string; agentCode: string }> {
    const agent = await db
      .selectFrom('users as u')
      .innerJoin('agentProfiles as a', 'a.userId', 'u.id')
      .select(['u.id', 'u.fullName', 'u.status', 'a.agentCode', 'a.employmentStatus'])
      .where('u.id', '=', agentId)
      .where('u.role', '=', 'AGENT')
      .executeTakeFirst();
    if (!agent) throw notFound('AGENT_NOT_FOUND', 'Agent not found');
    if (agent.status !== 'ACTIVE' || agent.employmentStatus === 'LEFT') {
      throw unprocessable('AGENT_NOT_ACTIVE', `Agent ${agent.agentCode} is not active`);
    }
    return { id: agent.id, fullName: agent.fullName, agentCode: agent.agentCode };
  }

  private async primaryFor(db: Database, customerIds: string[]): Promise<Map<string, PrimaryRow>> {
    if (customerIds.length === 0) return new Map();
    const rows = await db
      .selectFrom('customerPrimaryAgent')
      .selectAll()
      .where('customerId', 'in', customerIds)
      .execute();
    return new Map(rows.map((r) => [r.customerId, r]));
  }

  private async endAssignment(db: Database, assignmentId: string, actorId: string, reason: string): Promise<void> {
    await db
      .updateTable('customerAgentAssignments')
      .set({
        validDuring: sql<string>`tstzrange(lower(valid_during), greatest(lower(valid_during), now()))`,
        endedBy: actorId,
        endedAt: sql<Date>`now()`,
        endedReason: reason,
      })
      .where('id', '=', assignmentId)
      .execute();
  }

  private async openPrimary(
    db: Database,
    customerId: string,
    agentId: string,
    source: AssignmentSource,
    actorId: string,
    reason: string | null,
  ): Promise<void> {
    await db
      .insertInto('customerAgentAssignments')
      .values({
        customerId,
        agentId,
        kind: 'PRIMARY',
        source,
        validDuring: sql<string>`tstzrange(now(), NULL)`,
        reason,
        createdBy: actorId,
      })
      .execute();
  }

  // ---------------------------------------------------------------------------
  // Permanent (PRIMARY) assignment
  // ---------------------------------------------------------------------------

  /**
   * Re-points customers to their area's current default agent.
   * Customers with a MANUAL override are left alone unless `force` is true.
   * Customers whose area has no owner keep their current assignment.
   */
  async applyAreaDefault(
    db: Database,
    customerIds: string[],
    actorId: string,
    reason: string,
    opts: { force?: boolean } = {},
  ): Promise<AssignmentChange[]> {
    if (customerIds.length === 0) return [];
    await this.lockCustomers(db, customerIds);
    const owners = await db
      .selectFrom('customers as c')
      .innerJoin('societies as s', 's.id', 'c.societyId')
      .leftJoin('areaAgentAssignments as aa', (j) =>
        j.onRef('aa.areaId', '=', 's.areaId').on(sql<boolean>`aa.valid_during @> now()`),
      )
      .select(['c.id as customerId', 'aa.agentId as ownerId'])
      .where('c.id', 'in', customerIds)
      .execute();
    const primary = await this.primaryFor(db, customerIds);
    const changes: AssignmentChange[] = [];

    for (const { customerId, ownerId } of owners) {
      if (!ownerId) continue;
      const current = primary.get(customerId);
      if (current?.source === 'MANUAL' && !opts.force) continue;
      if (current && current.agentId === ownerId && current.source !== 'MANUAL') continue;
      if (current) await this.endAssignment(db, current.assignmentId, actorId, reason);
      await this.openPrimary(db, customerId, ownerId, 'AREA_DEFAULT', actorId, reason);
      if (current?.agentId !== ownerId) {
        changes.push({ customerId, fromAgentId: current?.agentId ?? null, toAgentId: ownerId });
      }
    }
    return changes;
  }

  /** Pins customers to an agent (MANUAL override of the area default). */
  async assignPermanent(
    db: Database,
    customerIds: string[],
    agentId: string,
    actorId: string,
    reason: string,
  ): Promise<AssignmentChange[]> {
    await this.assertActiveAgent(db, agentId);
    await this.lockCustomers(db, customerIds);
    const primary = await this.primaryFor(db, customerIds);
    const changes: AssignmentChange[] = [];
    for (const customerId of customerIds) {
      const current = primary.get(customerId);
      if (current?.agentId === agentId && current.source === 'MANUAL') continue;
      if (current) await this.endAssignment(db, current.assignmentId, actorId, reason);
      await this.openPrimary(db, customerId, agentId, 'MANUAL', actorId, reason);
      if (current?.agentId !== agentId) changes.push({ customerId, fromAgentId: current?.agentId ?? null, toAgentId: agentId });
    }
    return changes;
  }

  /** Admin endpoint: permanent move of customers (or a whole society) to an agent. */
  async permanentMove(
    input: { agentId: string; customerIds?: string[]; societyId?: string; reason: string },
    actorId: string,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const customerIds = input.societyId
        ? (await this.customerIdsInSocieties(trx, [input.societyId], true))
        : await this.assertCustomersExist(trx, input.customerIds ?? []);
      if (customerIds.length === 0) throw unprocessable('NO_CUSTOMERS', 'No customers to assign');
      const changes = await this.assignPermanent(trx, customerIds, input.agentId, actorId, input.reason);
      await this.afterPermanentChanges(trx, changes, input.reason, 'assignment.permanent_move');
      return { changed: changes.length, unchanged: customerIds.length - changes.length };
    });
  }

  /** Admin endpoint: drop manual overrides so customers follow their area default again. */
  async resetToAreaDefault(input: { customerIds: string[]; reason: string }, actorId: string) {
    return this.db.transaction().execute(async (trx) => {
      const ids = await this.assertCustomersExist(trx, input.customerIds);
      const changes = await this.applyAreaDefault(trx, ids, actorId, input.reason, { force: true });
      await this.afterPermanentChanges(trx, changes, input.reason, 'assignment.reset_to_area_default');
      return { changed: changes.length };
    });
  }

  /** Audit + notify agents after PRIMARY changes. */
  async afterPermanentChanges(db: Database, changes: AssignmentChange[], reason: string, action: string): Promise<void> {
    if (changes.length === 0) return;
    for (const c of changes) {
      await this.audit.record(db, {
        action,
        entityType: 'customer',
        entityId: c.customerId,
        before: { agentId: c.fromAgentId },
        after: { agentId: c.toAgentId },
        reason,
      });
    }
    const gained = countBy(changes, (c) => c.toAgentId);
    const lost = countBy(changes.filter((c) => c.fromAgentId), (c) => c.fromAgentId!);
    for (const [agentId, n] of gained) {
      await this.notifications.notify(db, [agentId], {
        type: 'ASSIGNMENT_ADDED',
        title: 'New customers assigned',
        body: `${n} customer(s) have been assigned to you.`,
        data: { count: n, reason },
      });
    }
    for (const [agentId, n] of lost) {
      await this.notifications.notify(db, [agentId], {
        type: 'ASSIGNMENT_REMOVED',
        title: 'Customers reassigned',
        body: `${n} customer(s) have been moved to another agent.`,
        data: { count: n, reason },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Area default owner
  // ---------------------------------------------------------------------------

  async setAreaOwner(
    areaId: string,
    input: { agentId: string | null; reason: string; applyToManualOverrides: boolean },
    actorId: string,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const area = await trx.selectFrom('areas').select(['id', 'name']).where('id', '=', areaId).forUpdate().executeTakeFirst();
      if (!area) throw notFound('AREA_NOT_FOUND', 'Area not found');
      if (input.agentId) await this.assertActiveAgent(trx, input.agentId);

      const current = await trx
        .selectFrom('areaAgentAssignments')
        .select(['id', 'agentId'])
        .where('areaId', '=', areaId)
        .where(sql<boolean>`valid_during @> now()`)
        .executeTakeFirst();

      if (current?.agentId !== input.agentId) {
        if (current) {
          await trx
            .updateTable('areaAgentAssignments')
            .set({
              validDuring: sql<string>`tstzrange(lower(valid_during), now())`,
              endedBy: actorId,
              endedReason: input.reason,
            })
            .where('id', '=', current.id)
            .execute();
        }
        if (input.agentId) {
          await trx
            .insertInto('areaAgentAssignments')
            .values({
              areaId,
              agentId: input.agentId,
              validDuring: sql<string>`tstzrange(now(), NULL)`,
              reason: input.reason,
              createdBy: actorId,
            })
            .execute();
        }
        await this.audit.record(trx, {
          action: 'area.owner_changed',
          entityType: 'area',
          entityId: areaId,
          before: { agentId: current?.agentId ?? null },
          after: { agentId: input.agentId },
          reason: input.reason,
        });
      }

      let changes: AssignmentChange[] = [];
      if (input.agentId) {
        const customerIds = await this.customerIdsInArea(trx, areaId);
        changes = await this.applyAreaDefault(trx, customerIds, actorId, input.reason, {
          force: input.applyToManualOverrides,
        });
        await this.afterPermanentChanges(trx, changes, input.reason, 'assignment.area_default');
      }
      return { areaId, agentId: input.agentId, customersMoved: changes.length };
    });
  }

  // ---------------------------------------------------------------------------
  // Temporary reassignment
  // ---------------------------------------------------------------------------

  async createTemporary(input: TemporaryReassignmentRequest, actorId: string) {
    return this.db.transaction().execute(async (trx) => {
      const from = await trx
        .selectFrom('agentProfiles as a')
        .innerJoin('users as u', 'u.id', 'a.userId')
        .select(['u.id', 'u.fullName', 'a.agentCode'])
        .where('u.id', '=', input.fromAgentId)
        .executeTakeFirst();
      if (!from) throw notFound('AGENT_NOT_FOUND', 'Source agent not found');
      const to = await this.assertActiveAgent(trx, input.toAgentId);

      const today = businessDateOf(new Date());
      if (input.startsOn < today) throw unprocessable('START_IN_PAST', 'Start date cannot be in the past');

      // Only customers whose PRIMARY agent is the source agent can be lent out.
      const ownedRows = await trx
        .selectFrom('customerPrimaryAgent as p')
        .innerJoin('customers as c', 'c.id', 'p.customerId')
        .select(['c.id', 'c.customerCode', 'c.societyId'])
        .where('p.agentId', '=', input.fromAgentId)
        .execute();
      const owned = new Map(ownedRows.map((r) => [r.id, r]));

      let customerIds: string[];
      if (input.scope === 'ALL_OF_AGENT') {
        customerIds = [...owned.keys()];
      } else if (input.scope === 'SOCIETIES') {
        const societyIds = new Set(input.societyIds);
        const found = await trx.selectFrom('societies').select('id').where('id', 'in', [...societyIds]).execute();
        if (found.length !== societyIds.size) throw notFound('SOCIETY_NOT_FOUND', 'One or more societies not found');
        customerIds = ownedRows.filter((r) => societyIds.has(r.societyId)).map((r) => r.id);
      } else {
        const requested = [...new Set(input.customerIds)];
        const notOwned = requested.filter((id) => !owned.has(id));
        if (notOwned.length > 0) {
          const codes = await trx.selectFrom('customers').select(['id', 'customerCode']).where('id', 'in', notOwned).execute();
          throw unprocessable('CUSTOMERS_NOT_ASSIGNED_TO_AGENT', `Some customers are not assigned to ${from.agentCode}`, {
            customers: notOwned.map((id) => codes.find((c) => c.id === id)?.customerCode ?? id),
          });
        }
        customerIds = requested;
      }
      if (customerIds.length === 0) throw unprocessable('NO_CUSTOMERS', 'No customers match the selection');

      await this.lockCustomers(trx, customerIds);
      const start = startOfBusinessDay(input.startsOn);
      const end = startOfBusinessDay(addDays(input.endsOn, 1));
      const range = sql<string>`tstzrange(greatest(${start}::timestamptz, now()), ${end}::timestamptz)`;

      const clashes = await trx
        .selectFrom('customerAgentAssignments as t')
        .innerJoin('customers as c', 'c.id', 't.customerId')
        .innerJoin('agentProfiles as a', 'a.userId', 't.agentId')
        .select([
          'c.customerCode',
          'a.agentCode',
          sql<Date>`lower(t.valid_during)`.as('from'),
          sql<Date>`upper(t.valid_during)`.as('to'),
        ])
        .where('t.kind', '=', 'TEMPORARY')
        .where('t.customerId', 'in', customerIds)
        .where(sql<boolean>`t.valid_during && ${range}`)
        .execute();
      if (clashes.length > 0) {
        throw conflict('TEMPORARY_ASSIGNMENT_CONFLICT', 'Some customers already have a temporary assignment in this period', {
          conflicts: clashes,
        });
      }

      const header = await trx
        .insertInto('tempReassignments')
        .values({
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId,
          scope: input.scope,
          scopeIds: input.scope === 'SOCIETIES' ? (input.societyIds ?? null) : input.scope === 'CUSTOMERS' ? customerIds : null,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          reason: input.reason,
          customerCount: customerIds.length,
          createdBy: actorId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('customerAgentAssignments')
        .values(
          customerIds.map((customerId) => ({
            customerId,
            agentId: input.toAgentId,
            kind: 'TEMPORARY' as const,
            source: 'TEMP_REASSIGNMENT' as const,
            validDuring: range,
            tempReassignmentId: header.id,
            reason: input.reason,
            createdBy: actorId,
          })),
        )
        .execute();

      await this.audit.record(trx, {
        action: 'assignment.temporary_created',
        entityType: 'temp_reassignment',
        entityId: header.id,
        after: { ...header, customerIds },
        reason: input.reason,
      });
      const period = input.startsOn === input.endsOn ? input.startsOn : `${input.startsOn} to ${input.endsOn}`;
      await this.notifications.notify(trx, [input.toAgentId], {
        type: 'TEMP_ASSIGNMENT_RECEIVED',
        title: 'Temporary customers assigned',
        body: `You will cover ${customerIds.length} customer(s) of ${from.fullName} (${period}).`,
        data: { tempReassignmentId: header.id, startsOn: input.startsOn, endsOn: input.endsOn },
      });
      await this.notifications.notify(trx, [input.fromAgentId], {
        type: 'TEMP_ASSIGNMENT_GIVEN',
        title: 'Your customers are temporarily reassigned',
        body: `${to.fullName} will cover ${customerIds.length} of your customer(s) (${period}).`,
        data: { tempReassignmentId: header.id, startsOn: input.startsOn, endsOn: input.endsOn },
      });
      return { ...this.withStatus(header), customerIds };
    });
  }

  async revokeTemporary(id: string, reason: string, actorId: string) {
    return this.db.transaction().execute(async (trx) => {
      const header = await trx.selectFrom('tempReassignments').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!header) throw notFound('TEMP_REASSIGNMENT_NOT_FOUND', 'Temporary reassignment not found');
      const status = this.statusOf(header);
      if (status === 'REVOKED') throw conflict('ALREADY_REVOKED', 'This reassignment was already revoked');
      if (status === 'ENDED') throw conflict('ALREADY_ENDED', 'This reassignment has already ended');

      // Shorten every still-running/future row to end now (future rows become empty ranges).
      await trx
        .updateTable('customerAgentAssignments')
        .set({
          validDuring: sql<string>`tstzrange(lower(valid_during), greatest(lower(valid_during), now()))`,
          endedBy: actorId,
          endedAt: sql<Date>`now()`,
          endedReason: reason,
        })
        .where('tempReassignmentId', '=', id)
        .where(sql<boolean>`NOT isempty(valid_during) AND upper(valid_during) > now()`)
        .execute();
      const updated = await trx
        .updateTable('tempReassignments')
        .set({ revokedBy: actorId, revokedAt: sql<Date>`now()`, revokeReason: reason })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.audit.record(trx, {
        action: 'assignment.temporary_revoked',
        entityType: 'temp_reassignment',
        entityId: id,
        before: { status },
        after: { status: 'REVOKED' },
        reason,
      });
      await this.notifications.notify(trx, [header.toAgentId, header.fromAgentId], {
        type: 'TEMP_ASSIGNMENT_REVOKED',
        title: 'Temporary reassignment ended',
        body: `The temporary reassignment of ${header.customerCount} customer(s) has been ended by the admin.`,
        data: { tempReassignmentId: id },
      });
      return this.withStatus(updated);
    });
  }

  async listTemporary(filter: { status?: TempStatus; agentId?: string; page: number; pageSize: number }) {
    const today = businessDateOf(new Date());
    let q = this.db.selectFrom('tempReassignments as t');
    if (filter.agentId) q = q.where((eb) => eb.or([eb('t.fromAgentId', '=', filter.agentId!), eb('t.toAgentId', '=', filter.agentId!)]));
    switch (filter.status) {
      case 'REVOKED':
        q = q.where('t.revokedAt', 'is not', null);
        break;
      case 'SCHEDULED':
        q = q.where('t.revokedAt', 'is', null).where('t.startsOn', '>', today);
        break;
      case 'ACTIVE':
        q = q.where('t.revokedAt', 'is', null).where('t.startsOn', '<=', today).where('t.endsOn', '>=', today);
        break;
      case 'ENDED':
        q = q.where('t.revokedAt', 'is', null).where('t.endsOn', '<', today);
        break;
    }
    const [rows, total] = await Promise.all([
      q
        .innerJoin('users as fu', 'fu.id', 't.fromAgentId')
        .innerJoin('users as tu', 'tu.id', 't.toAgentId')
        .selectAll('t')
        .select(['fu.fullName as fromAgentName', 'tu.fullName as toAgentName'])
        .orderBy('t.startsOn', 'desc')
        .orderBy('t.createdAt', 'desc')
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize)
        .execute(),
      q.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(
      rows.map((r) => this.withStatus(r)),
      { page: filter.page, pageSize: filter.pageSize, total: Number(total.n) },
    );
  }

  async getTemporary(id: string) {
    const header = await this.db.selectFrom('tempReassignments').selectAll().where('id', '=', id).executeTakeFirst();
    if (!header) throw notFound('TEMP_REASSIGNMENT_NOT_FOUND', 'Temporary reassignment not found');
    const customers = await this.db
      .selectFrom('customerAgentAssignments as t')
      .innerJoin('customers as c', 'c.id', 't.customerId')
      .select(['c.id', 'c.customerCode', 'c.name', 't.endedAt', 't.endedReason'])
      .where('t.tempReassignmentId', '=', id)
      .orderBy('c.customerCode')
      .execute();
    return { ...this.withStatus(header), customers };
  }

  /** Full assignment history of one customer (newest first). */
  async customerHistory(customerId: string) {
    return this.db
      .selectFrom('customerAgentAssignments as h')
      .innerJoin('users as u', 'u.id', 'h.agentId')
      .innerJoin('agentProfiles as a', 'a.userId', 'h.agentId')
      .select([
        'h.id',
        'h.kind',
        'h.source',
        'h.agentId',
        'u.fullName as agentName',
        'a.agentCode',
        sql<Date | null>`lower(h.valid_during)`.as('validFrom'),
        sql<Date | null>`upper(h.valid_during)`.as('validTo'),
        sql<boolean>`isempty(h.valid_during)`.as('cancelledBeforeStart'),
        sql<boolean>`h.valid_during @> now()`.as('isCurrent'),
        'h.tempReassignmentId',
        'h.reason',
        'h.createdBy',
        'h.createdAt',
        'h.endedBy',
        'h.endedAt',
        'h.endedReason',
      ])
      .where('h.customerId', '=', customerId)
      .orderBy('h.createdAt', 'desc')
      .execute();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  statusOf(t: { revokedAt: Date | null; startsOn: string; endsOn: string }): TempStatus {
    if (t.revokedAt) return 'REVOKED';
    const today = businessDateOf(new Date());
    if (today < t.startsOn) return 'SCHEDULED';
    if (today > t.endsOn) return 'ENDED';
    return 'ACTIVE';
  }

  private withStatus<T extends { revokedAt: Date | null; startsOn: string; endsOn: string }>(t: T): T & { status: TempStatus } {
    return { ...t, status: this.statusOf(t) };
  }

  async customerIdsInArea(db: Database, areaId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('customers as c')
      .innerJoin('societies as s', 's.id', 'c.societyId')
      .select('c.id')
      .where('s.areaId', '=', areaId)
      .execute();
    return rows.map((r) => r.id);
  }

  async customerIdsInSocieties(db: Database, societyIds: string[], mustExist = false): Promise<string[]> {
    if (mustExist) {
      const found = await db.selectFrom('societies').select('id').where('id', 'in', societyIds).execute();
      if (found.length !== new Set(societyIds).size) throw notFound('SOCIETY_NOT_FOUND', 'Society not found');
    }
    const rows = await db.selectFrom('customers').select('id').where('societyId', 'in', societyIds).execute();
    return rows.map((r) => r.id);
  }

  private async assertCustomersExist(db: Database, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await db.selectFrom('customers').select('id').where('id', 'in', unique).execute();
    if (rows.length !== unique.length) throw notFound('CUSTOMER_NOT_FOUND', 'One or more customers not found');
    return unique;
  }
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return m;
}
