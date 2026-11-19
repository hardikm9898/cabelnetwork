import { RawBuilder, sql } from 'kysely';
import type { ReportColumn } from './exporters';

/**
 * The 18 business reports (brief §14). Each is one parameterised SQL statement whose output
 * aliases are the snake_case form of the column keys; the generic runner adds search, sorting,
 * pagination, totals and exports. All money is computed in SQL numeric (never floats).
 */
export interface ReportFilters {
  from: string;
  to: string;
  today: string;
  q?: string;
  agentId?: string;
  societyId?: string;
  areaId?: string;
  customerId?: string;
  status?: string;
}

export type FilterName = 'dateRange' | 'agentId' | 'societyId' | 'areaId' | 'customerId' | 'status';

export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  columns: ReportColumn[];
  filters: FilterName[];
  /** Allowed values for the `status` filter, if used. */
  statusOptions?: string[];
  /** Default date range when none given. */
  defaultRange?: 'month' | 'today' | 'next30' | 'none';
  defaultSort: string;
  requiresCustomer?: boolean;
  /** PDF makes sense for this report (very wide/long reports are Excel-only). */
  pdf: boolean;
  query: (f: ReportFilters) => RawBuilder<unknown>;
}

const c = (key: string, label: string, type: ReportColumn['type'] = 'text', total = false): ReportColumn => ({ key, label, type, total });

/** Customer scope (society / area / current agent / customer) on alias `cu`. */
function scope(f: ReportFilters, alias = 'cu') {
  const ref = (col: string) => sql.ref(`${alias}.${col}`);
  const parts = [sql`TRUE`];
  if (f.societyId) parts.push(sql`${ref('society_id')} = ${f.societyId}::uuid`);
  if (f.areaId) parts.push(sql`EXISTS (SELECT 1 FROM societies s2 WHERE s2.id = ${ref('society_id')} AND s2.area_id = ${f.areaId}::uuid)`);
  if (f.agentId) parts.push(sql`EXISTS (SELECT 1 FROM customer_current_agent x WHERE x.customer_id = ${ref('id')} AND x.agent_id = ${f.agentId}::uuid)`);
  if (f.customerId) parts.push(sql`${ref('id')} = ${f.customerId}::uuid`);
  return sql.join(parts, sql` AND `);
}

const between = (expr: RawBuilder<unknown>, f: ReportFilters) => sql`${expr} BETWEEN ${f.from}::date AND ${f.to}::date`;
const istDate = (col: string) => sql`(${sql.ref(col)} AT TIME ZONE 'Asia/Kolkata')::date`;

/** Shared joins: customer, society, area, current agent. */
const customerJoins = sql`
  JOIN societies so ON so.id = cu.society_id
  LEFT JOIN areas ar ON ar.id = so.area_id
  LEFT JOIN customer_current_agent ca ON ca.customer_id = cu.id
  LEFT JOIN users ag ON ag.id = ca.agent_id
  LEFT JOIN customer_balances cb ON cb.customer_id = cu.id`;

const openInvoiceStats = (f: ReportFilters) => sql`
  LEFT JOIN LATERAL (
    SELECT count(*) AS open_invoices,
           min(i.due_date) FILTER (WHERE i.due_date < ${f.today}::date) AS oldest_due,
           coalesce(sum(i.total - i.amount_paid) FILTER (WHERE i.due_date < ${f.today}::date), 0) AS overdue_amount
    FROM invoices i WHERE i.customer_id = cu.id AND i.status IN ('UNPAID', 'PARTIALLY_PAID')
  ) oi ON TRUE`;

export const REPORTS: ReportDefinition[] = [
  {
    key: 'customer-master',
    title: 'Customer Master',
    description: 'All customers with contact, society, agent, plan and set-top box.',
    filters: ['societyId', 'areaId', 'agentId', 'status'],
    statusOptions: ['ACTIVE', 'SUSPENDED', 'INACTIVE', 'DISCONNECTED'],
    defaultRange: 'none',
    defaultSort: 'customerCode',
    pdf: true,
    columns: [
      c('customerCode', 'Customer ID'),
      c('name', 'Name'),
      c('mobile', 'Mobile'),
      c('addressLine', 'Address'),
      c('society', 'Society'),
      c('area', 'Area'),
      c('agent', 'Agent'),
      c('status', 'Status'),
      c('monthlyRate', 'Monthly rate', 'money'),
      c('intervalMonths', 'Billing every (months)', 'number'),
      c('stbNumbers', 'STB'),
    ],
    query: (f) => sql`
      SELECT cu.customer_code, cu.name, cu.mobile, cu.address_line, so.name AS society, ar.name AS area,
             ag.full_name AS agent, cu.status::text AS status, rt.monthly_rate, sub.billing_interval_months AS interval_months,
             (SELECT string_agg(cc.stb_number, ', ') FROM customer_connections cc WHERE cc.customer_id = cu.id AND cc.active_to IS NULL) AS stb_numbers
      FROM customers cu ${customerJoins}
      LEFT JOIN customer_subscriptions sub ON sub.customer_id = cu.id AND sub.status <> 'ENDED'
      LEFT JOIN LATERAL (SELECT r.monthly_rate FROM subscription_rates r WHERE r.subscription_id = sub.id AND r.effective_from <= ${f.today}::date
                         ORDER BY r.effective_from DESC LIMIT 1) rt ON TRUE
      WHERE ${scope(f)} ${f.status ? sql`AND cu.status = ${f.status}::customer_status` : sql``}`,
  },
  {
    key: 'outstanding',
    title: 'Customer Outstanding',
    description: 'Customers who owe money, with overdue amount and age.',
    filters: ['societyId', 'areaId', 'agentId'],
    defaultRange: 'none',
    defaultSort: '-outstanding',
    pdf: true,
    columns: [
      c('customerCode', 'Customer ID'),
      c('name', 'Name'),
      c('mobile', 'Mobile'),
      c('society', 'Society'),
      c('agent', 'Agent'),
      c('outstanding', 'Outstanding', 'money', true),
      c('overdueAmount', 'Overdue', 'money', true),
      c('oldestDueDate', 'Oldest due', 'date'),
      c('daysOverdue', 'Days overdue', 'number'),
      c('openInvoices', 'Open bills', 'number'),
    ],
    query: (f) => sql`
      SELECT cu.customer_code, cu.name, cu.mobile, so.name AS society, ag.full_name AS agent,
             cb.outstanding, oi.overdue_amount, oi.oldest_due AS oldest_due_date,
             CASE WHEN oi.oldest_due IS NULL THEN 0 ELSE ${f.today}::date - oi.oldest_due END AS days_overdue,
             oi.open_invoices
      FROM customers cu ${customerJoins} ${openInvoiceStats(f)}
      WHERE ${scope(f)} AND cb.balance > 0`,
  },
  {
    key: 'advance',
    title: 'Customer Advance',
    description: 'Customers who have paid ahead, and roughly how many months it covers.',
    filters: ['societyId', 'areaId', 'agentId'],
    defaultRange: 'none',
    defaultSort: '-advance',
    pdf: true,
    columns: [
      c('customerCode', 'Customer ID'),
      c('name', 'Name'),
      c('mobile', 'Mobile'),
      c('society', 'Society'),
      c('agent', 'Agent'),
      c('advance', 'Advance', 'money', true),
      c('monthlyRate', 'Monthly rate', 'money'),
      c('monthsCovered', 'Full months covered', 'number'),
    ],
    query: (f) => sql`
      SELECT cu.customer_code, cu.name, cu.mobile, so.name AS society, ag.full_name AS agent, cb.advance, rt.monthly_rate,
             CASE WHEN coalesce(rt.monthly_rate, 0) > 0 THEN floor(cb.advance / rt.monthly_rate)::int END AS months_covered
      FROM customers cu ${customerJoins}
      LEFT JOIN customer_subscriptions sub ON sub.customer_id = cu.id AND sub.status <> 'ENDED'
      LEFT JOIN LATERAL (SELECT r.monthly_rate FROM subscription_rates r WHERE r.subscription_id = sub.id AND r.effective_from <= ${f.today}::date
                         ORDER BY r.effective_from DESC LIMIT 1) rt ON TRUE
      WHERE ${scope(f)} AND cb.balance < 0`,
  },
  {
    key: 'customer-ledger',
    title: 'Customer Ledger',
    description: 'Every charge, payment and adjustment for one customer with running balance.',
    filters: ['customerId', 'dateRange'],
    requiresCustomer: true,
    defaultRange: 'none',
    defaultSort: 'seq',
    pdf: true,
    columns: [
      c('seq', '#', 'number'),
      c('entryDate', 'Date', 'date'),
      c('type', 'Type'),
      c('description', 'Description'),
      c('debit', 'Debit', 'money', true),
      c('credit', 'Credit', 'money', true),
      c('runningBalance', 'Balance', 'money'),
    ],
    query: (f) => sql`
      SELECT * FROM (
        SELECT row_number() OVER w AS seq, e.entry_date, e.type::text AS type, e.description,
               CASE WHEN e.amount > 0 THEN e.amount END AS debit,
               CASE WHEN e.amount < 0 THEN -e.amount END AS credit,
               sum(e.amount) OVER w AS running_balance
        FROM ledger_entries e
        WHERE e.customer_id = ${f.customerId ?? null}::uuid
        WINDOW w AS (ORDER BY e.entry_date, e.id)
      ) l
      ${f.from !== '1900-01-01' ? sql`WHERE l.entry_date BETWEEN ${f.from}::date AND ${f.to}::date` : sql``}`,
  },
  {
    key: 'daily-collection',
    title: 'Daily Collection',
    description: 'Every confirmed payment in the period with receipt, mode and collector.',
    filters: ['dateRange', 'agentId', 'societyId', 'areaId'],
    defaultRange: 'today',
    defaultSort: '-paymentDate',
    pdf: true,
    columns: [
      c('paymentDate', 'Date', 'date'),
      c('receiptNumber', 'Receipt'),
      c('customerCode', 'Customer ID'),
      c('name', 'Customer'),
      c('society', 'Society'),
      c('amount', 'Amount', 'money', true),
      c('mode', 'Mode'),
      c('reference', 'Reference'),
      c('collectedBy', 'Collected by'),
      c('source', 'Source'),
    ],
    query: (f) => sql`
      SELECT p.payment_date, r.receipt_number, cu.customer_code, cu.name, so.name AS society, p.amount, p.mode::text AS mode,
             p.reference, u.full_name AS collected_by, p.source::text AS source
      FROM payments p JOIN customers cu ON cu.id = p.customer_id JOIN societies so ON so.id = cu.society_id
      LEFT JOIN users u ON u.id = p.collected_by
      LEFT JOIN receipts r ON r.payment_id = p.id AND r.status = 'ISSUED'
      WHERE p.status = 'CONFIRMED' AND ${between(sql`p.payment_date`, f)}
        ${f.agentId ? sql`AND p.collected_by = ${f.agentId}::uuid` : sql``}
        AND ${scope({ ...f, agentId: undefined })}`,
  },
  {
    key: 'monthly-collection',
    title: 'Monthly Collection',
    description: 'Billed and collected per month, split by payment mode.',
    filters: ['dateRange', 'agentId', 'societyId', 'areaId'],
    defaultRange: 'none',
    defaultSort: 'month',
    pdf: true,
    columns: [
      c('month', 'Month'),
      c('billed', 'Billed', 'money', true),
      c('collected', 'Collected', 'money', true),
      c('cash', 'Cash', 'money', true),
      c('upi', 'UPI', 'money', true),
      c('otherModes', 'Other modes', 'money', true),
      c('payments', 'Payments', 'number', true),
    ],
    query: (f) => sql`
      WITH months AS (
        SELECT generate_series(date_trunc('month', ${f.from}::date), date_trunc('month', ${f.to}::date), interval '1 month')::date AS m
      )
      SELECT to_char(m.m, 'YYYY-MM') AS month,
        (SELECT coalesce(sum(e.amount), 0) FROM ledger_entries e JOIN customers cu ON cu.id = e.customer_id
          WHERE e.type = 'CHARGE' AND date_trunc('month', e.entry_date) = m.m AND ${scope(f)}) AS billed,
        coalesce(sum(p.amount), 0) AS collected,
        coalesce(sum(p.amount) FILTER (WHERE p.mode = 'CASH'), 0) AS cash,
        coalesce(sum(p.amount) FILTER (WHERE p.mode = 'UPI'), 0) AS upi,
        coalesce(sum(p.amount) FILTER (WHERE p.mode NOT IN ('CASH', 'UPI')), 0) AS other_modes,
        count(p.id) AS payments
      FROM months m
      LEFT JOIN (payments p JOIN customers cu ON cu.id = p.customer_id)
        ON date_trunc('month', p.payment_date) = m.m AND p.status = 'CONFIRMED'
           ${f.agentId ? sql`AND p.collected_by = ${f.agentId}::uuid` : sql``}
           AND ${scope({ ...f, agentId: undefined })}
      GROUP BY m.m`,
  },
  {
    key: 'agent-collection',
    title: 'Agent-wise Collection',
    description: 'What each agent collected in the period, by mode.',
    filters: ['dateRange', 'agentId'],
    defaultRange: 'month',
    defaultSort: '-total',
    pdf: true,
    columns: [
      c('agent', 'Agent'),
      c('agentCode', 'Code'),
      c('payments', 'Payments', 'number', true),
      c('customersPaid', 'Customers paid', 'number', true),
      c('cash', 'Cash', 'money', true),
      c('upi', 'UPI', 'money', true),
      c('otherModes', 'Other modes', 'money', true),
      c('total', 'Total', 'money', true),
    ],
    query: (f) => sql`
      SELECT u.full_name AS agent, a.agent_code, count(p.id) AS payments, count(DISTINCT p.customer_id) AS customers_paid,
             coalesce(sum(p.amount) FILTER (WHERE p.mode = 'CASH'), 0) AS cash,
             coalesce(sum(p.amount) FILTER (WHERE p.mode = 'UPI'), 0) AS upi,
             coalesce(sum(p.amount) FILTER (WHERE p.mode NOT IN ('CASH', 'UPI')), 0) AS other_modes,
             coalesce(sum(p.amount), 0) AS total
      FROM users u JOIN agent_profiles a ON a.user_id = u.id
      LEFT JOIN payments p ON p.collected_by = u.id AND p.status = 'CONFIRMED' AND ${between(sql`p.payment_date`, f)}
      WHERE u.role = 'AGENT' ${f.agentId ? sql`AND u.id = ${f.agentId}::uuid` : sql``}
      GROUP BY u.id, a.agent_code`,
  },
  {
    key: 'society-collection',
    title: 'Society-wise Collection',
    description: 'Billed, collected and outstanding per society.',
    filters: ['dateRange', 'areaId', 'societyId'],
    defaultRange: 'month',
    defaultSort: 'society',
    pdf: true,
    columns: [
      c('society', 'Society'),
      c('area', 'Area'),
      c('customers', 'Customers', 'number', true),
      c('billed', 'Billed', 'money', true),
      c('collected', 'Collected', 'money', true),
      c('collectionPct', 'Collected % of billed', 'number'),
      c('outstanding', 'Outstanding now', 'money', true),
    ],
    query: (f) => sql`
      SELECT so.name AS society, ar.name AS area,
        (SELECT count(*) FROM customers cu WHERE cu.society_id = so.id) AS customers,
        b.billed, p.collected,
        CASE WHEN b.billed > 0 THEN round(p.collected * 100 / b.billed, 1) END AS collection_pct,
        (SELECT coalesce(sum(cb.outstanding), 0) FROM customers cu JOIN customer_balances cb ON cb.customer_id = cu.id WHERE cu.society_id = so.id) AS outstanding
      FROM societies so LEFT JOIN areas ar ON ar.id = so.area_id
      CROSS JOIN LATERAL (SELECT coalesce(sum(e.amount), 0) AS billed FROM ledger_entries e JOIN customers cu ON cu.id = e.customer_id
                          WHERE cu.society_id = so.id AND e.type = 'CHARGE' AND ${between(sql`e.entry_date`, f)}) b
      CROSS JOIN LATERAL (SELECT coalesce(sum(x.amount), 0) AS collected FROM payments x JOIN customers cu ON cu.id = x.customer_id
                          WHERE cu.society_id = so.id AND x.status = 'CONFIRMED' AND ${between(sql`x.payment_date`, f)}) p
      WHERE TRUE ${f.areaId ? sql`AND so.area_id = ${f.areaId}::uuid` : sql``} ${f.societyId ? sql`AND so.id = ${f.societyId}::uuid` : sql``}`,
  },
  {
    key: 'payment-mode',
    title: 'Payment Mode',
    description: 'Confirmed collections by payment mode.',
    filters: ['dateRange', 'agentId'],
    defaultRange: 'month',
    defaultSort: '-amount',
    pdf: true,
    columns: [c('mode', 'Mode'), c('payments', 'Payments', 'number', true), c('amount', 'Amount', 'money', true), c('sharePct', 'Share %', 'number')],
    query: (f) => sql`
      SELECT p.mode::text AS mode, count(*) AS payments, sum(p.amount) AS amount,
             round(sum(p.amount) * 100 / nullif(sum(sum(p.amount)) OVER (), 0), 1) AS share_pct
      FROM payments p
      WHERE p.status = 'CONFIRMED' AND ${between(sql`p.payment_date`, f)} ${f.agentId ? sql`AND p.collected_by = ${f.agentId}::uuid` : sql``}
      GROUP BY p.mode`,
  },
  {
    key: 'partial-payment',
    title: 'Partial Payments',
    description: 'Bills that are partly paid, with the balance still due.',
    filters: ['societyId', 'areaId', 'agentId'],
    defaultRange: 'none',
    defaultSort: 'dueDate',
    pdf: true,
    columns: [
      c('invoiceNumber', 'Bill'),
      c('customerCode', 'Customer ID'),
      c('name', 'Customer'),
      c('society', 'Society'),
      c('periodStart', 'Period from', 'date'),
      c('periodEnd', 'Period to', 'date'),
      c('dueDate', 'Due', 'date'),
      c('total', 'Bill amount', 'money', true),
      c('paid', 'Paid', 'money', true),
      c('balance', 'Balance', 'money', true),
    ],
    query: (f) => sql`
      SELECT i.invoice_number, cu.customer_code, cu.name, so.name AS society, i.period_start, i.period_end, i.due_date,
             i.total, i.amount_paid AS paid, i.total - i.amount_paid AS balance
      FROM invoices i JOIN customers cu ON cu.id = i.customer_id JOIN societies so ON so.id = cu.society_id
      WHERE i.status = 'PARTIALLY_PAID' AND ${scope(f)}`,
  },
  {
    key: 'overdue-customers',
    title: 'Overdue Customers',
    description: 'Customers with bills past their due date, oldest first, with ageing bucket.',
    filters: ['societyId', 'areaId', 'agentId'],
    defaultRange: 'none',
    defaultSort: '-daysOverdue',
    pdf: true,
    columns: [
      c('customerCode', 'Customer ID'),
      c('name', 'Name'),
      c('mobile', 'Mobile'),
      c('society', 'Society'),
      c('agent', 'Agent'),
      c('overdueAmount', 'Overdue', 'money', true),
      c('outstanding', 'Total outstanding', 'money', true),
      c('oldestDueDate', 'Oldest due', 'date'),
      c('daysOverdue', 'Days', 'number'),
      c('ageing', 'Ageing'),
    ],
    query: (f) => sql`
      SELECT cu.customer_code, cu.name, cu.mobile, so.name AS society, ag.full_name AS agent, oi.overdue_amount, cb.outstanding,
             oi.oldest_due AS oldest_due_date, ${f.today}::date - oi.oldest_due AS days_overdue,
             CASE WHEN ${f.today}::date - oi.oldest_due <= 30 THEN '1-30' WHEN ${f.today}::date - oi.oldest_due <= 60 THEN '31-60'
                  WHEN ${f.today}::date - oi.oldest_due <= 90 THEN '61-90' ELSE '90+' END AS ageing
      FROM customers cu ${customerJoins} ${openInvoiceStats(f)}
      WHERE ${scope(f)} AND oi.oldest_due IS NOT NULL`,
  },
  {
    key: 'collection-visits',
    title: 'Collection Visits',
    description: 'Field visits with outcome, promises and follow-up dates.',
    filters: ['dateRange', 'agentId', 'societyId', 'areaId'],
    defaultRange: 'today',
    defaultSort: '-visitedAt',
    pdf: true,
    columns: [
      c('visitedAt', 'When', 'datetime'),
      c('agent', 'Agent'),
      c('customerCode', 'Customer ID'),
      c('name', 'Customer'),
      c('society', 'Society'),
      c('outcome', 'Outcome'),
      c('paymentAmount', 'Collected', 'money', true),
      c('promisedAmount', 'Promised', 'money'),
      c('promisedDate', 'Promised by', 'date'),
      c('followUpDate', 'Follow-up', 'date'),
      c('notes', 'Notes'),
    ],
    query: (f) => sql`
      SELECT v.visited_at, u.full_name AS agent, cu.customer_code, cu.name, so.name AS society, v.outcome::text AS outcome,
             p.amount AS payment_amount, v.promised_amount, v.promised_date, v.follow_up_date, v.notes
      FROM visits v JOIN users u ON u.id = v.agent_id JOIN customers cu ON cu.id = v.customer_id JOIN societies so ON so.id = cu.society_id
      LEFT JOIN payments p ON p.id = v.payment_id AND p.status = 'CONFIRMED'
      WHERE ${between(istDate('v.visited_at'), f)} ${f.agentId ? sql`AND v.agent_id = ${f.agentId}::uuid` : sql``}
        AND ${scope({ ...f, agentId: undefined })}`,
  },
  {
    key: 'promise-to-pay',
    title: 'Promise to Pay',
    description: 'Payment promises recorded by the office or agents, and whether they were kept.',
    filters: ['dateRange', 'status', 'societyId', 'agentId'],
    statusOptions: ['PROMISE_TO_PAY', 'COMPLETED', 'NOT_INTERESTED', 'FOLLOW_UP_REQUIRED'],
    defaultRange: 'month',
    defaultSort: 'promiseDate',
    pdf: true,
    columns: [
      c('customerCode', 'Customer ID'),
      c('name', 'Customer'),
      c('mobile', 'Mobile'),
      c('expectedAmount', 'Promised', 'money', true),
      c('promiseDate', 'Promised by', 'date'),
      c('status', 'Status'),
      c('broken', 'Missed', 'boolean'),
      c('recordedBy', 'Recorded by'),
      c('recordedOn', 'Recorded on', 'date'),
      c('paidAmount', 'Paid (linked)', 'money', true),
    ],
    query: (f) => sql`
      SELECT cu.customer_code, cu.name, cu.mobile, i.expected_amount, i.promise_date, i.status::text AS status,
             (i.status = 'PROMISE_TO_PAY' AND i.promise_date < ${f.today}::date) AS broken,
             u.full_name AS recorded_by, ${istDate('i.created_at')} AS recorded_on, p.amount AS paid_amount
      FROM interactions i JOIN customers cu ON cu.id = i.customer_id JOIN users u ON u.id = i.recorded_by
      LEFT JOIN payments p ON p.id = i.resolved_payment_id
      WHERE i.interaction_type = 'PAYMENT_PROMISE' AND ${between(istDate('i.created_at'), f)}
        ${f.status ? sql`AND i.status = ${f.status}::interaction_status` : sql``} AND ${scope(f)}`,
  },
  {
    key: 'cash-handover',
    title: 'Cash Handover',
    description: 'Cash submitted by agents and what the office received.',
    filters: ['dateRange', 'agentId', 'status'],
    statusOptions: ['SUBMITTED', 'CONFIRMED', 'REJECTED'],
    defaultRange: 'month',
    defaultSort: '-submittedAt',
    pdf: true,
    columns: [
      c('handoverNumber', 'Handover'),
      c('agent', 'Agent'),
      c('submittedAt', 'Submitted', 'datetime'),
      c('expectedAmount', 'Expected', 'money', true),
      c('declaredAmount', 'Declared', 'money', true),
      c('receivedAmount', 'Received', 'money', true),
      c('difference', 'Difference', 'money', true),
      c('status', 'Status'),
      c('verifiedBy', 'Verified by'),
      c('mismatchReason', 'Note'),
    ],
    query: (f) => sql`
      SELECT h.handover_number, u.full_name AS agent, h.submitted_at, h.expected_amount, h.declared_amount, h.received_amount,
             h.difference, h.status, v.full_name AS verified_by, h.mismatch_reason
      FROM cash_handovers h JOIN users u ON u.id = h.agent_id LEFT JOIN users v ON v.id = h.verified_by
      WHERE ${between(istDate('h.submitted_at'), f)} ${f.agentId ? sql`AND h.agent_id = ${f.agentId}::uuid` : sql``}
        ${f.status ? sql`AND h.status = ${f.status}` : sql``}`,
  },
  {
    key: 'cash-reconciliation',
    title: 'Cash Reconciliation',
    description: 'Per agent: cash collected and handed over in the period, and cash in hand now.',
    filters: ['dateRange', 'agentId'],
    defaultRange: 'month',
    defaultSort: '-cashInHand',
    pdf: true,
    columns: [
      c('agent', 'Agent'),
      c('cashCollected', 'Cash collected', 'money', true),
      c('cashReceived', 'Received by office', 'money', true),
      c('adjustments', 'Adjustments', 'money', true),
      c('shortExcess', 'Short (−) / excess (+)', 'money', true),
      c('notHandedOver', 'Not yet handed over', 'money', true),
      c('pendingHandover', 'Awaiting office', 'money', true),
      c('cashInHand', 'Cash in hand now', 'money', true),
    ],
    query: (f) => sql`
      SELECT u.full_name AS agent,
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE collected_by = u.id AND mode = 'CASH' AND status = 'CONFIRMED' AND ${between(sql`payment_date`, f)}) AS cash_collected,
        (SELECT coalesce(sum(received_amount), 0) FROM cash_handovers WHERE agent_id = u.id AND status = 'CONFIRMED' AND ${between(istDate('verified_at'), f)}) AS cash_received,
        (SELECT coalesce(sum(amount), 0) FROM cash_adjustments WHERE agent_id = u.id AND ${between(istDate('created_at'), f)}) AS adjustments,
        (SELECT coalesce(sum(difference), 0) FROM cash_handovers WHERE agent_id = u.id AND status = 'CONFIRMED' AND ${between(istDate('verified_at'), f)}) AS short_excess,
        (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.collected_by = u.id AND p.mode = 'CASH' AND p.status = 'CONFIRMED'
           AND NOT EXISTS (SELECT 1 FROM cash_handover_items i WHERE i.payment_id = p.id)) AS not_handed_over,
        (SELECT coalesce(sum(expected_amount), 0) FROM cash_handovers WHERE agent_id = u.id AND status = 'SUBMITTED') AS pending_handover,
        (SELECT coalesce(sum(amount), 0) FROM payments WHERE collected_by = u.id AND mode = 'CASH' AND status = 'CONFIRMED')
          - (SELECT coalesce(sum(received_amount), 0) FROM cash_handovers WHERE agent_id = u.id AND status = 'CONFIRMED')
          - (SELECT coalesce(sum(amount), 0) FROM cash_adjustments WHERE agent_id = u.id) AS cash_in_hand
      FROM users u WHERE u.role = 'AGENT' ${f.agentId ? sql`AND u.id = ${f.agentId}::uuid` : sql``}`,
  },
  {
    key: 'subscription-renewal',
    title: 'Subscription Renewal',
    description: 'Upcoming bills: subscriptions whose next period starts in the date range.',
    filters: ['dateRange', 'societyId', 'areaId', 'agentId'],
    defaultRange: 'next30',
    defaultSort: 'nextPeriodStart',
    pdf: true,
    columns: [
      c('customerCode', 'Customer ID'),
      c('name', 'Customer'),
      c('mobile', 'Mobile'),
      c('society', 'Society'),
      c('agent', 'Agent'),
      c('intervalMonths', 'Every (months)', 'number'),
      c('billingMode', 'Billing'),
      c('nextPeriodStart', 'Next period', 'date'),
      c('nextAmount', 'Next bill', 'money', true),
      c('outstanding', 'Outstanding now', 'money', true),
      c('advance', 'Advance now', 'money', true),
    ],
    query: (f) => sql`
      SELECT cu.customer_code, cu.name, cu.mobile, so.name AS society, ag.full_name AS agent, sub.billing_interval_months AS interval_months,
             sub.billing_mode::text AS billing_mode, sub.next_period_start, rt.monthly_rate * sub.billing_interval_months AS next_amount,
             coalesce(cb.outstanding, 0) AS outstanding, coalesce(cb.advance, 0) AS advance
      FROM customer_subscriptions sub JOIN customers cu ON cu.id = sub.customer_id ${customerJoins}
      LEFT JOIN LATERAL (SELECT r.monthly_rate FROM subscription_rates r WHERE r.subscription_id = sub.id AND r.effective_from <= sub.next_period_start
                         ORDER BY r.effective_from DESC LIMIT 1) rt ON TRUE
      WHERE sub.status <> 'ENDED' AND ${between(sql`sub.next_period_start`, f)} AND ${scope(f)}`,
  },
  {
    key: 'inactive-customers',
    title: 'Inactive Customers',
    description: 'Deactivated or disconnected customers, with any amount still owed.',
    filters: ['societyId', 'areaId'],
    defaultRange: 'none',
    defaultSort: '-deactivatedOn',
    pdf: true,
    columns: [
      c('customerCode', 'Customer ID'),
      c('name', 'Name'),
      c('mobile', 'Mobile'),
      c('society', 'Society'),
      c('status', 'Status'),
      c('statusReason', 'Reason'),
      c('deactivatedOn', 'Since', 'date'),
      c('outstanding', 'Outstanding', 'money', true),
    ],
    query: (f) => sql`
      SELECT cu.customer_code, cu.name, cu.mobile, so.name AS society, cu.status::text AS status, cu.status_reason,
             ${istDate('cu.deactivated_at')} AS deactivated_on, coalesce(cb.outstanding, 0) AS outstanding
      FROM customers cu ${customerJoins}
      WHERE cu.status IN ('INACTIVE', 'DISCONNECTED') AND ${scope(f)}`,
  },
  {
    key: 'payment-reversal',
    title: 'Payment Reversals',
    description: 'Every reversed payment with reason and who approved it.',
    filters: ['dateRange', 'agentId'],
    defaultRange: 'month',
    defaultSort: '-reversedAt',
    pdf: true,
    columns: [
      c('reversedAt', 'Reversed', 'datetime'),
      c('paymentDate', 'Payment date', 'date'),
      c('customerCode', 'Customer ID'),
      c('name', 'Customer'),
      c('amount', 'Amount', 'money', true),
      c('mode', 'Mode'),
      c('collectedBy', 'Collected by'),
      c('reason', 'Reason'),
      c('approvedBy', 'Approved by'),
    ],
    query: (f) => sql`
      SELECT r.created_at AS reversed_at, p.payment_date, cu.customer_code, cu.name, p.amount, p.mode::text AS mode,
             cb.full_name AS collected_by, r.reason, ab.full_name AS approved_by
      FROM payment_reversals r JOIN payments p ON p.id = r.payment_id JOIN customers cu ON cu.id = p.customer_id
      LEFT JOIN users cb ON cb.id = p.collected_by JOIN users ab ON ab.id = r.approved_by
      WHERE ${between(istDate('r.created_at'), f)} ${f.agentId ? sql`AND p.collected_by = ${f.agentId}::uuid` : sql``}`,
  },
];

export const REPORT_INDEX = new Map(REPORTS.map((r) => [r.key, r]));
