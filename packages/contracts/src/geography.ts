import { z } from 'zod';
import { optionalTrimmed, reason, trimmed, uuid } from './common';

export const createAreaRequest = z.object({ name: trimmed(100), description: optionalTrimmed(500) });
export type CreateAreaRequest = z.infer<typeof createAreaRequest>;

export const updateAreaRequest = z
  .object({ name: trimmed(100), description: optionalTrimmed(500), status: z.enum(['ACTIVE', 'INACTIVE']) })
  .partial();
export type UpdateAreaRequest = z.infer<typeof updateAreaRequest>;

export const setAreaOwnerRequest = z.object({
  /** null removes the default owner (customers keep their current assignment). */
  agentId: uuid.nullable(),
  reason,
  /** Also move customers whose assignment was set manually (default: leave overrides alone). */
  applyToManualOverrides: z.boolean().default(false),
});
export type SetAreaOwnerRequest = z.infer<typeof setAreaOwnerRequest>;

const collectionDay = z.number().int().min(1).max(31);

export const createSocietyRequest = z.object({
  name: trimmed(120),
  legacyName: optionalTrimmed(120),
  areaId: uuid.nullish(),
  collectionDay: collectionDay.nullish(),
});
export type CreateSocietyRequest = z.infer<typeof createSocietyRequest>;

export const updateSocietyRequest = z
  .object({
    name: trimmed(120),
    areaId: uuid.nullable(),
    collectionDay: collectionDay.nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    /** Required when areaId changes, because customer assignments may move. */
    reason,
  })
  .partial();
export type UpdateSocietyRequest = z.infer<typeof updateSocietyRequest>;
