import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { ListInvoicesQuery, ManualInvoiceRequest } from '@cablenet/contracts';
import {
  addMonths,
  BillingPeriod,
  businessDateOf,
  duePeriods,
  fromPaise,
  Paise,
  periodAt,
  periodLabel,
  rateOn,
  splitBalance,
  toPaise,
} from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { assertWithinApprovalLimit } from './approval-limits';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { Page } from '../../common/http';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { CustomerAccessService } from '../customers/customer-access.service';
import { AlertsService } from './alerts.service';
import { LedgerService } from './ledger.service';
import { SubscriptionsService } from './subscriptions.service';

export interface BillingRunResult {
  runId: string;
  asOf: string;
  invoicesCreated: number;
  periodsSkipped: number;
  errors: { subscriptionId: string; message: string }[];
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly subscriptions: SubscriptionsService,
    private readonly alerts: AlertsService,
    private readonly audit: AuditService,
    private readonly access: CustomerAccessService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Subscriptions that may have a period to bill as of `asOf`. Subscriptions paused for a
   * missing rate (open NO_RATE_FOR_PERIOD alert) are skipped until a rate is added.
   */
  private dueSubscriptionIds(asOf: string) {
    return this.db
      .selectFrom('customerSubscriptions as s')
      .select('s.id')
      .where('s.billingMode', '=', 'AUTO')
      .where('s.nextPeriodStart', '<=', asOf)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('systemAlerts as a')
              .select('a.id')
              .where('a.type', '=', 'NO_RATE_FOR_PERIOD')
              .where('a.resolvedAt', 'is', null)
              .whereRef('a.entityId', '=', sql<string>`s.id::text`),
          ),
        ),
      )
      .where((eb) =>
        eb.or([eb('s.status', '!=', 'ENDED'), eb.and([eb('s.endDate', 'is not', null), eb('s.nextPeriodStart', '<=', eb.ref('s.endDate'))])]),
      )
      .orderBy('s.nextPeriodStart')
      .execute();
  }

  async hasDueWork(asOf: string): Promise<boolean> {
    return (await this.dueSubscriptionIds(asOf)).length > 0;
  }

  /**
   * Issues every invoice that has become due by `asOf`. Safe to run any number of times and
   * concurrently: each period is created in its own customer-locked transaction and the
   * (subscription, period_start) unique index rejects duplicates.
   */
  async run(asOf: string, trigger: 'SCHEDULED' | 'MANUAL', actorId: string | null): Promise<BillingRunResult> {
    const run = await this.db
      .insertInto('billingRuns')
      .values({ asOf, trigger, triggeredBy: actorId })
      .returning('id')
      .executeTakeFirstOrThrow();
    const result: BillingRunResult = { runId: run.id, asOf, invoicesCreated: 0, periodsSkipped: 0, errors: [] };

    for (const { id } of await this.dueSubscriptionIds(asOf)) {
      try {
        const r = await this.billSubscription(id, asOf, run.id, actorId);
        result.invoicesCreated += r.created;
        result.periodsSkipped += r.skipped;
      } catch (err) {
        const message = (err as Error).message;
        this.logger.error({ err, subscriptionId: id }, 'billing failed for subscription');
        result.errors.push({ subscriptionId: id, message });
      }
    }

    await this.db
      .updateTable('billingRuns')
      .set({
        finishedAt: sql<Date>`now()`,
        status: result.errors.length ? 'FAILED' : 'COMPLETED',
        invoicesCreated: result.invoicesCreated,
        periodsSkipped: result.periodsSkipped,
        errors: JSON.stringify(result.errors),
      })
      .where('id', '=', run.id)
      .execute();
    if (result.errors.length) {
      await this.alerts.raise(this.db, {
        type: 'BILLING_RUN_ERRORS',
        severity: 'CRITICAL',
        entityType: 'billing_run',
        entityId: run.id,
        message: `Billing run for ${asOf} had ${result.errors.length} error(s)`,
        details: result.errors,
      });
    }
    return result;
  }

  /** Bills one subscription up to `asOf`, one period per transaction. */
  async billSubscription(subscriptionId: string, asOf: string, runId: string | null, actorId: string | null) {
    let created = 0;
    let skipped = 0;
    for (let guard = 0; guard < 240; guard++) {
      const outcome = await this.db.transaction().execute(async (trx) => {
        await this.subscriptions.lock(trx, subscriptionId);
        const { sub, terms, rates, suspensions } = await this.subscriptions.planInputs(trx, subscriptionId);
        if (sub.billingMode !== 'AUTO') return 'DONE' as const;
        const [next] = duePeriods(terms, rates, suspensions, asOf, 1);
        if (!next) return 'DONE' as const;

        if (next.action === 'NO_RATE') {
          await this.alerts.raise(trx, {
            type: 'NO_RATE_FOR_PERIOD',
            severity: 'WARNING',
            entityType: 'subscription',
            entityId: subscriptionId,
            message: `No monthly rate is set for the period starting ${next.period.start}; billing is paused for this customer`,
          });
          return 'DONE' as const;
        }
        if (next.action === 'BILL') {
          await this.issueSubscriptionInvoice(trx, sub, next.period, next.monthlyRate, sub.billingIntervalMonths, 'SCHEDULER', runId, actorId);
        }
        await trx
          .updateTable('customerSubscriptions')
          .set({ nextPeriodStart: addMonths(next.period.start, sub.billingIntervalMonths) })
          .where('id', '=', subscriptionId)
          .execute();
        return next.action;
      });
      if (outcome === 'DONE') break;
      if (outcome === 'BILL') created++;
      else skipped++;
    }
    return { created, skipped };
  }

  private async issueSubscriptionInvoice(
    trx: Database,
    sub: { id: string; customerId: string },
    period: BillingPeriod,
    monthlyRate: Paise,
    months: number,
    source: 'SCHEDULER' | 'ADMIN',
    runId: string | null,
    actorId: string | null,
    description?: string | null,
  ): Promise<string> {
    const amount = monthlyRate * BigInt(months);
    const previous = await this.ledger.balance(trx, sub.customerId);
    const label = periodLabel(period.start, period.end);
    const number = await this.ledger.nextNumber(trx, 'INV', period.billingDate);
    const invoice = await trx
      .insertInto('invoices')
      .values({
        invoiceNumber: number,
        kind: 'SUBSCRIPTION',
        customerId: sub.customerId,
        subscriptionId: sub.id,
        periodStart: period.start,
        periodEnd: period.end,
        billingDate: period.billingDate,
        dueDate: period.dueDate,
        subtotal: fromPaise(amount),
        total: fromPaise(amount),
        previousOutstandingSnapshot: fromPaise(previous),
        status: amount === 0n ? 'PAID' : 'UNPAID',
        description: description ?? `Cable TV subscription ${label}`,
        billingRunId: runId,
        source,
        createdBy: actorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('invoiceItems')
      .values({
        invoiceId: invoice.id,
        itemType: 'SUBSCRIPTION',
        description: `Subscription ${label}`,
        months,
        unitRate: fromPaise(monthlyRate),
        amount: fromPaise(amount),
        periodStart: period.start,
        periodEnd: period.end,
      })
      .execute();
    if (amount > 0n) {
      await this.ledger.post(trx, {
        customerId: sub.customerId,
        entryDate: period.billingDate,
        type: 'CHARGE',
        amount,
        description: `Subscription ${label} (${number})`,
        invoiceId: invoice.id,
        createdBy: actorId,
      });
      await this.ledger.allocate(trx, sub.customerId, actorId);
    }
    return invoice.id;
  }

  /** Manual invoice for a MANUAL-mode subscription (admin chooses the period). */
  async createManual(customerId: string, input: ManualInvoiceRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.ledger.lockCustomer(trx, customerId);
      const sub = await trx
        .selectFrom('customerSubscriptions')
        .selectAll()
        .where('customerId', '=', customerId)
        .where('status', '!=', 'ENDED')
        .forUpdate()
        .executeTakeFirst();
      if (!sub) throw unprocessable('NO_SUBSCRIPTION', 'Customer has no live subscription');
      if (sub.billingMode !== 'MANUAL') {
        throw unprocessable('SUBSCRIPTION_IS_AUTO', 'This customer is billed automatically; switch the subscription to MANUAL to raise invoices by hand');
      }
      const { rates } = await this.subscriptions.planInputs(trx, sub.id);
      const rate = rateOn(rates, input.periodStart);
      if (rate === null) throw unprocessable('NO_RATE_FOR_PERIOD', 'No monthly rate is in force on the period start');
      const period = periodAt(input.periodStart, input.months, sub.billingTiming, sub.dueDays);
      const overlap = await trx
        .selectFrom('invoices')
        .select(['invoiceNumber', 'periodStart', 'periodEnd'])
        .where('subscriptionId', '=', sub.id)
        .where('kind', '=', 'SUBSCRIPTION')
        .where('status', '!=', 'CANCELLED')
        .where('periodStart', '<=', period.end)
        .where('periodEnd', '>=', period.start)
        .executeTakeFirst();
      if (overlap) {
        throw conflict('PERIOD_ALREADY_BILLED', `Overlaps ${overlap.invoiceNumber} (${overlap.periodStart} to ${overlap.periodEnd})`);
      }
      const id = await this.issueSubscriptionInvoice(
        trx,
        sub,
        period,
        rate,
        input.months,
        'ADMIN',
        null,
        actor.id,
        input.description,
      );
      await this.audit.record(trx, { action: 'invoice.manual_created', entityType: 'invoice', entityId: id, after: { ...period, months: input.months } });
      return this.detail(trx, id);
    });
  }

  /**
   * Cancels an issued invoice: a REVERSAL ledger entry offsets its charge and any money applied
   * to it is released and re-applied FIFO to the customer's other open invoices (or advance).
   */
  async cancel(invoiceId: string, reason: string, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const head = await trx.selectFrom('invoices').select('customerId').where('id', '=', invoiceId).executeTakeFirst();
      if (!head) throw notFound('INVOICE_NOT_FOUND', 'Invoice not found');
      await this.ledger.lockCustomer(trx, head.customerId);
      const inv = await trx.selectFrom('invoices').selectAll().where('id', '=', invoiceId).forUpdate().executeTakeFirstOrThrow();
      if (inv.status === 'CANCELLED') throw conflict('INVOICE_ALREADY_CANCELLED', 'Invoice is already cancelled');
      // Cancelling a bill waives it: same approval limit as credits (security review M-6).
      await assertWithinApprovalLimit(trx, this.settings, actor, inv.customerId, inv.total);

      await this.ledger.reverse(trx, { invoiceId }, businessDateOf(new Date()), `Invoice ${inv.invoiceNumber} cancelled: ${reason}`, actor.id);
      await this.ledger.releaseAllocations(trx, { invoiceId }, actor.id);
      await trx
        .updateTable('invoices')
        .set({ status: 'CANCELLED', amountPaid: '0.00', cancelledAt: sql<Date>`now()`, cancelledBy: actor.id, cancelReason: reason })
        .where('id', '=', invoiceId)
        .execute();
      await this.ledger.allocate(trx, inv.customerId, actor.id);
      await this.audit.record(trx, {
        action: 'invoice.cancelled',
        entityType: 'invoice',
        entityId: invoiceId,
        before: { status: inv.status, amountPaid: inv.amountPaid },
        after: { status: 'CANCELLED' },
        reason,
      });
      return this.detail(trx, invoiceId);
    });
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list(q: ListInvoicesQuery) {
    const today = businessDateOf(new Date());
    let query = this.db.selectFrom('invoices as i').innerJoin('customers as c', 'c.id', 'i.customerId');
    if (q.customerId) query = query.where('i.customerId', '=', q.customerId);
    if (q.from) query = query.where('i.billingDate', '>=', q.from);
    if (q.to) query = query.where('i.billingDate', '<=', q.to);
    switch (q.status) {
      case undefined:
        break;
      case 'OPEN':
        query = query.where('i.status', 'in', ['UNPAID', 'PARTIALLY_PAID']);
        break;
      case 'OVERDUE':
        query = query.where('i.status', 'in', ['UNPAID', 'PARTIALLY_PAID']).where('i.dueDate', '<', today);
        break;
      default:
        query = query.where('i.status', '=', q.status);
    }
    const [items, totals] = await Promise.all([
      query
        .selectAll('i')
        .select(['c.customerCode', 'c.name as customerName'])
        .orderBy('i.billingDate', 'desc')
        .orderBy('i.createdAt', 'desc')
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(
      items.map((i) => this.withDerivedStatus(i, today)),
      { page: q.page, pageSize: q.pageSize, total: Number(totals.n) },
    );
  }

  async listForCustomer(customerId: string, user: AuthUser, q: ListInvoicesQuery) {
    await this.access.assertCanAccess(user, customerId);
    return this.list({ ...q, customerId });
  }

  async get(id: string, user: AuthUser) {
    const head = await this.db.selectFrom('invoices').select('customerId').where('id', '=', id).executeTakeFirst();
    if (!head) throw notFound('INVOICE_NOT_FOUND', 'Invoice not found');
    await this.access.assertCanAccess(user, head.customerId).catch(() => {
      throw notFound('INVOICE_NOT_FOUND', 'Invoice not found');
    });
    return this.detail(this.db, id);
  }

  async detail(db: Database, id: string) {
    const inv = await db
      .selectFrom('invoices as i')
      .innerJoin('customers as c', 'c.id', 'i.customerId')
      .selectAll('i')
      .select(['c.customerCode', 'c.name as customerName'])
      .where('i.id', '=', id)
      .executeTakeFirstOrThrow();
    const [items, allocations] = await Promise.all([
      db.selectFrom('invoiceItems').selectAll().where('invoiceId', '=', id).execute(),
      this.ledger.allocationsOf(db, { invoiceId: id }),
    ]);
    return { ...this.withDerivedStatus(inv, businessDateOf(new Date())), items, allocations };
  }

  async runs(page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      this.db.selectFrom('billingRuns').selectAll().orderBy('startedAt', 'desc').limit(pageSize).offset((page - 1) * pageSize).execute(),
      this.db.selectFrom('billingRuns').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page, pageSize, total: Number(total.n) });
  }

  /** `OVERDUE` is derived at read time: open, with a balance, past its due date. */
  private withDerivedStatus<T extends { status: string; dueDate: string; total: string; amountPaid: string }>(inv: T, today: string) {
    const open = inv.status === 'UNPAID' || inv.status === 'PARTIALLY_PAID';
    const balance = inv.status === 'CANCELLED' ? '0.00' : fromPaise(splitBalance(toPaise(inv.total) - toPaise(inv.amountPaid)).outstanding);
    return { ...inv, balance, overdue: open && inv.dueDate < today, displayStatus: open && inv.dueDate < today ? 'OVERDUE' : inv.status };
  }
}
