import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Small key-value store for secrets (refresh token, PIN hash, device id).
 * Native: expo-secure-store (Android Keystore / iOS Keychain).
 * Web (used only for automated tests and demos): localStorage — not secure, never for production.
 */
const web = Platform.OS === 'web';

export const storage = {
  async get(key: string): Promise<string | null> {
    if (web) return globalThis.localStorage?.getItem(key) ?? null;
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (web) {
      globalThis.localStorage?.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (web) {
      globalThis.localStorage?.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export const KEYS = {
  refresh: 'cablenet.refresh',
  deviceId: 'cablenet.deviceId',
  pin: 'cablenet.pin',
  pinFails: 'cablenet.pinFails',
  lang: 'cablenet.lang',
  /** Signed-in user (so the app can open offline after the PIN). */
  me: 'cablenet.me',
} as const;
