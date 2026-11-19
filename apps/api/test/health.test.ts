import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, Harness } from './support/harness';

describe('health and readiness', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('liveness answers without signing in', async () => {
    expect((await h.http().get('/api/v1/health')).body.data.status).toBe('ok');
  });

  it('readiness is 200 when healthy and 503 with an open critical alert; it shows no business data', async () => {
    const ok = await h.http().get('/api/v1/health/ready');
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'ok', checks: { database: { ok: true }, criticalAlerts: { ok: true, detail: 0 } } });

    await h.db.insertInto('systemAlerts').values({ type: 'JOB_FAILED', severity: 'CRITICAL', message: 'Scheduled jobs failed: test' }).execute();
    const bad = await h.http().get('/api/v1/health/ready');
    expect(bad.status).toBe(503);
    expect(bad.body.data).toMatchObject({ status: 'degraded', checks: { criticalAlerts: { ok: false, detail: 1 } } });
    expect(JSON.stringify(bad.body)).not.toContain('test'); // the alert text stays private
  });
});
