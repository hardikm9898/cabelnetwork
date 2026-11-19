import * as argon2 from 'argon2';

// OWASP-recommended argon2id parameters (19 MiB, t=2, p=1) are the minimum; we use 64 MiB / t=3.
const OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

/**
 * Each hash/verify uses 64 MiB. At most MAX_PARALLEL run at once; the rest wait their turn, so a
 * burst of sign-in attempts cannot exhaust the server's memory (security review L-4).
 */
const MAX_PARALLEL = 4;
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export function hashPassword(plain: string): Promise<string> {
  return limited(() => argon2.hash(plain, OPTIONS));
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await limited(() => argon2.verify(hash, plain));
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Burns comparable CPU time when the user does not exist (prevents account enumeration by timing). */
export async function verifyAgainstDummy(plain: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing-1');
  await verifyPassword(await dummyHash, plain);
}
