import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  CreateAreaRequest,
  createAreaRequest,
  CreateSocietyRequest,
  createSocietyRequest,
  SetAreaOwnerRequest,
  setAreaOwnerRequest,
  UpdateAreaRequest,
  updateAreaRequest,
  reason,
  UpdateSocietyRequest,
  updateSocietyRequest,
  uuid,
} from '@cablenet/contracts';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/request-context';
import { ZodBody, ZodQuery } from '../../common/zod';
import { AssignmentsService } from '../assignments/assignments.service';
import { GeographyService } from './geography.service';

@ApiTags('areas')
@ApiBearerAuth()
@Controller('areas')
export class AreasController {
  constructor(
    private readonly geo: GeographyService,
    private readonly assignments: AssignmentsService,
  ) {}

  @RequirePermissions('areas:read')
  @Get()
  list() {
    return this.geo.listAreas();
  }

  @RequirePermissions('areas:read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.geo.getArea(id);
  }

  @RequirePermissions('areas:manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @ZodBody(createAreaRequest) body: CreateAreaRequest) {
    return this.geo.createArea(body, user);
  }

  @RequirePermissions('areas:manage')
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(updateAreaRequest) body: UpdateAreaRequest) {
    return this.geo.updateArea(id, body, user);
  }

  @RequirePermissions('areas:manage')
  @Post(':id/delete')
  @HttpCode(200)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(z.object({ reason })) body: { reason: string }) {
    return this.geo.deleteArea(id, body.reason, user);
  }

  /** Set (or clear) the default agent for an area; customers following the default move with it. */
  @RequirePermissions('areas:manage', 'assignments:manage')
  @Put(':id/owner')
  @HttpCode(200)
  setOwner(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(setAreaOwnerRequest) body: SetAreaOwnerRequest) {
    return this.assignments.setAreaOwner(id, body, user.id);
  }
}

const listSocietiesQuery = z.object({ areaId: uuid.optional() });

@ApiTags('societies')
@ApiBearerAuth()
@Controller('societies')
export class SocietiesController {
  constructor(private readonly geo: GeographyService) {}

  @RequirePermissions('societies:read')
  @Get()
  list(@ZodQuery(listSocietiesQuery) q: z.infer<typeof listSocietiesQuery>) {
    return this.geo.listSocieties(q);
  }

  @RequirePermissions('societies:read')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.geo.getSociety(id);
  }

  @RequirePermissions('societies:manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @ZodBody(createSocietyRequest) body: CreateSocietyRequest) {
    return this.geo.createSociety(body, user);
  }

  @RequirePermissions('societies:manage')
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(updateSocietyRequest) body: UpdateSocietyRequest) {
    return this.geo.updateSociety(id, body, user);
  }

  @RequirePermissions('societies:manage')
  @Post(':id/delete')
  @HttpCode(200)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZodBody(z.object({ reason })) body: { reason: string }) {
    return this.geo.deleteSociety(id, body.reason, user);
  }
}
