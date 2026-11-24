import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  fiscalYear,
  fromPaise,
  OpenCredit,
  OpenInvoice,
  Paise,
  planAllocation,
  splitBalance,
  toPaise,
} from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import type { LedgerType } from '../../db/schema';
import { notFound } from '../../common/errors';

export interface LedgerPosting {
  customerId: string;
  entryDate: string;
  type: LedgerType;
  /** + customer owes more, − customer owes less. */
  amount: Paise;
  description: string;
  invoiceId?: string | null;
  paymentId?: string | null;
  creditNoteId?: string | null;
  refundId?: string | null;
  reversesEntryId?: string | null;
  createdBy: string | null;
}

export interface BalanceSummary {
  balance: string;
  outstanding: string;
  advance: string;
}

export type NumberPrefix = 'INV' | 'RCPT' | 'CRN' | 'RFD' | 'CHO';

/**
 * Low-level financial primitives shared by every money-moving service.
 *
 * Concurrency rule (FINANCIAL_LOGIC §1.4): every operation that changes a customer's money
 * first calls `lockCustomer` inside its transaction. That row lock serialises all postings
 * for one customer; different customers proceed in parallel.
 */
@Injectable()
export class LedgerService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async lockCustomer(trx: Database, customerId: string) {
    const c = await trx
      .selectFrom('customers')
      .select(['id', 'customerCode', 'name', 'mobile', 'addressLine', 'status', 'societyId'])
      .where('id', '=', customerId)
      .forUpdate()
      .executeTakeFirst();
    if (!c) throw notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
    return c;
  }

  /** Gap-free document number per financial year, e.g. INV/2026-27/000042. */
  async nextNumber(trx: Database, prefix: NumberPrefix, businessDate: string): Promise<string> {
    const fy = fiscalYear(businessDate);
    const row = await trx
      .insertInto('numberSequences')
      .values({ name: prefix, fiscalYear: fy, nextValue: '2' })
      .onConflict((oc) => oc.columns(['name', 'fiscalYear']).doUpdateSet({ nextValue: sql`number_sequences.next_value + 1` }))
      .returning(sql<string>`next_value - 1`.as('value'))
      .executeTakeFirstOrThrow();
    return `${prefix}/${fy}/${row.value.padStart(6, '0')}`;
  }

  async post(trx: Database, p: LedgerPosting): Promise<string> {
    if (p.amount === 0n) throw new Error('Ledger amounts cannot be zero');
    const row = await trx
      .insertInto('ledgerEntries')
      .values({
        customerId: p.customerId,
        entryDate: p.entryDate,
        type: p.type,
        amount: fromPaise(p.amount),
        description: p.description,
        invoiceId: p.invoiceId ?? null,
        paymentId: p.paymentId ?? null,
        creditNoteId: p.creditNoteId ?? null,
        refundId: p.refundId ?? null,
        reversesEntryId: p.reversesEntryId ?? null,
        createdBy: p.createdBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Posts the exact opposite of an earlier entry (found by document reference). */
  async reverse(
    trx: Database,
    ref: { invoiceId?: string; paymentId?: string; creditNoteId?: string; refundId?: string },
    entryDate: string,
    description: string,
    createdBy: string,
  ): Promise<void> {
    let q = trx
      .selectFrom('ledgerEntries as e')
      .selectAll('e')
      .where('e.type', '!=', 'REVERSAL')
      .where((eb) => eb.not(eb.exists(eb.selectFrom('ledgerEntries as r').select('r.id').whereRef('r.reversesEntryId', '=', 'e.id'))));
    if (ref.invoiceId) q = q.where('e.invoiceId', '=', ref.invoiceId);
    if (ref.paymentId) q = q.where('e.paymentId', '=', ref.paymentId);
    if (ref.creditNoteId) q = q.where('e.creditNoteId', '=', ref.creditNoteId);
    if (ref.refundId) q = q.where('e.refundId', '=', ref.refundId);
    const entries = await q.execute();
    for (const e of entries) {
      await this.post(trx, {
        customerId: e.customerId,
        entryDate,
        type: 'REVERSAL',
        amount: -toPaise(e.amount),
        description,
        invoiceId: e.invoiceId,
        paymentId: e.paymentId,
        creditNoteId: e.creditNoteId,
        refundId: e.refundId,
        reversesEntryId: e.id,
        createdBy,
      });
    }
  }

  async balance(db: Database, customerId: string): Promise<Paise> {
    const row = await db
      .selectFrom('ledgerEntries')
      .select(sql<string>`coalesce(sum(amount), 0)`.as('b'))
      .where('customerId', '=', customerId)
      .executeTakeFirstOrThrow();
    return toPaise(row.b);
  }

  async summary(db: Database, customerId: string): Promise<BalanceSummary> {
    const b = await this.balance(db, customerId);
    const { outstanding, advance } = splitBalance(b);
    return { balance: fromPaise(b), outstanding: fromPaise(outstanding), advance: fromPaise(advance) };
  }

  // ---------------------------------------------------------------------------
  // Allocation
  // ---------------------------------------------------------------------------

  /** Unallocated part of every live credit (confirmed payments + active credit notes), oldest first. */
  async openCredits(db: Database, customerId: string): Promise<(OpenCredit & { kind: 'P' | 'C'; id: string; date: string })[]> {
    const rows = await sql<{ kind: 'P' | 'C'; id: string; d: string; remaining: string; target: string | null }>`
      SELECT 'P' AS kind, p.id, p.payment_date AS d, p.created_at,
             p.amount - coalesce((SELECT sum(a.amount) FROM allocations a WHERE a.payment_id = p.id), 0) AS remaining,
             NULL::uuid AS target
      FROM payments p
      WHERE p.customer_id = ${customerId} AND p.status = 'CONFIRMED'
      UNION ALL
      SELECT 'C', c.id, c.credit_date, c.created_at,
             c.amount - coalesce((SELECT sum(a.amount) FROM allocations a WHERE a.credit_note_id = c.id), 0),
             c.target_invoice_id
      FROM credit_notes c
      WHERE c.customer_id = ${customerId} AND c.status = 'ACTIVE'
      ORDER BY d, created_at, id
    `.execute(db);
    return rows.rows
      .map((r) => ({
        kind: r.kind,
        id: r.id,
        date: r.d,
        ref: `${r.kind}:${r.id}`,
        remaining: toPaise(r.remaining),
        targetInvoiceId: r.target,
      }))
      .filter((c) => c.remaining > 0n);
  }

  /** Open receivables, oldest first: opening balance, then by period/billing date. */
  async openInvoices(db: Database, customerId: string): Promise<OpenInvoice[]> {
    const rows = await db
      .selectFrom('invoices')
      .select(['id', sql<string>`total - amount_paid`.as('remaining')])
      .where('customerId', '=', customerId)
      .where('status', 'in', ['UNPAID', 'PARTIALLY_PAID'])
      .orderBy(sql`kind = 'OPENING_BALANCE'`, 'desc')
      .orderBy(sql`coalesce(period_start, billing_date)`)
      .orderBy('billingDate')
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, remaining: toPaise(r.remaining) }));
  }

  /**
   * Keeps the customer's allocations strictly oldest-first and applies all unallocated credit.
   *
   * 1. If an older invoice is open while a newer one holds money (after a reversal, a
   *    cancellation or a back-dated opening balance), the newer invoices' allocations are
   *    released with compensating rows, so the money can flow to the oldest debt first.
   *    Discounts targeted at a specific invoice stay where they are.
   * 2. Unallocated credit is then planned FIFO (packages/domain planAllocation).
   *
   * In the normal flow step 1 finds nothing to release. Idempotent; must run inside the
   * customer-locked transaction.
   */
  async allocate(trx: Database, customerId: string, actorId: string | null): Promise<number> {
    await this.releaseOutOfOrder(trx, customerId, actorId);
    const [credits, invoices] = await Promise.all([this.openCredits(trx, customerId), this.openInvoices(trx, customerId)]);
    if (credits.length === 0 || invoices.length === 0) return 0;
    const plan = planAllocation(credits, invoices);
    if (plan.length === 0) return 0;
    const byRef = new Map(credits.map((c) => [c.ref, c]));
    await trx
      .insertInto('allocations')
      .values(
        plan.map((a) => {
          const credit = byRef.get(a.creditRef)!;
          return {
            customerId,
            paymentId: credit.kind === 'P' ? credit.id : null,
            creditNoteId: credit.kind === 'C' ? credit.id : null,
            invoiceId: a.invoiceId,
            amount: fromPaise(a.amount),
            createdBy: actorId,
          };
        }),
      )
      .execute();
    await this.refreshInvoices(trx, [...new Set(plan.map((a) => a.invoiceId))]);
    return plan.length;
  }

  private async releaseOutOfOrder(trx: Database, customerId: string, actorId: string | null): Promise<void> {
    const ordered = await trx
      .selectFrom('invoices')
      .select(['id', 'status', sql<string>`amount_paid`.as('paid')])
      .where('customerId', '=', customerId)
      .where('status', 'in', ['UNPAID', 'PARTIALLY_PAID', 'PAID'])
      .orderBy(sql`kind = 'OPENING_BALANCE'`, 'desc')
      .orderBy(sql`coalesce(period_start, billing_date)`)
      .orderBy('billingDate')
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
    const firstOpen = ordered.findIndex((i) => i.status !== 'PAID');
    if (firstOpen < 0) return;
    const later = ordered.slice(firstOpen + 1).filter((i) => toPaise(i.paid) > 0n).map((i) => i.id);
    if (later.length === 0) return;
    const res = await sql<{ invoiceId: string }>`
      INSERT INTO allocations (customer_id, payment_id, credit_note_id, invoice_id, refund_id, amount, reverses_allocation_id, created_by)
      SELECT a.customer_id, a.payment_id, a.credit_note_id, a.invoice_id, a.refund_id, -a.amount, a.id, ${actorId}
      FROM allocations a
      LEFT JOIN credit_notes c ON c.id = a.credit_note_id
      WHERE a.invoice_id IN (${sql.join(later)})
        AND a.amount > 0
        AND NOT EXISTS (SELECT 1 FROM allocations r WHERE r.reverses_allocation_id = a.id)
        AND (c.target_invoice_id IS DISTINCT FROM a.invoice_id)
      RETURNING invoice_id
    `.execute(trx);
    await this.refreshInvoices(trx, [...new Set(res.rows.map((r) => r.invoiceId))]);
  }

  /**
   * Undoes the live allocations of a payment, credit note or invoice by appending
   * compensating (negative) rows. Returns the affected invoice ids (already refreshed).
   */
  async releaseAllocations(
    trx: Database,
    filter: { paymentId?: string; creditNoteId?: string; invoiceId?: string; refundId?: string },
    actorId: string,
  ): Promise<string[]> {
    const col = filter.paymentId ? 'payment_id' : filter.creditNoteId ? 'credit_note_id' : filter.refundId ? 'refund_id' : 'invoice_id';
    const value = filter.paymentId ?? filter.creditNoteId ?? filter.refundId ?? filter.invoiceId;
    const res = await sql<{ invoiceId: string | null }>`
      INSERT INTO allocations (customer_id, payment_id, credit_note_id, invoice_id, refund_id, amount, reverses_allocation_id, created_by)
      SELECT a.customer_id, a.payment_id, a.credit_note_id, a.invoice_id, a.refund_id, -a.amount, a.id, ${actorId}
      FROM allocations a
      WHERE a.${sql.raw(col)} = ${value}
        AND a.amount > 0
        AND NOT EXISTS (SELECT 1 FROM allocations r WHERE r.reverses_allocation_id = a.id)
      RETURNING invoice_id
    `.execute(trx);
    const invoiceIds = [...new Set(res.rows.map((r) => r.invoiceId).filter((id): id is string => !!id))];
    await this.refreshInvoices(trx, invoiceIds);
    return invoiceIds;
  }

  /** Recomputes the cached amount_paid / status of invoices from their allocations. */
  async refreshInvoices(trx: Database, invoiceIds: string[]): Promise<void> {
    if (invoiceIds.length === 0) return;
    await sql`
      UPDATE invoices i
      SET amount_paid = p.paid,
          status = CASE
            WHEN i.status IN ('CANCELLED', 'DRAFT') THEN i.status
            WHEN p.paid >= i.total THEN 'PAID'::invoice_status
            WHEN p.paid = 0 THEN 'UNPAID'::invoice_status
            ELSE 'PARTIALLY_PAID'::invoice_status
          END
      FROM (
        SELECT inv.id, coalesce(sum(a.amount), 0) AS paid
        FROM invoices inv LEFT JOIN allocations a ON a.invoice_id = inv.id
        WHERE inv.id IN (${sql.join(invoiceIds)})
        GROUP BY inv.id
      ) p
      WHERE i.id = p.id
    `.execute(trx);
  }

  /** Allocation lines for a payment/credit, with invoice labels (for receipts and the UI). */
  async allocationsOf(db: Database, filter: { paymentId?: string; invoiceId?: string; creditNoteId?: string }) {
    let q = db
      .selectFrom('allocations as a')
      .leftJoin('invoices as i', 'i.id', 'a.invoiceId')
      .leftJoin('payments as p', 'p.id', 'a.paymentId')
      .leftJoin('creditNotes as c', 'c.id', 'a.creditNoteId')
      .select([
        'a.id',
        'a.amount',
        'a.createdAt',
        'a.reversesAllocationId',
        'a.invoiceId',
        'a.refundId',
        'a.paymentId',
        'a.creditNoteId',
        'i.invoiceNumber',
        'i.kind as invoiceKind',
        'i.periodStart',
        'i.periodEnd',
        'p.clientTxnId',
        'c.creditNumber',
      ]);
    if (filter.paymentId) q = q.where('a.paymentId', '=', filter.paymentId);
    if (filter.invoiceId) q = q.where('a.invoiceId', '=', filter.invoiceId);
    if (filter.creditNoteId) q = q.where('a.creditNoteId', '=', filter.creditNoteId);
    return q.orderBy('a.createdAt').orderBy('a.id').execute();
  }
}
