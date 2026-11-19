import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  CreateFollowUpRequest,
  CreateInteractionRequest,
  ListFollowUpsQuery,
  ListInteractionsQuery,
  RecordVisitRequest,
  UpdateInteractionRequest,
} from '@cablenet/contracts';
import { businessDateOf, canReadAllCustomers, hasPermission } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import type { InteractionStatus } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { Page } from '../../common/http';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { CustomerAccessService } from '../customers/customer-access.service';

/**
 * Visits (agent field work), interactions (calls, walk-ins, promises to pay) and follow-up
 * tasks. A promise to pay is never money: only a confirmed payment changes balances; a
 * confirmed payment closes the customer's open promises (see resolvePromises).
 */
@Injectable()
export class FieldOpsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: CustomerAccessService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Visits
  // ---------------------------------------------------------------------------

  async recordVisit(customerId: string, input: RecordVisitRequest, user: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.access.assertCanAccess(user, customerId, trx);
      return this.recordVisitIn(trx, customerId, input, user);
    });
  }

  /** Records a visit inside the caller's transaction (access already checked). Idempotent by clientId. */
  async recordVisitIn(trx: Database, customerId: string, input: RecordVisitRequest, user: AuthUser) {
    {
      const existing = await trx.selectFrom('visits').selectAll().where('clientId', '=', input.clientId).executeTakeFirst();
      if (existing) {
        if (existing.customerId !== customerId || existing.agentId !== user.id) {
          throw conflict('CLIENT_ID_CONFLICT', 'This visit id was already used for a different visit');
        }
        return { ...existing, replayed: true };
      }
      if (input.paymentId) {
        const p = await trx.selectFrom('payments').select(['customerId']).where('id', '=', input.paymentId).executeTakeFirst();
        if (!p || p.customerId !== customerId) throw unprocessable('PAYMENT_NOT_FOR_CUSTOMER', 'The linked payment belongs to another customer');
      }
      const visit = await trx
        .insertInto('visits')
        .values({
          clientId: input.clientId,
          customerId,
          agentId: user.id,
          visitedAt: input.visitedAt ?? sql<Date>`now()`,
          outcome: input.outcome,
          paymentId: input.paymentId ?? null,
          promisedAmount: input.promisedAmount ?? null,
          promisedDate: input.promisedDate ?? null,
          followUpDate: input.followUpDate ?? null,
          notes: input.notes ?? null,
          gpsLat: input.gps ? String(input.gps.lat) : null,
          gpsLng: input.gps ? String(input.gps.lng) : null,
          gpsAccuracyM: input.gps?.accuracyM ?? null,
          deviceId: user.deviceId,
          recordedOffline: input.recordedOffline,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // "Will pay later" with an amount/date is a promise to pay; follow-ups become tasks.
      if (input.outcome === 'WILL_PAY_LATER' && input.promisedAmount && input.promisedDate) {
        await trx
          .insertInto('interactions')
          .values({
            customerId,
            channel: 'VISIT',
            interactionType: 'PAYMENT_PROMISE',
            expectedAmount: input.promisedAmount,
            promiseDate: input.promisedDate,
            followUpDate: input.followUpDate ?? input.promisedDate,
            status: 'PROMISE_TO_PAY',
            notes: input.notes ?? null,
            recordedBy: user.id,
          })
          .execute();
      }
      const followUp = input.followUpDate ?? (input.outcome === 'WILL_PAY_LATER' ? input.promisedDate : null);
      if (followUp) {
        await trx
          .insertInto('followUpTasks')
          .values({
            customerId,
            assignedTo: user.role === 'AGENT' ? user.id : null,
            dueDate: followUp,
            title: `Revisit: ${input.outcome.replace(/_/g, ' ').toLowerCase()}`,
            sourceType: 'VISIT',
            sourceId: visit.id,
            createdBy: user.id,
          })
          .execute();
      }
      await this.audit.record(trx, { action: 'visit.recorded', entityType: 'visit', entityId: visit.id, after: { customerId, outcome: input.outcome } });
      return { ...visit, replayed: false };
    }
  }

  async customerVisits(customerId: string, user: AuthUser, page: number, pageSize: number) {
    await this.access.assertCanAccess(user, customerId);
    const q = this.db.selectFrom('visits as v').innerJoin('users as u', 'u.id', 'v.agentId').where('v.customerId', '=', customerId);
    const [items, total] = await Promise.all([
      q.selectAll('v').select('u.fullName as agentName').orderBy('v.visitedAt', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute(),
      q.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page, pageSize, total: Number(total.n) });
  }

  // ---------------------------------------------------------------------------
  // Interactions (admin)
  // ---------------------------------------------------------------------------

  async createInteraction(customerId: string, input: CreateInteractionRequest, user: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.access.assertCanAccess(user, customerId, trx);
      const status: InteractionStatus =
        input.interactionType === 'PAYMENT_PROMISE' ? 'PROMISE_TO_PAY' : input.followUpDate ? 'FOLLOW_UP_REQUIRED' : 'PENDING';
      const interaction = await trx
        .insertInto('interactions')
        .values({
          customerId,
          channel: input.channel,
          interactionType: input.interactionType,
          expectedAmount: input.expectedAmount ?? null,
          promiseDate: input.promiseDate ?? null,
          followUpDate: input.followUpDate ?? input.promiseDate ?? null,
          status,
          notes: input.notes ?? null,
          recordedBy: user.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const due = input.followUpDate ?? input.promiseDate;
      if (due) {
        if (input.followUpAssigneeId) await this.assertStaff(trx, input.followUpAssigneeId);
        await trx
          .insertInto('followUpTasks')
          .values({
            customerId,
            assignedTo: input.followUpAssigneeId ?? user.id,
            dueDate: due,
            title:
              input.interactionType === 'PAYMENT_PROMISE'
                ? `Promised ₹${input.expectedAmount} by ${input.promiseDate}`
                : `Follow up: ${input.interactionType.replace(/_/g, ' ').toLowerCase()}`,
            sourceType: 'INTERACTION',
            sourceId: interaction.id,
            createdBy: user.id,
          })
          .execute();
      }
      await this.audit.record(trx, { action: 'interaction.created', entityType: 'interaction', entityId: interaction.id, after: interaction });
      return interaction;
    });
  }

  async updateInteraction(id: string, input: UpdateInteractionRequest, user: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('interactions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('INTERACTION_NOT_FOUND', 'Interaction not found');
      const after = await trx
        .updateTable('interactions')
        .set({
          ...(input.status !== undefined && { status: input.status }),
          ...(input.notes !== undefined && { notes: input.notes }),
          ...(input.followUpDate !== undefined && { followUpDate: input.followUpDate }),
          ...(input.status === 'COMPLETED' || input.status === 'NOT_INTERESTED' ? { resolvedAt: sql<Date>`now()` } : {}),
          updatedBy: user.id,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (input.status === 'COMPLETED' || input.status === 'NOT_INTERESTED') {
        await this.closeTasksFor(trx, 'INTERACTION', [id], user.id, `Interaction ${input.status.toLowerCase().replace('_', ' ')}`);
      }
      await this.audit.record(trx, {
        action: 'interaction.updated',
        entityType: 'interaction',
        entityId: id,
        before: { status: before.status, notes: before.notes, followUpDate: before.followUpDate },
        after: { status: after.status, notes: after.notes, followUpDate: after.followUpDate },
      });
      return after;
    });
  }

  async listInteractions(q: ListInteractionsQuery, user: AuthUser) {
    if (q.customerId) await this.access.assertCanAccess(user, q.customerId);
    else if (!canReadAllCustomers(user.role)) throw notFound('NOT_FOUND', 'Choose a customer');
    let query = this.db
      .selectFrom('interactions as i')
      .innerJoin('customers as c', 'c.id', 'i.customerId')
      .innerJoin('users as u', 'u.id', 'i.recordedBy');
    if (q.customerId) query = query.where('i.customerId', '=', q.customerId);
    if (q.status) query = query.where('i.status', '=', q.status);
    if (q.interactionType) query = query.where('i.interactionType', '=', q.interactionType);
    if (q.from) query = query.where(sql<boolean>`(i.created_at AT TIME ZONE 'Asia/Kolkata')::date >= ${q.from}::date`);
    if (q.to) query = query.where(sql<boolean>`(i.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${q.to}::date`);
    const [items, total] = await Promise.all([
      query
        .selectAll('i')
        .select(['c.customerCode', 'c.name as customerName', 'u.fullName as recordedByName'])
        .orderBy('i.createdAt', 'desc')
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page: q.page, pageSize: q.pageSize, total: Number(total.n) });
  }

  /**
   * Called inside the payment-confirmation transaction: open promises for the customer are
   * marked COMPLETED and linked to the payment; their follow-up tasks are closed.
   */
  async resolvePromises(trx: Database, customerId: string, paymentId: string, actorId: string): Promise<number> {
    const resolved = await trx
      .updateTable('interactions')
      .set({ status: 'COMPLETED', resolvedPaymentId: paymentId, resolvedAt: sql<Date>`now()`, updatedBy: actorId })
      .where('customerId', '=', customerId)
      .where('status', '=', 'PROMISE_TO_PAY')
      .returning('id')
      .execute();
    await this.closeTasksFor(trx, 'INTERACTION', resolved.map((r) => r.id), actorId, 'Payment received');
    return resolved.length;
  }

  // ---------------------------------------------------------------------------
  // Follow-ups
  // ---------------------------------------------------------------------------

  async createFollowUp(customerId: string, input: CreateFollowUpRequest, user: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.access.assertCanAccess(user, customerId, trx);
      const assignee = input.assignedTo ?? user.id;
      if (assignee !== user.id) {
        if (!hasPermission(user.role, 'followups:manage')) throw unprocessable('CANNOT_ASSIGN', 'You can only create follow-ups for yourself');
        await this.assertStaff(trx, assignee);
      }
      const task = await trx
        .insertInto('followUpTasks')
        .values({ customerId, assignedTo: assignee, dueDate: input.dueDate, title: input.title, sourceType: 'MANUAL', createdBy: user.id })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'followup.created', entityType: 'follow_up', entityId: task.id, after: task });
      return task;
    });
  }

  async listFollowUps(q: ListFollowUpsQuery, user: AuthUser) {
    const today = businessDateOf(new Date());
    const manageAll = hasPermission(user.role, 'followups:manage');
    let query = this.db
      .selectFrom('followUpTasks as t')
      .innerJoin('customers as c', 'c.id', 't.customerId')
      .innerJoin('societies as s', 's.id', 'c.societyId')
      .leftJoin('users as a', 'a.id', 't.assignedTo')
      .leftJoin('customerCurrentAgent as ca', 'ca.customerId', 't.customerId')
      .where('t.status', '=', q.status);
    if (!manageAll || q.scope === 'mine') {
      // Mine: assigned to me, or (agents) unassigned tasks for customers currently mine.
      query = query.where((eb) =>
        eb.or([
          eb('t.assignedTo', '=', user.id),
          ...(user.role === 'AGENT' ? [eb.and([eb('t.assignedTo', 'is', null), eb('ca.agentId', '=', user.id)])] : []),
        ]),
      );
    }
    if (user.role === 'AGENT') query = query.where('ca.agentId', '=', user.id); // never another agent's customers
    if (q.customerId) query = query.where('t.customerId', '=', q.customerId);
    if (q.due === 'overdue') query = query.where('t.dueDate', '<', today);
    if (q.due === 'today') query = query.where('t.dueDate', '=', today);
    if (q.due === 'upcoming') query = query.where('t.dueDate', '>', today);
    const [items, total] = await Promise.all([
      query
        .selectAll('t')
        .select(['c.customerCode', 'c.name as customerName', 'c.mobile', 's.name as societyName', 'a.fullName as assignedToName'])
        .select(sql<boolean>`t.due_date < ${today}::date AND t.status = 'OPEN'`.as('overdue'))
        .orderBy('t.dueDate')
        .orderBy('t.createdAt')
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page: q.page, pageSize: q.pageSize, total: Number(total.n) });
  }

  async closeFollowUp(id: string, status: 'DONE' | 'CANCELLED', note: string | null | undefined, user: AuthUser) {
    return this.db.transaction().execute((trx) => this.closeFollowUpIn(trx, id, status, note, user));
  }

  async closeFollowUpIn(trx: Database, id: string, status: 'DONE' | 'CANCELLED', note: string | null | undefined, user: AuthUser) {
    {
      const task = await trx.selectFrom('followUpTasks').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!task) throw notFound('FOLLOW_UP_NOT_FOUND', 'Follow-up not found');
      if (!hasPermission(user.role, 'followups:manage') && task.assignedTo !== user.id) {
        await this.access.assertCanAccess(user, task.customerId, trx).catch(() => {
          throw notFound('FOLLOW_UP_NOT_FOUND', 'Follow-up not found');
        });
        if (task.assignedTo !== null) throw notFound('FOLLOW_UP_NOT_FOUND', 'Follow-up not found');
      }
      if (task.status !== 'OPEN') throw conflict('FOLLOW_UP_CLOSED', `Follow-up is already ${task.status.toLowerCase()}`);
      const updated = await trx
        .updateTable('followUpTasks')
        .set({ status, completedAt: sql<Date>`now()`, completedBy: user.id, outcomeNote: note ?? null })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: `followup.${status.toLowerCase()}`, entityType: 'follow_up', entityId: id, reason: note ?? null });
      return updated;
    }
  }

  private async closeTasksFor(db: Database, sourceType: 'INTERACTION' | 'VISIT', sourceIds: string[], actorId: string, note: string) {
    if (sourceIds.length === 0) return;
    await db
      .updateTable('followUpTasks')
      .set({ status: 'DONE', completedAt: sql<Date>`now()`, completedBy: actorId, outcomeNote: note })
      .where('sourceType', '=', sourceType)
      .where('sourceId', 'in', sourceIds)
      .where('status', '=', 'OPEN')
      .execute();
  }

  private async assertStaff(db: Database, userId: string) {
    const u = await db.selectFrom('users').select(['status']).where('id', '=', userId).executeTakeFirst();
    if (!u || u.status !== 'ACTIVE') throw unprocessable('ASSIGNEE_NOT_ACTIVE', 'Follow-up assignee must be an active user');
  }
}
