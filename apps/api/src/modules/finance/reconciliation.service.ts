import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { AlertsService } from './alerts.service';

export interface ReconciliationResult {
  checkedCustomers: number;
  customerMismatches: { customerId: string; ledger: string; derived: string }[];
  invoiceCacheMismatches: { invoiceId: string; cached: string; allocated: string }[];
  overAllocatedCredits: { kind: string; id: string; amount: string; allocated: string }[];
  newAlerts: number;
}

/**
 * Independent cross-checks of the financial invariants (FINANCIAL_LOGIC §8). Read-only: a
 * mismatch raises an alert for a human; nothing is auto-corrected.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly alerts: AlertsService,
  ) {}

  async run(): Promise<ReconciliationResult> {
    // 1. ledger balance == Σ open invoice balances − Σ unallocated live credits
    const customers = await sql<{ customerId: string; ledger: string; derived: string }>`
      WITH ledger AS (
        SELECT customer_id, sum(amount) AS bal FROM ledger_entries GROUP BY customer_id
      ), receivable AS (
        SELECT customer_id, sum(total - amount_paid) AS due FROM invoices WHERE status <> 'CANCELLED' GROUP BY customer_id
      ), credit AS (
        SELECT customer_id, sum(remaining) AS unallocated FROM (
          SELECT p.customer_id, p.amount - coalesce((SELECT sum(a.amount) FROM allocations a WHERE a.payment_id = p.id), 0) AS remaining
          FROM payments p WHERE p.status = 'CONFIRMED'
          UNION ALL
          SELECT c.customer_id, c.amount - coalesce((SELECT sum(a.amount) FROM allocations a WHERE a.credit_note_id = c.id), 0)
          FROM credit_notes c WHERE c.status = 'ACTIVE'
        ) x GROUP BY customer_id
      ), ids AS (
        SELECT customer_id FROM ledger UNION SELECT customer_id FROM receivable UNION SELECT customer_id FROM credit
      )
      SELECT ids.customer_id,
             coalesce(l.bal, 0) AS ledger,
             coalesce(r.due, 0) - coalesce(c.unallocated, 0) AS derived
      FROM ids
      LEFT JOIN ledger l USING (customer_id)
      LEFT JOIN receivable r USING (customer_id)
      LEFT JOIN credit c USING (customer_id)
    `.execute(this.db);
    const customerMismatches = customers.rows.filter((r) => toPaise(r.ledger) !== toPaise(r.derived));

    // 2. invoice.amount_paid cache == Σ allocations (and never above total)
    const invoices = await sql<{ invoiceId: string; cached: string; allocated: string }>`
      SELECT i.id AS invoice_id, i.amount_paid AS cached, coalesce(sum(a.amount), 0) AS allocated
      FROM invoices i LEFT JOIN allocations a ON a.invoice_id = i.id
      GROUP BY i.id
      HAVING i.amount_paid <> coalesce(sum(a.amount), 0)
    `.execute(this.db);

    // 3. no credit allocated beyond its amount; no negative net allocation
    const credits = await sql<{ kind: string; id: string; amount: string; allocated: string }>`
      SELECT 'PAYMENT' AS kind, p.id, p.amount, coalesce(sum(a.amount), 0) AS allocated
      FROM payments p LEFT JOIN allocations a ON a.payment_id = p.id
      GROUP BY p.id HAVING coalesce(sum(a.amount), 0) > p.amount OR coalesce(sum(a.amount), 0) < 0
      UNION ALL
      SELECT 'CREDIT_NOTE', c.id, c.amount, coalesce(sum(a.amount), 0)
      FROM credit_notes c LEFT JOIN allocations a ON a.credit_note_id = c.id
      GROUP BY c.id HAVING coalesce(sum(a.amount), 0) > c.amount OR coalesce(sum(a.amount), 0) < 0
    `.execute(this.db);

    let newAlerts = 0;
    for (const m of customerMismatches) {
      if (
        await this.alerts.raise(this.db, {
          type: 'LEDGER_MISMATCH',
          severity: 'CRITICAL',
          entityType: 'customer',
          entityId: m.customerId,
          message: `Ledger balance ₹${m.ledger} does not match invoices/credits (₹${m.derived})`,
          details: m,
        })
      )
        newAlerts++;
    }
    for (const m of invoices.rows) {
      if (
        await this.alerts.raise(this.db, {
          type: 'INVOICE_CACHE_MISMATCH',
          severity: 'CRITICAL',
          entityType: 'invoice',
          entityId: m.invoiceId,
          message: `Invoice paid amount ₹${m.cached} differs from its allocations ₹${m.allocated}`,
          details: m,
        })
      )
        newAlerts++;
    }
    for (const m of credits.rows) {
      if (
        await this.alerts.raise(this.db, {
          type: 'CREDIT_OVER_ALLOCATED',
          severity: 'CRITICAL',
          entityType: m.kind.toLowerCase(),
          entityId: m.id,
          message: `${m.kind} ₹${m.amount} has ₹${m.allocated} allocated`,
          details: m,
        })
      )
        newAlerts++;
    }

    return {
      checkedCustomers: customers.rows.length,
      customerMismatches,
      invoiceCacheMismatches: invoices.rows,
      overAllocatedCredits: credits.rows,
      newAlerts,
    };
  }
}
