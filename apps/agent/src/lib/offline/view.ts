import type { SyncCustomer, SyncFollowUp } from '@cablenet/contracts';
import { businessDateOf, fromPaise, toPaise } from '@cablenet/domain';
import type { OutboxOp, SnapshotHeader } from './store';

/**
 * What the screens show, derived from the last snapshot plus entries made on this phone that the
 * snapshot does not contain yet. Balances are never recalculated here: the server's figures are
 * shown "as of" the snapshot, and unsent collections are shown next to them, not subtracted.
 */

export type ItemStatus = 'PAID' | 'PARTIAL' | 'VISITED' | 'PENDING' | 'CLEAR';
export type Filter = 'all' | 'due_today' | 'overdue' | 'partial' | 'pending' | 'paid' | 'follow_up';
export type Sort = 'outstanding' | 'due_date' | 'name' | 'society' | 'last_visit';

export interface ListItem extends SyncCustomer {
  dueToday: boolean;
  overdue: boolean;
  visitedToday: boolean;
  followUpDue: boolean;
  /** Today's state of the visit/collection (not the customer's account status). */
  todayStatus: ItemStatus;
  /** Collected on this phone, not yet part of the snapshot. */
  unsentAmount: string | null;
  /** Some of it is still waiting to be sent (vs. sent, waiting for the next download). */
  waitingToSend: boolean;
}

/**
 * Payments the agent deleted on this phone (by payment entry id and by server id). A deletion the
 * server refused (e.g. cash already handed over) does not count.
 */
export function deletedPayments(ops: OutboxOp[]): Set<string> {
  const out = new Set<string>();
  for (const o of ops) {
    if (o.type !== 'PAYMENT_CANCEL' || o.state === 'REJECTED') continue;
    if (o.payload.paymentOpId) out.add(String(o.payload.paymentOpId));
    if (o.payload.paymentId) out.add(String(o.payload.paymentId));
  }
  return out;
}

/** Entries made on this phone that the current snapshot does not reflect yet. */
export function notInSnapshot(ops: OutboxOp[], header: SnapshotHeader | null): OutboxOp[] {
  const pulledAt = header?.pulledAt ?? '';
  return ops.filter((o) => o.state !== 'REJECTED' && (o.state === 'PENDING' || (o.syncedAt ?? '') > pulledAt));
}

export function isHidden(c: SyncCustomer, now: Date) {
  // A temporary cover that has ended is hidden even before the next download.
  return !!c.temporaryUntil && new Date(c.temporaryUntil).getTime() <= now.getTime();
}

export function buildList(customers: SyncCustomer[], header: SnapshotHeader | null, ops: OutboxOp[], followUps: SyncFollowUp[], now: Date): ListItem[] {
  const today = businessDateOf(now);
  const sameDay = header?.today === today;
  const local = notInSnapshot(ops, header);
  const deleted = deletedPayments(ops);
  const doneFollowUps = new Set(
    ops.filter((o) => o.type === 'FOLLOWUP_DONE' && o.state !== 'REJECTED').map((o) => String(o.payload.followUpId)),
  );
  const dueFollowUps = new Set(followUps.filter((f) => f.dueDate <= today && !doneFollowUps.has(f.id)).map((f) => f.customerId));

  return customers
    .filter((c) => !isHidden(c, now))
    .map((c) => {
      const mine = local.filter((o) => o.label.customerId === c.id && businessDateOf(new Date(o.createdAt)) === today);
      const pays = mine.filter((o) => o.type === 'PAYMENT_CREATE' && !deleted.has(o.opId));
      const unsent = pays.reduce((s, o) => s + toPaise(String(o.payload.amount)), 0n);
      const serverPaidToday = sameDay ? toPaise(c.paidToday) : 0n;
      const owes = toPaise(c.outstanding) > 0n;
      const visitedToday = (!!c.lastVisitAt && businessDateOf(new Date(c.lastVisitAt)) === today) || mine.some((o) => o.type === 'VISIT_CREATE');
      let status: ItemStatus;
      if (unsent > 0n) status = unsent >= toPaise(c.outstanding) ? 'PAID' : 'PARTIAL';
      else if (serverPaidToday > 0n) status = owes ? 'PARTIAL' : 'PAID';
      else if (visitedToday) status = 'VISITED';
      else status = owes ? 'PENDING' : 'CLEAR';
      return {
        ...c,
        dueToday: c.openInvoices.some((i) => i.dueDate === today),
        overdue: !!c.oldestDueDate && c.oldestDueDate < today,
        visitedToday,
        followUpDue: dueFollowUps.has(c.id),
        todayStatus: status,
        unsentAmount: unsent > 0n ? fromPaise(unsent) : null,
        waitingToSend: pays.some((o) => o.state === 'PENDING'),
      stbNumbers: c.stbNumbers ?? [],
      mqNumbers: c.mqNumbers ?? [],
      bills: c.bills ?? [],
      upcomingRate: c.upcomingRate ?? null,
      };
    });
}

export const FILTERS: Record<Filter, (i: ListItem) => boolean> = {
  all: () => true,
  due_today: (i) => i.dueToday,
  overdue: (i) => i.overdue,
  partial: (i) => i.todayStatus === 'PARTIAL',
  pending: (i) => i.todayStatus === 'PENDING' || i.todayStatus === 'VISITED',
  paid: (i) => i.todayStatus === 'PAID',
  follow_up: (i) => i.followUpDue,
};

export function counts(items: ListItem[]): Record<Filter, number> {
  return Object.fromEntries((Object.keys(FILTERS) as Filter[]).map((f) => [f, items.filter(FILTERS[f]).length])) as Record<Filter, number>;
}

const byName = (a: ListItem, b: ListItem) => a.name.localeCompare(b.name);
export const SORTS: Record<Sort, (a: ListItem, b: ListItem) => number> = {
  outstanding: (a, b) => {
    const d = toPaise(b.outstanding) - toPaise(a.outstanding);
    return d > 0n ? 1 : d < 0n ? -1 : byName(a, b);
  },
  due_date: (a, b) => (a.nextDueDate ?? '9999').localeCompare(b.nextDueDate ?? '9999') || byName(a, b),
  name: byName,
  society: (a, b) => a.society.localeCompare(b.society) || a.addressLine.localeCompare(b.addressLine, undefined, { numeric: true }),
  last_visit: (a, b) => (a.lastVisitAt ?? '').localeCompare(b.lastVisitAt ?? '') || byName(a, b),
};

/**
 * Finds customers by name, Customer ID, mobile, set-top box (STB) number, MQ number, address or
 * society. Every word must match somewhere ("ram 402" finds Ram in flat 402). Best matches first:
 * exact Customer ID, then ID / box / MQ starting with the text, then the rest.
 */
export function search<T extends ListItem>(items: T[], q: string): T[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  const scored: { i: T; score: number }[] = [];
  for (const i of items) {
    const code = i.customerCode.toLowerCase();
    const boxes = [...(i.stbNumbers ?? []), ...(i.mqNumbers ?? [])].map((b) => b.toLowerCase());
    const phones = [i.mobile, i.altMobile].filter((m): m is string => !!m);
    const text = [i.name, i.addressLine, i.society, i.landmark ?? ''].join(' ').toLowerCase();
    let score = 0;
    const all = words.every((w) => {
      const digits = w.replace(/\D/g, '');
      if (code === w) score += 100;
      else if (code.startsWith(w)) score += 50;
      else if (code.includes(w)) score += 20;
      else if (boxes.some((b) => b === w)) score += 90;
      else if (boxes.some((b) => b.startsWith(w) || (w.length >= 4 && b.endsWith(w)))) score += 40;
      else if (w.length >= 3 && boxes.some((b) => b.includes(w))) score += 15;
      else if (digits.length >= 3 && digits === w && phones.some((m) => m.includes(digits))) score += 30;
      else if (i.name.toLowerCase().startsWith(w)) score += 25;
      else if (text.includes(w)) score += 10;
      else return false;
      return true;
    });
    if (all) scored.push({ i, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.i);
}

/** Money collected on this phone that the snapshot's day figures do not include yet. */
export function unsentToday(ops: OutboxOp[], header: SnapshotHeader | null, now: Date) {
  const today = businessDateOf(now);
  const deleted = deletedPayments(ops);
  const pays = notInSnapshot(ops, header).filter((o) => o.type === 'PAYMENT_CREATE' && !deleted.has(o.opId) && businessDateOf(new Date(o.createdAt)) === today);
  return { count: pays.length, amount: fromPaise(pays.reduce((s, o) => s + toPaise(String(o.payload.amount)), 0n)) };
}

/** The snapshot is older than the configured limit (balances may have changed in the office). */
export function isStale(header: SnapshotHeader | null, now: Date) {
  if (!header) return false;
  return now.getTime() - new Date(header.pulledAt).getTime() > header.staleAfterHours * 3_600_000;
}
