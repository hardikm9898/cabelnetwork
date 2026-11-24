import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  ChangeRateRequest,
  CreateSubscriptionRequest,
  SetMonthlyChargeRequest,
  SuspendRequest,
  UpdateSubscriptionTermsRequest,
} from '@cablenet/contracts';
import {
  addDays,
  addMonths,
  businessDateOf,
  defaultAnchorDay,
  firstPeriodStart,
  fromPaise,
  periodAt,
  toPaise,
} from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { conflict, notFound, unprocessable } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { NotificationsService } from '../core/notifications.service';
import { SettingsService } from '../core/settings.service';
import { CustomerAccessService } from '../customers/customer-access.service';
import { AlertsService } from './alerts.service';
import { LedgerService } from './ledger.service';

@Injectable()
export class SubscriptionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly access: CustomerAccessService,
    private readonly alerts: AlertsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The customer's monthly charge from the next bill on; bills already made stay (agents: their
   * own customers). A customer without a plan starts billing on the 1st of next month. A change
   * made by an agent is notified to the office.
   */
  async setMonthlyCharge(customerId: string, input: SetMonthlyChargeRequest, actor: AuthUser) {
    await this.access.assertCanAccess(actor, customerId);
    const customer = await this.db.selectFrom('customers').select(['customerCode', 'name', 'deletedAt']).where('id', '=', customerId).executeTakeFirstOrThrow();
    if (customer.deletedAt) throw conflict('CUSTOMER_DELETED', 'This customer is deleted; restore it first');
    const live = await this.db
      .selectFrom('customerSubscriptions')
      .selectAll()
      .where('customerId', '=', customerId)
      .where('status', '!=', 'ENDED')
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    const reason = input.reason?.trim() || (actor.role === 'AGENT' ? 'Changed by the agent' : 'Monthly charge changed');
    let before: string | null = null;
    let from: string;
    let result: Awaited<ReturnType<SubscriptionsService['describe']>>;
    if (live) {
      from = live.nextPeriodStart < live.startDate ? live.startDate : live.nextPeriodStart;
      before = await this.currentRate(this.db, live.id, from);
      if (before !== null && toPaise(before) === toPaise(input.monthlyRate)) return this.describe(this.db, live.id);
      result = await this.changeRate(live.id, { monthlyRate: input.monthlyRate, effectiveFrom: from, reason }, actor);
    } else {
      from = addMonths(`${businessDateOf(new Date()).slice(0, 7)}-01`, 1);
      result = await this.create(
        customerId,
        { monthlyRate: input.monthlyRate, startDate: from, billingIntervalMonths: 1, billingTiming: 'ADVANCE', billingMode: 'AUTO', notes: null },
        actor,
      );
    }
    if (actor.role === 'AGENT') {
      const admins = await this.db.selectFrom('users').select('id').where('role', 'in', ['ADMIN', 'SUPER_ADMIN']).where('status', '=', 'ACTIVE').where('deletedAt', 'is', null).execute();
      const who = await this.db.selectFrom('users').select('fullName').where('id', '=', actor.id).executeTakeFirst();
      await this.notifications.notify(
        this.db,
        admins.map((u) => u.id),
        {
          type: 'RATE_CHANGED_BY_AGENT',
          title: 'Monthly charge changed by agent',
          body: `${who?.fullName ?? 'Agent'} set ${customer.name} (${customer.customerCode}) to ₹${fromPaise(toPaise(input.monthlyRate))}/month from ${from}${before !== null ? ` (was ₹${fromPaise(toPaise(before))})` : ''}: ${reason}`,
          data: { customerId },
        },
      );
    }
    return result;
  }

  /** Live subscription with rate history, suspensions and the next billing preview. */
  async getForCustomer(customerId: string, user: AuthUser) {
    await this.access.assertCanAccess(user, customerId);
    const sub = await this.db
      .selectFrom('customerSubscriptions')
      .selectAll()
      .where('customerId', '=', customerId)
      .orderBy(sql`status = 'ENDED'`)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
    if (!sub) return null;
    return this.describe(this.db, sub.id);
  }

  async describe(db: Database, subscriptionId: string) {
    const sub = await db.selectFrom('customerSubscriptions').selectAll().where('id', '=', subscriptionId).executeTakeFirstOrThrow();
    const [rates, suspensions] = await Promise.all([
      db.selectFrom('subscriptionRates').selectAll().where('subscriptionId', '=', sub.id).orderBy('effectiveFrom', 'desc').execute(),
      db.selectFrom('subscriptionSuspensions').selectAll().where('subscriptionId', '=', sub.id).orderBy('fromDate', 'desc').execute(),
    ]);
    const today = businessDateOf(new Date());
    const current = rates.find((r) => r.effectiveFrom <= today) ?? null;
    // Before the first rate starts (e.g. imported customers before cutover), the upcoming one.
    const upcoming = current ? null : ([...rates].reverse().find((r) => r.effectiveFrom > today) ?? null);
    const live = sub.status !== 'ENDED' || (sub.endDate !== null && sub.nextPeriodStart <= sub.endDate);
    const next = live ? periodAt(sub.nextPeriodStart, sub.billingIntervalMonths, sub.billingTiming, sub.dueDays) : null;
    const nextRate = next ? (rates.find((r) => r.effectiveFrom <= next.start)?.monthlyRate ?? null) : null;
    return {
      ...sub,
      currentMonthlyRate: current?.monthlyRate ?? null,
      /** The rate shown to people: current, or the first one still to come. */
      monthlyRate: current?.monthlyRate ?? upcoming?.monthlyRate ?? null,
      monthlyRateFrom: current ? null : (upcoming?.effectiveFrom ?? null),
      cycleAmount: current ? fromPaise(toPaise(current.monthlyRate) * BigInt(sub.billingIntervalMonths)) : null,
      nextBilling: next && nextRate ? { ...next, amount: fromPaise(toPaise(nextRate) * BigInt(sub.billingIntervalMonths)) } : null,
      rates,
      suspensions,
      suspendedToday: suspensions.some((s) => !s.cancelledAt && s.fromDate <= today && (s.toDate === null || today <= s.toDate)),
    };
  }

  async create(customerId: string, input: CreateSubscriptionRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const customer = await this.ledger.lockCustomer(trx, customerId);
      if (customer.status === 'INACTIVE' || customer.status === 'DISCONNECTED') {
        throw unprocessable('CUSTOMER_NOT_ACTIVE', 'Reactivate the customer before starting a subscription');
      }
      const live = await trx
        .selectFrom('customerSubscriptions')
        .select('id')
        .where('customerId', '=', customerId)
        .where('status', '!=', 'ENDED')
        .executeTakeFirst();
      if (live) throw conflict('SUBSCRIPTION_EXISTS', 'Customer already has a live subscription; change it or end it first');
      // An imported customer waiting for a plan (Excel rate AMP/BOSS/DC, Q1) now has one.
      await trx.updateTable('customers').set({ pendingDecision: null }).where('id', '=', customerId).where('pendingDecision', 'is not', null).execute();

      const anchor = input.billingAnchorDay ?? defaultAnchorDay(input.startDate);
      const dueDays = input.dueDays ?? (await this.settings.get('billing.defaults', trx)).dueDays;
      const sub = await trx
        .insertInto('customerSubscriptions')
        .values({
          customerId,
          startDate: input.startDate,
          billingMode: input.billingMode,
          billingIntervalMonths: input.billingIntervalMonths,
          billingAnchorDay: anchor,
          billingTiming: input.billingTiming,
          dueDays,
          nextPeriodStart: firstPeriodStart(input.startDate, anchor),
          notes: input.notes ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('subscriptionRates')
        .values({ subscriptionId: sub.id, monthlyRate: input.monthlyRate, effectiveFrom: input.startDate, reason: 'Initial rate', createdBy: actor.id })
        .execute();
      const result = await this.describe(trx, sub.id);
      await this.audit.record(trx, { action: 'subscription.create', entityType: 'subscription', entityId: sub.id, after: result });
      return result;
    });
  }

  /**
   * New rate from a date. Invoices already issued never change; the new rate applies to
   * periods starting on/after `effectiveFrom`.
   */
  async changeRate(subscriptionId: string, input: ChangeRateRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const sub = await this.lock(trx, subscriptionId);
      if (sub.status === 'ENDED') throw conflict('SUBSCRIPTION_ENDED', 'Subscription has ended');
      if (input.effectiveFrom < sub.startDate) throw unprocessable('EFFECTIVE_BEFORE_START', 'Rate cannot start before the subscription');
      const billedAfter = await trx
        .selectFrom('invoices')
        .select(['invoiceNumber', 'periodStart'])
        .where('subscriptionId', '=', subscriptionId)
        .where('kind', '=', 'SUBSCRIPTION')
        .where('status', '!=', 'CANCELLED')
        .where('periodStart', '>=', input.effectiveFrom)
        .orderBy('periodStart')
        .executeTakeFirst();
      if (billedAfter) {
        throw unprocessable(
          'PERIOD_ALREADY_BILLED',
          `Period starting ${billedAfter.periodStart} is already billed (${billedAfter.invoiceNumber}). Choose a later date, or cancel that invoice first.`,
        );
      }
      const before = await this.currentRate(trx, subscriptionId, input.effectiveFrom);
      // Same date as an existing rate: nothing is billed from that date (checked above), so the
      // old rate was never used and is replaced (audited below with the old value).
      const sameDay = await trx
        .selectFrom('subscriptionRates')
        .select(['id', 'monthlyRate'])
        .where('subscriptionId', '=', subscriptionId)
        .where('effectiveFrom', '=', input.effectiveFrom)
        .executeTakeFirst();
      if (sameDay) {
        await sql`SELECT set_config('cablenet.replace_unbilled_rate', 'on', true)`.execute(trx);
        await trx.deleteFrom('subscriptionRates').where('id', '=', sameDay.id).execute();
        await sql`SELECT set_config('cablenet.replace_unbilled_rate', 'off', true)`.execute(trx);
      }
      await trx
        .insertInto('subscriptionRates')
        .values({ subscriptionId, monthlyRate: input.monthlyRate, effectiveFrom: input.effectiveFrom, reason: input.reason, createdBy: actor.id })
        .execute();
      // A paused subscription resumes billing once it has a rate.
      await this.alerts.resolveOpen(trx, 'NO_RATE_FOR_PERIOD', subscriptionId, 'Rate added', actor.id);
      await this.audit.record(trx, {
        action: 'subscription.rate_changed',
        entityType: 'subscription',
        entityId: subscriptionId,
        before: { monthlyRate: before },
        after: { monthlyRate: input.monthlyRate, effectiveFrom: input.effectiveFrom },
        reason: input.reason,
      });
      return this.describe(trx, subscriptionId);
    });
  }

  /** Terms apply from the next unbilled period; already-issued invoices are untouched. */
  async updateTerms(subscriptionId: string, input: UpdateSubscriptionTermsRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const sub = await this.lock(trx, subscriptionId);
      if (sub.status === 'ENDED') throw conflict('SUBSCRIPTION_ENDED', 'Subscription has ended');
      const patch: Record<string, unknown> = {};
      if (input.billingIntervalMonths !== undefined) patch.billingIntervalMonths = input.billingIntervalMonths;
      if (input.billingTiming !== undefined) patch.billingTiming = input.billingTiming;
      if (input.billingMode !== undefined) patch.billingMode = input.billingMode;
      if (input.dueDays !== undefined) patch.dueDays = input.dueDays;
      if (input.notes !== undefined) patch.notes = input.notes;
      let unbilledGap: { from: string; to: string } | null = null;
      if (input.billingAnchorDay !== undefined && input.billingAnchorDay !== sub.billingAnchorDay) {
        const next = firstPeriodStart(sub.nextPeriodStart, input.billingAnchorDay);
        if (next !== sub.nextPeriodStart) unbilledGap = { from: sub.nextPeriodStart, to: addDays(next, -1) };
        patch.billingAnchorDay = input.billingAnchorDay;
        patch.nextPeriodStart = next;
      }
      if (Object.keys(patch).length === 0) return this.describe(trx, subscriptionId);
      await trx.updateTable('customerSubscriptions').set({ ...patch, updatedBy: actor.id }).where('id', '=', subscriptionId).execute();
      await this.audit.record(trx, {
        action: 'subscription.terms_changed',
        entityType: 'subscription',
        entityId: subscriptionId,
        before: Object.fromEntries(Object.keys(patch).map((k) => [k, (sub as Record<string, unknown>)[k]])),
        after: patch,
        reason: input.reason,
      });
      // A changed anchor can leave days that no period covers; report them so the admin can bill them manually.
      return { ...(await this.describe(trx, subscriptionId)), unbilledGap };
    });
  }

  async suspend(subscriptionId: string, input: SuspendRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const sub = await this.lock(trx, subscriptionId);
      if (sub.status === 'ENDED') throw conflict('SUBSCRIPTION_ENDED', 'Subscription has ended');
      const overlap = await trx
        .selectFrom('subscriptionSuspensions')
        .select(['fromDate', 'toDate'])
        .where('subscriptionId', '=', subscriptionId)
        .where('cancelledAt', 'is', null)
        .where(sql<boolean>`daterange(from_date, to_date, '[]') && daterange(${input.fromDate}::date, ${input.toDate ?? null}::date, '[]')`)
        .executeTakeFirst();
      if (overlap) throw conflict('SUSPENSION_OVERLAP', `Already suspended from ${overlap.fromDate}${overlap.toDate ? ` to ${overlap.toDate}` : ''}`);
      await trx
        .insertInto('subscriptionSuspensions')
        .values({ subscriptionId, fromDate: input.fromDate, toDate: input.toDate ?? null, reason: input.reason, createdBy: actor.id })
        .execute();
      await this.syncStatus(trx, [subscriptionId]);
      await this.audit.record(trx, {
        action: 'subscription.suspended',
        entityType: 'subscription',
        entityId: subscriptionId,
        after: { fromDate: input.fromDate, toDate: input.toDate ?? null },
        reason: input.reason,
      });
      return this.describe(trx, subscriptionId);
    });
  }

  /** Ends the suspension covering `date` (default today): service resumes on that date. */
  async reactivate(subscriptionId: string, input: { date?: string; reason: string }, actor: AuthUser) {
    const date = input.date ?? businessDateOf(new Date());
    return this.db.transaction().execute(async (trx) => {
      await this.lock(trx, subscriptionId);
      const s = await trx
        .selectFrom('subscriptionSuspensions')
        .selectAll()
        .where('subscriptionId', '=', subscriptionId)
        .where('cancelledAt', 'is', null)
        .where(sql<boolean>`to_date IS NULL OR to_date >= ${date}::date`)
        .orderBy('fromDate')
        .executeTakeFirst();
      if (!s) throw conflict('NOT_SUSPENDED', 'There is no current or upcoming suspension to end');
      if (date <= s.fromDate) {
        await trx
          .updateTable('subscriptionSuspensions')
          .set({ cancelledAt: sql<Date>`now()`, endedBy: actor.id, endedReason: input.reason })
          .where('id', '=', s.id)
          .execute();
      } else {
        await trx
          .updateTable('subscriptionSuspensions')
          .set({ toDate: addDays(date, -1), endedBy: actor.id, endedReason: input.reason })
          .where('id', '=', s.id)
          .execute();
      }
      await this.syncStatus(trx, [subscriptionId]);
      await this.audit.record(trx, {
        action: 'subscription.reactivated',
        entityType: 'subscription',
        entityId: subscriptionId,
        before: { fromDate: s.fromDate, toDate: s.toDate },
        after: date <= s.fromDate ? { cancelled: true } : { toDate: addDays(date, -1) },
        reason: input.reason,
      });
      return this.describe(trx, subscriptionId);
    });
  }

  /** Stops billing after `endDate` (last day of service). */
  async end(subscriptionId: string, endDate: string, reason: string, actor: AuthUser, trxIn?: Database) {
    const run = async (trx: Database) => {
      const sub = await this.lock(trx, subscriptionId);
      if (sub.status === 'ENDED') throw conflict('SUBSCRIPTION_ENDED', 'Subscription has already ended');
      const last = endDate < sub.startDate ? addDays(sub.startDate, -1) : endDate;
      await trx
        .updateTable('customerSubscriptions')
        .set({ status: 'ENDED', endDate: last, updatedBy: actor.id })
        .where('id', '=', subscriptionId)
        .execute();
      await this.audit.record(trx, {
        action: 'subscription.ended',
        entityType: 'subscription',
        entityId: subscriptionId,
        before: { status: sub.status },
        after: { status: 'ENDED', endDate: last },
        reason,
      });
      return this.describe(trx, subscriptionId);
    };
    return trxIn ? run(trxIn) : this.db.transaction().execute(run);
  }

  /** Used by customer deactivation. */
  async endLiveForCustomer(trx: Database, customerId: string, reason: string, actor: AuthUser): Promise<void> {
    const live = await trx
      .selectFrom('customerSubscriptions')
      .select('id')
      .where('customerId', '=', customerId)
      .where('status', '!=', 'ENDED')
      .executeTakeFirst();
    if (live) await this.end(live.id, businessDateOf(new Date()), reason, actor, trx);
  }

  /**
   * Keeps subscription.status (and customer.status) in line with today's suspensions.
   * Called after suspend/reactivate and daily by the job runner (future-dated suspensions).
   */
  async syncStatus(db: Database, subscriptionIds?: string[]): Promise<number> {
    const today = businessDateOf(new Date());
    const res = await sql<{ id: string; customerId: string; status: string }>`
      UPDATE customer_subscriptions s
      SET status = CASE WHEN EXISTS (
            SELECT 1 FROM subscription_suspensions x
            WHERE x.subscription_id = s.id AND x.cancelled_at IS NULL
              AND x.from_date <= ${today}::date AND (x.to_date IS NULL OR x.to_date >= ${today}::date)
          ) THEN 'SUSPENDED'::subscription_status ELSE 'ACTIVE'::subscription_status END
      WHERE s.status <> 'ENDED'
        ${subscriptionIds ? sql`AND s.id IN (${sql.join(subscriptionIds)})` : sql``}
      RETURNING s.id, s.customer_id, s.status
    `.execute(db);
    for (const r of res.rows) {
      await db
        .updateTable('customers')
        .set({ status: r.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE' })
        .where('id', '=', r.customerId)
        .where('status', 'in', ['ACTIVE', 'SUSPENDED'])
        .where('status', '!=', r.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE')
        .execute();
    }
    return res.rows.length;
  }

  async lock(trx: Database, subscriptionId: string) {
    const head = await trx.selectFrom('customerSubscriptions').select('customerId').where('id', '=', subscriptionId).executeTakeFirst();
    if (!head) throw notFound('SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
    await this.ledger.lockCustomer(trx, head.customerId);
    return trx.selectFrom('customerSubscriptions').selectAll().where('id', '=', subscriptionId).forUpdate().executeTakeFirstOrThrow();
  }

  /** Terms + rates + suspensions in the shape the domain billing planner expects. */
  async planInputs(db: Database, subscriptionId: string) {
    const sub = await db.selectFrom('customerSubscriptions').selectAll().where('id', '=', subscriptionId).executeTakeFirstOrThrow();
    const [rates, suspensions] = await Promise.all([
      db.selectFrom('subscriptionRates').select(['effectiveFrom', 'monthlyRate']).where('subscriptionId', '=', subscriptionId).execute(),
      db
        .selectFrom('subscriptionSuspensions')
        .select(['fromDate', 'toDate'])
        .where('subscriptionId', '=', subscriptionId)
        .where('cancelledAt', 'is', null)
        .execute(),
    ]);
    return {
      sub,
      terms: {
        nextPeriodStart: sub.nextPeriodStart,
        intervalMonths: sub.billingIntervalMonths,
        timing: sub.billingTiming,
        dueDays: sub.dueDays,
        endDate: sub.endDate,
      },
      rates: rates.map((r) => ({ effectiveFrom: r.effectiveFrom, monthlyRate: toPaise(r.monthlyRate) })),
      suspensions: suspensions.map((s) => ({ from: s.fromDate, to: s.toDate })),
    };
  }

  private async currentRate(db: Database, subscriptionId: string, onDate: string): Promise<string | null> {
    const r = await db
      .selectFrom('subscriptionRates')
      .select('monthlyRate')
      .where('subscriptionId', '=', subscriptionId)
      .where('effectiveFrom', '<=', onDate)
      .orderBy('effectiveFrom', 'desc')
      .executeTakeFirst();
    return r?.monthlyRate ?? null;
  }
}

