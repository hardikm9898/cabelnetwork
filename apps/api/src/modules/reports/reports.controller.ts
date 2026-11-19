import { Controller, Get, Param, ParseUUIDPipe, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { businessDate, uuid } from '@cablenet/contracts';
import { canReadAllCustomers } from '@cablenet/domain';
import { AnyAuthenticated, CurrentUser, RequirePermissions } from '../../common/decorators';
import { notFound } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import { ZodQuery } from '../../common/zod';
import { PaymentsService } from '../finance/payments.service';
import { ReceiptsService } from '../finance/receipts.service';
import { SettingsService } from '../core/settings.service';
import { DashboardService } from './dashboard.service';
import { receiptPdf } from './exporters';
import { ReportsService } from './reports.service';

const reportQuery = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  q: z.string().trim().max(100).optional(),
  agentId: uuid.optional(),
  societyId: uuid.optional(),
  areaId: uuid.optional(),
  customerId: uuid.optional(),
  status: z.string().max(40).optional(),
  sort: z.string().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  format: z.enum(['json', 'xlsx', 'pdf']).default('json'),
});

const dashboardQuery = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  agentId: uuid.optional(),
  societyId: uuid.optional(),
  areaId: uuid.optional(),
});

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly dashboard: DashboardService,
    private readonly receipts: ReceiptsService,
    private readonly payments: PaymentsService,
    private readonly settings: SettingsService,
  ) {}

  @RequirePermissions('dashboard:read')
  @Get('dashboard')
  overview(@ZodQuery(dashboardQuery) q: z.infer<typeof dashboardQuery>) {
    return this.dashboard.overview(q);
  }

  @RequirePermissions('reports:read')
  @Get('reports')
  catalogue() {
    return this.reports.catalogue();
  }

  /** `format=json` (paged) or `format=xlsx|pdf` (file download of all matching rows). */
  @RequirePermissions('reports:read')
  @Get('reports/:key')
  async run(@Param('key') key: string, @ZodQuery(reportQuery) q: z.infer<typeof reportQuery>) {
    if (q.format === 'json') return this.reports.run(key, q);
    const file = await this.reports.export(key, q, q.format);
    return new StreamableFile(file.body, { type: file.contentType, disposition: `attachment; filename="${file.filename}"` });
  }

  /** Printable/shareable receipt. Agents: receipts they may see (own collections / assigned customers). */
  @AnyAuthenticated()
  @Get('receipts/:id/pdf')
  async receiptPdf(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.receipts.get(id);
    if (!canReadAllCustomers(user.role)) {
      await this.payments.get(r.paymentId, user).catch(() => {
        throw notFound('RECEIPT_NOT_FOUND', 'Receipt not found');
      });
    }
    const snap = r.snapshot as Parameters<typeof receiptPdf>[0];
    const body = await receiptPdf({ ...snap, status: r.status, business: { ...snap.business, name: snap.business.name || (await this.settings.get('business.profile')).name } });
    const safe = r.receiptNumber.replace(/[^A-Za-z0-9-]/g, '_');
    return new StreamableFile(body, { type: 'application/pdf', disposition: `inline; filename="receipt_${safe}.pdf"` });
  }
}
