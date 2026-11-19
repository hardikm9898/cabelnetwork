import { z } from 'zod';
import { businessDate, optionalTrimmed, paginationQuery, uuid } from './common';
import { VISIT_OUTCOMES } from './fieldops';
import { PAYMENT_MODES, positiveMoney } from './finance';

/**
 * Offline sync between the agent app and the API (SYSTEM_ARCHITECTURE §6, FINANCIAL_LOGIC §7).
 *
 * The phone keeps a snapshot of the agent's customers (pull) and an outbox of operations it
 * recorded (push). Every operation carries an id made on the phone; the server applies each id
 * at most once and returns the same outcome for every replay.
 */

export const SYNC_OP_TYPES = ['PAYMENT_CREATE', 'VISIT_CREATE', 'FOLLOWUP_DONE'] as const;
export type SyncOpType = (typeof SYNC_OP_TYPES)[number];

/** Reference shown to the customer before the final receipt exists: P-{AGENTCODE}-{seq}. */
export const provisionalRef = z.string().regex(/^P-[A-Z0-9]{1,10}-\d{6,9}$/, 'Invalid provisional reference');

/** Payment collected on the phone. The op id is the payment's clientTxnId. */
export const paymentOpPayload = z
  .object({
    customerId: uuid,
    amount: positiveMoney,
    mode: z.enum(PAYMENT_MODES),
    reference: z.string().trim().max(100).nullish(),
    notes: optionalTrimmed(1000),
    provisionalRef,
    /** The server records the visit too (outcome decided from the balance after posting). */
    visitId: uuid.nullish(),
  })
  .refine((v) => !['UPI', 'BANK_TRANSFER', 'CHEQUE'].includes(v.mode) || !!v.reference?.trim(), {
    message: 'A transaction reference (UTR / cheque number) is required for this payment mode',
    path: ['reference'],
  });
export type PaymentOpPayload = z.infer<typeof paymentOpPayload>;

/** Visit without a payment (payment visits travel inside PAYMENT_CREATE). The op id is the visit's clientId. */
export const visitOpPayload = z
  .object({
    customerId: uuid,
    outcome: z.enum(VISIT_OUTCOMES.filter((o) => o !== 'PAYMENT_COLLECTED' && o !== 'PARTIAL_PAYMENT') as [string, ...string[]]),
    promisedAmount: positiveMoney.nullish(),
    promisedDate: businessDate.nullish(),
    followUpDate: businessDate.nullish(),
    notes: optionalTrimmed(1000),
  })
  .refine((v) => v.outcome !== 'OTHER' || !!v.notes, { message: 'Describe the outcome', path: ['notes'] });
export type VisitOpPayload = z.infer<typeof visitOpPayload>;

export const followUpDoneOpPayload = z.object({ followUpId: uuid, note: optionalTrimmed(500) });
export type FollowUpDoneOpPayload = z.infer<typeof followUpDoneOpPayload>;

export const SYNC_PAYLOADS = {
  PAYMENT_CREATE: paymentOpPayload,
  VISIT_CREATE: visitOpPayload,
  FOLLOWUP_DONE: followUpDoneOpPayload,
} as const;

export const syncOp = z.object({
  opId: uuid,
  type: z.enum(SYNC_OP_TYPES),
  /** Per-device counter; the server applies a batch in this order. */
  seq: z.number().int().positive(),
  /** Phone clock when the agent recorded it. */
  createdAt: z.iso.datetime({ offset: true }),
  /** The phone had no connection when this was recorded. */
  offline: z.boolean().default(false),
  /** Checked per operation so one bad entry cannot block the rest. */
  payload: z.unknown(),
});
export type SyncOp = z.infer<typeof syncOp>;

export const syncPushRequest = z.object({
  /** Phone clock at the moment of sending; used to correct a wrong phone clock. */
  deviceTime: z.iso.datetime({ offset: true }),
  ops: z.array(syncOp).min(1).max(100),
});
export type SyncPushRequest = z.infer<typeof syncPushRequest>;

/**
 * APPLIED: done. NEEDS_REVIEW: done, and the office will look at it (see `flags`).
 * DUPLICATE: already received earlier; `result` is the original outcome.
 * REJECTED: invalid, nothing changed; shown to the agent until acknowledged.
 * RETRY: temporary server problem; send again later.
 */
export type SyncOpStatus = 'APPLIED' | 'NEEDS_REVIEW' | 'DUPLICATE' | 'REJECTED' | 'RETRY';

/** Why an applied operation needs an office review. */
export const SYNC_FLAGS = [
  'REASSIGNED_BEFORE_SYNC', // the agent had the customer when collecting, not any more
  'NOT_ASSIGNED_AT_COLLECTION', // assigned to the agent around that time, but not at the recorded moment
  'CUSTOMER_INACTIVE',
  'POSSIBLE_DUPLICATE',
  'CLOCK_SKEW', // the phone clock was more than 24 h off
  'LATE_SYNC', // older than the payment back-date limit when it arrived
] as const;
export type SyncFlag = (typeof SYNC_FLAGS)[number];

export interface ReceiptLine {
  label: string;
  invoiceNumber: string | null;
  amount: string;
}

export interface PaymentOpResult {
  paymentId: string;
  status: 'CONFIRMED' | 'PENDING_VERIFICATION';
  paymentDate: string;
  provisionalRef: string;
  receiptId: string | null;
  receiptNumber: string | null;
  allocations: ReceiptLine[];
  advanceCreated: string;
  /** null when the payment is held for the office (the customer is no longer the agent's). */
  remainingOutstanding: string | null;
  remainingAdvance: string | null;
  visitId: string | null;
}
export interface VisitOpResult {
  visitId: string;
}
export interface FollowUpDoneOpResult {
  followUpId: string;
  alreadyClosed: boolean;
}
export type SyncOpResultData = PaymentOpResult | VisitOpResult | FollowUpDoneOpResult;

export interface SyncOpOutcome {
  opId: string;
  status: SyncOpStatus;
  /** For DUPLICATE: what happened the first time. */
  originalStatus?: 'APPLIED' | 'NEEDS_REVIEW' | 'REJECTED';
  flags: string[];
  error?: { code: string; message: string };
  result?: SyncOpResultData | null;
}
export interface SyncPushResponse {
  serverTime: string;
  clockSkewSeconds: number;
  results: SyncOpOutcome[];
}

// ---------------------------------------------------------------------------
// Pull: the agent's customers as of `asOf`
// ---------------------------------------------------------------------------

export interface SyncCustomer {
  id: string;
  customerCode: string;
  name: string;
  mobile: string | null;
  addressLine: string;
  landmark: string | null;
  society: string;
  status: string;
  assignment: 'PRIMARY' | 'TEMPORARY';
  /** End of a temporary cover; the phone hides the customer after this time even offline. */
  temporaryUntil: string | null;
  monthlyRate: string | null;
  outstanding: string;
  advance: string;
  oldestDueDate: string | null;
  nextDueDate: string | null;
  openInvoices: { id: string; label: string; dueDate: string; balance: string }[];
  pendingVerification: string;
  lastPaymentDate: string | null;
  lastPaymentAmount: string | null;
  /** Confirmed payments dated `today` (server). */
  paidToday: string;
  lastVisitAt: string | null;
  lastVisitOutcome: string | null;
  recentPayments: { id: string; amount: string; paymentDate: string; mode: string; status: string; receiptNumber: string | null; collectedByName: string | null }[];
  recentVisits: { id: string; visitedAt: string; outcome: string; notes: string | null; agentName: string }[];
}

export interface SyncFollowUp {
  id: string;
  customerId: string;
  dueDate: string;
  title: string;
}

export interface SyncDay {
  expectedToday: string;
  collectedToday: string;
  remainingToday: string;
  byMode: { cash: string; upi: string; other: string };
  pendingVerification: string;
  visitsToday: number;
  customersNotAvailable: number;
  cashInHand: string;
  cashNotYetHandedOver: string;
  pendingHandoverAmount: string;
}

export interface SyncSnapshot {
  unchanged: false;
  asOf: string;
  /** Server business date (IST) at `asOf`. */
  today: string;
  /** Changes whenever the content changes; send it back as `etag` to skip an unchanged download. */
  etag: string;
  agent: { id: string; code: string; name: string };
  /** For provisional receipts made offline. */
  business: { name: string; phone: string | null };
  /** The phone's provisional receipt counter must start at least here (after a reinstall). */
  nextProvisionalSeq: number;
  staleAfterHours: number;
  maxAmount: string;
  day: SyncDay;
  customers: SyncCustomer[];
  followUps: SyncFollowUp[];
}
export type SyncPullResponse = SyncSnapshot | { unchanged: true; asOf: string; etag: string };

export const syncPullQuery = z.object({ etag: z.string().max(100).optional() });

// ---------------------------------------------------------------------------
// Office review queue
// ---------------------------------------------------------------------------

export const listSyncReviewQuery = paginationQuery.extend({
  state: z.enum(['open', 'reviewed', 'all']).default('open'),
  agentId: uuid.optional(),
});
export type ListSyncReviewQuery = z.infer<typeof listSyncReviewQuery>;

export const reviewSyncOpRequest = z.object({ note: optionalTrimmed(500) });
