import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@cablenet/domain';
import type { AuthUser } from './request-context';

export const IS_PUBLIC = 'cablenet:isPublic';
export const PERMISSIONS_KEY = 'cablenet:permissions';
export const ANY_AUTHENTICATED = 'cablenet:anyAuthenticated';
export const ALLOW_PENDING_PASSWORD_CHANGE = 'cablenet:allowPendingPasswordChange';

/** No authentication required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Caller's role must hold ALL listed permissions. */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Any signed-in user may call this (the handler itself scopes data to the caller).
 * Authorization is deny-by-default: every non-public handler must carry either this
 * or @RequirePermissions.
 */
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED, true);

/** Reachable while the user still has to replace a temporary password. */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE, true);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
  if (!req.user) throw new Error('CurrentUser used on an unauthenticated route');
  return req.user;
});
