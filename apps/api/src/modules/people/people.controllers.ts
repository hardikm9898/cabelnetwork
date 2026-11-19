import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  ChangeUserStatusRequest,
  changeUserStatusRequest,
  CreateAdminUserRequest,
  createAdminUserRequest,
  CreateAgentRequest,
  createAgentRequest,
  reason,
  ResetPasswordRequest,
  resetPasswordRequest,
  UpdateAgentRequest,
  updateAgentRequest,
  USER_STATUSES,
} from '@cablenet/contracts';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/request-context';
import { ZodBody, ZodQuery } from '../../common/zod';
import { AuthService } from '../auth/auth.service';
import { PeopleService } from './people.service';

const listAgentsQuery = z.object({ status: z.enum(USER_STATUSES).optional(), q: z.string().trim().max(100).optional() });
const reasonBody = z.object({ reason });

@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
export class AgentsController {
  constructor(
    private readonly people: PeopleService,
    private readonly auth: AuthService,
  ) {}

  @RequirePermissions('agents:read')
  @Get()
  list(@ZodQuery(listAgentsQuery) q: z.infer<typeof listAgentsQuery>) {
    return this.people.listAgents(q);
  }

  @RequirePermissions('agents:read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.people.getAgent(id);
  }

  @RequirePermissions('agents:manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @ZodBody(createAgentRequest) body: CreateAgentRequest) {
    return this.people.createAgent(body, user);
  }

  @RequirePermissions('agents:manage')
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(updateAgentRequest) body: UpdateAgentRequest) {
    return this.people.updateAgent(id, body, user);
  }

  @RequirePermissions('agents:manage')
  @Post(':id/status')
  @HttpCode(200)
  status(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(changeUserStatusRequest) body: ChangeUserStatusRequest,
  ) {
    return this.people.changeStatus(id, body, user, ['AGENT']);
  }

  @RequirePermissions('agents:manage')
  @Post(':id/reset-password')
  @HttpCode(204)
  async resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(resetPasswordRequest) body: ResetPasswordRequest,
  ) {
    await this.people.resetPassword(id, body.temporaryPassword, body.reason, user, ['AGENT']);
  }

  @RequirePermissions('agents:read')
  @Get(':id/sessions')
  async sessions(@Param('id', ParseUUIDPipe) id: string) {
    await this.people.getAgent(id);
    return this.auth.listSessions(id);
  }

  @RequirePermissions('agents:manage')
  @Delete(':id/sessions/:familyId')
  @HttpCode(204)
  async revokeSession(@Param('id', ParseUUIDPipe) id: string, @Param('familyId', ParseUUIDPipe) familyId: string) {
    await this.auth.revokeSession(id, familyId, 'revoked_by_admin');
  }

  @RequirePermissions('agents:read')
  @Get(':id/devices')
  async devices(@Param('id', ParseUUIDPipe) id: string) {
    await this.people.getAgent(id);
    return this.people.devices(id);
  }

  @RequirePermissions('agents:manage')
  @Post(':id/devices/:deviceId/revoke')
  @HttpCode(204)
  async revokeDevice(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @ZodBody(reasonBody) body: z.infer<typeof reasonBody>,
  ) {
    await this.people.revokeDevice(id, deviceId, body.reason);
  }
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly people: PeopleService) {}

  @RequirePermissions('users:manage')
  @Get()
  list() {
    return this.people.listAdmins();
  }

  @RequirePermissions('users:manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @ZodBody(createAdminUserRequest) body: CreateAdminUserRequest) {
    return this.people.createAdmin(body, user);
  }

  @RequirePermissions('users:manage')
  @Post(':id/status')
  @HttpCode(200)
  status(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(changeUserStatusRequest) body: ChangeUserStatusRequest,
  ) {
    return this.people.changeStatus(id, body, user, ['ADMIN', 'SUPER_ADMIN']);
  }

  @RequirePermissions('users:manage')
  @Post(':id/reset-password')
  @HttpCode(204)
  async resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(resetPasswordRequest) body: ResetPasswordRequest,
  ) {
    await this.people.resetPassword(id, body.temporaryPassword, body.reason, user, ['ADMIN', 'SUPER_ADMIN']);
  }
}
