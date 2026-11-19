/**
 * Stricter rate limit for credential endpoints (per client IP). Read lazily so the value
 * validated by config/env.ts (LOGIN_RATE_LIMIT_PER_MINUTE) applies.
 */
export function loginThrottle() {
  return {
    ttl: 60_000,
    limit: () => Number(process.env.LOGIN_RATE_LIMIT_PER_MINUTE ?? 10),
  };
}
