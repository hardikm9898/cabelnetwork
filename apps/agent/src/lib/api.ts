import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { AuthTokens } from '@cablenet/contracts';
import { KEYS, storage } from './storage';

/**
 * API client for the agent app. Access token in memory; refresh token in secure storage.
 * Expired access tokens are refreshed once (single flight) and the request retried.
 *
 * API location: EXPO_PUBLIC_API_URL (build-time). Defaults: Android emulator → host machine
 * (10.0.2.2), web → same origin.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'android' ? 'http://10.0.2.2:3000' : '')).replace(/\/$/, '');

// Release builds talk to the server only over HTTPS (customer data and cash entries; review I-7).
// An internal-network build can opt in to plain http with EXPO_PUBLIC_ALLOW_HTTP=true.
if (!__DEV__ && process.env.NODE_ENV === 'production' && process.env.EXPO_PUBLIC_ALLOW_HTTP !== 'true' && /^http:\/\/(?!localhost|127\.0\.0\.1)/.test(API_URL)) {
  throw new Error(`Release build points at an insecure API address (${API_URL}); set EXPO_PUBLIC_API_URL to https://…`);
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionEnd: (() => void) | null = null;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const session = {
  async setTokens(t: Pick<AuthTokens, 'accessToken' | 'refreshToken'>) {
    accessToken = t.accessToken;
    await storage.set(KEYS.refresh, t.refreshToken);
  },
  async clear() {
    accessToken = null;
    await storage.remove(KEYS.refresh);
  },
  async hasRefresh() {
    return !!(await storage.get(KEYS.refresh));
  },
  onEnd(cb: () => void) {
    onSessionEnd = cb;
  },
};

/** Stable per-install device id (sent at sign-in so the office can block a lost phone). */
export async function deviceInfo() {
  let id = await storage.get(KEYS.deviceId);
  if (!id) {
    id = Crypto.randomUUID();
    await storage.set(KEYS.deviceId, id);
  }
  return {
    id,
    platform: Platform.OS,
    model: [Device.manufacturer, Device.modelName].filter(Boolean).join(' ') || undefined,
    appVersion: Constants.expoConfig?.version,
  };
}

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const token = await storage.get(KEYS.refresh);
      if (!token) return false;
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!res.ok) {
        if (res.status === 401) await session.clear();
        return false;
      }
      const body = (await res.json()) as { data: AuthTokens };
      await session.setTokens(body.data);
      return true;
    } catch {
      return false; // network error: keep the refresh token for later
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

type Query = Record<string, string | number | undefined | null>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  idempotencyKey?: string;
}

const qs = (q?: Query) => {
  if (!q) return '';
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

export async function api<T>(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(`${API_URL}/api/v1${path}${qs(opts.query)}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && !retried && !path.startsWith('/auth/login')) {
    if (await refreshSession()) return api<T>(method, path, opts, true);
    if (!(await session.hasRefresh())) onSessionEnd?.();
  }
  if (!res.ok) {
    let body: { error?: { code: string; message: string; details?: unknown } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, body.error?.code ?? 'HTTP_ERROR', body.error?.message ?? `Request failed (${res.status})`, body.error?.details);
  }
  if (res.status === 204) return undefined as T;
  return ((await res.json()) as { data: T }).data;
}

export async function login(mobile: string, password: string) {
  const device = await deviceInfo();
  const res = await api<AuthTokens & { user: Me }>('POST', '/auth/login', { body: { mobile, password, device } });
  await session.setTokens(res);
  return res.user;
}

export interface Me {
  id: string;
  fullName: string;
  mobile: string;
  role: 'AGENT' | 'ADMIN' | 'SUPER_ADMIN';
  mustChangePassword: boolean;
  agentCode: string | null;
}

export const newId = () => Crypto.randomUUID();
