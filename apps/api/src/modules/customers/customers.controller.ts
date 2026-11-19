import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CreateCustomerRequest,
  createCustomerRequest,
  CustomerStatusChangeRequest,
  customerStatusChangeRequest,
  ListCustomersQuery,
  listCustomersQuery,
  ReplaceConnectionRequest,
  replaceConnectionRequest,
  UpdateCustomerRequest,
  updateCustomerRequest,
} from '@cablenet/contracts';
import { AnyAuthenticated, CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/request-context';
import { ZodBody, ZodQuery } from '../../common/zod';
import { CustomersService } from './customers.service';

/**
 * Read endpoints are open to any signed-in user but always scoped by the service:
 * admins see everything, agents only customers currently assigned to them.
 */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @AnyAuthenticated()
  @Get()
  list(@CurrentUser() user: AuthUser, @ZodQuery(listCustomersQuery) q: ListCustomersQuery) {
    return this.customers.list(q, user);
  }

  @AnyAuthenticated()
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(id, user);
  }

  @AnyAuthenticated()
  @Get(':id/connections')
  connections(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.connections(id, user);
  }

  @RequirePermissions('assignments:read')
  @Get(':id/assignments')
  assignments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.assignmentHistory(id, user);
  }

  @RequirePermissions('customers:manage')
  @Post()
  create(@CurrentUser() user: AuthUser, @ZodBody(createCustomerRequest) body: CreateCustomerRequest) {
    return this.customers.create(body, user);
  }

  @RequirePermissions('customers:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateCustomerRequest) body: UpdateCustomerRequest,
  ) {
    return this.customers.update(id, body, user);
  }

  @RequirePermissions('customers:manage')
  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(customerStatusChangeRequest) body: CustomerStatusChangeRequest,
  ) {
    return this.customers.changeStatus(id, 'deactivate', body.reason, user);
  }

  @RequirePermissions('customers:manage')
  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(customerStatusChangeRequest) body: CustomerStatusChangeRequest,
  ) {
    return this.customers.changeStatus(id, 'reactivate', body.reason, user);
  }

  @RequirePermissions('customers:manage')
  @Post(':id/connections/replace')
  replaceConnection(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(replaceConnectionRequest) body: ReplaceConnectionRequest,
  ) {
    return this.customers.replaceConnection(id, body, user);
  }
}
