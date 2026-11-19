import { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../src/app.factory';
import { AppConfig, loadConfig } from '../../src/config/env';
import { createDatabase, Database } from '../../src/db/database';
import { hashPassword } from '../../src/modules/auth/passwords';

export const PASSWORD = 'Kh8-field-Route';

export interface Harness {
  app: INestApplication;
  db: Database;
  cfg: AppConfig;
  /** Unauthenticated client. */
  http: () => ReturnType<typeof request>;
  /** Client that sends `Authorization: Bearer <token>`. */
  as: (token: string) => AuthedClient;
  superAdminToken: string;
  close: () => Promise<void>;
}

export interface AuthedClient {
  get: (url: string) => request.Test;
  post: (url: string, body?: object, headers?: Record<string, string>) => request.Test;
  put: (url: string, body?: unknown) => request.Test;
  patch: (url: string, body?: object) => request.Test;
  delete: (url: string) => request.Test;
}

/**
 * Boots the real application against a fresh database cloned from the migrated template,
 * seeds a super admin (password already changed) and returns helpers.
 */
export async function createHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const serverUrl = inject('pgServerUrl');
  const template = inject('pgTemplateDb');
  const dbName = `t_${randomUUID().replace(/-/g, '')}`;

  const admin = new Client({ connectionString: `${serverUrl}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${template}`);
  await admin.end();

  const env = {
    NODE_ENV: 'test',
    DATABASE_URL: `${serverUrl}/${dbName}`,
    DATABASE_POOL_MAX: '5',
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
    LOG_LEVEL: 'silent',
    SWAGGER_ENABLED: 'false',
    RATE_LIMIT_PER_MINUTE: '100000',
    LOGIN_RATE_LIMIT_PER_MINUTE: '100000',
    JOBS_ENABLED: 'false',
    ...overrides,
  };
  Object.assign(process.env, { LOGIN_RATE_LIMIT_PER_MINUTE: env.LOGIN_RATE_LIMIT_PER_MINUTE });
  const cfg = loadConfig(env as NodeJS.ProcessEnv);
  const app = await createApp(cfg);
  await app.init();
  const db = createDatabase(cfg.DATABASE_URL, 2);

  await db
    .insertInto('users')
    .values({
      fullName: 'Super Admin',
      mobile: '9000000001',
      passwordHash: await hashPassword(PASSWORD),
      role: 'SUPER_ADMIN',
      mustChangePassword: false,
    })
    .execute();

  const server = app.getHttpServer();
  const http = () => request(server);
  const as = (token: string): AuthedClient => {
    const auth = (t: request.Test) => t.set('Authorization', `Bearer ${token}`);
    return {
      get: (url) => auth(request(server).get(url)),
      post: (url, body, headers) => auth(request(server).post(url)).set(headers ?? {}).send(body ?? {}),
      put: (url, body) => auth(request(server).put(url)).send(body as object),
      patch: (url, body) => auth(request(server).patch(url)).send(body ?? {}),
      delete: (url) => auth(request(server).delete(url)),
    };
  };

  const superAdminToken = await login(http, '9000000001', PASSWORD);

  return {
    app,
    db,
    cfg,
    http,
    as,
    superAdminToken,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

export async function login(
  http: () => ReturnType<typeof request>,
  mobile: string,
  password: string,
  device?: { id: string },
): Promise<string> {
  const res = await http().post('/api/v1/auth/login').send({ mobile, password, device });
  if (res.status !== 200) throw new Error(`login failed for ${mobile}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}

let mobileSeq = 9100000000;
export const nextMobile = () => String(++mobileSeq);

/** Creates an agent through the API and returns its id and a signed-in token (password changed). */
export async function createAgent(h: Harness, code: string, name = `Agent ${code}`) {
  const mobile = nextMobile();
  const res = await h
    .as(h.superAdminToken)
    .post('/api/v1/agents', { fullName: name, mobile, agentCode: code, temporaryPassword: 'Temp1234' });
  if (res.status !== 201) throw new Error(`create agent failed: ${JSON.stringify(res.body)}`);
  const id = res.body.data.id as string;
  const temp = await login(h.http, mobile, 'Temp1234');
  await h.as(temp).post('/api/v1/auth/change-password', { currentPassword: 'Temp1234', newPassword: PASSWORD }).expect(204);
  const token = await login(h.http, mobile, PASSWORD);
  return { id, mobile, token, code };
}

export async function createArea(h: Harness, name: string, ownerAgentId?: string) {
  const res = await h.as(h.superAdminToken).post('/api/v1/areas', { name });
  if (res.status !== 201) throw new Error(`create area failed: ${JSON.stringify(res.body)}`);
  const id = res.body.data.id as string;
  if (ownerAgentId) {
    await h.as(h.superAdminToken).put(`/api/v1/areas/${id}/owner`, { agentId: ownerAgentId, reason: 'Initial owner' }).expect(200);
  }
  return id;
}

export async function createSociety(h: Harness, name: string, areaId?: string) {
  const res = await h.as(h.superAdminToken).post('/api/v1/societies', { name, areaId });
  if (res.status !== 201) throw new Error(`create society failed: ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

let codeSeq = 320000;
export async function createCustomer(h: Harness, societyId: string, extra: Record<string, unknown> = {}) {
  const code = String(++codeSeq);
  const res = await h.as(h.superAdminToken).post('/api/v1/customers', {
    customerCode: code,
    name: `Customer ${code}`,
    mobile: nextMobile(),
    addressLine: `${code} Test Society`,
    societyId,
    stbNumber: `307070260700${code}`,
    acknowledgeWarnings: true,
    ...extra,
  });
  if (res.status !== 201) throw new Error(`create customer failed: ${JSON.stringify(res.body)}`);
  return res.body.data.customer as { id: string; customerCode: string; currentAgent: { agentId: string } | null };
}
