import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { sql } from 'kysely';
import { hasPermission, Permission } from '@cablenet/domain';
import {
  ALLOW_PENDING_PASSWORD_CHANGE,
  ANY_AUTHENTICATED,
  IS_PUBLIC,
  PERMISSIONS_KEY,
} from '../../common/decorators';
import { AppError, forbidden, unauthorized } from '../../common/errors';
import { AuthUser, requestContext } from '../../common/request-context';
import { DATABASE, Database } from '../../db/database';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  typ: 'access';
}

/**
 * Authenticates every non-public request: verifies the JWT, then confirms in the database
 * that the user is still ACTIVE and the session has not been revoked (so logout, password
 * reset, deactivation and "log out lost phone" take effect immediately, not after expiry).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized('UNAUTHENTICATED', 'Sign in required');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(header.slice(7));
    } catch {
      throw unauthorized('TOKEN_INVALID', 'Session expired or invalid; please sign in again');
    }
    if (claims.typ !== 'access') throw unauthorized('TOKEN_INVALID', 'Invalid token type');

    const row = await this.db
      .selectFrom('users as u')
      .innerJoin('sessions as s', 's.userId', 'u.id')
      .select(['u.id', 'u.role', 'u.fullName', 'u.status', 'u.mustChangePassword', 's.deviceId'])
      .where('u.id', '=', claims.sub)
      .where('s.familyId', '=', claims.sid)
      .where('s.revokedAt', 'is', null)
      .where('s.rotatedAt', 'is', null)
      .where('s.expiresAt', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) throw unauthorized('SESSION_REVOKED', 'Session ended; please sign in again');
    if (row.status !== 'ACTIVE') throw unauthorized('ACCOUNT_DISABLED', 'This account is not active');

    const user: AuthUser = {
      id: row.id,
      role: row.role,
      fullName: row.fullName,
      sessionId: claims.sid,
      deviceId: row.deviceId,
      mustChangePassword: row.mustChangePassword,
    };
    req.user = user;
    requestContext.setUser(user);

    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE, targets)) {
      throw forbidden('PASSWORD_CHANGE_REQUIRED', 'Change your temporary password to continue');
    }
    return true;
  }
}

/** Deny-by-default role/permission check (runs after AuthGuard). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const user = ctx.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) throw unauthorized('UNAUTHENTICATED', 'Sign in required');

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets);
    if (required && required.length > 0) {
      if (required.every((p) => hasPermission(user.role, p))) return true;
      throw forbidden('FORBIDDEN', 'You do not have permission to perform this action');
    }
    if (this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED, targets)) return true;
    // A route without an explicit authorization rule is a programming error: fail closed.
    throw new AppError(403, 'FORBIDDEN', 'Route has no authorization rule');
  }
}
