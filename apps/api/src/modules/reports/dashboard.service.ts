import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { addMonths, businessDateOf, fromPaise, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { badRequest } from '../../common/errors';

export interface DashboardFilters {
  from?: string;
  to?: string;
  agentId?: string;
  societyId?: string;
  areaId?: string;
}

const m = (v: string | null | undefined) => fromPaise(toPaise(v ?? '0'));

/**
 * Business overview. Every figure is computed from the ledger/payments in the database;
 * nothing is cached or estimated.
 *
 * Filter semantics: society/area/agent narrow the *customers* (agent = currently assigned).
 * Collections are additionally narrowed to what that agent collected when an agent is chosen.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async overview(input: DashboardFilters) {
    const today = businessDateOf(new Date());
    const from = input.from ?? `${today.slice(0, 8)}01`;
    const to = input.to ?? today;
    if (to < from) throw badRequest('INVALID_RANGE', 'The end date is before the start date');
    const f = { ...input, from, to, today };

    const scope = (alias: string, includeAgent = true) => {
      const ref = (col: string) => sql.ref(`${alias}.${col}`);
      const parts = [sql`TRUE`];
      if (f.societyId) parts.push(sql`${ref('society_id')} = ${f.societyId}::uuid`);
      if (f.areaId) parts.push(sql`EXISTS (SELECT 1 FROM societies s2 WHERE s2.id = ${ref('society_id')} AND s2.area_id = ${f.areaId}::uuid)`);
      if (f.agentId && includeAgent) {
        parts.push(sql`EXISTS (SELECT 1 FROM customer_current_agent x WHERE x.customer_id = ${ref('id')} AND x.agent_id = ${f.agentId}::uuid)`);
      }
      return sql.join(parts, sql` AND `);
    };
    // Collections: with an agent chosen, count what that agent collected (even from customers
    // since moved to someone else); society/area filters still apply.
    const payScope = sql`p.status = 'CONFIRMED' AND ${f.agentId ? sql`p.collected_by = ${f.agentId}::uuid` : sql`TRUE`}
      AND EXISTS (SELECT 1 FROM customers cu WHERE cu.id = p.customer_id AND ${scope('cu', false)})`;

    const kpi = await sql<Record<string, string>>`
      SELECT
        (SELECT count(*) FROM customers c WHERE c.status IN ('ACTIVE', 'SUSPENDED') AND c.deleted_at IS NULL AND ${scope('c')}) AS active_customers,
        (SELECT count(*) FROM customers c WHERE c.status IN ('INACTIVE', 'DISCONNECTED') AND c.deleted_at IS NULL AND ${scope('c')}) AS inactive_customers,
        (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.payment_date = ${today}::date AND ${payScope}) AS today_collection,
        (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.payment_date BETWEEN ${from}::date AND ${to}::date AND ${payScope}) AS period_collection,
        (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE date_trunc('month', p.payment_date) = date_trunc('month', ${today}::date) AND ${payScope}) AS month_collection,
        (SELECT coalesce(sum(e.amount), 0) FROM ledger_entries e JOIN customers c ON c.id = e.customer_id
           WHERE e.type = 'CHARGE' AND e.entry_date BETWEEN ${from}::date AND ${to}::date AND ${scope('c')}) AS period_billed,
        (SELECT coalesce(sum(b.outstanding), 0) FROM customer_balances b JOIN customers c ON c.id = b.customer_id WHERE ${scope('c')}) AS total_outstanding,
        (SELECT coalesce(sum(b.advance), 0) FROM customer_balances b JOIN customers c ON c.id = b.customer_id WHERE ${scope('c')}) AS total_advance,
        (SELECT count(DISTINCT i.customer_id) FROM invoices i JOIN customers c ON c.id = i.customer_id
           WHERE i.status IN ('UNPAID', 'PARTIALLY_PAID') AND i.due_date = ${today}::date AND ${scope('c')}) AS due_today_customers,
        (SELECT count(DISTINCT i.customer_id) FROM invoices i JOIN customers c ON c.id = i.customer_id
           WHERE i.status IN ('UNPAID', 'PARTIALLY_PAID') AND i.due_date < ${today}::date AND ${scope('c')}) AS overdue_customers,
        (SELECT coalesce(sum(i.total - i.amount_paid), 0) FROM invoices i JOIN customers c ON c.id = i.customer_id
           WHERE i.status IN ('UNPAID', 'PARTIALLY_PAID') AND i.due_date < ${today}::date AND ${scope('c')}) AS overdue_amount,
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE mode = 'CASH' AND status = 'CONFIRMED' ${f.agentId ? sql`AND collected_by = ${f.agentId}::uuid` : sql`AND collected_by IN (SELECT id FROM users WHERE role = 'AGENT')`})
          - (SELECT coalesce(sum(received_amount), 0) FROM cash_handovers WHERE status = 'CONFIRMED' ${f.agentId ? sql`AND agent_id = ${f.agentId}::uuid` : sql``})
          - (SELECT coalesce(sum(amount), 0) FROM cash_adjustments ${f.agentId ? sql`WHERE agent_id = ${f.agentId}::uuid` : sql``}) AS agent_cash_in_hand,
        (SELECT count(*) FROM cash_handovers WHERE status = 'SUBMITTED' ${f.agentId ? sql`AND agent_id = ${f.agentId}::uuid` : sql``}) AS pending_handovers,
        (SELECT coalesce(sum(expected_amount), 0) FROM cash_handovers WHERE status = 'SUBMITTED' ${f.agentId ? sql`AND agent_id = ${f.agentId}::uuid` : sql``}) AS pending_handover_amount,
        (SELECT count(*) FROM payments WHERE status = 'PENDING_VERIFICATION') AS pending_verifications,
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'PENDING_VERIFICATION') AS pending_verification_amount,
        (SELECT count(*) FROM follow_up_tasks WHERE status = 'OPEN' AND due_date <= ${today}::date) AS follow_ups_due,
        (SELECT count(*) FROM interactions WHERE status = 'PROMISE_TO_PAY' AND promise_date < ${today}::date) AS missed_promises,
        (SELECT count(*) FROM system_alerts WHERE resolved_at IS NULL) AS open_alerts
    `.execute(this.db);
    const k = kpi.rows[0]!;

    const [daily, monthly, agents, societies, ageing, modes, frequencies] = await Promise.all([
      sql<{ date: string; cash: string; upi: string; other: string; total: string }>`
        SELECT d::date AS date,
          coalesce(sum(p.amount) FILTER (WHERE p.mode = 'CASH'), 0) AS cash,
          coalesce(sum(p.amount) FILTER (WHERE p.mode = 'UPI'), 0) AS upi,
          coalesce(sum(p.amount) FILTER (WHERE p.mode NOT IN ('CASH', 'UPI')), 0) AS other,
          coalesce(sum(p.amount), 0) AS total
        FROM generate_series(${from}::date, ${to}::date, interval '1 day') d
        LEFT JOIN payments p ON p.payment_date = d::date AND ${payScope}
        GROUP BY d ORDER BY d`.execute(this.db),
      sql<{ month: string; billed: string; collected: string }>`
        SELECT to_char(mo, 'YYYY-MM') AS month,
          (SELECT coalesce(sum(e.amount), 0) FROM ledger_entries e JOIN customers c ON c.id = e.customer_id
            WHERE e.type = 'CHARGE' AND date_trunc('month', e.entry_date) = mo AND ${scope('c')}) AS billed,
          (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE date_trunc('month', p.payment_date) = mo AND ${payScope}) AS collected
        FROM generate_series(${addMonths(`${to.slice(0, 8)}01`, -11)}::date, ${`${to.slice(0, 8)}01`}::date, interval '1 month') mo
        ORDER BY mo`.execute(this.db),
      this.agentPerformance(f),
      sql<{ society: string; customers: string; collected: string; outstanding: string }>`
        SELECT so.name AS society,
          count(DISTINCT c.id) AS customers,
          (SELECT coalesce(sum(p.amount), 0) FROM payments p JOIN customers c2 ON c2.id = p.customer_id
            WHERE c2.society_id = so.id AND p.payment_date BETWEEN ${from}::date AND ${to}::date AND ${payScope}) AS collected,
          coalesce(sum(b.outstanding), 0) AS outstanding
        FROM societies so
        JOIN customers c ON c.society_id = so.id AND c.deleted_at IS NULL AND ${scope('c')}
        LEFT JOIN customer_balances b ON b.customer_id = c.id
        GROUP BY so.id ORDER BY collected DESC, so.name`.execute(this.db),
      sql<{ bucket: string; invoices: string; amount: string }>`
        WITH open AS (
          SELECT i.total - i.amount_paid AS bal, ${today}::date - i.due_date AS days
          FROM invoices i JOIN customers c ON c.id = i.customer_id
          WHERE i.status IN ('UNPAID', 'PARTIALLY_PAID') AND ${scope('c')}
        ), buckets(bucket, lo, hi, ord) AS (
          VALUES ('Not yet due', -100000, 0, 1), ('1-30 days', 1, 30, 2), ('31-60 days', 31, 60, 3), ('61-90 days', 61, 90, 4), ('90+ days', 91, 100000, 5)
        )
        SELECT b.bucket, count(o.bal) AS invoices, coalesce(sum(o.bal), 0) AS amount
        FROM buckets b LEFT JOIN open o ON o.days BETWEEN b.lo AND b.hi
        GROUP BY b.bucket, b.ord ORDER BY b.ord`.execute(this.db),
      sql<{ mode: string; payments: string; amount: string }>`
        SELECT p.mode::text AS mode, count(*) AS payments, sum(p.amount) AS amount
        FROM payments p WHERE p.payment_date BETWEEN ${from}::date AND ${to}::date AND ${payScope}
        GROUP BY p.mode ORDER BY sum(p.amount) DESC`.execute(this.db),
      sql<{ intervalMonths: number; customers: string }>`
        SELECT s.billing_interval_months AS interval_months, count(*) AS customers
        FROM customer_subscriptions s JOIN customers c ON c.id = s.customer_id
        WHERE s.status <> 'ENDED' AND ${scope('c')}
        GROUP BY s.billing_interval_months ORDER BY s.billing_interval_months`.execute(this.db),
    ]);

    return {
      filters: { from, to, today, agentId: f.agentId ?? null, societyId: f.societyId ?? null, areaId: f.areaId ?? null },
      kpis: {
        activeCustomers: Number(k.activeCustomers),
        inactiveCustomers: Number(k.inactiveCustomers),
        todayCollection: m(k.todayCollection),
        periodCollection: m(k.periodCollection),
        monthCollection: m(k.monthCollection),
        periodBilled: m(k.periodBilled),
        totalOutstanding: m(k.totalOutstanding),
        totalAdvance: m(k.totalAdvance),
        dueTodayCustomers: Number(k.dueTodayCustomers),
        overdueCustomers: Number(k.overdueCustomers),
        overdueAmount: m(k.overdueAmount),
        agentCashInHand: m(k.agentCashInHand),
        pendingHandovers: Number(k.pendingHandovers),
        pendingHandoverAmount: m(k.pendingHandoverAmount),
        pendingVerifications: Number(k.pendingVerifications),
        pendingVerificationAmount: m(k.pendingVerificationAmount),
        followUpsDue: Number(k.followUpsDue),
        missedPromises: Number(k.missedPromises),
        openAlerts: Number(k.openAlerts),
      },
      dailyCollection: daily.rows.map((r) => ({ date: r.date, cash: m(r.cash), upi: m(r.upi), other: m(r.other), total: m(r.total) })),
      monthlyTrend: monthly.rows.map((r) => ({ month: r.month, billed: m(r.billed), collected: m(r.collected) })),
      agentPerformance: agents,
      societyCollection: societies.rows.map((r) => ({ society: r.society, customers: Number(r.customers), collected: m(r.collected), outstanding: m(r.outstanding) })),
      ageing: ageing.rows.map((r) => ({ bucket: r.bucket, invoices: Number(r.invoices), amount: m(r.amount) })),
      paymentModes: modes.rows.map((r) => ({ mode: r.mode, payments: Number(r.payments), amount: m(r.amount) })),
      billingFrequency: frequencies.rows.map((r) => ({ intervalMonths: r.intervalMonths, customers: Number(r.customers) })),
      definitions: {
        expectedCollection:
          'For each customer currently assigned to the agent: balance before the period plus charges in the period (never below zero).',
        collectionPct: 'Amount the agent collected in the period ÷ expected collection.',
      },
    };
  }

  /**
   * Per agent: assigned customers, outstanding now, expected vs actual collection for the
   * period, visits, and cash in hand.
   */
  private async agentPerformance(f: Required<Pick<DashboardFilters, 'from' | 'to'>> & DashboardFilters & { today: string }) {
    const rows = await sql<Record<string, string>>`
      WITH assigned AS (
        SELECT ca.agent_id, ca.customer_id FROM customer_current_agent ca
      ), expected AS (
        SELECT a.agent_id,
          sum(greatest(
            coalesce((SELECT sum(e.amount) FROM ledger_entries e WHERE e.customer_id = a.customer_id AND e.entry_date < ${f.from}::date), 0)
            + coalesce((SELECT sum(e.amount) FROM ledger_entries e WHERE e.customer_id = a.customer_id AND e.type = 'CHARGE'
                        AND e.entry_date BETWEEN ${f.from}::date AND ${f.to}::date), 0), 0)) AS expected
        FROM assigned a GROUP BY a.agent_id
      )
      SELECT u.id AS agent_id, u.full_name AS agent, ap.agent_code,
        (SELECT count(*) FROM assigned a WHERE a.agent_id = u.id) AS assigned_customers,
        (SELECT coalesce(sum(b.outstanding), 0) FROM assigned a JOIN customer_balances b ON b.customer_id = a.customer_id WHERE a.agent_id = u.id) AS outstanding,
        coalesce(ex.expected, 0) AS expected,
        (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.collected_by = u.id AND p.status = 'CONFIRMED'
           AND p.payment_date BETWEEN ${f.from}::date AND ${f.to}::date) AS collected,
        (SELECT count(*) FROM visits v WHERE v.agent_id = u.id AND (v.visited_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${f.from}::date AND ${f.to}::date) AS visits,
        (SELECT count(*) FROM visits v WHERE v.agent_id = u.id AND v.outcome IN ('PAYMENT_COLLECTED', 'PARTIAL_PAYMENT')
           AND (v.visited_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${f.from}::date AND ${f.to}::date) AS successful_visits,
        (SELECT count(*) FROM follow_up_tasks t JOIN assigned a ON a.customer_id = t.customer_id AND a.agent_id = u.id
           WHERE t.status = 'OPEN' AND t.due_date <= ${f.today}::date) AS pending_follow_ups,
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE collected_by = u.id AND mode = 'CASH' AND status = 'CONFIRMED')
          - (SELECT coalesce(sum(received_amount), 0) FROM cash_handovers WHERE agent_id = u.id AND status = 'CONFIRMED')
          - (SELECT coalesce(sum(amount), 0) FROM cash_adjustments WHERE agent_id = u.id) AS cash_in_hand
      FROM users u JOIN agent_profiles ap ON ap.user_id = u.id
      LEFT JOIN expected ex ON ex.agent_id = u.id
      WHERE u.role = 'AGENT' AND u.status = 'ACTIVE' ${f.agentId ? sql`AND u.id = ${f.agentId}::uuid` : sql``}
      ORDER BY u.full_name`.execute(this.db);
    return rows.rows.map((r) => {
      const expected = toPaise(r.expected!);
      const collected = toPaise(r.collected!);
      return {
        agentId: r.agentId,
        agent: r.agent,
        agentCode: r.agentCode,
        assignedCustomers: Number(r.assignedCustomers),
        outstanding: m(r.outstanding),
        expectedCollection: fromPaise(expected),
        actualCollection: fromPaise(collected),
        // A percentage (ratio, not money): one decimal, integer arithmetic.
        collectionPct: expected > 0n ? Number((collected * 1000n) / expected) / 10 : null,
        visits: Number(r.visits),
        successfulVisits: Number(r.successfulVisits),
        pendingFollowUps: Number(r.pendingFollowUps),
        cashInHand: m(r.cashInHand),
      };
    });
  }
}

