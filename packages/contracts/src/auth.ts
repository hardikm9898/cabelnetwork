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

/** At least 6 characters; digits only is fine (e.g. a 6-digit number). Trivial ones are refused. */
export const PASSWORD_MIN = 6;
export const passwordPolicy = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(200)
  .refine((v) => !isTrivialPassword(v), 'This password is too easy to guess (like 123456 or 111111); choose another');

/** Same character repeated, or a straight run like 123456 / 654321 / abcdef, or a well-known password. */
export function isTrivialPassword(v: string): boolean {
  const s = v.toLowerCase();
  if (/^(.)\1+$/.test(s)) return true;
  const codes = [...s].map((c) => c.charCodeAt(0));
  const step = codes[1]! - codes[0]!;
  if ((step === 1 || step === -1) && codes.every((c, i) => i === 0 || c - codes[i - 1]! === step)) return true;
  return /^(password|passw0rd|qwerty|qwertyuiop|abc123|admin123|cablenet|iloveyou|123123|121212|112233|123321)$/.test(s);
}

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
