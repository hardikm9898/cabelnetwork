import type { AuthTokens, PageMeta } from '@cablenet/contracts';

/**
 * API client. Access token lives in memory; the refresh token in localStorage so a reload
 * keeps the session (rotated on every refresh; a replayed token ends the session server-side).
 * On an expired access token the client refreshes once (single flight) and retries.
 */
const REFRESH_KEY = 'cablenet.refresh';
let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }

  /** Field → message map for validation errors. */
  fieldErrors(): Record<string, string> {
    if (this.code !== 'VALIDATION_FAILED' || !Array.isArray(this.details)) return {};
    return Object.fromEntries((this.details as { path: string; message: string }[]).map((d) => [d.path, d.message]));
  }
}

export const session = {
  setTokens(t: Pick<AuthTokens, 'accessToken' | 'refreshToken'>) {
    accessToken = t.accessToken;
    localStorage.setItem(REFRESH_KEY, t.refreshToken);
  },
  clear() {
    accessToken = null;
    localStorage.removeItem(REFRESH_KEY);
    listeners.forEach((l) => l());
  },
  hasRefresh: () => !!localStorage.getItem(REFRESH_KEY),
  /** Called when the session ends (refresh failed / revoked). */
  onEnd(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

async function refresh(): Promise<boolean> {
  const token = localStorage.getItem(REFRESH_KEY);
  if (!token) return false;
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { data: AuthTokens };
      session.setTokens(body.data);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshInFlight = null), 0);
    }
  })();
  return refreshInFlight;
}

export async function ensureSession(): Promise<boolean> {
  return accessToken ? true : refresh();
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Sends Idempotency-Key (financial commands). Reuse the same key when retrying the same action. */
  idempotencyKey?: string;
  /** Multipart upload (the browser sets the content type with its boundary). */
  form?: FormData;
}

const qs = (q?: Query) => {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function raw(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined && !opts.form) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(`/api/v1${path}${qs(opts.query)}`, {
    method,
    headers,
    body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  if (res.status === 401 && !retried && !path.startsWith('/auth/login')) {
    if (await refresh()) return raw(method, path, opts, true);
    session.clear();
  }
  return res;
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code: string; message: string; details?: unknown; requestId?: string } };
    if (body.error) return new ApiError(res.status, body.error.code, body.error.message, body.error.details, body.error.requestId);
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, 'HTTP_ERROR', `Request failed (${res.status})`);
}

export async function api<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
  const res = await raw(method, path, opts);
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return ((await res.json()) as { data: T }).data;
}

export async function apiPage<T>(path: string, query?: Query): Promise<{ items: T[]; meta: PageMeta }> {
  const res = await raw('GET', path, { query });
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as { data: T[]; meta: PageMeta };
  return { items: body.data, meta: body.meta };
}

/** Downloads a file endpoint (xlsx/pdf) with auth and saves or opens it. */
export async function download(path: string, query?: Query, mode: 'save' | 'open' = 'save'): Promise<void> {
  const res = await raw('GET', path, { query });
  if (!res.ok) throw await parseError(res);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  const url = URL.createObjectURL(blob);
  if (mode === 'open') {
    window.open(url, '_blank', 'noopener');
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const newKey = () => crypto.randomUUID();
