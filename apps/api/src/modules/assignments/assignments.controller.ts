import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  paginationQuery,
  PermanentAssignmentRequest,
  permanentAssignmentRequest,
  ResetToAreaDefaultRequest,
  resetToAreaDefaultRequest,
  RevokeTemporaryRequest,
  revokeTemporaryRequest,
  TemporaryReassignmentRequest,
  temporaryReassignmentRequest,
  uuid,
} from '@cablenet/contracts';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/request-context';
import { ZodBody, ZodQuery } from '../../common/zod';
import { AssignmentsService } from './assignments.service';

const listTemporaryQuery = paginationQuery.extend({
  status: z.enum(['SCHEDULED', 'ACTIVE', 'ENDED', 'REVOKED']).optional(),
  agentId: uuid.optional(),
});

@ApiTags('assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @RequirePermissions('assignments:manage')
  @Post('permanent')
  @HttpCode(200)
  permanent(@CurrentUser() user: AuthUser, @ZodBody(permanentAssignmentRequest) body: PermanentAssignmentRequest) {
    return this.assignments.permanentMove(body, user.id);
  }

  @RequirePermissions('assignments:manage')
  @Post('reset-to-area-default')
  @HttpCode(200)
  reset(@CurrentUser() user: AuthUser, @ZodBody(resetToAreaDefaultRequest) body: ResetToAreaDefaultRequest) {
    return this.assignments.resetToAreaDefault(body, user.id);
  }

  @RequirePermissions('assignments:manage')
  @Post('temporary')
  createTemporary(
    @CurrentUser() user: AuthUser,
    @ZodBody(temporaryReassignmentRequest) body: TemporaryReassignmentRequest,
  ) {
    return this.assignments.createTemporary(body, user.id);
  }

  @RequirePermissions('assignments:read')
  @Get('temporary')
  listTemporary(@ZodQuery(listTemporaryQuery) q: z.infer<typeof listTemporaryQuery>) {
    return this.assignments.listTemporary(q);
  }

  @RequirePermissions('assignments:read')
  @Get('temporary/:id')
  getTemporary(@Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.getTemporary(id);
  }

  @RequirePermissions('assignments:manage')
  @Post('temporary/:id/revoke')
  @HttpCode(200)
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(revokeTemporaryRequest) body: RevokeTemporaryRequest,
  ) {
    return this.assignments.revokeTemporary(id, body.reason, user.id);
  }
}
