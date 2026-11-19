import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { businessDateOf, canReadAllCustomers, fromPaise, maxPaise, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { unprocessable } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import { CashService } from '../finance/cash.service';

export const WORKLIST_FILTERS = ['all', 'due_today', 'overdue', 'partial', 'pending', 'paid', 'follow_up'] as const;
export const WORKLIST_SORTS = ['outstanding', 'due_date', 'name', 'society', 'last_visit'] as const;
export type WorklistFilter = (typeof WORKLIST_FILTERS)[number];
export type WorklistSort = (typeof WORKLIST_SORTS)[number];

/** Today's state of a customer from the agent's point of view. */
export type CollectionStatus = 'PAID' | 'PARTIAL' | 'VISITED' | 'PENDING' | 'CLEAR';

export interface WorklistItem {
  id: string;
  customerCode: string;
  name: string;
  mobile: string | null;
  addressLine: string;
  landmark: string | null;
  society: string;
  collectionDay: number | null;
  assignment: 'PRIMARY' | 'TEMPORARY';
  outstanding: string;
  advance: string;
  oldestDueDate: string | null;
  nextDueDate: string | null;
  dueToday: boolean;
  overdue: boolean;
  lastPaymentDate: string | null;
  lastPaymentAmount: string | null;
  paidToday: string;
  pendingVerificationToday: string;
  lastVisitAt: string | null;
  lastVisitOutcome: string | null;
  visitedToday: boolean;
  followUpDue: boolean;
  status: CollectionStatus;
}

/**
 * The agent's daily work list and "my day" summary (BUSINESS_REQUIREMENTS FR-COLL).
 * Built from the same ledger/payments/visits as everything else; nothing is cached.
 */
@Injectable()
export class CollectionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly cash: CashService,
  ) {}

  private agentFor(user: AuthUser, agentId?: string): string {
    if (canReadAllCustomers(user.role)) {
      if (!agentId) throw unprocessable('AGENT_REQUIRED', 'Choose an agent');
      return agentId;
    }
    return user.id; // agents only ever see their own list
  }

  async worklist(user: AuthUser, opts: { agentId?: string; filter: WorklistFilter; sort: WorklistSort; q?: string }) {
    const agentId = this.agentFor(user, opts.agentId);
    const today = businessDateOf(new Date());
    const res = await sql<Record<string, unknown>>`
      SELECT c.id, c.customer_code, c.name, c.mobile, c.address_line, c.landmark, s.name AS society,
             coalesce(c.collection_day, s.collection_day) AS collection_day, ca.kind AS assignment,
             coalesce(b.outstanding, 0) AS outstanding, coalesce(b.advance, 0) AS advance,
             oi.oldest_due, oi.due_today,
             CASE WHEN oi.oldest_due IS NOT NULL THEN oi.oldest_due
                  WHEN sub.next_period_start IS NOT NULL THEN sub.next_period_start + sub.due_days END AS next_due_date,
             lp.payment_date AS last_payment_date, lp.amount AS last_payment_amount,
             coalesce(pt.paid_today, 0) AS paid_today, coalesce(pt.pending_today, 0) AS pending_today,
             lv.visited_at AS last_visit_at, lv.outcome::text AS last_visit_outcome,
             (lv.visited_at AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date AS visited_today,
             EXISTS (SELECT 1 FROM follow_up_tasks t WHERE t.customer_id = c.id AND t.status = 'OPEN'
                       AND t.due_date <= ${today}::date AND (t.assigned_to IS NULL OR t.assigned_to = ${agentId}::uuid)) AS follow_up_due
      FROM customer_current_agent ca
      JOIN customers c ON c.id = ca.customer_id
      JOIN societies s ON s.id = c.society_id
      LEFT JOIN customer_balances b ON b.customer_id = c.id
      LEFT JOIN customer_subscriptions sub ON sub.customer_id = c.id AND sub.status <> 'ENDED'
      LEFT JOIN LATERAL (
        SELECT min(i.due_date) AS oldest_due, bool_or(i.due_date = ${today}::date) AS due_today
        FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('UNPAID', 'PARTIALLY_PAID')
      ) oi ON TRUE
      LEFT JOIN LATERAL (
        SELECT p.payment_date, p.amount FROM payments p WHERE p.customer_id = c.id AND p.status = 'CONFIRMED'
        ORDER BY p.payment_date DESC, p.created_at DESC LIMIT 1
      ) lp ON TRUE
      LEFT JOIN LATERAL (
        SELECT sum(p.amount) FILTER (WHERE p.status = 'CONFIRMED') AS paid_today,
               sum(p.amount) FILTER (WHERE p.status = 'PENDING_VERIFICATION') AS pending_today
        FROM payments p WHERE p.customer_id = c.id AND p.payment_date = ${today}::date
      ) pt ON TRUE
      LEFT JOIN LATERAL (
        SELECT v.visited_at, v.outcome FROM visits v WHERE v.customer_id = c.id ORDER BY v.visited_at DESC LIMIT 1
      ) lv ON TRUE
      WHERE ca.agent_id = ${agentId}::uuid AND c.status IN ('ACTIVE', 'SUSPENDED', 'INACTIVE')
      -- No row cap: this is one agent's whole list, and the offline snapshot is built from it
      -- (a cap of 2,000 hid customers at 10,000 per agent in the Phase 8 load test).
    `.execute(this.db);

    const m = (v: unknown) => fromPaise(toPaise(String(v ?? '0')));
    let items: WorklistItem[] = res.rows.map((r) => {
      const outstanding = m(r.outstanding);
      const paidToday = m(r.paidToday);
      const owes = toPaise(outstanding) > 0n;
      const paid = toPaise(paidToday) > 0n;
      const status: CollectionStatus = paid ? (owes ? 'PARTIAL' : 'PAID') : r.visitedToday ? 'VISITED' : owes ? 'PENDING' : 'CLEAR';
      return {
        id: r.id as string,
        customerCode: r.customerCode as string,
        name: r.name as string,
        mobile: (r.mobile as string | null) ?? null,
        addressLine: r.addressLine as string,
        landmark: (r.landmark as string | null) ?? null,
        society: r.society as string,
        collectionDay: (r.collectionDay as number | null) ?? null,
        assignment: r.assignment as 'PRIMARY' | 'TEMPORARY',
        outstanding,
        advance: m(r.advance),
        oldestDueDate: (r.oldestDue as string | null) ?? null,
        nextDueDate: (r.nextDueDate as string | null) ?? null,
        dueToday: !!r.dueToday,
        overdue: !!r.oldestDue && (r.oldestDue as string) < today,
        lastPaymentDate: (r.lastPaymentDate as string | null) ?? null,
        lastPaymentAmount: r.lastPaymentAmount ? m(r.lastPaymentAmount) : null,
        paidToday,
        pendingVerificationToday: m(r.pendingToday),
        lastVisitAt: r.lastVisitAt ? new Date(r.lastVisitAt as string).toISOString() : null,
        lastVisitOutcome: (r.lastVisitOutcome as string | null) ?? null,
        visitedToday: !!r.visitedToday,
        followUpDue: !!r.followUpDue,
        status,
      };
    });

    const counts = {
      all: items.length,
      due_today: items.filter((i) => i.dueToday).length,
      overdue: items.filter((i) => i.overdue).length,
      partial: items.filter((i) => i.status === 'PARTIAL').length,
      pending: items.filter((i) => i.status === 'PENDING').length,
      paid: items.filter((i) => i.status === 'PAID').length,
      follow_up: items.filter((i) => i.followUpDue).length,
    };

    const pick: Record<WorklistFilter, (i: WorklistItem) => boolean> = {
      all: () => true,
      due_today: (i) => i.dueToday,
      overdue: (i) => i.overdue,
      partial: (i) => i.status === 'PARTIAL',
      pending: (i) => i.status === 'PENDING',
      paid: (i) => i.status === 'PAID',
      follow_up: (i) => i.followUpDue,
    };
    items = items.filter(pick[opts.filter]);
    if (opts.q) {
      const q = opts.q.toLowerCase();
      const digits = opts.q.replace(/\D/g, '');
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.customerCode.toLowerCase().startsWith(q) ||
          i.society.toLowerCase().includes(q) ||
          i.addressLine.toLowerCase().includes(q) ||
          (digits.length >= 3 && !!i.mobile?.includes(digits)),
      );
    }
    const byName = (a: WorklistItem, b: WorklistItem) => a.name.localeCompare(b.name);
    const sorters: Record<WorklistSort, (a: WorklistItem, b: WorklistItem) => number> = {
      outstanding: (a, b) => {
        const d = toPaise(b.outstanding) - toPaise(a.outstanding);
        return d > 0n ? 1 : d < 0n ? -1 : byName(a, b);
      },
      due_date: (a, b) => (a.nextDueDate ?? '9999').localeCompare(b.nextDueDate ?? '9999') || byName(a, b),
      name: byName,
      society: (a, b) => a.society.localeCompare(b.society) || a.addressLine.localeCompare(b.addressLine, undefined, { numeric: true }),
      last_visit: (a, b) => (a.lastVisitAt ?? '').localeCompare(b.lastVisitAt ?? '') || byName(a, b),
    };
    items.sort(sorters[opts.sort]);
    return { today, counts, items };
  }

  /** "My day" for the agent home screen. */
  async myDay(user: AuthUser, agentId?: string, pre?: Awaited<ReturnType<CollectionsService['worklist']>>) {
    const id = this.agentFor(user, agentId);
    const { today, counts, items } = pre ?? (await this.worklist(user, { agentId: id, filter: 'all', sort: 'name' }));
    const sum = (xs: string[]) => xs.reduce((s, x) => s + toPaise(x), 0n);
    // Expected = what was due at the start of today: customers due/overdue now, plus those who
    // were due but have already paid today (they no longer have open bills).
    const dueNow = items.filter((i) => i.dueToday || i.overdue || toPaise(i.paidToday) > 0n);
    const expected = sum(dueNow.map((i) => i.outstanding)) + sum(dueNow.map((i) => i.paidToday));
    const [cash, visits] = await Promise.all([
      this.cash.summary(id, today),
      this.db
        .selectFrom('visits')
        .select(['outcome'])
        .where('agentId', '=', id)
        .where(sql<boolean>`(visited_at AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date`)
        .execute(),
    ]);
    const collectedToday = toPaise(cash.day.cashCollected) + toPaise(cash.day.upiCollected) + toPaise(cash.day.otherCollected);
    return {
      today,
      assignedCustomers: counts.all,
      temporaryCustomers: items.filter((i) => i.assignment === 'TEMPORARY').length,
      totalOutstanding: fromPaise(sum(items.map((i) => i.outstanding))),
      expectedToday: fromPaise(expected),
      collectedToday: fromPaise(collectedToday),
      remainingToday: fromPaise(maxPaise(expected - collectedToday, 0n)),
      byMode: { cash: cash.day.cashCollected, upi: cash.day.upiCollected, other: cash.day.otherCollected },
      pendingVerification: cash.day.pendingVerification,
      customersPaid: counts.paid,
      customersPartiallyPaid: counts.partial,
      customersNotAvailable: visits.filter((v) => v.outcome === 'NOT_AVAILABLE').length,
      visitsToday: visits.length,
      pendingFollowUps: counts.follow_up,
      dueToday: counts.due_today,
      overdue: counts.overdue,
      cashInHand: cash.cashInHand,
      cashNotYetHandedOver: cash.cashNotYetHandedOver,
      pendingHandoverAmount: cash.pendingHandoverAmount,
    };
  }
}
