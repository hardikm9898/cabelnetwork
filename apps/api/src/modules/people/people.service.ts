import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  ChangeUserStatusRequest,
  CreateAdminUserRequest,
  CreateAgentRequest,
  UpdateAdminUserRequest,
  UpdateAgentRequest,
} from '@cablenet/contracts';
import { businessDateOf, cleanText, normalizeIndianMobile, Role } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { AuthService } from '../auth/auth.service';
import { hashPassword } from '../auth/passwords';

const STAFF_COLUMNS = [
  'u.id',
  'u.fullName',
  'u.mobile',
  'u.email',
  'u.role',
  'u.status',
  'u.mustChangePassword',
  'u.lastLoginAt',
  'u.createdAt',
] as const;

@Injectable()
export class PeopleService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  async listAgents(filter: { status?: string; q?: string }) {
    let q = this.db.selectFrom('users as u').innerJoin('agentProfiles as a', 'a.userId', 'u.id').where('u.role', '=', 'AGENT').where('u.deletedAt', 'is', null);
    if (filter.status) q = q.where('u.status', '=', filter.status as never);
    if (filter.q) {
      const term = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where((eb) => eb.or([eb('u.fullName', 'ilike', term), eb('a.agentCode', 'ilike', term), eb('u.mobile', 'like', term)]));
    }
    return q
      .select([...STAFF_COLUMNS, 'a.agentCode', 'a.employmentStatus', 'a.joiningDate', 'a.photoUrl'])
      .select((eb) => [
        eb
          .selectFrom('customerPrimaryAgent as p')
          .select((e) => e.fn.countAll<string>().as('n'))
          .whereRef('p.agentId', '=', 'u.id')
          .as('primaryCustomers'),
        eb
          .selectFrom('customerCurrentAgent as ca')
          .select((e) => e.fn.countAll<string>().as('n'))
          .whereRef('ca.agentId', '=', 'u.id')
          .as('currentCustomers'),
      ])
      .orderBy('a.agentCode')
      .execute()
      .then((rows) =>
        rows.map((r) => ({ ...r, primaryCustomers: Number(r.primaryCustomers ?? 0), currentCustomers: Number(r.currentCustomers ?? 0) })),
      );
  }

  async getAgent(id: string, db: Database = this.db) {
    const agent = await db
      .selectFrom('users as u')
      .innerJoin('agentProfiles as a', 'a.userId', 'u.id')
      .select([...STAFF_COLUMNS, 'a.agentCode', 'a.employmentStatus', 'a.joiningDate', 'a.photoUrl', 'a.notes'])
      .where('u.id', '=', id)
      .where('u.role', '=', 'AGENT')
      .executeTakeFirst();
    if (!agent) throw notFound('AGENT_NOT_FOUND', 'Agent not found');
    const [areas, counts] = await Promise.all([
      db
        .selectFrom('areaAgentAssignments as aa')
        .innerJoin('areas as ar', 'ar.id', 'aa.areaId')
        .select(['ar.id', 'ar.name', sql<Date>`lower(aa.valid_during)`.as('since')])
        .where('aa.agentId', '=', id)
        .where(sql<boolean>`aa.valid_during @> now()`)
        .execute(),
      this.assignmentCounts(db, id),
    ]);
    return { ...agent, areas, ...counts };
  }

  async createAgent(input: CreateAgentRequest, actor: AuthUser) {
    const mobile = this.staffMobile(input.mobile);
    const passwordHash = await hashPassword(input.temporaryPassword);
    return this.db.transaction().execute(async (trx) => {
      await this.assertMobileFree(trx, mobile);
      const codeTaken = await trx
        .selectFrom('agentProfiles')
        .select('userId')
        .where(sql<boolean>`upper(agent_code) = ${input.agentCode}`)
        .executeTakeFirst();
      if (codeTaken) throw conflict('AGENT_CODE_EXISTS', `Agent code ${input.agentCode} is already used`);

      const user = await trx
        .insertInto('users')
        .values({
          fullName: cleanText(input.fullName),
          mobile,
          email: input.email ?? null,
          passwordHash,
          role: 'AGENT',
          mustChangePassword: true,
          createdBy: actor.id,
          updatedBy: actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('agentProfiles')
        .values({
          userId: user.id,
          agentCode: input.agentCode,
          joiningDate: input.joiningDate ?? null,
          photoUrl: input.photoUrl ?? null,
          notes: input.notes ?? null,
        })
        .execute();
      const agent = await this.getAgent(user.id, trx);
      await this.audit.record(trx, { action: 'agent.create', entityType: 'user', entityId: user.id, after: agent });
      return agent;
    });
  }

  async updateAgent(id: string, input: UpdateAgentRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const before = await this.getAgent(id, trx);
      const userPatch: Record<string, unknown> = {};
      const profilePatch: Record<string, unknown> = {};
      if (input.fullName !== undefined) userPatch.fullName = cleanText(input.fullName);
      if (input.email !== undefined) userPatch.email = input.email;
      if (input.mobile !== undefined) {
        const mobile = this.staffMobile(input.mobile);
        if (mobile !== before.mobile) {
          await this.assertMobileFree(trx, mobile);
          userPatch.mobile = mobile;
        }
      }
      if (input.joiningDate !== undefined) profilePatch.joiningDate = input.joiningDate;
      if (input.photoUrl !== undefined) profilePatch.photoUrl = input.photoUrl;
      if (input.employmentStatus !== undefined) profilePatch.employmentStatus = input.employmentStatus;
      if (input.notes !== undefined) profilePatch.notes = input.notes;

      if (input.employmentStatus === 'LEFT') await this.assertNoAssignments(trx, id);
      if (Object.keys(userPatch).length) {
        await trx.updateTable('users').set({ ...userPatch, updatedBy: actor.id }).where('id', '=', id).execute();
      }
      if (Object.keys(profilePatch).length) {
        await trx.updateTable('agentProfiles').set(profilePatch).where('userId', '=', id).execute();
      }
      const after = await this.getAgent(id, trx);
      await this.audit.record(trx, {
        action: 'agent.update',
        entityType: 'user',
        entityId: id,
        before: pick(before, [...Object.keys(userPatch), ...Object.keys(profilePatch)]),
        after: pick(after, [...Object.keys(userPatch), ...Object.keys(profilePatch)]),
      });
      return after;
    });
  }

  // ---------------------------------------------------------------------------
  // Admin users
  // ---------------------------------------------------------------------------

  async listAdmins() {
    return this.db
      .selectFrom('users as u')
      .select([...STAFF_COLUMNS])
      .where('u.role', 'in', ['ADMIN', 'SUPER_ADMIN'])
      .where('u.deletedAt', 'is', null)
      .orderBy('u.fullName')
      .execute();
  }

  async createAdmin(input: CreateAdminUserRequest, actor: AuthUser) {
    const mobile = this.staffMobile(input.mobile);
    const passwordHash = await hashPassword(input.temporaryPassword);
    return this.db.transaction().execute(async (trx) => {
      await this.assertMobileFree(trx, mobile);
      const user = await trx
        .insertInto('users')
        .values({
          fullName: cleanText(input.fullName),
          mobile,
          email: input.email ?? null,
          passwordHash,
          role: input.role,
          mustChangePassword: true,
          createdBy: actor.id,
          updatedBy: actor.id,
        })
        .returning(['id', 'fullName', 'mobile', 'email', 'role', 'status', 'mustChangePassword', 'lastLoginAt', 'createdAt'])
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'user.create', entityType: 'user', entityId: user.id, after: user });
      return user;
    });
  }

  /** Name, mobile, email and role of an office account. */
  async updateAdmin(id: string, input: UpdateAdminUserRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom('users')
        .select(['id', 'fullName', 'mobile', 'email', 'role', 'status'])
        .where('id', '=', id)
        .where('role', 'in', ['ADMIN', 'SUPER_ADMIN'])
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw notFound('USER_NOT_FOUND', 'User not found');
      const patch: Record<string, unknown> = {};
      if (input.fullName !== undefined) patch.fullName = cleanText(input.fullName);
      if (input.email !== undefined) patch.email = input.email;
      if (input.mobile !== undefined) {
        const mobile = this.staffMobile(input.mobile);
        if (mobile !== before.mobile) {
          await this.assertMobileFree(trx, mobile);
          patch.mobile = mobile;
        }
      }
      if (input.role !== undefined && input.role !== before.role) {
        if (id === actor.id) throw forbidden('CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role');
        if (before.role === 'SUPER_ADMIN') await this.assertAnotherSuperAdmin(trx, id);
        patch.role = input.role;
      }
      const keys = Object.keys(patch).filter((k) => patch[k] !== (before as Record<string, unknown>)[k]);
      if (keys.length === 0) return before;
      await trx.updateTable('users').set({ ...patch, updatedBy: actor.id }).where('id', '=', id).execute();
      // A new role or mobile number takes effect at the next sign-in.
      if (patch.role !== undefined || patch.mobile !== undefined) await this.auth.revokeAllSessions(trx, id, 'account_changed_by_admin');
      await this.audit.record(trx, {
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        before: pick(before, keys),
        after: Object.fromEntries(keys.map((k) => [k, patch[k]])),
      });
      return { ...before, ...patch };
    });
  }

  // ---------------------------------------------------------------------------
  // Shared account operations
  // ---------------------------------------------------------------------------

  /**
   * Deletes an office or agent account: it can no longer sign in, disappears from the lists, and
   * its mobile number can be used again. Its history (payments it recorded, audit) stays.
   * An agent must first hand over its customers and areas.
   */
  async deleteUser(userId: string, reason: string, actor: AuthUser, allowedRoles: Role[]) {
    if (userId === actor.id) throw forbidden('CANNOT_DELETE_SELF', 'You cannot delete your own account');
    await this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select(['id', 'role', 'status', 'fullName', 'mobile'])
        .where('id', '=', userId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!user || !allowedRoles.includes(user.role)) throw notFound('USER_NOT_FOUND', 'User not found');
      if (user.role === 'AGENT') await this.assertNoAssignments(trx, userId);
      if (user.role === 'SUPER_ADMIN') await this.assertAnotherSuperAdmin(trx, userId);
      await trx
        .updateTable('users')
        .set({ status: 'DEACTIVATED', deletedAt: sql<Date>`now()`, deletedBy: actor.id, updatedBy: actor.id })
        .where('id', '=', userId)
        .execute();
      await this.auth.revokeAllSessions(trx, userId, 'account_deleted');
      await this.audit.record(trx, { action: 'user.delete', entityType: 'user', entityId: userId, before: { fullName: user.fullName, mobile: user.mobile, role: user.role, status: user.status }, reason });
    });
    return { ok: true };
  }

  /** Activate / suspend / deactivate a staff account. Non-active accounts are signed out everywhere. */
  async changeStatus(userId: string, input: ChangeUserStatusRequest, actor: AuthUser, allowedRoles: Role[]) {
    if (userId === actor.id) throw forbidden('CANNOT_CHANGE_OWN_STATUS', 'You cannot change your own account status');
    return this.db.transaction().execute(async (trx) => {
      const user = await trx.selectFrom('users').select(['id', 'role', 'status']).where('id', '=', userId).forUpdate().executeTakeFirst();
      if (!user || !allowedRoles.includes(user.role)) throw notFound('USER_NOT_FOUND', 'User not found');
      if (user.status === input.status) return { id: user.id, status: user.status };

      if (user.role === 'AGENT' && input.status === 'DEACTIVATED') await this.assertNoAssignments(trx, userId);
      await trx.updateTable('users').set({ status: input.status, updatedBy: actor.id }).where('id', '=', userId).execute();
      if (input.status !== 'ACTIVE') await this.auth.revokeAllSessions(trx, userId, `account_${input.status.toLowerCase()}`);
      await this.audit.record(trx, {
        action: 'user.status_changed',
        entityType: 'user',
        entityId: userId,
        before: { status: user.status },
        after: { status: input.status },
        reason: input.reason,
      });
      return { id: userId, status: input.status };
    });
  }

  async resetPassword(userId: string, temporaryPassword: string, reason: string, actor: AuthUser, allowedRoles: Role[]) {
    const passwordHash = await hashPassword(temporaryPassword);
    await this.db.transaction().execute(async (trx) => {
      const user = await trx.selectFrom('users').select(['id', 'role']).where('id', '=', userId).executeTakeFirst();
      if (!user || !allowedRoles.includes(user.role)) throw notFound('USER_NOT_FOUND', 'User not found');
      await trx
        .updateTable('users')
        .set({ passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, updatedBy: actor.id })
        .where('id', '=', userId)
        .execute();
      await this.auth.revokeAllSessions(trx, userId, 'password_reset_by_admin');
      await this.audit.record(trx, { action: 'user.password_reset', entityType: 'user', entityId: userId, reason });
    });
  }

  async devices(userId: string) {
    return this.db.selectFrom('devices').selectAll().where('userId', '=', userId).orderBy('lastSeenAt', 'desc').execute();
  }

  /** Block a (lost/stolen) device: it can no longer sign in and its sessions end now. */
  async revokeDevice(userId: string, deviceId: string, reason: string) {
    await this.db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable('devices')
        .set({ revokedAt: sql<Date>`now()` })
        .where('id', '=', deviceId)
        .where('userId', '=', userId)
        .where('revokedAt', 'is', null)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw notFound('DEVICE_NOT_FOUND', 'Active device not found');
      await trx
        .updateTable('sessions')
        .set({ revokedAt: sql<Date>`now()`, revokeReason: 'device_revoked' })
        .where('deviceId', '=', deviceId)
        .where('revokedAt', 'is', null)
        .execute();
      await this.audit.record(trx, { action: 'device.revoked', entityType: 'device', entityId: deviceId, reason });
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private staffMobile(raw: string): string {
    const m = normalizeIndianMobile(raw);
    if (!m?.valid) throw unprocessable('INVALID_MOBILE', 'Enter a valid 10-digit mobile number (used to sign in)');
    return m.normalized;
  }

  private async assertMobileFree(db: Database, mobile: string): Promise<void> {
    const taken = await db.selectFrom('users').select('id').where('mobile', '=', mobile).where('deletedAt', 'is', null).executeTakeFirst();
    if (taken) throw conflict('MOBILE_IN_USE', 'Another user already uses this mobile number');
  }

  private async assignmentCounts(db: Database, agentId: string) {
    const today = businessDateOf(new Date());
    const [primary, current, areas, temps] = await Promise.all([
      db.selectFrom('customerPrimaryAgent').select((e) => e.fn.countAll<string>().as('n')).where('agentId', '=', agentId).executeTakeFirstOrThrow(),
      db.selectFrom('customerCurrentAgent').select((e) => e.fn.countAll<string>().as('n')).where('agentId', '=', agentId).executeTakeFirstOrThrow(),
      db
        .selectFrom('areaAgentAssignments')
        .select((e) => e.fn.countAll<string>().as('n'))
        .where('agentId', '=', agentId)
        .where(sql<boolean>`valid_during @> now()`)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('tempReassignments')
        .select((e) => e.fn.countAll<string>().as('n'))
        .where((eb) => eb.or([eb('fromAgentId', '=', agentId), eb('toAgentId', '=', agentId)]))
        .where('revokedAt', 'is', null)
        .where('endsOn', '>=', today)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      primaryCustomers: Number(primary.n),
      currentCustomers: Number(current.n),
      areasOwned: Number(areas.n),
      openTemporaryReassignments: Number(temps.n),
    };
  }

  /** There must always be one active super admin left. */
  private async assertAnotherSuperAdmin(db: Database, userId: string): Promise<void> {
    const other = await db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'SUPER_ADMIN')
      .where('status', '=', 'ACTIVE')
      .where('deletedAt', 'is', null)
      .where('id', '<>', userId)
      .executeTakeFirst();
    if (!other) throw conflict('LAST_SUPER_ADMIN', 'This is the only super admin; make another user super admin first');
  }

  private async assertNoAssignments(db: Database, agentId: string): Promise<void> {
    const c = await this.assignmentCounts(db, agentId);
    if (c.primaryCustomers + c.currentCustomers + c.areasOwned + c.openTemporaryReassignments > 0) {
      throw conflict('AGENT_HAS_ASSIGNMENTS', 'Move this agent’s customers, areas and temporary reassignments first', c);
    }
  }
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}
