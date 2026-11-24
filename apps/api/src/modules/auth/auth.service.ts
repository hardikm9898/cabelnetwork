import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AuthTokens, ChangePasswordRequest, LoginRequest } from '@cablenet/contracts';
import { normalizeIndianMobile } from '@cablenet/domain';
import { APP_CONFIG, AppConfig } from '../../config/env';
import { DATABASE, Database } from '../../db/database';
import { AppError, unprocessable, badRequest, notFound, unauthorized } from '../../common/errors';
import { AuthUser, requestContext } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords';
import type { AccessTokenClaims } from './auth.guard';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');

export interface PublicUser {
  id: string;
  fullName: string;
  mobile: string;
  email: string | null;
  role: string;
  mustChangePassword: boolean;
  agentCode: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginRequest): Promise<AuthTokens & { user: PublicUser }> {
    const mobile = normalizeIndianMobile(input.mobile)?.normalized ?? input.mobile;
    const user = await this.db.selectFrom('users').selectAll().where('mobile', '=', mobile).where('deletedAt', 'is', null).executeTakeFirst();

    if (!user) {
      await verifyAgainstDummy(input.password);
      throw unauthorized('INVALID_CREDENTIALS', 'Mobile number or password is incorrect');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      // Same answer and timing as a wrong password: does not reveal that the number has an account
      // or that it is locked (ASVS 2.2 / 3.x; security review L-2).
      await verifyAgainstDummy(input.password);
      throw unauthorized('INVALID_CREDENTIALS', 'Mobile number or password is incorrect');
    }

    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) {
      await this.recordFailure(user.id);
      throw unauthorized('INVALID_CREDENTIALS', 'Mobile number or password is incorrect');
    }
    if (user.status !== 'ACTIVE') throw unauthorized('ACCOUNT_DISABLED', 'This account is not active');
    return this.startSession(user.id, input);
  }

  /** Counts a wrong password; the account locks for LOGIN_LOCK_MINUTES after LOGIN_MAX_FAILURES. */
  private async recordFailure(userId: string) {
    {
      await this.db.transaction().execute(async (trx) => {
        // Atomic increment: concurrent wrong guesses cannot under-count.
        const max = this.cfg.LOGIN_MAX_FAILURES;
        const { locked: lock } = await trx
          .updateTable('users')
          .set({
            failedLoginCount: sql<number>`CASE WHEN failed_login_count + 1 >= ${max} THEN 0 ELSE failed_login_count + 1 END`,
            lockedUntil: sql<Date>`CASE WHEN failed_login_count + 1 >= ${max}
              THEN now() + make_interval(mins => ${this.cfg.LOGIN_LOCK_MINUTES}) ELSE locked_until END`,
          })
          .where('id', '=', userId)
          .returning(sql<boolean>`coalesce(locked_until > now(), false)`.as('locked'))
          .executeTakeFirstOrThrow();
        await this.audit.record(trx, {
          action: lock ? 'auth.account_locked' : 'auth.login_failed',
          entityType: 'user',
          entityId: userId,
          actorUserId: null,
        });
      });
    }
  }

  private async startSession(userId: string, input: LoginRequest): Promise<AuthTokens & { user: PublicUser }> {
    const user = await this.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
    return this.db.transaction().execute(async (trx) => {
      if (input.device) {
        const existing = await trx.selectFrom('devices').selectAll().where('id', '=', input.device.id).executeTakeFirst();
        if (existing?.revokedAt) throw unauthorized('DEVICE_REVOKED', 'This device has been blocked by the administrator');
        await trx
          .insertInto('devices')
          .values({
            id: input.device.id,
            userId: user.id,
            platform: input.device.platform ?? null,
            model: input.device.model ?? null,
            appVersion: input.device.appVersion ?? null,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              userId: user.id,
              platform: input.device!.platform ?? null,
              model: input.device!.model ?? null,
              appVersion: input.device!.appVersion ?? null,
              lastSeenAt: sql<Date>`now()`,
            }),
          )
          .execute();
      }
      await trx
        .updateTable('users')
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: sql<Date>`now()` })
        .where('id', '=', user.id)
        .execute();

      const familyId = randomUUID();
      const tokens = await this.issueTokens(trx, user.id, familyId, input.device?.id ?? null);
      requestContext.setUser({
        id: user.id,
        role: user.role,
        fullName: user.fullName,
        sessionId: familyId,
        deviceId: input.device?.id ?? null,
        mustChangePassword: user.mustChangePassword,
      });
      await this.audit.record(trx, { action: 'auth.login', entityType: 'user', entityId: user.id });
      return { ...tokens, user: await this.publicUser(user.id, trx) };
    });
  }

  /**
   * Rotates a refresh token. Presenting an already-rotated token outside the grace window is
   * treated as theft: the whole session family is revoked.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const hash = sha256(refreshToken);
    const outcome = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('sessions')
        .selectAll()
        .where('refreshTokenHash', '=', hash)
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.revokedAt) return { ok: false as const, error: 'SESSION_REVOKED' as const };
      if (row.expiresAt <= new Date()) return { ok: false as const, error: 'SESSION_EXPIRED' as const };

      if (row.rotatedAt) {
        const ageMs = Date.now() - row.rotatedAt.getTime();
        if (ageMs > this.cfg.REFRESH_REUSE_GRACE_SECONDS * 1000) {
          await this.revokeFamily(trx, row.familyId, 'refresh_token_reuse');
          await this.audit.record(trx, {
            action: 'auth.refresh_token_reuse',
            entityType: 'session',
            entityId: row.familyId,
            actorUserId: row.userId,
          });
          return { ok: false as const, error: 'REFRESH_TOKEN_REUSED' as const };
        }
        // Lost response on a flaky network: replace the successor issued from this token.
        await trx
          .updateTable('sessions')
          .set({ revokedAt: sql<Date>`now()`, revokeReason: 'superseded_by_retry' })
          .where('familyId', '=', row.familyId)
          .where('createdAt', '>=', row.rotatedAt)
          .where('revokedAt', 'is', null)
          .where('id', '!=', row.id)
          .execute();
      }

      const user = await trx.selectFrom('users').select(['status', 'role']).where('id', '=', row.userId).executeTakeFirstOrThrow();
      if (user.status !== 'ACTIVE') return { ok: false as const, error: 'ACCOUNT_DISABLED' as const };
      // Office sessions end after a fixed time however actively they are used (ASVS 3.3.2; review M-5).
      // Agents keep the longer, device-bound, PIN-protected session.
      if (user.role !== 'AGENT') {
        const started = await trx.selectFrom('sessions').select((eb) => eb.fn.min<Date>('createdAt').as('at')).where('familyId', '=', row.familyId).executeTakeFirstOrThrow();
        if (Date.now() - new Date(started.at).getTime() > this.cfg.ADMIN_SESSION_MAX_HOURS * 3_600_000) {
          await this.revokeFamily(trx, row.familyId, 'absolute_timeout');
          return { ok: false as const, error: 'SESSION_EXPIRED' as const };
        }
      }

      await trx.updateTable('sessions').set({ rotatedAt: sql<Date>`now()` }).where('id', '=', row.id).execute();
      return { ok: true as const, tokens: await this.issueTokens(trx, row.userId, row.familyId, row.deviceId) };
    });
    if (!outcome.ok) throw unauthorized(outcome.error, 'Session ended; please sign in again');
    return outcome.tokens;
  }

  async logout(user: AuthUser): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.revokeFamily(trx, user.sessionId, 'logout');
      await this.audit.record(trx, { action: 'auth.logout', entityType: 'session', entityId: user.sessionId });
    });
  }

  async changePassword(user: AuthUser, input: ChangePasswordRequest): Promise<void> {
    const row = await this.db.selectFrom('users').select(['passwordHash', 'role', 'mobile']).where('id', '=', user.id).executeTakeFirstOrThrow();
    // 6+ characters for everyone (owner's decision, 2026-11-24); guessing is limited by the
    // lockout after 5 wrong tries and the sign-in rate limit. The own mobile number is refused,
    // also a 6-digit piece of it.
    const lower = input.newPassword.toLowerCase();
    const digits = lower.replace(/\D/g, '');
    if (lower.includes(row.mobile) || (digits.length >= 6 && digits === lower && row.mobile.includes(digits))) {
      throw unprocessable('PASSWORD_TOO_COMMON', 'Do not use your own mobile number as the password');
    }
    if (!(await verifyPassword(row.passwordHash, input.currentPassword))) {
      // Counts toward the lockout like a failed sign-in (review L-3).
      await this.recordFailure(user.id);
      throw badRequest('INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
    }
    if (input.currentPassword === input.newPassword) {
      throw badRequest('PASSWORD_UNCHANGED', 'New password must differ from the current password');
    }
    const passwordHash = await hashPassword(input.newPassword);
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({ passwordHash, mustChangePassword: false, passwordChangedAt: sql<Date>`now()`, updatedBy: user.id })
        .where('id', '=', user.id)
        .execute();
      // Sign out every other session; keep the one that changed the password.
      await trx
        .updateTable('sessions')
        .set({ revokedAt: sql<Date>`now()`, revokeReason: 'password_changed' })
        .where('userId', '=', user.id)
        .where('familyId', '!=', user.sessionId)
        .where('revokedAt', 'is', null)
        .execute();
      await this.audit.record(trx, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
    });
  }

  async listSessions(userId: string, currentSessionId?: string) {
    const rows = await this.db
      .selectFrom('sessions as s')
      .leftJoin('devices as d', 'd.id', 's.deviceId')
      .select([
        's.familyId',
        's.createdAt as lastRefreshedAt',
        's.expiresAt',
        's.ip',
        's.userAgent',
        'd.id as deviceId',
        'd.platform',
        'd.model',
        'd.appVersion',
      ])
      .select((eb) =>
        eb
          .selectFrom('sessions as f')
          .whereRef('f.familyId', '=', 's.familyId')
          .select((e) => e.fn.min('f.createdAt').as('m'))
          .as('signedInAt'),
      )
      .where('s.userId', '=', userId)
      .where('s.revokedAt', 'is', null)
      .where('s.rotatedAt', 'is', null)
      .where('s.expiresAt', '>', sql<Date>`now()`)
      .orderBy('s.createdAt', 'desc')
      .execute();
    return rows.map((r) => ({ ...r, current: r.familyId === currentSessionId }));
  }

  /** Revoke one session family belonging to `userId`. */
  async revokeSession(userId: string, familyId: string, reason: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const n = await this.revokeFamily(trx, familyId, reason, userId);
      if (n === 0) throw notFound('SESSION_NOT_FOUND', 'Session not found');
      await this.audit.record(trx, { action: 'auth.session_revoked', entityType: 'session', entityId: familyId, reason });
    });
  }

  async revokeAllSessions(db: Database, userId: string, reason: string): Promise<void> {
    await db
      .updateTable('sessions')
      .set({ revokedAt: sql<Date>`now()`, revokeReason: reason })
      .where('userId', '=', userId)
      .where('revokedAt', 'is', null)
      .execute();
  }

  async publicUser(userId: string, db: Database = this.db): Promise<PublicUser> {
    const u = await db
      .selectFrom('users as u')
      .leftJoin('agentProfiles as a', 'a.userId', 'u.id')
      .select(['u.id', 'u.fullName', 'u.mobile', 'u.email', 'u.role', 'u.mustChangePassword', 'a.agentCode'])
      .where('u.id', '=', userId)
      .executeTakeFirstOrThrow();
    return u;
  }

  private async revokeFamily(db: Database, familyId: string, reason: string, userId?: string): Promise<number> {
    let q = db
      .updateTable('sessions')
      .set({ revokedAt: sql<Date>`now()`, revokeReason: reason })
      .where('familyId', '=', familyId)
      .where('revokedAt', 'is', null);
    if (userId) q = q.where('userId', '=', userId);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows);
  }

  private async issueTokens(db: Database, userId: string, familyId: string, deviceId: string | null): Promise<AuthTokens> {
    const ctx = requestContext.get();
    const refreshToken = newRefreshToken();
    const refreshExpires = new Date(Date.now() + this.cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await db
      .insertInto('sessions')
      .values({
        userId,
        familyId,
        deviceId,
        refreshTokenHash: sha256(refreshToken),
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent?.slice(0, 500) ?? null,
        expiresAt: refreshExpires,
      })
      .execute();
    const claims: AccessTokenClaims = { sub: userId, sid: familyId, typ: 'access' };
    const accessToken = await this.jwt.signAsync(claims);
    return {
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + this.cfg.ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpires.toISOString(),
    };
  }
}
