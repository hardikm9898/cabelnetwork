import { z } from 'zod';
import { optionalTrimmed, trimmed } from './common';

/**
 * Registry of business settings. Each key has its own schema and default; the API
 * rejects unknown keys and values that fail validation.
 */
export const SETTINGS_SCHEMAS = {
  'business.profile': z.object({
    name: trimmed(150),
    address: optionalTrimmed(500),
    phone: optionalTrimmed(20),
    email: z.email().nullish(),
    logoUrl: z.url().nullish(),
    gstin: optionalTrimmed(15),
    receiptFooter: optionalTrimmed(300),
  }),
  'customers.duplicateRules': z.object({
    mobile: z.enum(['off', 'warn', 'block']),
    stb: z.enum(['warn', 'block']),
  }),
  'field.gpsCheckIn': z.object({ enabled: z.boolean() }),
  'payments.rules': z.object({
    /** Largest single payment accepted (decimal string). */
    maxAmount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
    /** How many days in the past an agent may date a payment (offline collection). */
    agentMaxBackdateDays: z.number().int().min(0).max(60),
    /** Same customer + amount + mode within this window is flagged as a possible duplicate. */
    duplicateWindowMinutes: z.number().int().min(0).max(1440),
  }),
  'billing.defaults': z.object({ dueDays: z.number().int().min(0).max(90) }),
  'sync.rules': z.object({
    /** The agent app warns that balances may be out of date when its data is older than this. */
    staleAfterHours: z.number().int().min(1).max(168),
  }),
  'credits.limits': z.object({
    /** Credits/refunds above this need the super admin (credits:approve-large). */
    adminMaxAmount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_SCHEMAS)[K]>;

export const SETTINGS_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  'business.profile': { name: 'Cable Network' },
  'customers.duplicateRules': { mobile: 'warn', stb: 'block' },
  'field.gpsCheckIn': { enabled: false },
  'payments.rules': { maxAmount: '100000.00', agentMaxBackdateDays: 7, duplicateWindowMinutes: 10 },
  'billing.defaults': { dueDays: 10 },
  'sync.rules': { staleAfterHours: 12 },
  'credits.limits': { adminMaxAmount: '1000.00' },
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMAS, key);
}
