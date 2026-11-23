import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  // Required: a missing value must not silently mean "development" (Swagger on, relaxed checks).
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  /** Signs public receipt links. Separate from the JWT secret so rotating one does not affect the other. */
  RECEIPT_LINK_SECRET: z.string().min(32, 'RECEIPT_LINK_SECRET must be at least 32 characters').optional(),
  RECEIPT_LINK_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(180).default(30),
  /** Window in which a just-rotated refresh token may be replayed (lost response on a flaky network). */
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  /** Office (non-agent) sessions end this many hours after sign-in, however active (ASVS 3.3.2). */
  ADMIN_SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(24 * 7).default(12),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  /**
   * How many reverse-proxy hops to trust for the client IP (rate limits, audit). "1" behind Caddy.
   * "true" (trust every hop) is not accepted: it lets a client choose its own IP via X-Forwarded-For.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v, ctx) => {
      if (v === 'false' || v === '0') return false as const;
      if (/^\d+$/.test(v)) return Number(v);
      if (v === 'true') {
        ctx.addIssue({ code: 'custom', message: 'Use the number of proxy hops (e.g. 1), not "true"' });
        return z.NEVER;
      }
      return v; // e.g. "loopback, 10.0.0.0/8"
    }),
  /** Public origin used in shareable links (e.g. https://cable.example.in). Defaults to the request host. */
  PUBLIC_BASE_URL: z.url().optional(),
  /**
   * Explicit opt-in to run production over plain HTTP (e.g. a trial on an internal IP without a
   * domain). Passwords and customer data then travel unencrypted on that network: internal use only.
   */
  ALLOW_INSECURE_HTTP: bool.default(false),
  SWAGGER_ENABLED: bool.optional(),
  /** Run the in-process scheduler (billing, reminders, reconciliation). Disable on extra replicas if desired. */
  JOBS_ENABLED: bool.default(true),
  JOBS_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof envSchema> & { SWAGGER_ENABLED: boolean };

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    // Refuse unsafe production settings at start-up (security review M-1, L-7).
    const problems: string[] = [];
    const weak = (v: string) => /change-?me|example|secret|password/i.test(v) || new Set(v).size < 16;
    if (weak(cfg.JWT_ACCESS_SECRET)) problems.push('JWT_ACCESS_SECRET looks like a placeholder; generate one with "openssl rand -hex 32"');
    if (!cfg.RECEIPT_LINK_SECRET || weak(cfg.RECEIPT_LINK_SECRET)) problems.push('RECEIPT_LINK_SECRET must be set to its own random value');
    if (cfg.RECEIPT_LINK_SECRET && cfg.RECEIPT_LINK_SECRET === cfg.JWT_ACCESS_SECRET) problems.push('RECEIPT_LINK_SECRET must differ from JWT_ACCESS_SECRET');
    if (!cfg.PUBLIC_BASE_URL) problems.push('PUBLIC_BASE_URL must be set to the address users open');
    else if (!cfg.PUBLIC_BASE_URL.startsWith('https://') && !cfg.PUBLIC_BASE_URL.startsWith('http://localhost')) {
      if (cfg.ALLOW_INSECURE_HTTP) {
        console.warn(`WARNING: running over plain HTTP (${cfg.PUBLIC_BASE_URL}). Passwords and customer data are not encrypted; use only on a trusted internal network.`);
      } else {
        problems.push('PUBLIC_BASE_URL must be the public https:// address (or set ALLOW_INSECURE_HTTP=true for an internal-network trial)');
      }
    }
    if (problems.length) throw new Error(`Unsafe production configuration:\n  ${problems.join('\n  ')}`);
  }
  return { ...cfg, SWAGGER_ENABLED: cfg.SWAGGER_ENABLED ?? cfg.NODE_ENV !== 'production' };
}
