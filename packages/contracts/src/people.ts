import { z } from 'zod';
import { businessDate, optionalTrimmed, phoneInput, reason, trimmed } from './common';
import { passwordPolicy } from './auth';

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export const EMPLOYMENT_STATUSES = ['ACTIVE', 'ON_LEAVE', 'LEFT'] as const;

export const createAdminUserRequest = z.object({
  fullName: trimmed(120),
  mobile: phoneInput,
  email: z.email().nullish(),
  role: z.enum(['ADMIN', 'SUPER_ADMIN']),
  temporaryPassword: passwordPolicy,
});
export type CreateAdminUserRequest = z.infer<typeof createAdminUserRequest>;

export const createAgentRequest = z.object({
  fullName: trimmed(120),
  mobile: phoneInput,
  email: z.email().nullish(),
  agentCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, 'Agent code must be 2–10 letters/digits'),
  joiningDate: businessDate.nullish(),
  photoUrl: z.url().nullish(),
  notes: optionalTrimmed(1000),
  temporaryPassword: passwordPolicy,
});
export type CreateAgentRequest = z.infer<typeof createAgentRequest>;

export const updateAgentRequest = z
  .object({
    fullName: trimmed(120),
    mobile: phoneInput,
    email: z.email().nullable(),
    joiningDate: businessDate.nullable(),
    photoUrl: z.url().nullable(),
    employmentStatus: z.enum(EMPLOYMENT_STATUSES),
    notes: optionalTrimmed(1000),
  })
  .partial();
export type UpdateAgentRequest = z.infer<typeof updateAgentRequest>;

export const resetPasswordRequest = z.object({ temporaryPassword: passwordPolicy, reason });
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequest>;

export const changeUserStatusRequest = z.object({ status: z.enum(USER_STATUSES), reason });
export type ChangeUserStatusRequest = z.infer<typeof changeUserStatusRequest>;
