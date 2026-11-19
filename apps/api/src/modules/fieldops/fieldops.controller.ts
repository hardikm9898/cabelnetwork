import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  completeFollowUpRequest,
  createFollowUpRequest,
  CreateFollowUpRequest,
  createInteractionRequest,
  CreateInteractionRequest,
  listFollowUpsQuery,
  ListFollowUpsQuery,
  listInteractionsQuery,
  ListInteractionsQuery,
  paginationQuery,
  recordVisitRequest,
  RecordVisitRequest,
  updateInteractionRequest,
  UpdateInteractionRequest,
} from '@cablenet/contracts';
import { AnyAuthenticated, CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/request-context';
import { ZodBody, ZodQuery } from '../../common/zod';
import { FieldOpsService } from './fieldops.service';

@ApiTags('field operations')
@ApiBearerAuth()
@Controller()
export class FieldOpsController {
  constructor(private readonly ops: FieldOpsService) {}

  /** Idempotent by `clientId` (offline retries). */
  @RequirePermissions('visits:record')
  @Post('customers/:customerId/visits')
  recordVisit(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string, @ZodBody(recordVisitRequest) body: RecordVisitRequest) {
    return this.ops.recordVisit(id, body, user);
  }

  @AnyAuthenticated()
  @Get('customers/:customerId/visits')
  visits(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string, @ZodQuery(paginationQuery) q: z.infer<typeof paginationQuery>) {
    return this.ops.customerVisits(id, user, q.page, q.pageSize);
  }

  @RequirePermissions('interactions:manage')
  @Post('customers/:customerId/interactions')
  createInteraction(
    @CurrentUser() user: AuthUser,
    @Param('customerId', ParseUUIDPipe) id: string,
    @ZodBody(createInteractionRequest) body: CreateInteractionRequest,
  ) {
    return this.ops.createInteraction(id, body, user);
  }

  /** Admins: all; agents: only with customerId of an assigned customer. */
  @AnyAuthenticated()
  @Get('interactions')
  interactions(@CurrentUser() user: AuthUser, @ZodQuery(listInteractionsQuery) q: ListInteractionsQuery) {
    return this.ops.listInteractions(q, user);
  }

  @RequirePermissions('interactions:manage')
  @Patch('interactions/:id')
  updateInteraction(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(updateInteractionRequest) body: UpdateInteractionRequest) {
    return this.ops.updateInteraction(id, body, user);
  }

  @AnyAuthenticated()
  @Post('customers/:customerId/follow-ups')
  createFollowUp(@CurrentUser() user: AuthUser, @Param('customerId', ParseUUIDPipe) id: string, @ZodBody(createFollowUpRequest) body: CreateFollowUpRequest) {
    return this.ops.createFollowUp(id, body, user);
  }

  @AnyAuthenticated()
  @Get('follow-ups')
  followUps(@CurrentUser() user: AuthUser, @ZodQuery(listFollowUpsQuery) q: ListFollowUpsQuery) {
    return this.ops.listFollowUps(q, user);
  }

  @AnyAuthenticated()
  @Post('follow-ups/:id/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(completeFollowUpRequest) body: z.infer<typeof completeFollowUpRequest>) {
    return this.ops.closeFollowUp(id, 'DONE', body.note, user);
  }

  @AnyAuthenticated()
  @Post('follow-ups/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(completeFollowUpRequest) body: z.infer<typeof completeFollowUpRequest>) {
    return this.ops.closeFollowUp(id, 'CANCELLED', body.note, user);
  }
}
