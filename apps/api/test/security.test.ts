import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env';
import { zipUncompressedSize } from '../src/modules/imports/workbook';
import { createAgent, createHarness, Harness, login, nextMobile, PASSWORD } from './support/harness';
import { customerWithSubscription, idem, invoicesOf, pay, runBilling, setupSociety } from './support/finance';

/** Fixes from the Phase 8 security review (docs/SECURITY_REVIEW.md). */
describe('security hardening', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof createAgent>>;
  let admin: string;
  let adminMobile: string;
  let society: string;

  beforeAll(async () => {
    h = await createHarness();
    agent = await createAgent(h, 'SEC1');
    society = await setupSociety(h, 'Security Society', agent.id);
    adminMobile = nextMobile();
    await h.as(h.superAdminToken).post('/api/v1/users', { fullName: 'Office Admin', mobile: adminMobile, role: 'ADMIN', temporaryPassword: 'Temp1234' }).expect(201);
    const temp = await login(h.http, adminMobile, 'Temp1234');
    await h.as(temp).post('/api/v1/auth/change-password', { currentPassword: 'Temp1234', newPassword: PASSWORD }).expect(204);
    admin = await login(h.http, adminMobile, PASSWORD);
  });
  afterAll(() => h.close());

  describe('configuration (M-1, M-2, L-7, I-1)', () => {
    const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', PUBLIC_BASE_URL: 'https://cable.example.in' };
    const strong = 'a8f3c91e0b7d4e2f6a9c1b3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f';
    it('refuses placeholder secrets, a shared receipt-link secret and a non-https public address', () => {
      expect(() => loadConfig({ ...prod, JWT_ACCESS_SECRET: 'change-me-to-a-long-random-secret-at-least-32-chars', RECEIPT_LINK_SECRET: strong })).toThrow(/placeholder/);
      expect(() => loadConfig({ ...prod, JWT_ACCESS_SECRET: strong })).toThrow(/RECEIPT_LINK_SECRET/);
      expect(() => loadConfig({ ...prod, JWT_ACCESS_SECRET: strong, RECEIPT_LINK_SECRET: strong })).toThrow(/differ/);
      expect(() => loadConfig({ ...prod, PUBLIC_BASE_URL: 'http://cable.example.in', JWT_ACCESS_SECRET: strong, RECEIPT_LINK_SECRET: strong.split('').reverse().join('') })).toThrow(/https/);
      expect(loadConfig({ ...prod, JWT_ACCESS_SECRET: strong, RECEIPT_LINK_SECRET: strong.split('').reverse().join(''), TRUST_PROXY: '1' })).toMatchObject({ TRUST_PROXY: 1, SWAGGER_ENABLED: false });
    });
    it('plain HTTP on an internal address needs the explicit opt-in', () => {
      const secrets = { JWT_ACCESS_SECRET: strong, RECEIPT_LINK_SECRET: strong.split('').reverse().join('') };
      const internal = { ...prod, ...secrets, PUBLIC_BASE_URL: 'http://10.50.0.201:6600' };
      expect(() => loadConfig(internal)).toThrow(/ALLOW_INSECURE_HTTP/);
      expect(loadConfig({ ...internal, ALLOW_INSECURE_HTTP: 'true' })).toMatchObject({ ALLOW_INSECURE_HTTP: true, PUBLIC_BASE_URL: 'http://10.50.0.201:6600' });
    });

    it('does not trust every proxy hop, and NODE_ENV must be stated', () => {
      expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'x', JWT_ACCESS_SECRET: strong, TRUST_PROXY: 'true' })).toThrow(/proxy hops/);
      expect(() => loadConfig({ DATABASE_URL: 'x', JWT_ACCESS_SECRET: strong })).toThrow(/NODE_ENV/);
    });
  });

  describe('sessions and passwords (M-5, L-1, L-3)', () => {
    it('office sessions end after the absolute limit; agent sessions continue', async () => {
      const res = await h.http().post('/api/v1/auth/login').send({ mobile: adminMobile, password: PASSWORD }).expect(200);
      const ag = await h.http().post('/api/v1/auth/login').send({ mobile: agent.mobile, password: PASSWORD }).expect(200);
      for (const r of [res, ag]) {
        await h.db.updateTable('sessions').set({ createdAt: new Date(Date.now() - 13 * 3_600_000) }).where('userId', '=', r.body.data.user.id).execute();
      }
      const officeRefresh = await h.http().post('/api/v1/auth/refresh').send({ refreshToken: res.body.data.refreshToken });
      expect(officeRefresh.body.error.code).toBe('SESSION_EXPIRED');
      await h.http().post('/api/v1/auth/refresh').send({ refreshToken: ag.body.data.refreshToken }).expect(200);
    });

    it('office passwords need 12 characters; common passwords and the own mobile are refused', async () => {
      const t = await login(h.http, adminMobile, PASSWORD);
      expect((await h.as(t).post('/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Short123abc' })).body.error.code).toBe('PASSWORD_TOO_SHORT');
      expect((await h.as(t).post('/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'MyPassword2026' })).body.error.code).toBe('PASSWORD_TOO_COMMON');
      expect((await h.as(t).post('/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: `x${adminMobile}1` })).body.error.code).toBe('PASSWORD_TOO_COMMON');
    });

    it('wrong current passwords on change-password count toward the lockout', async () => {
      const a = await createAgent(h, 'SEC2');
      for (let i = 0; i < 5; i++) await h.as(a.token).post('/api/v1/auth/change-password', { currentPassword: 'wrongwrong1', newPassword: 'Another2026x' }).expect(400);
      const locked = await h.db.selectFrom('users').select('lockedUntil').where('id', '=', a.id).executeTakeFirstOrThrow();
      expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('money controls (M-4, M-6, L-8)', () => {
    it('office admins cannot split or cancel their way past the approval limit', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '700' });
      await runBilling(h);
      await h.as(admin).post(`/api/v1/customers/${customer.id}/credits`, { kind: 'CREDIT_ADJUSTMENT', amount: '600', reason: 'Goodwill one' }, idem()).expect(201);
      const second = await h.as(admin).post(`/api/v1/customers/${customer.id}/credits`, { kind: 'CREDIT_ADJUSTMENT', amount: '600', reason: 'Goodwill two' }, idem());
      expect(second.body.error.code).toBe('APPROVAL_REQUIRED');
      const inv = await invoicesOf(h, customer.id);
      const cancel = await h.as(admin).post(`/api/v1/invoices/${inv[0]!.id}/cancel`, { reason: 'Waive a month' }, idem());
      expect(cancel.body.error.code).toBe('APPROVAL_REQUIRED');
      // The super admin is not limited.
      await h.as(h.superAdminToken).post(`/api/v1/invoices/${inv[0]!.id}/cancel`, { reason: 'Approved waiver' }, idem()).expect(200);
    });

    it('an agent cannot date an online payment outside the back-date window', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '300' });
      await runBilling(h);
      const res = await pay(h, agent.token, customer.id, '300', { receivedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
      expect(res.body.error.code).toBe('RECEIVED_AT_OUT_OF_RANGE');
    });

    it('oversized sync entries are refused without being stored as sent', async () => {
      const op = { opId: randomUUID(), type: 'PAYMENT_CREATE', seq: 1, createdAt: new Date().toISOString(), offline: true, payload: { customerId: randomUUID(), junk: 'x'.repeat(10_000) } };
      const res = await h.as(agent.token).post('/api/v1/sync/push', { deviceTime: new Date().toISOString(), ops: [op] }).expect(200);
      expect(res.body.data.results[0]).toMatchObject({ status: 'REJECTED', error: { code: 'PAYLOAD_TOO_LARGE' } });
      const row = await h.db.selectFrom('syncOperations').select('payload').where('opId', '=', op.opId).executeTakeFirstOrThrow();
      expect(JSON.stringify(row.payload).length).toBeLessThan(100);
    });
  });

  describe('public receipt links (M-3) and responses (L-5)', () => {
    it('a reversed payment’s link stops working; API responses are not cached', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '300' });
      await runBilling(h);
      const p = (await pay(h, agent.token, customer.id, '300').expect(201)).body.data;
      const link = await h.as(agent.token).get(`/api/v1/receipts/${p.receipt.id}/link`).expect(200);
      expect(new Date(link.body.data.expiresAt).getTime() - Date.now()).toBeLessThan(7.1 * 86_400_000);
      const path = new URL(link.body.data.url).pathname;
      const ok = await h.http().get(path).expect(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      await h.as(h.superAdminToken).post(`/api/v1/payments/${p.id}/reverse`, { reason: 'Entered by mistake' }, idem()).expect(200);
      expect((await h.http().get(path)).status).toBe(404);
      expect((await h.as(agent.token).get('/api/v1/collections/today')).headers['cache-control']).toBe('no-store');
    });
  });

  describe('Excel upload (L-10)', () => {
    it('reads the declared uncompressed size before inflating anything', () => {
      // Central-directory entry declaring 2 GB, followed by the end-of-directory record.
      const name = Buffer.from('xl/huge.xml');
      const cd = Buffer.alloc(46 + name.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt32LE(2_000_000_000, 24);
      cd.writeUInt16LE(name.length, 28);
      name.copy(cd, 46);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(cd.length, 12);
      eocd.writeUInt32LE(0, 16);
      expect(zipUncompressedSize(Buffer.concat([cd, eocd]))).toBe(2_000_000_000);
      expect(zipUncompressedSize(Buffer.from('not a zip at all'))).toBeNull();
    });

    it('a zip bomb is refused before it is unpacked', async () => {
      const name = Buffer.from('xl/huge.xml');
      const cd = Buffer.alloc(46 + name.length);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt32LE(2_000_000_000, 24);
      cd.writeUInt16LE(name.length, 28);
      name.copy(cd, 46);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(cd.length, 12);
      eocd.writeUInt32LE(0, 16);
      const res = await h.http().post('/api/v1/imports').set('authorization', `Bearer ${h.superAdminToken}`).attach('file', Buffer.concat([cd, eocd]), 'bomb.xlsx');
      expect(res.body.error).toMatchObject({ code: 'WORKBOOK_UNREADABLE' });
      expect(res.body.error.message).toMatch(/expand to/);
    });
  });
});
