import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { CreditRequest, DebitRequest, OpeningBalanceRequest, RefundRequest } from '@cablenet/contracts';
import { addDays, businessDateOf, fromPaise, hasPermission, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { assertWithinApprovalLimit } from './approval-limits';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { LedgerService } from './ledger.service';

/** Discounts, credit/debit adjustments, refunds and opening balances (admin only). */
@Injectable()
export class CreditsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private assertWithinLimit(db: Database, amount: string, actor: AuthUser, customerId: string): Promise<void> {
    return assertWithinApprovalLimit(db, this.settings, actor, customerId, amount);
  }

  async addCredit(customerId: string, input: CreditRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.ledger.lockCustomer(trx, customerId);
      await this.assertWithinLimit(trx, input.amount, actor, customerId);
      if (input.targetInvoiceId) {
        const inv = await trx
          .selectFrom('invoices')
          .select(['customerId', 'status'])
          .where('id', '=', input.targetInvoiceId)
          .executeTakeFirst();
        if (!inv || inv.customerId !== customerId) throw notFound('INVOICE_NOT_FOUND', 'Invoice not found for this customer');
        if (inv.status === 'CANCELLED') throw unprocessable('INVOICE_CANCELLED', 'Cannot discount a cancelled invoice');
      }
      const today = businessDateOf(new Date());
      const credit = await trx
        .insertInto('creditNotes')
        .values({
          creditNumber: await this.ledger.nextNumber(trx, 'CRN', today),
          customerId,
          kind: input.kind,
          amount: input.amount,
          creditDate: today,
          targetInvoiceId: input.targetInvoiceId ?? null,
          reason: input.reason,
          approvedBy: actor.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.ledger.post(trx, {
        customerId,
        entryDate: today,
        type: input.kind === 'DISCOUNT' ? 'DISCOUNT' : 'CREDIT_ADJUSTMENT',
        amount: -toPaise(input.amount),
        description: `${input.kind === 'DISCOUNT' ? 'Discount' : 'Credit adjustment'} ${credit.creditNumber}: ${input.reason}`,
        creditNoteId: credit.id,
        createdBy: actor.id,
      });
      await this.ledger.allocate(trx, customerId, actor.id);
      await this.audit.record(trx, { action: 'credit.created', entityType: 'credit_note', entityId: credit.id, after: credit, reason: input.reason });
      return { ...credit, allocations: await this.ledger.allocationsOf(trx, { creditNoteId: credit.id }), balance: await this.ledger.summary(trx, customerId) };
    });
  }

  async reverseCredit(creditId: string, reason: string, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const head = await trx.selectFrom('creditNotes').select('customerId').where('id', '=', creditId).executeTakeFirst();
      if (!head) throw notFound('CREDIT_NOT_FOUND', 'Credit note not found');
      await this.ledger.lockCustomer(trx, head.customerId);
      const credit = await trx.selectFrom('creditNotes').selectAll().where('id', '=', creditId).forUpdate().executeTakeFirstOrThrow();
      if (credit.status !== 'ACTIVE') throw conflict('CREDIT_ALREADY_REVERSED', 'Credit note already reversed');
      const refunded = await trx
        .selectFrom('allocations')
        .select(sql<string>`coalesce(sum(amount), 0)`.as('n'))
        .where('creditNoteId', '=', creditId)
        .where('refundId', 'is not', null)
        .executeTakeFirstOrThrow();
      if (toPaise(refunded.n) > 0n) throw conflict('CREDIT_REFUNDED', 'Part of this credit was refunded; it cannot be reversed');

      await this.ledger.reverse(trx, { creditNoteId: creditId }, businessDateOf(new Date()), `Credit ${credit.creditNumber} reversed: ${reason}`, actor.id);
      await this.ledger.releaseAllocations(trx, { creditNoteId: creditId }, actor.id);
      await trx
        .updateTable('creditNotes')
        .set({ status: 'REVERSED', reversedAt: sql<Date>`now()`, reversedBy: actor.id, reverseReason: reason })
        .where('id', '=', creditId)
        .execute();
      await this.ledger.allocate(trx, credit.customerId, actor.id);
      await this.audit.record(trx, { action: 'credit.reversed', entityType: 'credit_note', entityId: creditId, before: { status: 'ACTIVE' }, after: { status: 'REVERSED' }, reason });
      return { id: creditId, status: 'REVERSED', balance: await this.ledger.summary(trx, credit.customerId) };
    });
  }

  /** Extra charge (installation, reconnection, box replacement…) as its own receivable. */
  async addDebit(customerId: string, input: DebitRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.ledger.lockCustomer(trx, customerId);
      const today = businessDateOf(new Date());
      const dueDays = (await this.settings.get('billing.defaults', trx)).dueDays;
      const dueDate = input.dueDate ?? addDays(today, dueDays);
      if (dueDate < today) throw unprocessable('DUE_DATE_IN_PAST', 'Due date cannot be in the past');
      const previous = await this.ledger.balance(trx, customerId);
      const invoice = await trx
        .insertInto('invoices')
        .values({
          invoiceNumber: await this.ledger.nextNumber(trx, 'INV', today),
          kind: 'DEBIT_ADJUSTMENT',
          customerId,
          billingDate: today,
          dueDate,
          subtotal: input.amount,
          total: input.amount,
          previousOutstandingSnapshot: fromPaise(previous),
          status: 'UNPAID',
          description: input.description,
          source: 'ADMIN',
          createdBy: actor.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('invoiceItems')
        .values({ invoiceId: invoice.id, itemType: 'ADJUSTMENT', description: input.description, amount: input.amount })
        .execute();
      await this.ledger.post(trx, {
        customerId,
        entryDate: today,
        type: 'DEBIT_ADJUSTMENT',
        amount: toPaise(input.amount),
        description: `${input.description} (${invoice.invoiceNumber})`,
        invoiceId: invoice.id,
        createdBy: actor.id,
      });
      await this.ledger.allocate(trx, customerId, actor.id);
      await this.audit.record(trx, { action: 'debit.created', entityType: 'invoice', entityId: invoice.id, after: invoice, reason: input.reason });
      return { ...invoice, balance: await this.ledger.summary(trx, customerId) };
    });
  }

  /** Returns part of the customer's advance. Uses the oldest unallocated credit first. */
  async refund(customerId: string, input: RefundRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.ledger.lockCustomer(trx, customerId);
      await this.assertWithinLimit(trx, input.amount, actor, customerId);
      const credits = await this.ledger.openCredits(trx, customerId);
      const available = credits.reduce((s, c) => s + c.remaining, 0n);
      const amount = toPaise(input.amount);
      if (amount > available) {
        throw unprocessable('INSUFFICIENT_ADVANCE', `Only ₹${fromPaise(available)} of advance is available to refund`);
      }
      const today = businessDateOf(new Date());
      const refund = await trx
        .insertInto('refunds')
        .values({
          refundNumber: await this.ledger.nextNumber(trx, 'RFD', today),
          customerId,
          amount: input.amount,
          refundDate: today,
          mode: input.mode,
          reference: input.reference ?? null,
          reason: input.reason,
          approvedBy: actor.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      let left = amount;
      for (const c of credits) {
        if (left === 0n) break;
        const x = c.remaining < left ? c.remaining : left;
        await trx
          .insertInto('allocations')
          .values({
            customerId,
            paymentId: c.kind === 'P' ? c.id : null,
            creditNoteId: c.kind === 'C' ? c.id : null,
            refundId: refund.id,
            amount: fromPaise(x),
            createdBy: actor.id,
          })
          .execute();
        left -= x;
      }
      await this.ledger.post(trx, {
        customerId,
        entryDate: today,
        type: 'REFUND',
        amount,
        description: `Refund ${refund.refundNumber} (${input.mode.toLowerCase()}): ${input.reason}`,
        refundId: refund.id,
        createdBy: actor.id,
      });
      await this.audit.record(trx, { action: 'refund.created', entityType: 'refund', entityId: refund.id, after: refund, reason: input.reason });
      return { ...refund, balance: await this.ledger.summary(trx, customerId) };
    });
  }

  /**
   * Deletes a refund entered by mistake: its ledger entry is reversed and the advance it used is
   * available again (and goes to open bills). Kept in history with the reason.
   */
  async reverseRefund(refundId: string, reason: string, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const head = await trx.selectFrom('refunds').select('customerId').where('id', '=', refundId).executeTakeFirst();
      if (!head) throw notFound('REFUND_NOT_FOUND', 'Refund not found');
      await this.ledger.lockCustomer(trx, head.customerId);
      const refund = await trx.selectFrom('refunds').selectAll().where('id', '=', refundId).executeTakeFirstOrThrow();
      const done = await trx.selectFrom('refundReversals').select('id').where('refundId', '=', refundId).executeTakeFirst();
      if (done) throw conflict('REFUND_ALREADY_REVERSED', 'This refund was already deleted');
      await trx.insertInto('refundReversals').values({ refundId, reason, approvedBy: actor.id }).execute();
      await this.ledger.reverse(trx, { refundId }, businessDateOf(new Date()), `Refund ${refund.refundNumber} deleted: ${reason}`, actor.id);
      await this.ledger.releaseAllocations(trx, { refundId }, actor.id);
      await this.ledger.allocate(trx, refund.customerId, actor.id);
      await this.audit.record(trx, { action: 'refund.reversed', entityType: 'refund', entityId: refundId, before: { amount: refund.amount }, after: { status: 'REVERSED' }, reason });
      return { id: refundId, status: 'REVERSED', balance: await this.ledger.summary(trx, refund.customerId) };
    });
  }

  /**
   * One-time balance brought forward from the old system (positive = due, negative = advance).
   * Never imported as a "payment" (EXCEL_MIGRATION_MAPPING §6.2).
   */
  async openingBalance(customerId: string, input: OpeningBalanceRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.ledger.lockCustomer(trx, customerId);
      await this.assertWithinLimit(trx, fromPaise(toPaise(input.amount) < 0n ? -toPaise(input.amount) : toPaise(input.amount)), actor, customerId);
      const existing = await trx
        .selectFrom('ledgerEntries')
        .select('id')
        .where('customerId', '=', customerId)
        .where('type', '=', 'OPENING_BALANCE')
        .executeTakeFirst();
      if (existing) throw conflict('OPENING_BALANCE_EXISTS', 'An opening balance was already recorded for this customer');
      if (input.asOf > businessDateOf(new Date())) throw unprocessable('AS_OF_IN_FUTURE', 'Opening balance date cannot be in the future');

      const amount = toPaise(input.amount);
      if (amount > 0n) {
        const invoice = await trx
          .insertInto('invoices')
          .values({
            invoiceNumber: await this.ledger.nextNumber(trx, 'INV', input.asOf),
            kind: 'OPENING_BALANCE',
            customerId,
            billingDate: input.asOf,
            dueDate: input.asOf,
            subtotal: input.amount,
            total: input.amount,
            status: 'UNPAID',
            description: 'Balance brought forward',
            source: 'ADMIN',
            createdBy: actor.id,
          })
          .returning(['id', 'invoiceNumber'])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('invoiceItems')
          .values({ invoiceId: invoice.id, itemType: 'OPENING_BALANCE', description: 'Balance brought forward', amount: input.amount })
          .execute();
        await this.ledger.post(trx, {
          customerId,
          entryDate: input.asOf,
          type: 'OPENING_BALANCE',
          amount,
          description: `Opening balance due (${invoice.invoiceNumber}): ${input.reason}`,
          invoiceId: invoice.id,
          createdBy: actor.id,
        });
      } else {
        const credit = await trx
          .insertInto('creditNotes')
          .values({
            creditNumber: await this.ledger.nextNumber(trx, 'CRN', input.asOf),
            customerId,
            kind: 'OPENING_ADVANCE',
            amount: fromPaise(-amount),
            creditDate: input.asOf,
            reason: input.reason,
            approvedBy: actor.id,
          })
          .returning(['id', 'creditNumber'])
          .executeTakeFirstOrThrow();
        await this.ledger.post(trx, {
          customerId,
          entryDate: input.asOf,
          type: 'OPENING_BALANCE',
          amount,
          description: `Opening advance (${credit.creditNumber}): ${input.reason}`,
          creditNoteId: credit.id,
          createdBy: actor.id,
        });
      }
      await this.ledger.allocate(trx, customerId, actor.id);
      await this.audit.record(trx, {
        action: 'opening_balance.recorded',
        entityType: 'customer',
        entityId: customerId,
        after: { amount: input.amount, asOf: input.asOf },
        reason: input.reason,
      });
      return this.ledger.summary(trx, customerId);
    });
  }
}
