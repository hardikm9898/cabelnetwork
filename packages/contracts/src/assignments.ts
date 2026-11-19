import { z } from 'zod';
import { businessDate, reason, uuid } from './common';

const idList = z.array(uuid).min(1).max(1000);

export const permanentAssignmentRequest = z
  .object({
    agentId: uuid,
    customerIds: idList.optional(),
    societyId: uuid.optional(),
    reason,
  })
  .refine((v) => (v.customerIds ? 1 : 0) + (v.societyId ? 1 : 0) === 1, {
    message: 'Provide exactly one of customerIds or societyId',
  });
export type PermanentAssignmentRequest = z.infer<typeof permanentAssignmentRequest>;

export const resetToAreaDefaultRequest = z.object({ customerIds: idList, reason });
export type ResetToAreaDefaultRequest = z.infer<typeof resetToAreaDefaultRequest>;

export const TEMP_SCOPES = ['ALL_OF_AGENT', 'SOCIETIES', 'CUSTOMERS'] as const;

export const temporaryReassignmentRequest = z
  .object({
    fromAgentId: uuid,
    toAgentId: uuid,
    scope: z.enum(TEMP_SCOPES),
    societyIds: idList.optional(),
    customerIds: idList.optional(),
    /** Inclusive IST dates. */
    startsOn: businessDate,
    endsOn: businessDate,
    reason,
  })
  .refine((v) => v.fromAgentId !== v.toAgentId, { message: 'Agents must differ', path: ['toAgentId'] })
  .refine((v) => v.endsOn >= v.startsOn, { message: 'End date is before start date', path: ['endsOn'] })
  .refine((v) => v.scope !== 'SOCIETIES' || (v.societyIds?.length ?? 0) > 0, {
    message: 'societyIds required for SOCIETIES scope',
    path: ['societyIds'],
  })
  .refine((v) => v.scope !== 'CUSTOMERS' || (v.customerIds?.length ?? 0) > 0, {
    message: 'customerIds required for CUSTOMERS scope',
    path: ['customerIds'],
  });
export type TemporaryReassignmentRequest = z.infer<typeof temporaryReassignmentRequest>;

export const revokeTemporaryRequest = z.object({ reason });
export type RevokeTemporaryRequest = z.infer<typeof revokeTemporaryRequest>;
