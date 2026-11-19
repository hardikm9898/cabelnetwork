import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  billingRunRequest,
  businessDate,
  cashAdjustmentRequest,
  CashAdjustmentRequest,
  changeRateRequest,
  ChangeRateRequest,
  confirmHandoverRequest,
  ConfirmHandoverRequest,
  createSubscriptionRequest,
  CreateSubscriptionRequest,
  creditRequest,
  CreditRequest,
  debitRequest,
  DebitRequest,
  endSubscriptionRequest,
  EndSubscriptionRequest,
  failPaymentRequest,
  listInvoicesQuery,
  ListInvoicesQuery,
  listPaymentsQuery,
  ListPaymentsQuery,
  manualInvoiceRequest,
  ManualInvoiceRequest,
  openingBalanceRequest,
  OpeningBalanceRequest,
  paginationQuery,
  reactivateRequest,
  ReactivateRequest,
  reason,
  recordPaymentRequest,
  RecordPaymentRequest,
  refundRequest,
  RefundRequest,
  reverseCreditRequest,
  reversePaymentRequest,
  submitHandoverRequest,
  SubmitHandoverRequest,
  suspendRequest,
  SuspendRequest,
  updateSubscriptionTermsRequest,
  UpdateSubscriptionTermsRequest,
  uuid,
  verifyPaymentRequest,
} from '@cablenet/contracts';
import { addDays, businessDateOf, canReadAllCustomers } from '@cablenet/domain';
import { AnyAuthenticated, CurrentUser, RequirePermissions } from '../../common/decorators';
import { notFound, unprocessable } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import type { AuthUser } from '../../common/request-context';
import { ZodBody, ZodQuery } from '../../common/zod';
import { AlertsService } from './alerts.service';
import { BillingService } from './billing.service';
import { CashService } from './cash.service';
import { CreditsService } from './credits.service';
import { LedgerQueriesService } from './ledger-queries.service';
import { PaymentsService } from './payments.service';
import { ReceiptsService } from './receipts.service';
import { ReconciliationService } from './reconciliation.service';
import { SubscriptionsService } from './subscriptions.service';

const reasonBody = z.object({ reason });

// ---------------------------------------------------------------------------
// Customer-scoped financial views and commands
// ---------------------------------------------------------------------------

@ApiTags('customer finance')
@ApiBearerAuth()
@Controller('customers/:customerId')
export class CustomerFinanceController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly billing: BillingService,
    private readonly credits: CreditsService,
    private readonly ledgerQueries: LedgerQueriesService,
    private readonly payments: PaymentsService,
  ) {}

  /** Outstanding / advance, open invoices, last payment (agents: assigned customers only). */
  @AnyAuthenticated()
  @Get('balance')
  balance(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string) {
    return this.ledgerQueries.balance(id, user);
  }

  @AnyAuthenticated()
  @Get('ledger')
  ledger(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string) {
    return this.ledgerQueries.statement(id, user);
  }

  @AnyAuthenticated()
  @Get('payments')
  customerPayments(
    @CurrentUser() user: AuthUser,
    @Param('customerId', ParseUUIDPipe) id: string,
    @ZodQuery(paginationQuery) q: z.infer<typeof paginationQuery>,
  ) {
    return this.ledgerQueries.payments(id, user, q.page, q.pageSize);
  }

  @AnyAuthenticated()
  @Get('invoices')
  invoices(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string, @ZodQuery(listInvoicesQuery) q: ListInvoicesQuery) {
    return this.billing.listForCustomer(id, user, q);
  }

  @AnyAuthenticated()
  @Get('subscription')
  subscription(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string) {
    return this.subscriptions.getForCustomer(id, user);
  }

  @RequirePermissions('billing:manage')
  @Post('subscription')
  createSubscription(
    @CurrentUser() user: AuthUser,
    @Param('customerId', ParseUUIDPipe) id: string,
    @ZodBody(createSubscriptionRequest) body: CreateSubscriptionRequest,
  ) {
    return this.subscriptions.create(id, body, user);
  }

  @RequirePermissions('billing:manage')
  @Idempotent()
  @Post('invoices')
  manualInvoice(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string, @ZodBody(manualInvoiceRequest) body: ManualInvoiceRequest) {
    return this.billing.createManual(id, body, user);
  }

  @RequirePermissions('credits:manage')
  @Idempotent()
  @Post('credits')
  credit(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string, @ZodBody(creditRequest) body: CreditRequest) {
    return this.credits.addCredit(id, body, user);
  }

  @RequirePermissions('credits:manage')
  @Idempotent()
  @Post('debits')
  debit(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string, @ZodBody(debitRequest) body: DebitRequest) {
    return this.credits.addDebit(id, body, user);
  }

  @RequirePermissions('credits:manage')
  @Idempotent()
  @Post('refunds')
  refund(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string, @ZodBody(refundRequest) body: RefundRequest) {
    return this.credits.refund(id, body, user);
  }

  @RequirePermissions('credits:manage')
  @Idempotent()
  @Post('opening-balance')
  openingBalance(
    @CurrentUser() user: AuthUser,
    @Param('customerId', ParseUUIDPipe) id: string,
    @ZodBody(openingBalanceRequest) body: OpeningBalanceRequest,
  ) {
    return this.credits.openingBalance(id, body, user);
  }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

@ApiTags('subscriptions')
@ApiBearerAuth()
@Controller('subscriptions/:id')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @RequirePermissions('billing:manage')
  @Post('rates')
  changeRate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(changeRateRequest) body: ChangeRateRequest) {
    return this.subscriptions.changeRate(id, body, user);
  }

  @RequirePermissions('billing:manage')
  @Patch()
  updateTerms(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateSubscriptionTermsRequest) body: UpdateSubscriptionTermsRequest,
  ) {
    return this.subscriptions.updateTerms(id, body, user);
  }

  @RequirePermissions('billing:manage')
  @Post('suspensions')
  suspend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(suspendRequest) body: SuspendRequest) {
    return this.subscriptions.suspend(id, body, user);
  }

  @RequirePermissions('billing:manage')
  @Post('reactivate')
  @HttpCode(200)
  reactivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(reactivateRequest) body: ReactivateRequest) {
    return this.subscriptions.reactivate(id, body, user);
  }

  @RequirePermissions('billing:manage')
  @Post('end')
  @HttpCode(200)
  end(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(endSubscriptionRequest) body: EndSubscriptionRequest) {
    return this.subscriptions.end(id, body.endDate, body.reason, user);
  }
}

// ---------------------------------------------------------------------------
// Billing & invoices
// ---------------------------------------------------------------------------

@ApiTags('billing')
@ApiBearerAuth()
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @RequirePermissions('billing:manage')
  @Post('billing/runs')
  run(@CurrentUser() user: AuthUser, @ZodBody(billingRunRequest) body: z.infer<typeof billingRunRequest>) {
    const today = businessDateOf(new Date());
    const asOf = body.asOf ?? today;
    // Billing a little ahead (e.g. next month's bills on the 28th) is fine; far ahead is a mistake.
    if (asOf > addDays(today, 31)) throw unprocessable('AS_OF_TOO_FAR', 'Billing can run at most 31 days ahead');
    return this.billing.run(asOf, 'MANUAL', user.id);
  }

  @RequirePermissions('billing:read')
  @Get('billing/runs')
  runs(@ZodQuery(paginationQuery) q: z.infer<typeof paginationQuery>) {
    return this.billing.runs(q.page, q.pageSize);
  }

  @RequirePermissions('billing:read')
  @Get('invoices')
  list(@ZodQuery(listInvoicesQuery) q: ListInvoicesQuery) {
    return this.billing.list(q);
  }

  @AnyAuthenticated()
  @Get('invoices/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.get(id, user);
  }

  @RequirePermissions('billing:manage')
  @Idempotent()
  @Post('invoices/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(reasonBody) body: z.infer<typeof reasonBody>) {
    return this.billing.cancel(id, body.reason, user);
  }
}

// ---------------------------------------------------------------------------
// Payments, credits, receipts
// ---------------------------------------------------------------------------

@ApiTags('payments')
@ApiBearerAuth()
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly credits: CreditsService,
    private readonly receipts: ReceiptsService,
  ) {}

  /** Idempotent by `clientTxnId` in the body (works across offline retries). */
  @RequirePermissions('payments:record')
  @Post('payments')
  record(@CurrentUser() user: AuthUser, @ZodBody(recordPaymentRequest) body: RecordPaymentRequest) {
    return this.payments.record(body, user);
  }

  /** Admins: all payments. Agents: payments they collected. */
  @AnyAuthenticated()
  @Get('payments')
  list(@CurrentUser() user: AuthUser, @ZodQuery(listPaymentsQuery) q: ListPaymentsQuery) {
    return this.payments.list(q, user);
  }

  @AnyAuthenticated()
  @Get('payments/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.get(id, user);
  }

  @RequirePermissions('payments:verify')
  @Idempotent()
  @Post('payments/:id/verify')
  @HttpCode(200)
  verify(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(verifyPaymentRequest) body: z.infer<typeof verifyPaymentRequest>) {
    return this.payments.verify(id, body.note, user);
  }

  @RequirePermissions('payments:verify')
  @Idempotent()
  @Post('payments/:id/fail')
  @HttpCode(200)
  fail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(failPaymentRequest) body: z.infer<typeof failPaymentRequest>) {
    return this.payments.fail(id, body.reason, user);
  }

  @RequirePermissions('payments:reverse')
  @Idempotent()
  @Post('payments/:id/reverse')
  @HttpCode(200)
  reverse(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(reversePaymentRequest) body: z.infer<typeof reversePaymentRequest>) {
    return this.payments.reverse(id, body.reason, user);
  }

  @RequirePermissions('credits:manage')
  @Idempotent()
  @Post('credits/:id/reverse')
  @HttpCode(200)
  reverseCredit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(reverseCreditRequest) body: z.infer<typeof reverseCreditRequest>) {
    return this.credits.reverseCredit(id, body.reason, user);
  }

  @AnyAuthenticated()
  @Get('receipts/:id')
  async receipt(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.receipts.get(id);
    if (!canReadAllCustomers(user.role)) {
      await this.payments.get(r.paymentId, user).catch(() => {
        throw notFound('RECEIPT_NOT_FOUND', 'Receipt not found');
      });
    }
    return r;
  }

  @RequirePermissions('payments:reverse')
  @Idempotent()
  @Post('receipts/:id/reissue')
  reissue(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(reasonBody) body: z.infer<typeof reasonBody>) {
    return this.receipts.reissue(id, body.reason, user.id);
  }
}

// ---------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------

const listHandoversQuery = paginationQuery.extend({
  agentId: uuid.optional(),
  status: z.enum(['SUBMITTED', 'CONFIRMED', 'REJECTED']).optional(),
});
const cashDayQuery = z.object({ date: businessDate.optional() });

@ApiTags('cash')
@ApiBearerAuth()
@Controller('cash')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @RequirePermissions('cash:submit')
  @Get('me')
  me(@CurrentUser() user: AuthUser, @ZodQuery(cashDayQuery) q: z.infer<typeof cashDayQuery>) {
    return this.cash.summary(user.id, q.date);
  }

  @RequirePermissions('cash:manage')
  @Get('agents')
  agents() {
    return this.cash.allAgents();
  }

  @RequirePermissions('cash:manage')
  @Get('agents/:id')
  agent(@Param('id', ParseUUIDPipe) id: string, @ZodQuery(cashDayQuery) q: z.infer<typeof cashDayQuery>) {
    return this.cash.summary(id, q.date);
  }

  @RequirePermissions('cash:submit')
  @Idempotent()
  @Post('handovers')
  submit(@CurrentUser() user: AuthUser, @ZodBody(submitHandoverRequest) body: SubmitHandoverRequest) {
    return this.cash.submit(user, body);
  }

  @AnyAuthenticated()
  @Get('handovers')
  list(@CurrentUser() user: AuthUser, @ZodQuery(listHandoversQuery) q: z.infer<typeof listHandoversQuery>) {
    return this.cash.list(q, user);
  }

  @AnyAuthenticated()
  @Get('handovers/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cash.get(id, user);
  }

  @RequirePermissions('cash:manage')
  @Idempotent()
  @Post('handovers/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(confirmHandoverRequest) body: ConfirmHandoverRequest) {
    return this.cash.confirm(id, body, user);
  }

  @RequirePermissions('cash:manage')
  @Idempotent()
  @Post('handovers/:id/reject')
  @HttpCode(200)
  reject(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(reasonBody) body: z.infer<typeof reasonBody>) {
    return this.cash.reject(id, body.reason, user);
  }

  @RequirePermissions('cash:manage')
  @Idempotent()
  @Post('adjustments')
  adjust(@CurrentUser() user: AuthUser, @ZodBody(cashAdjustmentRequest) body: CashAdjustmentRequest) {
    return this.cash.adjust(body, user);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation & alerts
// ---------------------------------------------------------------------------

const alertsQuery = paginationQuery.extend({ open: z.enum(['true', 'false']).default('true').transform((v) => v === 'true') });
const resolveBody = z.object({ resolution: reason });

@ApiTags('reconciliation')
@ApiBearerAuth()
@Controller()
export class ReconciliationController {
  constructor(
    private readonly reconciliation: ReconciliationService,
    private readonly alerts: AlertsService,
  ) {}

  @RequirePermissions('reconciliation:run')
  @Post('reconciliation/run')
  @HttpCode(200)
  run() {
    return this.reconciliation.run();
  }

  @RequirePermissions('reconciliation:run')
  @Get('system-alerts')
  list(@ZodQuery(alertsQuery) q: z.infer<typeof alertsQuery>) {
    return this.alerts.list(q);
  }

  @RequirePermissions('reconciliation:run')
  @Post('system-alerts/:id/resolve')
  @HttpCode(200)
  resolve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(resolveBody) body: z.infer<typeof resolveBody>) {
    return this.alerts.resolve(id, body.resolution, user.id);
  }
}
