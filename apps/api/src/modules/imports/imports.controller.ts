import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  importApproveRequest,
  importCorrectionRequest,
  ImportCorrectionRequest,
  importDryRunRequest,
  ImportDryRunRequest,
  listImportsQuery,
} from '@cablenet/contracts';
import { AnyAuthenticated, CurrentUser, RequirePermissions } from '../../common/decorators';
import { unprocessable } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import { ZodBody, ZodQuery } from '../../common/zod';
import { CustomerAccessService } from '../customers/customer-access.service';
import { ImportsService } from './imports.service';

const MAX_UPLOAD = 15 * 1024 * 1024;

@ApiTags('imports')
@ApiBearerAuth()
@Controller()
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly access: CustomerAccessService,
  ) {}

  /** Upload the workbook (multipart field "file"); it is analysed at once. */
  @RequirePermissions('import:manage')
  @Post('imports')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  upload(@CurrentUser() user: AuthUser, @UploadedFile() file: { originalname: string; buffer: Buffer; size: number } | undefined) {
    if (!file) throw unprocessable('FILE_REQUIRED', 'Attach the workbook as "file"');
    return this.imports.upload(file, user);
  }

  @RequirePermissions('import:manage')
  @Get('imports')
  list(@ZodQuery(listImportsQuery) q: z.infer<typeof listImportsQuery>) {
    return this.imports.list(q.page, q.pageSize);
  }

  /** Parallel run: a workbook kept alongside the system vs the system's books for one month. */
  @RequirePermissions('import:manage')
  @Post('imports/compare')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  compare(@CurrentUser() user: AuthUser, @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined, @Query('month') month: string) {
    if (!file) throw unprocessable('FILE_REQUIRED', 'Attach the workbook as "file"');
    return this.imports.compare(file, month ?? '', user);
  }

  /** Customers imported without a usable rate (Q1), waiting for the office to set a plan. */
  @RequirePermissions('import:manage')
  @Get('imports/pending-decisions')
  pending() {
    return this.imports.pendingDecisions();
  }

  @RequirePermissions('import:manage')
  @Get('imports/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(id);
  }

  @RequirePermissions('import:manage')
  @Put('imports/:id/corrections')
  correct(@Param('id', ParseUUIDPipe) id: string, @ZodBody(importCorrectionRequest) body: ImportCorrectionRequest) {
    return this.imports.correct(id, body);
  }

  /** Runs the whole import in a transaction that is rolled back; returns the reconciliation report. */
  @RequirePermissions('import:manage')
  @Post('imports/:id/dry-run')
  @HttpCode(200)
  dryRun(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(importDryRunRequest) body: ImportDryRunRequest) {
    return this.imports.dryRun(id, body, user);
  }

  @RequirePermissions('import:manage')
  @Post('imports/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(importApproveRequest) body: z.infer<typeof importApproveRequest>) {
    return this.imports.approve(id, body.dryRunHash, user);
  }

  /** Writes the approved import; refused if the result would differ from the approved dry run. */
  @RequirePermissions('import:manage')
  @Post('imports/:id/commit')
  @HttpCode(200)
  commit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.commit(id, user);
  }

  @RequirePermissions('import:manage')
  @Post('imports/:id/discard')
  @HttpCode(200)
  discard(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.discard(id);
  }

  /** The customer's Excel month grid, read-only ("Excel history"). */
  @AnyAuthenticated()
  @Get('customers/:customerId/legacy-statement')
  async legacy(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string) {
    await this.access.assertCanAccess(user, id);
    return this.imports.legacyStatement(id);
  }
}
