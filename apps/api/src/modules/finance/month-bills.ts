import { sql } from 'kysely';
import { fromPaise, toPaise, type MonthBill } from '@cablenet/domain';
import type { Database } from '../../db/database';

/**
 * Subscription bills per customer for the month-by-month calendar (office site and agent app):
 * period, amount, how much is paid and the date of the last payment that went to it.
 * `since`: only bills whose period ends on/after this date (null: all).
 */
export async function monthBills(db: Database, customerIds: string[], since: string | null): Promise<Map<string, MonthBill[]>> {
  const out = new Map<string, MonthBill[]>();
  if (customerIds.length === 0) return out;
  const rows = await sql<{ customerId: string; periodStart: string; periodEnd: string; total: string; amountPaid: string; paidOn: string | null }>`
    SELECT i.customer_id, i.period_start, i.period_end, i.total, i.amount_paid,
           (SELECT max(p.payment_date) FROM allocations a JOIN payments p ON p.id = a.payment_id
             WHERE a.invoice_id = i.id AND a.amount > 0
               AND NOT EXISTS (SELECT 1 FROM allocations r WHERE r.reverses_allocation_id = a.id)) AS paid_on
    FROM invoices i
    WHERE i.customer_id = ANY(${customerIds}::uuid[])
      AND i.kind = 'SUBSCRIPTION'
      AND i.status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID')
      AND (${since}::date IS NULL OR i.period_end >= ${since}::date)
    ORDER BY i.customer_id, i.period_start`.execute(db);
  const m = (v: unknown) => fromPaise(toPaise(String(v ?? '0')));
  for (const r of rows.rows) {
    let list = out.get(r.customerId);
    if (!list) out.set(r.customerId, (list = []));
    list.push({ periodStart: r.periodStart, periodEnd: r.periodEnd, total: m(r.total), paid: m(r.amountPaid), paidOn: r.paidOn });
  }
  return out;
}
