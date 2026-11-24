import { z } from 'zod';
import { businessDate, optionalTrimmed, paginationQuery, phoneInput, reason, trimmed, uuid } from './common';

export const CUSTOMER_STATUSES = ['ACTIVE', 'SUSPENDED', 'INACTIVE', 'DISCONNECTED'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

const customerCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,20}$/, 'Customer ID may contain letters, digits and "-" (max 20)');
const stbNumber = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{4,30}$/, 'Invalid STB number');
const mqNumber = z.string().trim().max(30);
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

export const createCustomerRequest = z.object({
  customerCode,
  name: trimmed(150),
  mobile: phoneInput.nullish(),
  altMobile: phoneInput.nullish(),
  addressLine: trimmed(500),
  landmark: optionalTrimmed(200),
  societyId: uuid,
  stbNumber: stbNumber.nullish(),
  mqNumber: mqNumber.nullish(),
  notes: optionalTrimmed(2000),
  collectionDay: z.number().int().min(1).max(31).nullish(),
  paymentPreferenceMonths: z.number().int().min(1).max(24).nullish(),
  latitude: latitude.nullish(),
  longitude: longitude.nullish(),
  /** Assign to this agent instead of the area default (creates a manual override). */
  agentId: uuid.nullish(),
  /** Proceed despite duplicate warnings (e.g. a mobile shared by family members). */
  acknowledgeWarnings: z.boolean().default(false),
});
export type CreateCustomerRequest = z.infer<typeof createCustomerRequest>;

export const updateCustomerRequest = z
  .object({
    customerCode,
    /** Corrects the active box's number (typing mistake). A box swap is "replace connection". Empty removes the box. */
    stbNumber: z.union([stbNumber, z.literal('')]).nullable(),
    mqNumber: mqNumber.nullable(),
    name: trimmed(150),
    mobile: phoneInput.nullable(),
    altMobile: phoneInput.nullable(),
    addressLine: trimmed(500),
    landmark: optionalTrimmed(200),
    societyId: uuid,
    notes: optionalTrimmed(2000),
    collectionDay: z.number().int().min(1).max(31).nullable(),
    paymentPreferenceMonths: z.number().int().min(1).max(24).nullable(),
    latitude: latitude.nullable(),
    longitude: longitude.nullable(),
  })
  .partial()
  .extend({ acknowledgeWarnings: z.boolean().default(false), reason: reason.optional() });
export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequest>;

export const CUSTOMER_SORTS = ['name', '-name', 'code', '-code', 'society', '-society', '-createdAt', 'createdAt', '-outstanding', 'outstanding'] as const;

export const listCustomersQuery = paginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  societyId: uuid.optional(),
  areaId: uuid.optional(),
  agentId: uuid.optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
  /** OUTSTANDING: balance > 0, ADVANCE: balance < 0, SETTLED: balance = 0. */
  balance: z.enum(['OUTSTANDING', 'ADVANCE', 'SETTLED']).optional(),
  minOutstanding: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/)
    .optional(),
  sort: z.enum(CUSTOMER_SORTS).default('name'),
  /** true: only deleted customers (to restore one); default: only customers that are not deleted. */
  deleted: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuery>;

export const customerStatusChangeRequest = z.object({ reason });

/** Delete one customer (soft delete; the history stays and it can be restored). */
export const deleteCustomerRequest = z.object({ reason });
export type DeleteCustomerRequest = z.infer<typeof deleteCustomerRequest>;
export const bulkDeleteCustomersRequest = z.object({ customerIds: z.array(uuid).min(1).max(500), reason });
export type BulkDeleteCustomersRequest = z.infer<typeof bulkDeleteCustomersRequest>;
export type CustomerStatusChangeRequest = z.infer<typeof customerStatusChangeRequest>;

export const replaceConnectionRequest = z.object({
  stbNumber,
  mqNumber: mqNumber.nullish(),
  effectiveDate: businessDate,
  reason,
});
export type ReplaceConnectionRequest = z.infer<typeof replaceConnectionRequest>;
