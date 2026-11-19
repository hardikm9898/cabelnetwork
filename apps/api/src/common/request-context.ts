import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '@cablenet/domain';

/** The authenticated principal, resolved by AuthGuard on every request. */
export interface AuthUser {
  id: string;
  role: Role;
  fullName: string;
  /** Session family id (one per login). */
  sessionId: string;
  deviceId: string | null;
  mustChangePassword: boolean;
}

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  user?: AuthUser;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  setUser(user: AuthUser): void {
    const ctx = storage.getStore();
    if (ctx) ctx.user = user;
  },
};
