import { sql } from 'kysely';
import { businessDateOf, toPaise } from '@cablenet/domain';
import { hasPermission } from '@cablenet/domain';
import { forbidden } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import type { Database } from '../../db/database';
import type { SettingsService } from '../core/settings.service';

/**
 * Office admins may waive at most `credits.limits.adminMaxAmount` per customer per day, counting
 * credits, refunds and cancelled bills together, so splitting an amount or cancelling bills instead
 * cannot get round the super admin's approval (security review M-6). The super admin is not limited.
 */
export async function assertWithinApprovalLimit(db: Database, settings: SettingsService, actor: AuthUser, customerId: string, amount: string): Promise<void> {
  if (hasPermission(actor.role, 'credits:approve-large')) return;
  const { adminMaxAmount } = await settings.get('credits.limits', db);
  const today = businessDateOf(new Date());
  const r = await sql<{ used: string }>`
    SELECT (
      coalesce((SELECT sum(amount) FROM credit_notes WHERE customer_id = ${customerId}::uuid AND approved_by = ${actor.id}::uuid
                  AND status = 'ACTIVE' AND kind <> 'OPENING_ADVANCE' AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date), 0)
      + coalesce((SELECT sum(amount) FROM refunds WHERE customer_id = ${customerId}::uuid AND approved_by = ${actor.id}::uuid
                  AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date), 0)
      + coalesce((SELECT sum(total) FROM invoices WHERE customer_id = ${customerId}::uuid AND cancelled_by = ${actor.id}::uuid
                  AND (cancelled_at AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date), 0)
    )::text AS used
  `.execute(db);
  const used = toPaise(r.rows[0]?.used ?? '0');
  if (used + toPaise(amount) > toPaise(adminMaxAmount)) {
    throw forbidden(
      'APPROVAL_REQUIRED',
      `Credits, refunds and cancelled bills above ₹${adminMaxAmount} per customer per day must be entered by the super admin`,
    );
  }
}
