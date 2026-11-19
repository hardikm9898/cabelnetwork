import { Controller, Get, Inject, Param, ParseUUIDPipe, Req, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { uuid } from '@cablenet/contracts';
import { canReadAllCustomers } from '@cablenet/domain';
import { APP_CONFIG, AppConfig } from '../../config/env';
import { AnyAuthenticated, CurrentUser, Public } from '../../common/decorators';
import { notFound } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import { ZodQuery } from '../../common/zod';
import { PaymentsService } from '../finance/payments.service';
import { ReceiptsService } from '../finance/receipts.service';
import { SettingsService } from '../core/settings.service';
import { receiptPdf } from '../reports/exporters';
import { CollectionsService, WORKLIST_FILTERS, WORKLIST_SORTS } from './collections.service';
import { ReceiptLinkSigner } from './receipt-links';

const worklistQuery = z.object({
  agentId: uuid.optional(),
  filter: z.enum(WORKLIST_FILTERS).default('all'),
  sort: z.enum(WORKLIST_SORTS).default('outstanding'),
  q: z.string().trim().max(100).optional(),
});
const myDayQuery = z.object({ agentId: uuid.optional() });

@ApiTags('collections')
@ApiBearerAuth()
@Controller()
export class CollectionsController {
  private readonly signer: ReceiptLinkSigner;

  constructor(
    private readonly collections: CollectionsService,
    private readonly receipts: ReceiptsService,
    private readonly payments: PaymentsService,
    private readonly settings: SettingsService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    // Own secret in production (env check); development falls back to the JWT secret.
    this.signer = new ReceiptLinkSigner(cfg.RECEIPT_LINK_SECRET ?? cfg.JWT_ACCESS_SECRET);
  }

  /** Agent's work list (admins pass agentId to see an agent's list). */
  @AnyAuthenticated()
  @Get('collections/today')
  worklist(@CurrentUser() user: AuthUser, @ZodQuery(worklistQuery) q: z.infer<typeof worklistQuery>) {
    return this.collections.worklist(user, q);
  }

  @AnyAuthenticated()
  @Get('dashboard/me')
  myDay(@CurrentUser() user: AuthUser, @ZodQuery(myDayQuery) q: z.infer<typeof myDayQuery>) {
    return this.collections.myDay(user, q.agentId);
  }

  /** Signed link to the receipt PDF, for sharing with the customer (WhatsApp). */
  @AnyAuthenticated()
  @Get('receipts/:id/link')
  async link(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const r = await this.receipts.get(id);
    if (!canReadAllCustomers(user.role)) {
      // Only for a customer the agent currently has (a reassigned customer's receipt is the office's to share).
      const p = await this.payments.get(r.paymentId, user).catch(() => {
        throw notFound('RECEIPT_NOT_FOUND', 'Receipt not found');
      });
      if ('limited' in p) throw notFound('RECEIPT_NOT_FOUND', 'Receipt not found');
    }
    const { token, expiresAt } = this.signer.sign(id, this.cfg.RECEIPT_LINK_TTL_DAYS);
    const base = this.cfg.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`;
    return { url: `${base.replace(/\/$/, '')}/api/v1/public/receipts/${token}`, expiresAt: expiresAt.toISOString() };
  }

  /** Public: the PDF behind a signed link (no login; the token is the permission). */
  @Public()
  @Get('public/receipts/:token')
  async publicReceipt(@Param('token') token: string) {
    const id = this.signer.verify(token);
    if (!id) throw notFound('LINK_INVALID', 'This receipt link is invalid or has expired');
    const r = await this.receipts.get(id).catch(() => {
      throw notFound('LINK_INVALID', 'This receipt link is invalid or has expired');
    });
    // A reversed or reissued receipt is cancelled: links to it stop working (revocation).
    if (r.status !== 'ISSUED') throw notFound('LINK_INVALID', 'This receipt link is invalid or has expired');
    const snap = r.snapshot as Parameters<typeof receiptPdf>[0];
    const body = await receiptPdf(
      { ...snap, status: r.status, business: { ...snap.business, name: snap.business.name || (await this.settings.get('business.profile')).name } },
      { publicView: true },
    );
    const safe = r.receiptNumber.replace(/[^A-Za-z0-9-]/g, '_');
    return new StreamableFile(body, { type: 'application/pdf', disposition: `inline; filename="receipt_${safe}.pdf"` });
  }
}
