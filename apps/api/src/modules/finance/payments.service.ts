import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { ListPaymentsQuery, RecordPaymentRequest } from '@cablenet/contracts';
import { addDays, businessDateOf, canReadAllCustomers, fromPaise, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import type { PaymentSource, PaymentStatus } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { Page } from '../../common/http';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { NotificationsService } from '../core/notifications.service';
import { SettingsService } from '../core/settings.service';
import { CustomerAccessService } from '../customers/customer-access.service';
import { FieldOpsService } from '../fieldops/fieldops.service';
import { AlertsService } from './alerts.service';
import { LedgerService } from './ledger.service';
import { ReceiptsService } from './receipts.service';

/**
 * Payment status on entry (FINANCIAL_LOGIC §5.2). Cash is confirmed at once (the collector is
 * accountable for it). Bank/UPI recorded by an agent and every cheque wait for verification:
 * a screenshot is not proof, and a pending payment does not reduce the outstanding.
 */
/** Extra facts for a payment that arrives through offline sync (SyncService checked access and dates). */
export interface OfflinePosting {
  deviceId: string | null;
  provisionalRef: string;
  /** Phone clock when recorded, as sent. */
  clientRecordedAt: Date;
  /** Best estimate of the real collection time (phone time corrected for clock error). */
  receivedAt: Date;
  recordedOffline: boolean;
  flags: string[];
  /** Post as PENDING_VERIFICATION whatever the mode: the office checks it before it counts (review M-4). */
  hold: boolean;
}

function initialStatus(mode: RecordPaymentRequest['mode'], isAgent: boolean): PaymentStatus {
  if (mode === 'CASH') return 'CONFIRMED';
  if (mode === 'CHEQUE') return 'PENDING_VERIFICATION';
  return isAgent ? 'PENDING_VERIFICATION' : 'CONFIRMED';
}

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly receipts: ReceiptsService,
    private readonly access: CustomerAccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly alerts: AlertsService,
    private readonly fieldOps: FieldOpsService,
  ) {}

  async record(input: RecordPaymentRequest, user: AuthUser) {
    const isAgent = user.role === 'AGENT';
    const rules = await this.settings.get('payments.rules');
    const today = businessDateOf(new Date());
    if (input.paymentDate > today) throw unprocessable('PAYMENT_DATE_IN_FUTURE', 'Payment date cannot be in the future');
    if (isAgent && input.paymentDate < addDays(today, -rules.agentMaxBackdateDays)) {
      throw unprocessable('PAYMENT_DATE_TOO_OLD', `Agents can record payments up to ${rules.agentMaxBackdateDays} days old; ask the office`);
    }
    if (toPaise(input.amount) > toPaise(rules.maxAmount)) {
      throw unprocessable('AMOUNT_TOO_LARGE', `A single payment cannot exceed ₹${rules.maxAmount}`);
    }
    if (input.receivedAt) {
      // The collection time decides duplicate detection: keep it within the same window as the date.
      const at = new Date(input.receivedAt).getTime();
      const earliest = Date.now() - (rules.agentMaxBackdateDays + 1) * 86_400_000;
      if (at > Date.now() + 5 * 60_000 || (isAgent && at < earliest)) throw unprocessable('RECEIVED_AT_OUT_OF_RANGE', 'The collection time is outside the allowed range');
    }

    return this.db.transaction().execute(async (trx) => {
      // Ownership check first (agents: 404 for customers not assigned to them).
      await this.access.assertCanAccess(user, input.customerId, trx);
      return this.recordIn(trx, input, user, null);
    });
  }

  /**
   * Posts a payment inside the caller's transaction. Online entry passes `offline = null`;
   * offline sync passes the phone's facts, and the payment is posted even when the balance
   * changed meanwhile (collected money is a fact; FINANCIAL_LOGIC §7).
   */
  async recordIn(trx: Database, input: RecordPaymentRequest, user: AuthUser, offline: OfflinePosting | null) {
    const isAgent = user.role === 'AGENT';
    const rules = await this.settings.get('payments.rules', trx);
    {
      await this.ledger.lockCustomer(trx, input.customerId);

      // Idempotent replay: the same clientTxnId always returns the original result.
      const existing = await trx.selectFrom('payments').selectAll().where('clientTxnId', '=', input.clientTxnId).executeTakeFirst();
      if (existing) {
        const same =
          existing.customerId === input.customerId &&
          toPaise(existing.amount) === toPaise(input.amount) &&
          existing.recordedBy === user.id;
        if (!same) throw conflict('CLIENT_TXN_ID_CONFLICT', 'This transaction id was already used for a different payment');
        return { ...(await this.detail(trx, existing.id)), replayed: true };
      }

      if (input.reference && ['UPI', 'BANK_TRANSFER', 'CHEQUE'].includes(input.mode)) {
        const dupRef = await trx
          .selectFrom('payments')
          .select(['id'])
          .where('mode', '=', input.mode)
          .where(sql<boolean>`upper(reference) = upper(${input.reference})`)
          .where('status', '!=', 'FAILED')
          .executeTakeFirst();
        if (dupRef) throw conflict('DUPLICATE_REFERENCE', 'A payment with this transaction reference already exists');
      }

      const flags: string[] = [...(offline?.flags ?? [])];
      if (rules.duplicateWindowMinutes > 0) {
        // Online: same payment within N minutes. Offline the phone may sync hours later, so compare
        // around the time it was actually collected instead.
        const at = offline ? sql<Date>`${offline.receivedAt.toISOString()}::timestamptz` : sql<Date>`now()`;
        const similar = await trx
          .selectFrom('payments')
          .select('id')
          .where('customerId', '=', input.customerId)
          .where('amount', '=', input.amount)
          .where('mode', '=', input.mode)
          .where('status', 'in', ['CONFIRMED', 'PENDING_VERIFICATION'])
          .where(sql<Date>`coalesce(received_at, created_at)`, '>', sql<Date>`${at} - make_interval(mins => ${rules.duplicateWindowMinutes})`)
          .where(sql<Date>`coalesce(received_at, created_at)`, '<', sql<Date>`${at} + make_interval(mins => ${rules.duplicateWindowMinutes})`)
          .executeTakeFirst();
        if (similar) flags.push('POSSIBLE_DUPLICATE');
      }

      const before = await this.ledger.summary(trx, input.customerId);
      const status: PaymentStatus = offline?.hold ? 'PENDING_VERIFICATION' : initialStatus(input.mode, isAgent);
      const source: PaymentSource = isAgent ? 'AGENT_COLLECTION' : 'ADMIN_COLLECTION';
      const payment = await trx
        .insertInto('payments')
        .values({
          clientTxnId: input.clientTxnId,
          customerId: input.customerId,
          amount: input.amount,
          paymentDate: input.paymentDate,
          receivedAt: offline ? offline.receivedAt : (input.receivedAt ?? sql<Date>`now()`),
          mode: input.mode,
          reference: input.reference ?? null,
          source,
          status,
          collectedBy: user.id,
          recordedBy: user.id,
          deviceId: offline ? offline.deviceId : user.deviceId,
          recordedOffline: offline ? offline.recordedOffline : input.recordedOffline,
          clientRecordedAt: offline ? offline.clientRecordedAt : (input.receivedAt ?? null),
          reviewFlags: flags,
          notes: input.notes ?? null,
          provisionalRef: offline?.provisionalRef ?? null,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      if (status === 'CONFIRMED') await this.confirmPosting(trx, payment.id, before, user.id);
      if (flags.includes('POSSIBLE_DUPLICATE')) {
        await this.alerts.raise(trx, {
          type: 'POSSIBLE_DUPLICATE_PAYMENT',
          severity: 'WARNING',
          entityType: 'payment',
          entityId: payment.id,
          message: `Possible duplicate payment of ₹${input.amount} for the same customer within ${rules.duplicateWindowMinutes} minutes`,
        });
      }
      await this.audit.record(trx, {
        action: 'payment.recorded',
        entityType: 'payment',
        entityId: payment.id,
        after: { customerId: input.customerId, amount: input.amount, mode: input.mode, status, source, flags, provisionalRef: offline?.provisionalRef ?? null },
      });
      return { ...(await this.detail(trx, payment.id)), replayed: false };
    }
  }

  /** Ledger + FIFO allocation + receipt for a payment that has become CONFIRMED. */
  private async confirmPosting(trx: Database, paymentId: string, before: { outstanding: string; advance: string }, actorId: string) {
    const p = await trx.selectFrom('payments').selectAll().where('id', '=', paymentId).executeTakeFirstOrThrow();
    await this.ledger.post(trx, {
      customerId: p.customerId,
      entryDate: p.paymentDate,
      type: 'PAYMENT',
      amount: -toPaise(p.amount),
      description: `Payment received (${p.mode.toLowerCase()})`,
      paymentId: p.id,
      createdBy: actorId,
    });
    await this.ledger.allocate(trx, p.customerId, actorId);
    await this.receipts.issue(trx, p.id, before, actorId);
    // A received payment fulfils any open promise to pay (promises themselves never touch money).
    await this.fieldOps.resolvePromises(trx, p.customerId, p.id, actorId);
  }

  async verify(id: string, note: string | null | undefined, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const p = await this.lockPayment(trx, id);
      if (p.status !== 'PENDING_VERIFICATION') throw conflict('PAYMENT_NOT_PENDING', `Payment is ${p.status}`);
      const before = await this.ledger.summary(trx, p.customerId);
      await trx
        .updateTable('payments')
        .set({ status: 'CONFIRMED', verifiedBy: actor.id, verifiedAt: sql<Date>`now()`, verificationNote: note ?? null })
        .where('id', '=', id)
        .execute();
      await this.confirmPosting(trx, id, before, actor.id);
      await this.audit.record(trx, { action: 'payment.verified', entityType: 'payment', entityId: id, before: { status: p.status }, after: { status: 'CONFIRMED' }, reason: note ?? null });
      if (p.collectedBy && p.collectedBy !== actor.id) {
        await this.notifications.notify(trx, [p.collectedBy], {
          type: 'PAYMENT_VERIFIED',
          title: 'Payment verified',
          body: `₹${p.amount} (${p.mode}) has been verified and receipted.`,
          data: { paymentId: id },
        });
      }
      return this.detail(trx, id);
    });
  }

  async fail(id: string, reason: string, actor: AuthUser) {
    return this.db.transaction().execute((trx) => this.failIn(trx, id, reason, actor));
  }

  async failIn(trx: Database, id: string, reason: string, actor: AuthUser) {
    const p = await this.lockPayment(trx, id);
    if (p.status !== 'PENDING_VERIFICATION') throw conflict('PAYMENT_NOT_PENDING', `Payment is ${p.status}`);
    await trx
      .updateTable('payments')
      .set({ status: 'FAILED', verifiedBy: actor.id, verifiedAt: sql<Date>`now()`, verificationNote: reason })
      .where('id', '=', id)
      .execute();
    await this.audit.record(trx, { action: 'payment.failed', entityType: 'payment', entityId: id, before: { status: p.status }, after: { status: 'FAILED' }, reason });
    if (p.collectedBy && p.collectedBy !== actor.id) {
      await this.notifications.notify(trx, [p.collectedBy], {
        type: 'PAYMENT_FAILED',
        title: 'Payment could not be verified',
        body: `₹${p.amount} (${p.mode}) was rejected: ${reason}`,
        data: { paymentId: id },
      });
    }
    return this.detail(trx, id);
  }

  /**
   * Correction workflow for a wrong confirmed payment: nothing is deleted. A REVERSAL ledger
   * entry cancels the payment, its allocations are compensated, the receipt is cancelled, and
   * FIFO re-runs so other credits fill any invoices that reopened.
   */
  async reverse(id: string, reason: string, actor: AuthUser) {
    return this.db.transaction().execute((trx) => this.reverseIn(trx, id, reason, actor));
  }

  async reverseIn(trx: Database, id: string, reason: string, actor: AuthUser) {
    const p = await this.lockPayment(trx, id);
    if (p.status !== 'CONFIRMED') throw conflict('PAYMENT_NOT_CONFIRMED', `Only confirmed payments can be reversed (this one is ${p.status})`);

    const inPending = await trx
      .selectFrom('cashHandoverItems as i')
      .innerJoin('cashHandovers as h', 'h.id', 'i.handoverId')
      .select('h.handoverNumber')
      .where('i.paymentId', '=', id)
      .where('h.status', '=', 'SUBMITTED')
      .executeTakeFirst();
    if (inPending) {
      throw conflict('PAYMENT_IN_PENDING_HANDOVER', `Confirm or reject cash handover ${inPending.handoverNumber} first`);
    }
    const refunded = await trx
      .selectFrom('allocations')
      .select(sql<string>`coalesce(sum(amount), 0)`.as('n'))
      .where('paymentId', '=', id)
      .where('refundId', 'is not', null)
      .executeTakeFirstOrThrow();
    if (toPaise(refunded.n) > 0n) throw conflict('PAYMENT_REFUNDED', 'Part of this payment was refunded; it cannot be reversed');

    const today = businessDateOf(new Date());
    await trx.insertInto('paymentReversals').values({ paymentId: id, reason, approvedBy: actor.id }).execute();
    await this.ledger.reverse(trx, { paymentId: id }, today, `Payment reversed: ${reason}`, actor.id);
    await this.ledger.releaseAllocations(trx, { paymentId: id }, actor.id);
    await trx.updateTable('payments').set({ status: 'REVERSED' }).where('id', '=', id).execute();
    await this.receipts.cancelForPayment(trx, id, `Payment reversed: ${reason}`, actor.id);
    await this.ledger.allocate(trx, p.customerId, actor.id);

    await this.audit.record(trx, {
      action: 'payment.reversed',
      entityType: 'payment',
      entityId: id,
      before: { status: 'CONFIRMED', amount: p.amount },
      after: { status: 'REVERSED' },
      reason,
    });
    if (p.collectedBy && p.collectedBy !== actor.id) {
      await this.notifications.notify(trx, [p.collectedBy], {
        type: 'PAYMENT_REVERSED',
        title: 'Payment reversed',
        body: `₹${p.amount} collected on ${p.paymentDate} was reversed: ${reason}`,
        data: { paymentId: id },
      });
    }
    return this.detail(trx, id);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list(q: ListPaymentsQuery, user: AuthUser) {
    let query = this.db
      .selectFrom('payments as p')
      .innerJoin('customers as c', 'c.id', 'p.customerId')
      .leftJoin('users as u', 'u.id', 'p.collectedBy')
      .leftJoin('paymentReversals as pr', 'pr.paymentId', 'p.id');
    // Agents see only what they collected themselves.
    if (!canReadAllCustomers(user.role)) query = query.where('p.collectedBy', '=', user.id);
    if (q.customerId) query = query.where('p.customerId', '=', q.customerId);
    if (q.collectedBy) query = query.where('p.collectedBy', '=', q.collectedBy);
    if (q.status) query = query.where('p.status', '=', q.status);
    if (q.mode) query = query.where('p.mode', '=', q.mode);
    if (q.from) query = query.where('p.paymentDate', '>=', q.from);
    if (q.to) query = query.where('p.paymentDate', '<=', q.to);

    const [items, totals] = await Promise.all([
      query
        .select([
          'p.id',
          'p.amount',
          'p.paymentDate',
          'p.mode',
          'p.reference',
          'p.source',
          'p.status',
          'p.reviewFlags',
          'p.recordedOffline',
          'p.createdAt',
          'c.id as customerId',
          'c.customerCode',
          'c.name as customerName',
          'u.fullName as collectedByName',
          'p.collectedBy',
          sql<string | null>`coalesce(pr.reason, CASE WHEN p.status = 'FAILED' THEN p.verification_note END)`.as('correctionNote'),
          sql<boolean>`EXISTS (SELECT 1 FROM users x WHERE x.role = 'AGENT' AND x.id = coalesce(pr.approved_by, CASE WHEN p.status = 'FAILED' THEN p.verified_by END))`.as('deletedByAgent'),
        ])
        .orderBy('p.paymentDate', 'desc')
        .orderBy('p.createdAt', 'desc')
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute(),
      query
        .select((eb) => [eb.fn.countAll<string>().as('n'), sql<string>`coalesce(sum(p.amount), 0)`.as('amount')])
        .executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page: q.page, pageSize: q.pageSize, total: Number(totals.n), totalAmount: fromPaise(toPaise(totals.amount)) });
  }

  /** Single payment, visible to admins, its collector, or the agent currently assigned to the customer. */
  async get(id: string, user: AuthUser) {
    const p = await this.db.selectFrom('payments').select(['id', 'customerId', 'collectedBy']).where('id', '=', id).executeTakeFirst();
    if (!p) throw notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    if (!canReadAllCustomers(user.role)) {
      const hasCustomer = await this.access.assertCanAccess(user, p.customerId).then(
        () => true,
        () => false,
      );
      if (!hasCustomer) {
        if (p.collectedBy !== user.id) throw notFound('PAYMENT_NOT_FOUND', 'Payment not found');
        // The collector keeps sight of their own payment, but not of the customer any more (review M-4).
        const d = await this.detail(this.db, id);
        return { ...d, customerBalance: null, allocations: [], receipt: d.receipt ? { ...d.receipt, snapshot: null } : null, limited: true };
      }
    }
    return this.detail(this.db, id);
  }

  async detail(db: Database, id: string) {
    const p = await db
      .selectFrom('payments as p')
      .innerJoin('customers as c', 'c.id', 'p.customerId')
      .leftJoin('users as u', 'u.id', 'p.collectedBy')
      .selectAll('p')
      .select(['c.customerCode', 'c.name as customerName', 'u.fullName as collectedByName'])
      .where('p.id', '=', id)
      .executeTakeFirstOrThrow();
    const [allocations, receipt, balance] = await Promise.all([
      this.ledger.allocationsOf(db, { paymentId: id }),
      db
        .selectFrom('receipts')
        .select(['id', 'receiptNumber', 'status', 'issuedAt', 'snapshot'])
        .where('paymentId', '=', id)
        .orderBy('issuedAt', 'desc')
        .executeTakeFirst(),
      this.ledger.summary(db, p.customerId),
    ]);
    const allocated = allocations.reduce((s, a) => s + toPaise(a.amount), 0n);
    return {
      ...p,
      allocations,
      unallocated: p.status === 'CONFIRMED' ? fromPaise(toPaise(p.amount) - allocated) : '0.00',
      receipt: receipt ?? null,
      customerBalance: balance,
    };
  }

  private async lockPayment(trx: Database, id: string) {
    const head = await trx.selectFrom('payments').select('customerId').where('id', '=', id).executeTakeFirst();
    if (!head) throw notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    await this.ledger.lockCustomer(trx, head.customerId);
    return trx.selectFrom('payments').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
  }
}
