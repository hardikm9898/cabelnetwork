import { randomUUID } from 'node:crypto';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { ANY_AUTHENTICATED, IS_PUBLIC, PERMISSIONS_KEY } from '../src/common/decorators';
import { createAgent, createHarness, Harness, login, nextMobile, PASSWORD } from './support/harness';

describe('authentication & sessions', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ REFRESH_REUSE_GRACE_SECONDS: '0', LOGIN_MAX_FAILURES: '3' });
  });
  afterAll(() => h.close());

  it('rejects wrong password and unknown mobile with the same error', async () => {
    const a = await h.http().post('/api/v1/auth/login').send({ mobile: '9000000001', password: 'wrong-pass1' });
    const b = await h.http().post('/api/v1/auth/login').send({ mobile: '9999999999', password: 'wrong-pass1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(b.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after repeated failures, even for the correct password', async () => {
    const agent = await createAgent(h, 'LOCK1');
    for (let i = 0; i < 3; i++) {
      await h.http().post('/api/v1/auth/login').send({ mobile: agent.mobile, password: 'bad-pass99' }).expect(401);
    }
    const res = await h.http().post('/api/v1/auth/login').send({ mobile: agent.mobile, password: PASSWORD });
    expect(res.status).toBe(401);
    // Same answer as a wrong password: the lock is not revealed.
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await h.db.selectFrom('users').select('lockedUntil').where('id', '=', agent.id).executeTakeFirstOrThrow()).lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    const audit = await h.db.selectFrom('auditLogs').select('action').where('entityId', '=', agent.id).execute();
    expect(audit.map((a) => a.action)).toContain('auth.account_locked');
  });

  it('forces a temporary password to be changed before anything else', async () => {
    const mobile = nextMobile();
    await h
      .as(h.superAdminToken)
      .post('/api/v1/agents', { fullName: 'New Agent', mobile, agentCode: 'NEW1', temporaryPassword: 'Temp1234' })
      .expect(201);
    const token = await login(h.http, mobile, 'Temp1234');

    const blocked = await h.as(token).get('/api/v1/customers');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await h.as(token).get('/api/v1/auth/me').expect(200);

    await h.as(token).post('/api/v1/auth/change-password', { currentPassword: 'Temp1234', newPassword: 'short' }).expect(400);
    await h.as(token).post('/api/v1/auth/change-password', { currentPassword: 'Temp1234', newPassword: PASSWORD }).expect(204);
    await h.as(token).get('/api/v1/customers').expect(200);
  });

  it('rotates refresh tokens and revokes the whole session when an old token is replayed', async () => {
    const login1 = await h.http().post('/api/v1/auth/login').send({ mobile: '9000000001', password: PASSWORD }).expect(200);
    const { refreshToken: r1, accessToken: a1 } = login1.body.data;

    const rot = await h.http().post('/api/v1/auth/refresh').send({ refreshToken: r1 }).expect(200);
    const { refreshToken: r2, accessToken: a2 } = rot.body.data;
    expect(r2).not.toBe(r1);
    await h.as(a2).get('/api/v1/auth/me').expect(200);
    await h.as(a1).get('/api/v1/auth/me').expect(200); // same session family, still valid

    // Replay of the rotated token (grace = 0s in this suite) ⇒ theft ⇒ family revoked.
    const replay = await h.http().post('/api/v1/auth/refresh').send({ refreshToken: r1 });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    expect((await h.as(a2).get('/api/v1/auth/me')).body.error.code).toBe('SESSION_REVOKED');
    await h.http().post('/api/v1/auth/refresh').send({ refreshToken: r2 }).expect(401);
  });

  it('logout ends the session immediately (access token no longer accepted)', async () => {
    const token = await login(h.http, '9000000001', PASSWORD);
    await h.as(token).post('/api/v1/auth/logout').expect(204);
    const res = await h.as(token).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
  });

  it('suspending an agent signs them out everywhere at once', async () => {
    const agent = await createAgent(h, 'SUSP1');
    await h.as(agent.token).get('/api/v1/auth/me').expect(200);
    await h
      .as(h.superAdminToken)
      .post(`/api/v1/agents/${agent.id}/status`, { status: 'SUSPENDED', reason: 'On leave' })
      .expect(200);
    expect((await h.as(agent.token).get('/api/v1/auth/me')).status).toBe(401);
    const relog = await h.http().post('/api/v1/auth/login').send({ mobile: agent.mobile, password: PASSWORD });
    expect(relog.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('a revoked (lost) device can no longer sign in', async () => {
    const agent = await createAgent(h, 'DEV1');
    const deviceId = randomUUID();
    const token = await login(h.http, agent.mobile, PASSWORD, { id: deviceId });
    await h
      .as(h.superAdminToken)
      .post(`/api/v1/agents/${agent.id}/devices/${deviceId}/revoke`, { reason: 'Phone lost' })
      .expect(204);
    expect((await h.as(token).get('/api/v1/auth/me')).status).toBe(401);
    const res = await h.http().post('/api/v1/auth/login').send({ mobile: agent.mobile, password: PASSWORD, device: { id: deviceId } });
    expect(res.body.error.code).toBe('DEVICE_REVOKED');
  });

  it('rejects tampered and unsigned tokens', async () => {
    const token = await login(h.http, '9000000001', PASSWORD);
    const [head, body] = token.split('.');
    expect((await h.as(`${head}.${body}.invalidsig`).get('/api/v1/auth/me')).status).toBe(401);
    expect((await h.http().get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('authorization rules', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('every route declares an explicit authorization rule (deny-by-default)', () => {
    const reflector = new Reflector();
    const controllers = AppModule.forRoot(h.cfg).controllers ?? [];
    const missing: string[] = [];
    let routes = 0;
    for (const ctrl of controllers) {
      const proto = (ctrl as { prototype: Record<string, unknown> }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
        if (method === undefined) continue; // not a route handler
        routes++;
        const targets = [handler, ctrl] as never;
        const ok =
          reflector.getAllAndOverride(IS_PUBLIC, targets) ||
          reflector.getAllAndOverride(ANY_AUTHENTICATED, targets) ||
          (reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets)?.length ?? 0) > 0;
        if (!ok) missing.push(`${(ctrl as { name: string }).name}.${name} (${RequestMethod[method]})`);
      }
    }
    expect(routes).toBeGreaterThan(30);
    expect(missing).toEqual([]);
  });

  it('admins cannot manage admin users or settings; super admins can', async () => {
    const mobile = nextMobile();
    await h
      .as(h.superAdminToken)
      .post('/api/v1/users', { fullName: 'Office Admin', mobile, role: 'ADMIN', temporaryPassword: 'Temp1234' })
      .expect(201);
    const temp = await login(h.http, mobile, 'Temp1234');
    await h.as(temp).post('/api/v1/auth/change-password', { currentPassword: 'Temp1234', newPassword: PASSWORD }).expect(204);
    const admin = await login(h.http, mobile, PASSWORD);

    expect((await h.as(admin).get('/api/v1/users')).status).toBe(403);
    expect((await h.as(admin).put('/api/v1/settings/field.gpsCheckIn', { enabled: true })).status).toBe(403);
    await h.as(admin).get('/api/v1/settings').expect(200);
    await h.as(h.superAdminToken).put('/api/v1/settings/field.gpsCheckIn', { enabled: true }).expect(200);
    const invalid = await h.as(h.superAdminToken).put('/api/v1/settings/field.gpsCheckIn', { enabled: 'yes' });
    expect(invalid.status).toBe(400);
  });

  it('nobody can change their own account status (no self-lockout of the last admin)', async () => {
    const me = await h.as(h.superAdminToken).get('/api/v1/auth/me').expect(200);
    const self = await h
      .as(h.superAdminToken)
      .post(`/api/v1/users/${me.body.data.id}/status`, { status: 'SUSPENDED', reason: 'Testing self' });
    expect(self.body.error.code).toBe('CANNOT_CHANGE_OWN_STATUS');
  });

  it('agents cannot reach admin endpoints', async () => {
    const agent = await createAgent(h, 'AUTHZ1');
    const c = h.as(agent.token);
    expect((await c.get('/api/v1/agents')).status).toBe(403);
    expect((await c.post('/api/v1/customers', {})).status).toBe(403);
    expect((await c.post('/api/v1/assignments/permanent', { agentId: agent.id, customerIds: [randomUUID()], reason: 'self assign' })).status).toBe(403);
    expect((await c.post('/api/v1/assignments/temporary', {})).status).toBe(403);
    expect((await c.get('/api/v1/audit-logs')).status).toBe(403);
    expect((await c.put('/api/v1/settings/field.gpsCheckIn', { enabled: true })).status).toBe(403);
  });

  it('the audit log is append-only at the database level', async () => {
    await expect(sql`UPDATE audit_logs SET action = 'tampered'`.execute(h.db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_logs`.execute(h.db)).rejects.toThrow(/append-only/);
  });

  it('returns the standard error envelope with a request id', async () => {
    const res = await h.as(h.superAdminToken).post('/api/v1/areas', { name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });
});
