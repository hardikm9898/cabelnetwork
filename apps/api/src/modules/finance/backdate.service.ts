import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { addMonths, businessDateOf, firstPeriodStart, fromPaise, isBusinessDate, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { unprocessable } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { BillingService } from './billing.service';

export interface BackdateRow {
  subscriptionId: string;
  customerCode: string;
  name: string;
  startDate: string;
  monthlyRate: string | null;
  /** Bills this adds up to today (before suspensions). */
  periods: number;
  amount: string;
}

export interface BackdatePlan {
  from: string;
  today: string;
  change: BackdateRow[];
  skipped: { customerCode: string; name: string; reason: string }[];
  /** Customers who are not billed at all: no monthly charge set (e.g. AMP / BOSS / DC in the Excel). */
  noCharge: { customerCode: string; name: string }[];
  totalPeriods: number;
  totalAmount: string;
}

/**
 * Moves the start of billing back to an earlier date (owner's request 2026-11-24: bill everyone
 * from January 2026). Only subscriptions that have not been billed yet are moved; each keeps its
 * own monthly charge (its first rate is also used for the earlier months). The normal billing
 * run then raises every month from the new start up to today, one bill per month.
 */
@Injectable()
export class BackdateService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
  ) {}

  async plan(from: string, db: Database = this.db): Promise<BackdatePlan> {
    if (!isBusinessDate(from) || !from.endsWith('-01')) throw unprocessable('INVALID_FROM', 'Give the first day of a month, e.g. 2026-01-01');
    const today = businessDateOf(new Date());
    if (from > today) throw unprocessable('INVALID_FROM', 'The start must not be in the future');
    const subs = await sql<{
      id: string;
      customerCode: string;
      name: string;
      customerStatus: string;
      startDate: string;
      billingAnchorDay: number;
      billingIntervalMonths: number;
      billed: string;
      firstRate: string | null;
    }>`
      SELECT s.id, c.customer_code, c.name, c.status::text AS customer_status, s.start_date, s.billing_anchor_day, s.billing_interval_months,
             (SELECT count(*) FROM invoices i WHERE i.subscription_id = s.id AND i.kind = 'SUBSCRIPTION' AND i.status <> 'CANCELLED') AS billed,
             (SELECT r.monthly_rate FROM subscription_rates r WHERE r.subscription_id = s.id ORDER BY r.effective_from LIMIT 1) AS first_rate
      FROM customer_subscriptions s JOIN customers c ON c.id = s.customer_id
      WHERE s.status <> 'ENDED' AND c.deleted_at IS NULL
      ORDER BY c.customer_code`.execute(db);
    const noCharge = await sql<{ customerCode: string; name: string }>`
      SELECT c.customer_code, c.name FROM customers c
      WHERE c.deleted_at IS NULL AND c.status IN ('ACTIVE', 'SUSPENDED')
        AND NOT EXISTS (SELECT 1 FROM customer_subscriptions s WHERE s.customer_id = c.id AND s.status <> 'ENDED')
      ORDER BY c.customer_code`.execute(db);

    const plan: BackdatePlan = { from, today, change: [], skipped: [], noCharge: noCharge.rows, totalPeriods: 0, totalAmount: '0.00' };
    let total = 0n;
    for (const s of subs.rows) {
      const who = { customerCode: s.customerCode, name: s.name };
      if (s.customerStatus === 'INACTIVE' || s.customerStatus === 'DISCONNECTED') {
        plan.skipped.push({ ...who, reason: `customer is ${s.customerStatus.toLowerCase()}` });
        continue;
      }
      if (s.startDate <= from) continue; // already billed from then or earlier: nothing to do
      if (Number(s.billed) > 0) {
        plan.skipped.push({ ...who, reason: `already billed from ${s.startDate}; add earlier months as manual bills if needed` });
        continue;
      }
      if (!s.firstRate) {
        plan.skipped.push({ ...who, reason: 'no monthly charge set' });
        continue;
      }
      let periods = 0;
      for (let p = firstPeriodStart(from, s.billingAnchorDay); p <= today; p = addMonths(p, s.billingIntervalMonths)) periods++;
      const amount = toPaise(s.firstRate) * BigInt(periods * s.billingIntervalMonths);
      total += amount;
      plan.totalPeriods += periods;
      plan.change.push({ subscriptionId: s.id, ...who, startDate: s.startDate, monthlyRate: fromPaise(toPaise(s.firstRate)), periods, amount: fromPaise(amount) });
    }
    plan.totalAmount = fromPaise(total);
    return plan;
  }

  /** Moves the planned subscriptions, then runs billing up to today. */
  async apply(from: string, actor: AuthUser) {
    const plan = await this.plan(from);
    const reason = `Billing starts ${from} for every customer (owner's decision)`;
    for (const row of plan.change) {
      await this.db.transaction().execute(async (trx) => {
        const sub = await trx.selectFrom('customerSubscriptions').selectAll().where('id', '=', row.subscriptionId).forUpdate().executeTakeFirstOrThrow();
        const billed = await trx
          .selectFrom('invoices')
          .select('id')
          .where('subscriptionId', '=', sub.id)
          .where('kind', '=', 'SUBSCRIPTION')
          .where('status', '!=', 'CANCELLED')
          .executeTakeFirst();
        if (billed || sub.startDate <= from) return; // changed meanwhile
        const first = await trx.selectFrom('subscriptionRates').select(['monthlyRate', 'effectiveFrom']).where('subscriptionId', '=', sub.id).orderBy('effectiveFrom').executeTakeFirstOrThrow();
        await trx
          .updateTable('customerSubscriptions')
          .set({ startDate: from, nextPeriodStart: firstPeriodStart(from, sub.billingAnchorDay), updatedBy: actor.id })
          .where('id', '=', sub.id)
          .execute();
        if (first.effectiveFrom > from) {
          await trx.insertInto('subscriptionRates').values({ subscriptionId: sub.id, monthlyRate: first.monthlyRate, effectiveFrom: from, reason, createdBy: actor.id }).execute();
        }
        await this.audit.record(trx, {
          action: 'subscription.billing_backdated',
          entityType: 'subscription',
          entityId: sub.id,
          before: { startDate: sub.startDate, nextPeriodStart: sub.nextPeriodStart },
          after: { startDate: from, monthlyRate: first.monthlyRate },
          reason,
        });
      });
    }
    const run = await this.billing.run(plan.today, 'MANUAL', actor.id);
    return { plan, run };
  }
}
