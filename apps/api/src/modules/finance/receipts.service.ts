import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { businessDateOf, fromPaise, periodLabel, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { conflict, notFound } from '../../common/errors';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { LedgerService } from './ledger.service';

export interface ReceiptSnapshot {
  business: { name: string; address?: string | null; phone?: string | null; gstin?: string | null; logoUrl?: string | null; footer?: string | null };
  receiptNumber: string;
  issuedAt: string;
  payment: {
    id: string;
    amount: string;
    paymentDate: string;
    receivedAt: string | null;
    mode: string;
    reference: string | null;
    source: string;
    collectedBy: string | null;
  };
  customer: { id: string; code: string; name: string; mobile: string | null; address: string };
  allocations: { label: string; invoiceNumber: string | null; amount: string }[];
  advanceCreated: string;
  previousOutstanding: string;
  previousAdvance: string;
  remainingOutstanding: string;
  remainingAdvance: string;
  reissueOf: string | null;
}

/**
 * Receipts are issued only for CONFIRMED payments. The printed values are frozen in
 * `snapshot` so a reprint years later shows exactly what the customer received.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Issues a receipt. `before` is the customer's balance snapshot taken just before the
   * payment was posted; the "after" figures are read inside the same transaction.
   */
  async issue(
    trx: Database,
    paymentId: string,
    before: { outstanding: string; advance: string },
    actorId: string,
    reissueOf: { id: string; number: string } | null = null,
    carryOver: Partial<Pick<ReceiptSnapshot, 'allocations' | 'advanceCreated' | 'remainingOutstanding' | 'remainingAdvance'>> = {},
  ) {
    const p = await trx
      .selectFrom('payments as p')
      .innerJoin('customers as c', 'c.id', 'p.customerId')
      .leftJoin('users as u', 'u.id', 'p.collectedBy')
      .select([
        'p.id',
        'p.amount',
        'p.paymentDate',
        'p.receivedAt',
        'p.mode',
        'p.reference',
        'p.source',
        'p.status',
        'c.id as customerId',
        'c.customerCode',
        'c.name as customerName',
        'c.mobile',
        'c.addressLine',
        'u.fullName as collectedBy',
      ])
      .where('p.id', '=', paymentId)
      .executeTakeFirstOrThrow();
    if (p.status !== 'CONFIRMED') throw conflict('PAYMENT_NOT_CONFIRMED', 'Receipts are issued only for confirmed payments');

    const [allocs, after, business] = await Promise.all([
      this.ledger.allocationsOf(trx, { paymentId }),
      this.ledger.summary(trx, p.customerId),
      this.settings.get('business.profile', trx),
    ]);
    const live = allocs.filter((a) => toPaise(a.amount) > 0n && a.invoiceId);
    const allocated = live.reduce((s, a) => s + toPaise(a.amount), 0n);
    const number = await this.ledger.nextNumber(trx, 'RCPT', businessDateOf(new Date()));
    const issuedAt = new Date().toISOString();

    const snapshot: ReceiptSnapshot = {
      business: {
        name: business.name,
        address: business.address,
        phone: business.phone,
        gstin: business.gstin,
        logoUrl: business.logoUrl,
        footer: business.receiptFooter,
      },
      receiptNumber: number,
      issuedAt,
      payment: {
        id: p.id,
        amount: p.amount,
        paymentDate: p.paymentDate,
        receivedAt: p.receivedAt ? p.receivedAt.toISOString() : null,
        mode: p.mode,
        reference: p.reference,
        source: p.source,
        collectedBy: p.collectedBy,
      },
      customer: { id: p.customerId, code: p.customerCode, name: p.customerName, mobile: p.mobile, address: p.addressLine },
      allocations: live.map((a) => ({
        label:
          a.invoiceKind === 'OPENING_BALANCE'
            ? 'Previous balance'
            : a.periodStart && a.periodEnd
              ? periodLabel(a.periodStart, a.periodEnd)
              : 'Adjustment',
        invoiceNumber: a.invoiceNumber,
        amount: a.amount,
      })),
      advanceCreated: fromPaise(toPaise(p.amount) - allocated),
      previousOutstanding: before.outstanding,
      previousAdvance: before.advance,
      remainingOutstanding: after.outstanding,
      remainingAdvance: after.advance,
      reissueOf: reissueOf?.number ?? null,
      ...carryOver,
    };

    return trx
      .insertInto('receipts')
      .values({
        receiptNumber: number,
        paymentId,
        snapshot: JSON.stringify(snapshot),
        issuedBy: actorId,
        reissueOfReceiptId: reissueOf?.id ?? null,
      })
      .returning(['id', 'receiptNumber', 'status', 'snapshot', 'issuedAt'])
      .executeTakeFirstOrThrow();
  }

  async cancelForPayment(trx: Database, paymentId: string, reason: string, actorId: string): Promise<void> {
    await trx
      .updateTable('receipts')
      .set({ status: 'CANCELLED', cancelledAt: sql<Date>`now()`, cancelledBy: actorId, cancelReason: reason })
      .where('paymentId', '=', paymentId)
      .where('status', '=', 'ISSUED')
      .execute();
  }

  /**
   * Replaces a receipt (e.g. damaged print, wrong business details at the time). The old
   * receipt is cancelled and a new number issued; the balance figures are carried over from
   * the original so the new copy states what was true when the payment was made.
   */
  async reissue(receiptId: string, reason: string, actorId: string) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('receipts').selectAll().where('id', '=', receiptId).forUpdate().executeTakeFirst();
      if (!old) throw notFound('RECEIPT_NOT_FOUND', 'Receipt not found');
      if (old.status !== 'ISSUED') throw conflict('RECEIPT_CANCELLED', 'Only an issued receipt can be reissued');
      const snap = old.snapshot as ReceiptSnapshot;
      await trx
        .updateTable('receipts')
        .set({ status: 'CANCELLED', cancelledAt: sql<Date>`now()`, cancelledBy: actorId, cancelReason: `Reissued: ${reason}` })
        .where('id', '=', receiptId)
        .execute();
      // Carry the original figures over: later activity must not change this receipt's story.
      const fresh = await this.issue(
        trx,
        old.paymentId,
        { outstanding: snap.previousOutstanding, advance: snap.previousAdvance },
        actorId,
        { id: old.id, number: old.receiptNumber },
        {
          allocations: snap.allocations,
          advanceCreated: snap.advanceCreated,
          remainingOutstanding: snap.remainingOutstanding,
          remainingAdvance: snap.remainingAdvance,
        },
      );
      await this.audit.record(trx, {
        action: 'receipt.reissued',
        entityType: 'receipt',
        entityId: fresh.id,
        before: { receiptNumber: old.receiptNumber },
        after: { receiptNumber: fresh.receiptNumber },
        reason,
      });
      return fresh;
    });
  }

  async get(id: string) {
    const r = await this.db.selectFrom('receipts').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) throw notFound('RECEIPT_NOT_FOUND', 'Receipt not found');
    return r;
  }
}
