import { Inject, Injectable } from '@nestjs/common';
import { canReadAllCustomers } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { notFound } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';

/**
 * Backend ownership check for customer records. Agents may only touch customers currently
 * assigned to them (PRIMARY, or TEMPORARY overlay in force). A customer the caller may not
 * see is reported as "not found" so IDs cannot be probed.
 */
@Injectable()
export class CustomerAccessService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async assertCanAccess(user: AuthUser, customerId: string, db: Database = this.db): Promise<void> {
    if (canReadAllCustomers(user.role)) {
      const exists = await db.selectFrom('customers').select('id').where('id', '=', customerId).executeTakeFirst();
      if (!exists) throw notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
      return;
    }
    const assigned = await db
      .selectFrom('customerCurrentAgent')
      .select('customerId')
      .where('customerId', '=', customerId)
      .where('agentId', '=', user.id)
      .executeTakeFirst();
    if (!assigned) throw notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
  }
}
