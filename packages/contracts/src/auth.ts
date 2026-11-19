import { z } from 'zod';
import { uuid } from './common';

export const deviceInfo = z.object({
  id: uuid,
  platform: z.string().trim().max(40).optional(),
  model: z.string().trim().max(100).optional(),
  appVersion: z.string().trim().max(40).optional(),
});

export const loginRequest = z.object({
  mobile: z.string().trim().min(10).max(20),
  password: z.string().min(1).max(200),
  device: deviceInfo.optional(),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const refreshRequest = z.object({ refreshToken: z.string().min(20).max(500) });
export type RefreshRequest = z.infer<typeof refreshRequest>;

export const passwordPolicy = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password must contain letters and digits');

export const changePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordPolicy,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequest>;

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}
