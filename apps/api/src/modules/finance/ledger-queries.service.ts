import { Inject, Injectable } from '@nestjs/common';
import { businessDateOf, fromPaise, toPaise } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { Page } from '../../common/http';
import type { AuthUser } from '../../common/request-context';
import { CustomerAccessService } from '../customers/customer-access.service';
import { LedgerService } from './ledger.service';

/** Read models over the ledger for one customer (statement, balance card, payment history). */
@Injectable()
export class LedgerQueriesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly access: CustomerAccessService,
  ) {}

  async balance(customerId: string, user: AuthUser) {
    await this.access.assertCanAccess(user, customerId);
    const today = businessDateOf(new Date());
    const [summary, open, lastPayment, pending] = await Promise.all([
      this.ledger.summary(this.db, customerId),
      this.db
        .selectFrom('invoices')
        .select(['id', 'invoiceNumber', 'kind', 'periodStart', 'periodEnd', 'billingDate', 'dueDate', 'total', 'amountPaid', 'status'])
        .where('customerId', '=', customerId)
        .where('status', 'in', ['UNPAID', 'PARTIALLY_PAID'])
        .orderBy('billingDate')
        .execute(),
      this.db
        .selectFrom('payments')
        .select(['id', 'amount', 'paymentDate', 'mode'])
        .where('customerId', '=', customerId)
        .where('status', '=', 'CONFIRMED')
        .orderBy('paymentDate', 'desc')
        .orderBy('createdAt', 'desc')
        .executeTakeFirst(),
      this.db
        .selectFrom('payments')
        .select(['id', 'amount', 'paymentDate', 'mode', 'reference'])
        .where('customerId', '=', customerId)
        .where('status', '=', 'PENDING_VERIFICATION')
        .execute(),
    ]);
    const overdue = open.filter((i) => i.dueDate < today);
    return {
      ...summary,
      overdueAmount: fromPaise(overdue.reduce((s, i) => s + toPaise(i.total) - toPaise(i.amountPaid), 0n)),
      oldestDueDate: open[0]?.dueDate ?? null,
      openInvoices: open.map((i) => ({ ...i, balance: fromPaise(toPaise(i.total) - toPaise(i.amountPaid)), overdue: i.dueDate < today })),
      lastPayment: lastPayment ?? null,
      /** Recorded but not yet verified (UPI/cheque): not included in the balance above. */
      pendingVerification: pending,
    };
  }

  /** Ledger statement with running balance (oldest first). */
  async statement(customerId: string, user: AuthUser) {
    await this.access.assertCanAccess(user, customerId);
    const rows = await this.db
      .selectFrom('ledgerEntries as e')
      .leftJoin('invoices as i', 'i.id', 'e.invoiceId')
      .leftJoin('payments as p', 'p.id', 'e.paymentId')
      .leftJoin('creditNotes as c', 'c.id', 'e.creditNoteId')
      .leftJoin('refunds as r', 'r.id', 'e.refundId')
      .select([
        'e.id',
        'e.entryDate',
        'e.postedAt',
        'e.type',
        'e.amount',
        'e.description',
        'e.reversesEntryId',
        'i.invoiceNumber',
        'e.invoiceId',
        'e.paymentId',
        'p.mode as paymentMode',
        'c.creditNumber',
        'r.refundNumber',
      ])
      .where('e.customerId', '=', customerId)
      .orderBy('e.entryDate')
      .orderBy('e.id')
      .execute();
    let running = 0n;
    const entries = rows.map((r) => {
      running += toPaise(r.amount);
      return { ...r, debit: toPaise(r.amount) > 0n ? r.amount : null, credit: toPaise(r.amount) < 0n ? fromPaise(-toPaise(r.amount)) : null, runningBalance: fromPaise(running) };
    });
    return { summary: await this.ledger.summary(this.db, customerId), entries };
  }

  async payments(customerId: string, user: AuthUser, page: number, pageSize: number) {
    await this.access.assertCanAccess(user, customerId);
    const q = this.db.selectFrom('payments as p').leftJoin('users as u', 'u.id', 'p.collectedBy').where('p.customerId', '=', customerId);
    const [items, total] = await Promise.all([
      q
        .select(['p.id', 'p.amount', 'p.paymentDate', 'p.mode', 'p.reference', 'p.status', 'p.source', 'u.fullName as collectedByName', 'p.createdAt'])
        .orderBy('p.paymentDate', 'desc')
        .orderBy('p.createdAt', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute(),
      q.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return new Page(items, { page, pageSize, total: Number(total.n) });
  }
}
