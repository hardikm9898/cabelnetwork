import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import {
  SYNC_PAYLOADS,
  type FollowUpDoneOpPayload,
  type ListSyncReviewQuery,
  type PaymentCancelOpPayload,
  type PaymentCancelOpResult,
  type PaymentOpPayload,
  type PaymentOpResult,
  type SyncCustomer,
  type SyncOp,
  type SyncOpOutcome,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncSnapshot,
  type VisitOpPayload,
} from '@cablenet/contracts';
import { addDays, businessDateOf, fromPaise, periodLabel, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import type { VisitOutcome } from '../../db/schema';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { Page } from '../../common/http';
import type { AuthUser } from '../../common/request-context';
import { CollectionsService } from '../collections/collections.service';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { FieldOpsService } from '../fieldops/fieldops.service';
import type { ReceiptSnapshot } from '../finance/receipts.service';
import { AlertsService } from '../finance/alerts.service';
import { monthBills } from '../finance/month-bills';
import { PaymentsService } from '../finance/payments.service';

/** Phone clocks within this many seconds of the server are taken as right. */
const CLOCK_TOLERANCE_S = 120;
/** A phone clock further off than this is flagged for review (FINANCIAL_LOGIC §7). */
const CLOCK_FLAG_S = 24 * 3600;
/**
 * These rest on the phone's own timestamps; the payment is recorded but held (PENDING_VERIFICATION:
 * no ledger entry, no receipt) until the office verifies it (security review M-4).
 */
const HOLD_FLAGS = new Set(['REASSIGNED_BEFORE_SYNC', 'NOT_ASSIGNED_AT_COLLECTION', 'LATE_SYNC', 'CLOCK_SKEW']);

type Access = 'CURRENT' | 'REASSIGNED_BEFORE_SYNC' | 'NOT_ASSIGNED_AT_COLLECTION' | 'NONE';

interface Applied {
  status: 'APPLIED' | 'NEEDS_REVIEW';
  flags: string[];
  customerId: string | null;
  paymentId: string | null;
  visitId: string | null;
  result: unknown;
}

/**
 * Offline sync for the agent app (SYSTEM_ARCHITECTURE §6, FINANCIAL_LOGIC §7).
 *
 * Push: each operation is applied at most once, keyed by the id the phone gave it, inside one
 * transaction together with its `sync_operations` row; an advisory lock on the id makes
 * simultaneous retries wait for the first one and then see its stored outcome. Collected money
 * is posted even when things changed meanwhile; anything odd is flagged for office review.
 *
 * Pull: the agent's current customers with everything the app shows offline.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly payments: PaymentsService,
    private readonly fieldOps: FieldOpsService,
    private readonly collections: CollectionsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
  ) {}

  private assertAgent(user: AuthUser) {
    if (user.role !== 'AGENT') throw forbidden('AGENTS_ONLY', 'Offline sync is for the agent app');
  }

  // ---------------------------------------------------------------------------
  // Push
  // ---------------------------------------------------------------------------

  async push(user: AuthUser, req: SyncPushRequest): Promise<SyncPushResponse> {
    this.assertAgent(user);
    const serverNow = new Date();
    const skew = Math.round((serverNow.getTime() - new Date(req.deviceTime).getTime()) / 1000);
    const ops = [...req.ops].sort((a, b) => a.seq - b.seq);
    const results: SyncOpOutcome[] = [];
    for (const op of ops) results.push(await this.pushOne(user, op, skew, serverNow));
    await this.touchDevice(user);
    return { serverTime: serverNow.toISOString(), clockSkewSeconds: skew, results };
  }

  private async pushOne(user: AuthUser, op: SyncOp, skew: number, serverNow: Date): Promise<SyncOpOutcome> {
    const createdAt = new Date(op.createdAt);
    // Real entries are well under 2 KB; a huge payload is not stored as-is (review I-9).
    const payloadText = JSON.stringify(op.payload ?? null);
    const oversized = payloadText.length > 4096;
    let effectiveAt = Math.abs(skew) > CLOCK_TOLERANCE_S ? new Date(createdAt.getTime() + skew * 1000) : createdAt;
    if (effectiveAt > serverNow) effectiveAt = serverNow;
    const clockFlags = Math.abs(skew) > CLOCK_FLAG_S ? ['CLOCK_SKEW'] : [];
    const base = {
      opId: op.opId,
      userId: user.id,
      deviceId: user.deviceId,
      opType: op.type,
      deviceSeq: op.seq,
      clientCreatedAt: createdAt,
      effectiveAt,
      clockSkewSeconds: skew,
      recordedOffline: op.offline,
      payload: oversized ? JSON.stringify({ truncated: true, bytes: payloadText.length }) : payloadText,
    };

    try {
      return await this.db.transaction().execute(async (trx) => {
        const prior = await this.lockOp(trx, op.opId);
        if (prior) return this.replayOf(prior, user);

        if (oversized) throw unprocessable('PAYLOAD_TOO_LARGE', 'This entry is too large');
        const parsed = SYNC_PAYLOADS[op.type].safeParse(op.payload);
        if (!parsed.success) {
          throw unprocessable('VALIDATION_FAILED', parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; '));
        }
        let applied: Applied;
        switch (op.type) {
          case 'PAYMENT_CREATE':
            applied = await this.applyPayment(trx, user, op, parsed.data as PaymentOpPayload, effectiveAt, clockFlags);
            break;
          case 'VISIT_CREATE':
            applied = await this.applyVisit(trx, user, op, parsed.data as VisitOpPayload, effectiveAt, clockFlags);
            break;
          case 'FOLLOWUP_DONE':
            applied = await this.applyFollowUpDone(trx, user, parsed.data as FollowUpDoneOpPayload);
            break;
          case 'PAYMENT_CANCEL':
            applied = await this.applyPaymentCancel(trx, user, parsed.data as PaymentCancelOpPayload);
            break;
        }
        await trx
          .insertInto('syncOperations')
          .values({
            ...base,
            status: applied.status,
            flags: applied.flags,
            errorCode: null,
            errorMessage: null,
            customerId: applied.customerId,
            paymentId: applied.paymentId,
            visitId: applied.visitId,
            result: JSON.stringify(applied.result),
          })
          .execute();
        return { opId: op.opId, status: applied.status, flags: applied.flags, result: applied.result as SyncOpOutcome['result'] };
      });
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) {
        // Temporary trouble (database, bug): nothing was stored, the phone sends it again later.
        this.logger.error(`sync op ${op.opId} failed; the phone will retry: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        return { opId: op.opId, status: 'RETRY', flags: [] };
      }
      // Invalid: record the rejection so every replay gets the same answer and the office sees it.
      return this.db.transaction().execute(async (trx) => {
        const prior = await this.lockOp(trx, op.opId);
        if (prior) return this.replayOf(prior, user);
        const payloadCustomer = (op.payload as { customerId?: unknown } | null)?.customerId;
        const customerId = typeof payloadCustomer === 'string' && /^[0-9a-f-]{36}$/i.test(payloadCustomer)
          ? ((await trx.selectFrom('customers').select('id').where('id', '=', payloadCustomer).executeTakeFirst())?.id ?? null)
          : null;
        await trx
          .insertInto('syncOperations')
          .values({ ...base, status: 'REJECTED', errorCode: err.code, errorMessage: err.message, customerId, paymentId: null, visitId: null, result: null })
          .execute();
        return { opId: op.opId, status: 'REJECTED' as const, flags: [], error: { code: err.code, message: err.message } };
      });
    }
  }

  /** Serialises work on one op id and returns what was stored for it before, if anything. */
  private async lockOp(trx: Database, opId: string) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${opId}::text, 6))`.execute(trx);
    return trx.selectFrom('syncOperations').selectAll().where('opId', '=', opId).executeTakeFirst();
  }

  private replayOf(prior: { userId: string; status: 'APPLIED' | 'NEEDS_REVIEW' | 'REJECTED'; flags: string[]; errorCode: string | null; errorMessage: string | null; result: unknown; opId: string }, user: AuthUser): SyncOpOutcome {
    if (prior.userId !== user.id) {
      // Never reveal or reuse another user's operation.
      return { opId: prior.opId, status: 'REJECTED', flags: [], error: { code: 'OP_ID_CONFLICT', message: 'This operation id belongs to another user' } };
    }
    return {
      opId: prior.opId,
      status: 'DUPLICATE',
      originalStatus: prior.status,
      flags: prior.flags,
      ...(prior.errorCode ? { error: { code: prior.errorCode, message: prior.errorMessage ?? '' } } : {}),
      result: (prior.result ?? null) as SyncOpOutcome['result'],
    };
  }

  /**
   * Was the customer this agent's when the work was done? Collected money is never refused for a
   * reassignment that happened afterwards; it is posted and flagged instead.
   */
  private async accessAt(trx: Database, agentId: string, customerId: string, at: Date): Promise<Access> {
    const r = await sql<{ current: string | null; atCollection: string | null; near: boolean }>`
      SELECT
        (SELECT agent_id FROM customer_current_agent WHERE customer_id = ${customerId}::uuid) AS current,
        (SELECT agent_id FROM customer_agent_assignments
          WHERE customer_id = ${customerId}::uuid AND valid_during @> ${at.toISOString()}::timestamptz
          ORDER BY (kind = 'TEMPORARY') DESC LIMIT 1) AS at_collection,
        EXISTS (SELECT 1 FROM customer_agent_assignments
          WHERE customer_id = ${customerId}::uuid AND agent_id = ${agentId}::uuid
            AND valid_during && tstzrange(${at.toISOString()}::timestamptz - interval '1 day', now(), '[]')) AS near
    `.execute(trx);
    const row = r.rows[0]!;
    if (row.current === agentId) return 'CURRENT';
    if (row.atCollection === agentId) return 'REASSIGNED_BEFORE_SYNC';
    if (row.near) return 'NOT_ASSIGNED_AT_COLLECTION';
    return 'NONE';
  }

  private async customerFlags(trx: Database, user: AuthUser, customerId: string, at: Date): Promise<string[]> {
    const exists = await trx.selectFrom('customers').select(['id', 'status']).where('id', '=', customerId).executeTakeFirst();
    // Same answer as a customer that is not the agent's: no probing of ids.
    if (!exists) throw notFound('CUSTOMER_NOT_ASSIGNED', 'This customer is not assigned to you');
    const access = await this.accessAt(trx, user.id, customerId, at);
    if (access === 'NONE') throw notFound('CUSTOMER_NOT_ASSIGNED', 'This customer is not assigned to you');
    const flags: string[] = access === 'CURRENT' ? [] : [access];
    if (exists.status === 'INACTIVE' || exists.status === 'DISCONNECTED') flags.push('CUSTOMER_INACTIVE');
    return flags;
  }

  private async applyPayment(trx: Database, user: AuthUser, op: SyncOp, p: PaymentOpPayload, at: Date, clockFlags: string[]): Promise<Applied> {
    const rules = await this.settings.get('payments.rules', trx);
    if (toPaise(p.amount) > toPaise(rules.maxAmount)) throw unprocessable('AMOUNT_TOO_LARGE', `A single payment cannot exceed ₹${rules.maxAmount}`);
    const flags = [...clockFlags, ...(await this.customerFlags(trx, user, p.customerId, at))];
    const paymentDate = businessDateOf(at);
    if (paymentDate < addDays(businessDateOf(new Date()), -rules.agentMaxBackdateDays)) flags.push('LATE_SYNC');

    const payment = await this.payments.recordIn(
      trx,
      {
        clientTxnId: op.opId,
        customerId: p.customerId,
        amount: p.amount,
        paymentDate,
        mode: p.mode,
        reference: p.reference?.trim() || null,
        notes: p.notes ?? null,
        recordedOffline: op.offline,
      },
      user,
      { deviceId: user.deviceId, provisionalRef: p.provisionalRef, clientRecordedAt: new Date(op.createdAt), receivedAt: at, recordedOffline: op.offline, flags, hold: flags.some((f) => HOLD_FLAGS.has(f)) },
    );
    const held = payment.status === 'PENDING_VERIFICATION' && flags.some((f) => HOLD_FLAGS.has(f));
    const allFlags = [...payment.reviewFlags];
    const snap = (payment.receipt?.snapshot ?? null) as ReceiptSnapshot | null;

    let visitId: string | null = null;
    if (p.visitId) {
      // Outcome from the server's numbers: did this payment cover everything that was due?
      const dueBefore = snap ? snap.previousOutstanding : payment.customerBalance.outstanding;
      const visit = await this.fieldOps.recordVisitIn(
        trx,
        p.customerId,
        {
          clientId: p.visitId,
          outcome: toPaise(p.amount) >= toPaise(dueBefore) ? 'PAYMENT_COLLECTED' : 'PARTIAL_PAYMENT',
          visitedAt: at.toISOString(),
          paymentId: payment.id,
          recordedOffline: op.offline,
        },
        user,
      );
      visitId = visit.id;
    }

    const result: PaymentOpResult = {
      paymentId: payment.id,
      status: payment.status as PaymentOpResult['status'],
      paymentDate: payment.paymentDate,
      provisionalRef: p.provisionalRef,
      receiptId: payment.receipt?.id ?? null,
      receiptNumber: payment.receipt?.receiptNumber ?? null,
      allocations: snap?.allocations ?? [],
      advanceCreated: snap?.advanceCreated ?? '0.00',
      // Balances only for a customer that is (still) the agent's.
      remainingOutstanding: held ? null : (snap?.remainingOutstanding ?? payment.customerBalance.outstanding),
      remainingAdvance: held ? null : (snap?.remainingAdvance ?? payment.customerBalance.advance),
      visitId,
    };
    return { status: allFlags.length ? 'NEEDS_REVIEW' : 'APPLIED', flags: allFlags, customerId: p.customerId, paymentId: payment.id, visitId, result };
  }

  private async applyVisit(trx: Database, user: AuthUser, op: SyncOp, v: VisitOpPayload, at: Date, clockFlags: string[]): Promise<Applied> {
    const flags = [...clockFlags, ...(await this.customerFlags(trx, user, v.customerId, at))];
    const visit = await this.fieldOps.recordVisitIn(
      trx,
      v.customerId,
      {
        clientId: op.opId,
        outcome: v.outcome as VisitOutcome,
        visitedAt: at.toISOString(),
        promisedAmount: v.promisedAmount ?? null,
        promisedDate: v.promisedDate ?? null,
        followUpDate: v.followUpDate ?? null,
        notes: v.notes ?? null,
        recordedOffline: op.offline,
      },
      user,
    );
    return { status: flags.length ? 'NEEDS_REVIEW' : 'APPLIED', flags, customerId: v.customerId, paymentId: null, visitId: visit.id, result: { visitId: visit.id } };
  }

  private async applyFollowUpDone(trx: Database, user: AuthUser, f: FollowUpDoneOpPayload): Promise<Applied> {
    let alreadyClosed = false;
    let customerId: string | null = null;
    try {
      const task = await this.fieldOps.closeFollowUpIn(trx, f.followUpId, 'DONE', f.note, user);
      customerId = task.customerId;
    } catch (err) {
      // Closed meanwhile (by the office, or by a payment that fulfilled the promise): nothing to do.
      if (!(err instanceof AppError && err.code === 'FOLLOW_UP_CLOSED')) throw err;
      alreadyClosed = true;
      customerId = (await trx.selectFrom('followUpTasks').select('customerId').where('id', '=', f.followUpId).executeTakeFirst())?.customerId ?? null;
    }
    return { status: 'APPLIED', flags: [], customerId, paymentId: null, visitId: null, result: { followUpId: f.followUpId, alreadyClosed } };
  }

  /**
   * The agent deletes a payment they entered by mistake. Nothing is erased: a confirmed payment is
   * reversed (receipt cancelled, balance restored), an unverified one is marked failed; the reason
   * is kept and the office gets an alert. Cash already handed over is corrected by the office.
   */
  private async applyPaymentCancel(trx: Database, user: AuthUser, c: PaymentCancelOpPayload): Promise<Applied> {
    let q = trx
      .selectFrom('payments as p')
      .innerJoin('customers as c', 'c.id', 'p.customerId')
      .select(['p.id', 'p.status', 'p.collectedBy', 'p.amount', 'p.mode', 'p.paymentDate', 'p.customerId', 'c.name as customerName', 'c.customerCode']);
    q = c.paymentId ? q.where('p.id', '=', c.paymentId) : q.where('p.clientTxnId', '=', c.paymentOpId!);
    const p = await q.executeTakeFirst();
    if (!p) {
      if (c.paymentOpId) {
        const created = await trx.selectFrom('syncOperations').select(['status', 'userId']).where('opId', '=', c.paymentOpId).executeTakeFirst();
        // The payment entry was refused, so there is nothing to delete.
        if (created?.status === 'REJECTED' && created.userId === user.id) {
          const result: PaymentCancelOpResult = { paymentId: null, status: 'NOT_CREATED', alreadyDone: true };
          return { status: 'APPLIED', flags: [], customerId: c.customerId, paymentId: null, visitId: null, result };
        }
        // Not received yet (sent in the same batch and asked to retry): try again later.
        if (!created) throw new Error(`payment entry ${c.paymentOpId} has not arrived yet`);
      }
      throw notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    }
    if (p.collectedBy !== user.id) throw notFound('PAYMENT_NOT_FOUND', 'Only the agent who collected a payment can delete it');
    if (p.status === 'REVERSED' || p.status === 'FAILED') {
      const result: PaymentCancelOpResult = { paymentId: p.id, status: p.status, alreadyDone: true };
      return { status: 'APPLIED', flags: [], customerId: p.customerId, paymentId: p.id, visitId: null, result };
    }
    const handedOver = await trx
      .selectFrom('cashHandoverItems as i')
      .innerJoin('cashHandovers as h', 'h.id', 'i.handoverId')
      .select('h.handoverNumber')
      .where('i.paymentId', '=', p.id)
      .executeTakeFirst();
    if (handedOver) {
      throw unprocessable('PAYMENT_HANDED_OVER', `This cash is in handover ${handedOver.handoverNumber}. Ask the office to reverse it.`);
    }
    const reason = `Deleted by agent: ${c.reason}`;
    if (p.status === 'CONFIRMED') await this.payments.reverseIn(trx, p.id, reason, user);
    else await this.payments.failIn(trx, p.id, reason, user);
    const agent = await trx.selectFrom('users').select('fullName').where('id', '=', user.id).executeTakeFirst();
    await this.alerts.raise(trx, {
      type: 'PAYMENT_DELETED_BY_AGENT',
      severity: 'WARNING',
      entityType: 'payment',
      entityId: p.id,
      message: `${agent?.fullName ?? 'Agent'} deleted the ₹${fromPaise(toPaise(p.amount))} ${p.mode.toLowerCase()} payment of ${p.customerName} (${p.customerCode}) dated ${p.paymentDate}: ${c.reason}`,
      details: { customerId: p.customerId, customerCode: p.customerCode, amount: p.amount, mode: p.mode, paymentDate: p.paymentDate, reason: c.reason, agentId: user.id },
    });
    const result: PaymentCancelOpResult = { paymentId: p.id, status: p.status === 'CONFIRMED' ? 'REVERSED' : 'FAILED', alreadyDone: false };
    return { status: 'APPLIED', flags: [], customerId: p.customerId, paymentId: p.id, visitId: null, result };
  }

  private async touchDevice(user: AuthUser) {
    if (!user.deviceId) return;
    await this.db.updateTable('devices').set({ lastSyncAt: sql<Date>`now()` }).where('id', '=', user.deviceId).where('userId', '=', user.id).execute();
  }

  // ---------------------------------------------------------------------------
  // Pull
  // ---------------------------------------------------------------------------

  async pull(user: AuthUser, etag?: string): Promise<SyncPullResponse> {
    this.assertAgent(user);
    const asOf = new Date().toISOString();
    const snapshot = await this.snapshot(user);
    const { etag: tag } = snapshot;
    await this.touchDevice(user);
    if (etag && etag === tag) return { unchanged: true, asOf, etag: tag };
    return { ...snapshot, asOf };
  }

  private async snapshot(user: AuthUser): Promise<SyncSnapshot> {
    const list = await this.collections.worklist(user, { filter: 'all', sort: 'name' });
    const { today, items } = list;
    const ids = items.map((i) => i.id);
    const [day, extra, followUps, agent, rules, payRules, seq, business] = await Promise.all([
      this.collections.myDay(user, undefined, list),
      this.customerExtras(user.id, ids, today),
      sql<{ id: string; customerId: string; dueDate: string; title: string }>`
        SELECT t.id, t.customer_id, t.due_date, t.title
        FROM follow_up_tasks t JOIN customer_current_agent ca ON ca.customer_id = t.customer_id
        WHERE t.status = 'OPEN' AND ca.agent_id = ${user.id}::uuid AND (t.assigned_to = ${user.id}::uuid OR t.assigned_to IS NULL)
        ORDER BY t.due_date, t.created_at LIMIT 1000`.execute(this.db),
      this.db
        .selectFrom('users as u')
        .innerJoin('agentProfiles as a', 'a.userId', 'u.id')
        .select(['u.id', 'u.fullName', 'a.agentCode'])
        .where('u.id', '=', user.id)
        .executeTakeFirstOrThrow(),
      this.settings.get('sync.rules'),
      this.settings.get('payments.rules'),
      this.lastProvisionalSeq(user.id),
      this.settings.get('business.profile'),
    ]);

    const customers: SyncCustomer[] = items
      .map((i) => {
        const x = extra.get(i.id);
        return {
          id: i.id,
          customerCode: i.customerCode,
          name: i.name,
          mobile: i.mobile,
          altMobile: x?.altMobile ?? null,
          addressLine: i.addressLine,
          landmark: i.landmark,
          society: i.society,
          notes: x?.notes ?? null,
          stbNumbers: x?.stbNumbers ?? [],
          mqNumbers: x?.mqNumbers ?? [],
          status: x?.status ?? 'ACTIVE',
          assignment: i.assignment,
          temporaryUntil: x?.temporaryUntil ?? null,
          monthlyRate: x?.monthlyRate ?? null,
          upcomingRate: x?.upcomingRate ?? null,
          outstanding: i.outstanding,
          advance: i.advance,
          oldestDueDate: i.oldestDueDate,
          nextDueDate: i.nextDueDate,
          openInvoices: x?.openInvoices ?? [],
          pendingVerification: x?.pendingVerification ?? '0.00',
          lastPaymentDate: i.lastPaymentDate,
          lastPaymentAmount: i.lastPaymentAmount,
          paidToday: i.paidToday,
          lastVisitAt: i.lastVisitAt,
          lastVisitOutcome: i.lastVisitOutcome,
          recentPayments: x?.recentPayments ?? [],
          recentVisits: x?.recentVisits ?? [],
          bills: x?.bills ?? [],
        };
      })
      .sort((a, b) => a.customerCode.localeCompare(b.customerCode));

    const content = {
      today,
      agent: { id: agent.id, code: agent.agentCode, name: agent.fullName },
      business: { name: business.name, phone: business.phone ?? null },
      nextProvisionalSeq: seq + 1,
      staleAfterHours: rules.staleAfterHours,
      maxAmount: payRules.maxAmount,
      day: {
        expectedToday: day.expectedToday,
        collectedToday: day.collectedToday,
        remainingToday: day.remainingToday,
        byMode: day.byMode,
        pendingVerification: day.pendingVerification,
        visitsToday: day.visitsToday,
        customersNotAvailable: day.customersNotAvailable,
        cashInHand: day.cashInHand,
        cashNotYetHandedOver: day.cashNotYetHandedOver,
        pendingHandoverAmount: day.pendingHandoverAmount,
      },
      customers,
      followUps: followUps.rows.map((f) => ({ id: f.id, customerId: f.customerId, dueDate: f.dueDate, title: f.title })),
    };
    const etag = createHash('sha256').update(JSON.stringify(content)).digest('base64url').slice(0, 32);
    return { unchanged: false, asOf: '', etag, ...content };
  }

  /** Detail the list query does not carry, fetched for all of the agent's customers at once. */
  private async customerExtras(agentId: string, ids: string[], today: string) {
    type Extra = Pick<
      SyncCustomer,
      'status' | 'temporaryUntil' | 'monthlyRate' | 'upcomingRate' | 'openInvoices' | 'pendingVerification' | 'recentPayments' | 'recentVisits' | 'altMobile' | 'notes' | 'stbNumbers' | 'mqNumbers' | 'bills'
    >;
    const out = new Map<string, Extra>();
    if (ids.length === 0) return out;
    const m = (v: unknown) => fromPaise(toPaise(String(v ?? '0')));
    const [heads, rates, upcoming, invoices, pending, payments, visits, boxes, bills] = await Promise.all([
      sql<{ id: string; status: string; temporaryUntil: Date | null; altMobile: string | null; notes: string | null }>`
        SELECT c.id, c.status::text AS status, CASE WHEN a.kind = 'TEMPORARY' THEN upper(a.valid_during) END AS temporary_until,
               c.alt_mobile, c.notes
        FROM customer_current_agent ca
        JOIN customers c ON c.id = ca.customer_id
        JOIN customer_agent_assignments a ON a.id = ca.assignment_id
        WHERE ca.agent_id = ${agentId}::uuid`.execute(this.db),
      sql<{ customerId: string; monthlyRate: string }>`
        SELECT DISTINCT ON (s.customer_id) s.customer_id, r.monthly_rate
        FROM customer_subscriptions s JOIN subscription_rates r ON r.subscription_id = s.id AND r.effective_from <= ${today}::date
        WHERE s.customer_id = ANY(${ids}::uuid[]) AND s.status <> 'ENDED'
        ORDER BY s.customer_id, r.effective_from DESC`.execute(this.db),
      sql<{ customerId: string; monthlyRate: string; effectiveFrom: string }>`
        SELECT DISTINCT ON (s.customer_id) s.customer_id, r.monthly_rate, r.effective_from
        FROM customer_subscriptions s JOIN subscription_rates r ON r.subscription_id = s.id AND r.effective_from > ${today}::date
        WHERE s.customer_id = ANY(${ids}::uuid[]) AND s.status <> 'ENDED'
        ORDER BY s.customer_id, r.effective_from`.execute(this.db),
      sql<{ id: string; customerId: string; kind: string; periodStart: string | null; periodEnd: string | null; dueDate: string; balance: string }>`
        SELECT i.id, i.customer_id, i.kind::text AS kind, i.period_start, i.period_end, i.due_date, i.total - i.amount_paid AS balance
        FROM invoices i
        WHERE i.customer_id = ANY(${ids}::uuid[]) AND i.status IN ('UNPAID', 'PARTIALLY_PAID')
        ORDER BY i.due_date, i.created_at`.execute(this.db),
      sql<{ customerId: string; amount: string }>`
        SELECT customer_id, sum(amount) AS amount FROM payments
        WHERE customer_id = ANY(${ids}::uuid[]) AND status = 'PENDING_VERIFICATION' GROUP BY customer_id`.execute(this.db),
      sql<{
        id: string;
        customerId: string;
        amount: string;
        paymentDate: string;
        mode: string;
        status: string;
        receiptNumber: string | null;
        collectedByName: string | null;
        clientTxnId: string | null;
        canDelete: boolean;
        note: string | null;
      }>`
        SELECT * FROM (
          SELECT p.id, p.customer_id, p.amount, p.payment_date, p.mode::text AS mode, p.status::text AS status,
                 r.receipt_number, u.full_name AS collected_by_name,
                 CASE WHEN p.source = 'AGENT_COLLECTION' THEN p.client_txn_id END AS client_txn_id,
                 (p.collected_by = ${agentId}::uuid AND p.status IN ('CONFIRMED', 'PENDING_VERIFICATION')
                   AND NOT EXISTS (SELECT 1 FROM cash_handover_items hi WHERE hi.payment_id = p.id)) AS can_delete,
                 coalesce(pr.reason, CASE WHEN p.status = 'FAILED' THEN p.verification_note END) AS note,
                 row_number() OVER (PARTITION BY p.customer_id ORDER BY p.payment_date DESC, p.created_at DESC) AS rn
          FROM payments p
          LEFT JOIN receipts r ON r.payment_id = p.id AND r.status = 'ISSUED'
          LEFT JOIN users u ON u.id = p.collected_by
          LEFT JOIN payment_reversals pr ON pr.payment_id = p.id
          WHERE p.customer_id = ANY(${ids}::uuid[])
        ) x WHERE rn <= 8 ORDER BY customer_id, rn`.execute(this.db),
      sql<{ id: string; customerId: string; visitedAt: Date; outcome: string; notes: string | null; agentName: string }>`
        SELECT * FROM (
          SELECT v.id, v.customer_id, v.visited_at, v.outcome::text AS outcome, v.notes, u.full_name AS agent_name,
                 row_number() OVER (PARTITION BY v.customer_id ORDER BY v.visited_at DESC) AS rn
          FROM visits v JOIN users u ON u.id = v.agent_id
          WHERE v.customer_id = ANY(${ids}::uuid[])
        ) x WHERE rn <= 3 ORDER BY customer_id, rn`.execute(this.db),
      sql<{ customerId: string; stbNumber: string; mqNumber: string | null }>`
        SELECT customer_id, stb_number, mq_number FROM customer_connections
        WHERE customer_id = ANY(${ids}::uuid[]) AND active_to IS NULL
        ORDER BY customer_id, active_from`.execute(this.db),
      // 13 months: this month and the 12 before it.
      monthBills(this.db, ids, `${addDays(`${today.slice(0, 7)}-01`, -366).slice(0, 7)}-01`),
    ]);
    const get = (id: string) => {
      let e = out.get(id);
      if (!e) {
        e = {
          status: 'ACTIVE',
          temporaryUntil: null,
          monthlyRate: null,
          upcomingRate: null,
          openInvoices: [],
          pendingVerification: '0.00',
          recentPayments: [],
          recentVisits: [],
          altMobile: null,
          notes: null,
          stbNumbers: [],
          mqNumbers: [],
          bills: [],
        };
        out.set(id, e);
      }
      return e;
    };
    for (const h of heads.rows) {
      const e = get(h.id);
      e.status = h.status;
      e.temporaryUntil = h.temporaryUntil ? new Date(h.temporaryUntil).toISOString() : null;
      e.altMobile = h.altMobile;
      e.notes = h.notes;
    }
    for (const b of boxes.rows) {
      const e = get(b.customerId);
      e.stbNumbers.push(b.stbNumber);
      if (b.mqNumber) e.mqNumbers.push(b.mqNumber);
    }
    for (const [id, list] of bills) get(id).bills = list;
    for (const r of rates.rows) get(r.customerId).monthlyRate = m(r.monthlyRate);
    for (const r of upcoming.rows) get(r.customerId).upcomingRate = { monthlyRate: m(r.monthlyRate), from: r.effectiveFrom };
    for (const i of invoices.rows) {
      get(i.customerId).openInvoices.push({
        id: i.id,
        label: i.kind === 'OPENING_BALANCE' ? 'Previous balance' : i.periodStart && i.periodEnd ? periodLabel(i.periodStart, i.periodEnd) : 'Adjustment',
        dueDate: i.dueDate,
        balance: m(i.balance),
      });
    }
    for (const p of pending.rows) get(p.customerId).pendingVerification = m(p.amount);
    for (const p of payments.rows) {
      get(p.customerId).recentPayments.push({
        id: p.id,
        amount: m(p.amount),
        paymentDate: p.paymentDate,
        mode: p.mode,
        status: p.status,
        receiptNumber: p.receiptNumber,
        collectedByName: p.collectedByName,
        clientTxnId: p.clientTxnId,
        canDelete: p.canDelete,
        note: p.note,
      });
    }
    for (const v of visits.rows) {
      get(v.customerId).recentVisits.push({ id: v.id, visitedAt: new Date(v.visitedAt).toISOString(), outcome: v.outcome, notes: v.notes, agentName: v.agentName });
    }
    return out;
  }

  /** Highest provisional receipt number this agent has used (posted or rejected). */
  private async lastProvisionalSeq(userId: string): Promise<number> {
    const code = await this.db.selectFrom('agentProfiles').select('agentCode').where('userId', '=', userId).executeTakeFirst();
    if (!code) return 0;
    const prefix = `P-${code.agentCode}-%`;
    const r = await sql<{ n: number | null }>`
      SELECT max(n)::int AS n FROM (
        SELECT substring(provisional_ref FROM '(\\d+)$')::int AS n FROM payments WHERE provisional_ref LIKE ${prefix}
        UNION ALL
        SELECT substring(payload->>'provisionalRef' FROM '(\\d+)$')::int FROM sync_operations
        WHERE user_id = ${userId}::uuid AND op_type = 'PAYMENT_CREATE' AND payload->>'provisionalRef' LIKE ${prefix}
      ) x`.execute(this.db);
    return r.rows[0]?.n ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Office review queue
  // ---------------------------------------------------------------------------

  async reviewList(q: ListSyncReviewQuery) {
    let query = this.db
      .selectFrom('syncOperations as o')
      .innerJoin('users as u', 'u.id', 'o.userId')
      .leftJoin('agentProfiles as ap', 'ap.userId', 'o.userId')
      .leftJoin('customers as c', 'c.id', 'o.customerId')
      .leftJoin('payments as p', 'p.id', 'o.paymentId')
      .leftJoin('users as r', 'r.id', 'o.reviewedBy')
      .where('o.status', 'in', ['NEEDS_REVIEW', 'REJECTED']);
    if (q.state === 'open') query = query.where('o.reviewedAt', 'is', null);
    if (q.state === 'reviewed') query = query.where('o.reviewedAt', 'is not', null);
    if (q.agentId) query = query.where('o.userId', '=', q.agentId);
    const [items, total] = await Promise.all([
      query
        .select([
          'o.opId',
          'o.opType',
          'o.status',
          'o.flags',
          'o.errorCode',
          'o.errorMessage',
          'o.payload',
          'o.clientCreatedAt',
          'o.effectiveAt',
          'o.clockSkewSeconds',
          'o.recordedOffline',
          'o.receivedAt',
          'o.reviewedAt',
          'o.reviewNote',
          'o.paymentId',
          'o.visitId',
          'o.userId as agentId',
          'u.fullName as agentName',
          'ap.agentCode',
          'c.id as customerId',
          'c.customerCode',
          'c.name as customerName',
          'p.amount',
          'p.mode',
          'p.status as paymentStatus',
          'p.provisionalRef',
          'r.fullName as reviewedByName',
        ])
        .orderBy('o.receivedAt', 'desc')
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize)
        .execute(),
      query.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page: q.page, pageSize: q.pageSize, total: Number(total.n) });
  }

  async openReviewCount(): Promise<number> {
    const r = await this.db
      .selectFrom('syncOperations')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', 'in', ['NEEDS_REVIEW', 'REJECTED'])
      .where('reviewedAt', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** The office has looked at it. Corrections (reversal, reassignment) are done with the normal tools. */
  async review(opId: string, note: string | null | undefined, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const op = await trx.selectFrom('syncOperations').selectAll().where('opId', '=', opId).forUpdate().executeTakeFirst();
      if (!op || op.status === 'APPLIED') throw notFound('SYNC_OP_NOT_FOUND', 'Nothing to review for this entry');
      if (op.reviewedAt) throw conflict('SYNC_OP_REVIEWED', 'This entry was already reviewed');
      await trx.updateTable('syncOperations').set({ reviewedBy: actor.id, reviewedAt: sql<Date>`now()`, reviewNote: note ?? null }).where('opId', '=', opId).execute();
      await this.audit.record(trx, { action: 'sync.reviewed', entityType: 'sync_operation', entityId: opId, after: { status: op.status, flags: op.flags }, reason: note ?? null });
      return { opId, reviewedAt: new Date().toISOString() };
    });
  }
}
