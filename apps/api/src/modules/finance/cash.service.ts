import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { CashAdjustmentRequest, ConfirmHandoverRequest, SubmitHandoverRequest } from '@cablenet/contracts';
import { businessDateOf, canReadAllCustomers, fromPaise, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { Page } from '../../common/http';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { NotificationsService } from '../core/notifications.service';
import { AlertsService } from './alerts.service';
import { LedgerService } from './ledger.service';

/**
 * Cash accountability (FINANCIAL_LOGIC §6). Only CASH payments count; UPI/bank/cheque never
 * enter cash in hand.
 *
 *   cash in hand = Σ confirmed cash collected
 *                − Σ cash received by the office (confirmed handovers)
 *                − Σ adjustments (recoveries / write-offs; negative = correction upward)
 */
@Injectable()
export class CashService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly alerts: AlertsService,
  ) {}

  async summary(agentId: string, date = businessDateOf(new Date())) {
    const agent = await this.db
      .selectFrom('users as u')
      .innerJoin('agentProfiles as a', 'a.userId', 'u.id')
      .select(['u.id', 'u.fullName', 'a.agentCode'])
      .where('u.id', '=', agentId)
      .executeTakeFirst();
    if (!agent) throw notFound('AGENT_NOT_FOUND', 'Agent not found');

    const r = await sql<{
      collected: string;
      received: string;
      adjusted: string;
      unhanded: string;
      unhandedCount: string;
      pendingExpected: string;
      todayCash: string;
      todayUpi: string;
      todayOther: string;
      todayPendingVerification: string;
      todayCount: string;
      openingCash: string;
    }>`
      SELECT
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE collected_by = ${agentId} AND mode = 'CASH' AND status = 'CONFIRMED') AS collected,
        (SELECT coalesce(sum(received_amount), 0) FROM cash_handovers WHERE agent_id = ${agentId} AND status = 'CONFIRMED') AS received,
        (SELECT coalesce(sum(amount), 0) FROM cash_adjustments WHERE agent_id = ${agentId}) AS adjusted,
        (SELECT coalesce(sum(p.amount), 0) FROM payments p
          WHERE p.collected_by = ${agentId} AND p.mode = 'CASH' AND p.status = 'CONFIRMED'
            AND NOT EXISTS (SELECT 1 FROM cash_handover_items i WHERE i.payment_id = p.id)) AS unhanded,
        (SELECT count(*) FROM payments p
          WHERE p.collected_by = ${agentId} AND p.mode = 'CASH' AND p.status = 'CONFIRMED'
            AND NOT EXISTS (SELECT 1 FROM cash_handover_items i WHERE i.payment_id = p.id)) AS unhanded_count,
        (SELECT coalesce(sum(expected_amount), 0) FROM cash_handovers WHERE agent_id = ${agentId} AND status = 'SUBMITTED') AS pending_expected,
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE collected_by = ${agentId} AND payment_date = ${date}::date AND mode = 'CASH' AND status = 'CONFIRMED') AS today_cash,
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE collected_by = ${agentId} AND payment_date = ${date}::date AND mode = 'UPI' AND status = 'CONFIRMED') AS today_upi,
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE collected_by = ${agentId} AND payment_date = ${date}::date AND mode NOT IN ('CASH', 'UPI') AND status = 'CONFIRMED') AS today_other,
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE collected_by = ${agentId} AND payment_date = ${date}::date AND status = 'PENDING_VERIFICATION') AS today_pending_verification,
        (SELECT count(*) FROM payments WHERE collected_by = ${agentId} AND payment_date = ${date}::date AND status IN ('CONFIRMED', 'PENDING_VERIFICATION')) AS today_count,
        -- cash in hand at the start of the day: everything before it
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE collected_by = ${agentId} AND mode = 'CASH' AND status = 'CONFIRMED' AND payment_date < ${date}::date)
          - (SELECT coalesce(sum(received_amount), 0) FROM cash_handovers WHERE agent_id = ${agentId} AND status = 'CONFIRMED' AND (verified_at AT TIME ZONE 'Asia/Kolkata')::date < ${date}::date)
          - (SELECT coalesce(sum(amount), 0) FROM cash_adjustments WHERE agent_id = ${agentId} AND (created_at AT TIME ZONE 'Asia/Kolkata')::date < ${date}::date) AS opening_cash
    `.execute(this.db);
    const x = r.rows[0]!;
    // SQL sums come back as e.g. "0" or "700.00"; normalise every amount to 2 decimals.
    const m = (v: string) => fromPaise(toPaise(v));
    const cashInHand = toPaise(x.collected) - toPaise(x.received) - toPaise(x.adjusted);
    return {
      agent,
      cashInHand: fromPaise(cashInHand),
      cashNotYetHandedOver: m(x.unhanded),
      paymentsNotYetHandedOver: Number(x.unhandedCount),
      pendingHandoverAmount: m(x.pendingExpected),
      day: {
        date,
        openingCash: m(x.openingCash),
        cashCollected: m(x.todayCash),
        upiCollected: m(x.todayUpi),
        otherCollected: m(x.todayOther),
        pendingVerification: m(x.todayPendingVerification),
        payments: Number(x.todayCount),
      },
    };
  }

  async allAgents() {
    const agents = await this.db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'AGENT')
      .orderBy('fullName')
      .execute();
    return Promise.all(agents.map((a) => this.summary(a.id)));
  }

  /** Agent hands over every confirmed cash payment not yet handed over. */
  async submit(agent: AuthUser, input: SubmitHandoverRequest) {
    return this.db.transaction().execute(async (trx) => {
      await trx.selectFrom('users').select('id').where('id', '=', agent.id).forUpdate().executeTakeFirstOrThrow();
      const open = await trx
        .selectFrom('cashHandovers')
        .select('handoverNumber')
        .where('agentId', '=', agent.id)
        .where('status', '=', 'SUBMITTED')
        .executeTakeFirst();
      if (open) throw conflict('HANDOVER_PENDING', `Handover ${open.handoverNumber} is still waiting for the office`);

      const items = await trx
        .selectFrom('payments as p')
        .select(['p.id', 'p.amount'])
        .where('p.collectedBy', '=', agent.id)
        .where('p.mode', '=', 'CASH')
        .where('p.status', '=', 'CONFIRMED')
        .where((eb) => eb.not(eb.exists(eb.selectFrom('cashHandoverItems as i').select('i.paymentId').whereRef('i.paymentId', '=', 'p.id'))))
        .orderBy('p.createdAt')
        .forUpdate()
        .execute();
      if (items.length === 0) throw unprocessable('NOTHING_TO_HAND_OVER', 'There is no cash waiting to be handed over');
      const expected = items.reduce((s, i) => s + toPaise(i.amount), 0n);

      const handover = await trx
        .insertInto('cashHandovers')
        .values({
          handoverNumber: await this.ledger.nextNumber(trx, 'CHO', businessDateOf(new Date())),
          agentId: agent.id,
          expectedAmount: fromPaise(expected),
          declaredAmount: input.declaredAmount,
          notes: input.notes ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('cashHandoverItems')
        .values(items.map((i) => ({ handoverId: handover.id, paymentId: i.id, amount: i.amount })))
        .execute();
      await this.audit.record(trx, {
        action: 'cash.handover_submitted',
        entityType: 'cash_handover',
        entityId: handover.id,
        after: { expected: handover.expectedAmount, declared: handover.declaredAmount, payments: items.length },
      });
      const admins = await trx.selectFrom('users').select('id').where('role', 'in', ['ADMIN', 'SUPER_ADMIN']).where('status', '=', 'ACTIVE').execute();
      await this.notifications.notify(
        trx,
        admins.map((a) => a.id),
        {
          type: 'CASH_HANDOVER_SUBMITTED',
          title: 'Cash handover submitted',
          body: `${agent.fullName} submitted ₹${handover.declaredAmount} (system expects ₹${handover.expectedAmount}).`,
          data: { handoverId: handover.id },
        },
      );
      return { ...handover, paymentCount: items.length };
    });
  }

  async confirm(id: string, input: ConfirmHandoverRequest, admin: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const h = await this.lockHandover(trx, id);
      if (h.status !== 'SUBMITTED') throw conflict('HANDOVER_NOT_PENDING', `Handover is ${h.status}`);
      // Maker-checker: the person who hands over cash cannot also confirm it (security review L-8).
      if (h.agentId === admin.id) throw forbidden('SELF_CONFIRMATION', 'Someone else must confirm your own handover');
      const difference = toPaise(input.receivedAmount) - toPaise(h.expectedAmount);
      if (difference !== 0n && !input.mismatchReason) {
        throw badRequest('MISMATCH_REASON_REQUIRED', `Received amount differs from expected by ₹${fromPaise(difference)}; record the reason`);
      }
      const updated = await trx
        .updateTable('cashHandovers')
        .set({
          status: 'CONFIRMED',
          receivedAmount: input.receivedAmount,
          difference: fromPaise(difference),
          verifiedBy: admin.id,
          verifiedAt: sql<Date>`now()`,
          mismatchReason: input.mismatchReason ?? null,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        action: 'cash.handover_confirmed',
        entityType: 'cash_handover',
        entityId: id,
        before: { status: 'SUBMITTED', expected: h.expectedAmount },
        after: { status: 'CONFIRMED', received: input.receivedAmount, difference: fromPaise(difference) },
        reason: input.mismatchReason ?? null,
      });
      if (difference !== 0n) {
        await this.alerts.raise(trx, {
          type: 'CASH_MISMATCH',
          severity: 'WARNING',
          entityType: 'cash_handover',
          entityId: id,
          message: `Cash handover ${h.handoverNumber}: ${difference < 0n ? 'short' : 'excess'} by ₹${fromPaise(difference < 0n ? -difference : difference)}`,
          details: { expected: h.expectedAmount, received: input.receivedAmount, reason: input.mismatchReason },
        });
      }
      await this.notifications.notify(trx, [h.agentId], {
        type: 'CASH_HANDOVER_CONFIRMED',
        title: 'Cash handover confirmed',
        body:
          difference === 0n
            ? `₹${input.receivedAmount} received by the office.`
            : `₹${input.receivedAmount} received; difference ₹${fromPaise(difference)} (${input.mismatchReason}).`,
        data: { handoverId: id },
      });
      return updated;
    });
  }

  /** Office did not accept the handover: its payments go back to "not yet handed over". */
  async reject(id: string, reason: string, admin: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const h = await this.lockHandover(trx, id);
      if (h.status !== 'SUBMITTED') throw conflict('HANDOVER_NOT_PENDING', `Handover is ${h.status}`);
      await trx.deleteFrom('cashHandoverItems').where('handoverId', '=', id).execute();
      const updated = await trx
        .updateTable('cashHandovers')
        .set({ status: 'REJECTED', verifiedBy: admin.id, verifiedAt: sql<Date>`now()`, mismatchReason: reason })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'cash.handover_rejected', entityType: 'cash_handover', entityId: id, reason });
      await this.notifications.notify(trx, [h.agentId], {
        type: 'CASH_HANDOVER_REJECTED',
        title: 'Cash handover rejected',
        body: `Handover ${h.handoverNumber} was rejected: ${reason}`,
        data: { handoverId: id },
      });
      return updated;
    });
  }

  async adjust(input: CashAdjustmentRequest, admin: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const agent = await trx.selectFrom('users').select(['id', 'role']).where('id', '=', input.agentId).forUpdate().executeTakeFirst();
      if (!agent || agent.role !== 'AGENT') throw notFound('AGENT_NOT_FOUND', 'Agent not found');
      const adj = await trx
        .insertInto('cashAdjustments')
        .values({
          agentId: input.agentId,
          handoverId: input.handoverId ?? null,
          amount: input.amount,
          kind: input.kind,
          reason: input.reason,
          approvedBy: admin.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'cash.adjustment', entityType: 'cash_adjustment', entityId: adj.id, after: adj, reason: input.reason });
      // Every write-off/recovery of an agent's cash is brought to the owner's attention (review L-8).
      await this.alerts.raise(trx, {
        type: 'CASH_ADJUSTMENT',
        severity: 'WARNING',
        entityType: 'cash_adjustment',
        entityId: adj.id,
        message: `Cash ${input.kind.toLowerCase().replace('_', ' ')} of ₹${input.amount} for an agent by ${admin.id === input.agentId ? 'the agent' : 'an office user'}: ${input.reason}`.slice(0, 500),
      });
      return adj;
    });
  }

  async list(filter: { agentId?: string; status?: string; page: number; pageSize: number }, user: AuthUser) {
    let q = this.db.selectFrom('cashHandovers as h').innerJoin('users as u', 'u.id', 'h.agentId');
    if (!canReadAllCustomers(user.role)) q = q.where('h.agentId', '=', user.id);
    else if (filter.agentId) q = q.where('h.agentId', '=', filter.agentId);
    if (filter.status) q = q.where('h.status', '=', filter.status as never);
    const [items, total] = await Promise.all([
      q
        .selectAll('h')
        .select('u.fullName as agentName')
        .orderBy('h.submittedAt', 'desc')
        .limit(filter.pageSize)
        .offset((filter.page - 1) * filter.pageSize)
        .execute(),
      q.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page: filter.page, pageSize: filter.pageSize, total: Number(total.n) });
  }

  async get(id: string, user: AuthUser) {
    const h = await this.db.selectFrom('cashHandovers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!h || (!canReadAllCustomers(user.role) && h.agentId !== user.id)) throw notFound('HANDOVER_NOT_FOUND', 'Handover not found');
    const items = await this.db
      .selectFrom('cashHandoverItems as i')
      .innerJoin('payments as p', 'p.id', 'i.paymentId')
      .innerJoin('customers as c', 'c.id', 'p.customerId')
      .select(['i.paymentId', 'i.amount', 'p.paymentDate', 'p.status', 'c.customerCode', 'c.name as customerName'])
      .where('i.handoverId', '=', id)
      .orderBy('p.paymentDate')
      .execute();
    return { ...h, items };
  }

  private async lockHandover(trx: Database, id: string) {
    const h = await trx.selectFrom('cashHandovers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!h) throw notFound('HANDOVER_NOT_FOUND', 'Handover not found');
    return h;
  }
}
