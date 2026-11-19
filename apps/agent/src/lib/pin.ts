import * as Crypto from 'expo-crypto';
import { KEYS, storage } from './storage';

/**
 * App PIN (quick unlock on a shared/lost phone). Stored only as a salted SHA-256 hash in
 * secure storage. After MAX_FAILS wrong attempts the session is wiped and the agent must sign
 * in with their password again. The PIN never leaves the device.
 */
export const MAX_FAILS = 5;

async function hash(pin: string, salt: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
}

export const isValidPin = (pin: string) => /^\d{4}$/.test(pin);

export async function hasPin(): Promise<boolean> {
  return !!(await storage.get(KEYS.pin));
}

export async function savePin(pin: string): Promise<void> {
  const salt = Crypto.randomUUID();
  await storage.set(KEYS.pin, `${salt}$${await hash(pin, salt)}`);
  await storage.set(KEYS.pinFails, '0');
}

/** 'ok' | 'wrong' (with attempts left) | 'locked' (too many failures: caller signs out). */
export async function checkPin(pin: string): Promise<{ result: 'ok' } | { result: 'wrong'; left: number } | { result: 'locked' }> {
  const stored = await storage.get(KEYS.pin);
  if (!stored) return { result: 'locked' };
  const [salt, expected] = stored.split('$');
  if (salt && expected && (await hash(pin, salt)) === expected) {
    await storage.set(KEYS.pinFails, '0');
    return { result: 'ok' };
  }
  const fails = Number((await storage.get(KEYS.pinFails)) ?? '0') + 1;
  await storage.set(KEYS.pinFails, String(fails));
  return fails >= MAX_FAILS ? { result: 'locked' } : { result: 'wrong', left: MAX_FAILS - fails };
}

export async function clearPin(): Promise<void> {
  await storage.remove(KEYS.pin);
  await storage.remove(KEYS.pinFails);
}
