import { z } from 'zod';
import { businessDate, optionalTrimmed, paginationQuery, uuid } from './common';
import { positiveMoney } from './finance';

export const VISIT_OUTCOMES = [
  'PAYMENT_COLLECTED',
  'PARTIAL_PAYMENT',
  'NOT_AVAILABLE',
  'REFUSED',
  'WILL_PAY_LATER',
  'ALREADY_PAID_ADMIN',
  'WRONG_ADDRESS',
  'SERVICE_DISCONTINUED',
  'OTHER',
] as const;
export const INTERACTION_CHANNELS = ['CALL', 'WHATSAPP', 'WALK_IN', 'VISIT', 'OTHER'] as const;
export const INTERACTION_TYPES = ['PAYMENT_PROMISE', 'COMPLAINT', 'QUERY', 'DISCONNECTION_REQUEST', 'RECONNECTION_REQUEST', 'OTHER'] as const;
export const INTERACTION_STATUSES = ['PENDING', 'PROMISE_TO_PAY', 'FOLLOW_UP_REQUIRED', 'COMPLETED', 'NOT_INTERESTED'] as const;

export const recordVisitRequest = z
  .object({
    clientId: uuid,
    outcome: z.enum(VISIT_OUTCOMES),
    visitedAt: z.iso.datetime({ offset: true }).optional(),
    paymentId: uuid.nullish(),
    promisedAmount: positiveMoney.nullish(),
    promisedDate: businessDate.nullish(),
    followUpDate: businessDate.nullish(),
    notes: optionalTrimmed(1000),
    gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().int().min(0).max(100000).optional() }).nullish(),
    recordedOffline: z.boolean().default(false),
  })
  .refine((v) => !['PAYMENT_COLLECTED', 'PARTIAL_PAYMENT'].includes(v.outcome) || !!v.paymentId, {
    message: 'Link the payment that was collected',
    path: ['paymentId'],
  })
  .refine((v) => v.outcome !== 'OTHER' || !!v.notes, { message: 'Describe the outcome', path: ['notes'] });
export type RecordVisitRequest = z.infer<typeof recordVisitRequest>;

export const createInteractionRequest = z
  .object({
    channel: z.enum(INTERACTION_CHANNELS),
    interactionType: z.enum(INTERACTION_TYPES),
    expectedAmount: positiveMoney.nullish(),
    promiseDate: businessDate.nullish(),
    followUpDate: businessDate.nullish(),
    notes: optionalTrimmed(2000),
    /** Who should follow up (defaults to the person recording it). */
    followUpAssigneeId: uuid.nullish(),
  })
  .refine((v) => v.interactionType !== 'PAYMENT_PROMISE' || (!!v.expectedAmount && !!v.promiseDate), {
    message: 'A promise to pay needs the expected amount and date',
    path: ['promiseDate'],
  });
export type CreateInteractionRequest = z.infer<typeof createInteractionRequest>;

export const updateInteractionRequest = z.object({
  status: z.enum(INTERACTION_STATUSES).optional(),
  notes: optionalTrimmed(2000),
  followUpDate: businessDate.nullish(),
});
export type UpdateInteractionRequest = z.infer<typeof updateInteractionRequest>;

export const listInteractionsQuery = paginationQuery.extend({
  status: z.enum(INTERACTION_STATUSES).optional(),
  interactionType: z.enum(INTERACTION_TYPES).optional(),
  customerId: uuid.optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
});
export type ListInteractionsQuery = z.infer<typeof listInteractionsQuery>;

export const createFollowUpRequest = z.object({
  dueDate: businessDate,
  title: z.string().trim().min(3).max(200),
  assignedTo: uuid.nullish(),
});
export type CreateFollowUpRequest = z.infer<typeof createFollowUpRequest>;

export const completeFollowUpRequest = z.object({ note: optionalTrimmed(1000) });

export const listFollowUpsQuery = paginationQuery.extend({
  /** mine = assigned to me (or, for agents, unassigned tasks on my customers). */
  scope: z.enum(['mine', 'all']).default('mine'),
  status: z.enum(['OPEN', 'DONE', 'CANCELLED']).default('OPEN'),
  due: z.enum(['overdue', 'today', 'upcoming', 'any']).default('any'),
  customerId: uuid.optional(),
});
export type ListFollowUpsQuery = z.infer<typeof listFollowUpsQuery>;
