import type { PaymentCancelOpPayload, PaymentOpPayload, SyncCustomer, VisitOpPayload } from '@cablenet/contracts';
import type { LocalStore, OutboxOp } from './store';

export interface Actor {
  userId: string;
  agentCode: string;
}

/** P-{AGENTCODE}-{6+ digits}: what the customer gets before the final receipt exists. */
export function provisionalRef(agentCode: string, n: number) {
  const code = agentCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'AG';
  return `P-${code}-${String(n).padStart(6, '0')}`;
}

const label = (c: SyncCustomer) => ({ customerId: c.id, customerName: c.name, customerCode: c.customerCode });

/** A collected payment (and the visit that goes with it) as one outbox entry. */
export async function recordPayment(
  store: LocalStore,
  actor: Actor,
  args: { customer: SyncCustomer; amount: string; mode: 'CASH' | 'UPI' | 'OTHER'; reference: string | null; notes: string | null; offline: boolean; now: Date; newId: () => string },
): Promise<OutboxOp> {
  const [op] = await store.add((next) => {
    const ref = provisionalRef(actor.agentCode, next.provisional());
    const payload: PaymentOpPayload = {
      customerId: args.customer.id,
      amount: args.amount,
      mode: args.mode,
      reference: args.reference,
      notes: args.notes,
      provisionalRef: ref,
      visitId: args.newId(),
    };
    return [
      {
        opId: args.newId(),
        seq: next.seq(),
        type: 'PAYMENT_CREATE',
        createdAt: args.now.toISOString(),
        offline: args.offline,
        payload: payload as unknown as Record<string, unknown>,
        userId: actor.userId,
        state: 'PENDING',
        attempts: 0,
        flags: [],
        label: { ...label(args.customer), amount: args.amount, mode: args.mode, provisionalRef: ref },
      },
    ];
  });
  return op!;
}

export async function recordVisit(
  store: LocalStore,
  actor: Actor,
  args: { customer: SyncCustomer; visit: Omit<VisitOpPayload, 'customerId'>; offline: boolean; now: Date; newId: () => string },
): Promise<OutboxOp> {
  const [op] = await store.add((next) => [
    {
      opId: args.newId(),
      seq: next.seq(),
      type: 'VISIT_CREATE',
      createdAt: args.now.toISOString(),
      offline: args.offline,
      payload: { ...args.visit, customerId: args.customer.id },
      userId: actor.userId,
      state: 'PENDING',
      attempts: 0,
      flags: [],
      label: label(args.customer),
    },
  ]);
  return op!;
}

export async function completeFollowUp(
  store: LocalStore,
  actor: Actor,
  args: { followUpId: string; customer: SyncCustomer | null; offline: boolean; now: Date; newId: () => string },
): Promise<OutboxOp> {
  const [op] = await store.add((next) => [
    {
      opId: args.newId(),
      seq: next.seq(),
      type: 'FOLLOWUP_DONE',
      createdAt: args.now.toISOString(),
      offline: args.offline,
      payload: { followUpId: args.followUpId },
      userId: actor.userId,
      state: 'PENDING',
      attempts: 0,
      flags: [],
      label: args.customer ? label(args.customer) : {},
    },
  ]);
  return op!;
}

/**
 * Deletes a payment entered by mistake. Saved on the phone like any entry and sent in order, so it
 * also works for a payment that has not been sent yet; the office sees the deletion and the reason.
 */
export async function cancelPayment(
  store: LocalStore,
  actor: Actor,
  args: { customer: SyncCustomer; paymentOpId: string | null; paymentId: string | null; amount: string; reason: string; offline: boolean; now: Date; newId: () => string },
): Promise<OutboxOp> {
  const payload: PaymentCancelOpPayload = { customerId: args.customer.id, paymentOpId: args.paymentOpId, paymentId: args.paymentId, reason: args.reason };
  const [op] = await store.add((next) => [
    {
      opId: args.newId(),
      seq: next.seq(),
      type: 'PAYMENT_CANCEL',
      createdAt: args.now.toISOString(),
      offline: args.offline,
      payload: payload as unknown as Record<string, unknown>,
      userId: actor.userId,
      state: 'PENDING',
      attempts: 0,
      flags: [],
      label: { ...label(args.customer), amount: args.amount },
    },
  ]);
  return op!;
}

/** The agent has seen a rejected entry; it leaves the attention list. */
export async function acknowledge(store: LocalStore, opId: string, now: Date) {
  const op = store.getOp(opId);
  if (!op || op.state !== 'REJECTED') return;
  await store.updateOps([{ ...op, acknowledgedAt: now.toISOString() }]);
}
