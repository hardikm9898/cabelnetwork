import { addDays, businessDateOf } from '@cablenet/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createArea, createCustomer, createHarness, createSociety, Harness } from './support/harness';

describe('customer management', () => {
  let h: Harness;
  let society: string;
  let otherSociety: string;
  let admin: ReturnType<Harness['as']>;

  beforeAll(async () => {
    h = await createHarness();
    admin = h.as(h.superAdminToken);
    const ag = await createAgent(h, 'AGC');
    const area = await createArea(h, 'Area C', ag.id);
    society = await createSociety(h, 'Ambikanagar Sooc', area);
    otherSociety = await createSociety(h, 'Babunagar');
  });
  afterAll(() => h.close());

  const base = (code: string, extra: Record<string, unknown> = {}) => ({
    customerCode: code,
    name: '  BUDHABHAI  K PRAJAPATI ',
    mobile: '9998659339',
    addressLine: '1/KASTURI NAGAR ,CHANDLODIY, gota ',
    societyId: society,
    stbNumber: `307070260700${code}`,
    ...extra,
  });

  it('creates a customer with cleaned text, an active STB and the area agent', async () => {
    const res = await admin.post('/api/v1/customers', base('322760')).expect(201);
    const c = res.body.data.customer;
    expect(c).toMatchObject({
      customerCode: '322760',
      name: 'BUDHABHAI K PRAJAPATI',
      addressLine: '1/KASTURI NAGAR ,CHANDLODIY, gota',
      mobile: '9998659339',
      mobileValid: true,
      status: 'ACTIVE',
    });
    expect(c.activeConnections[0].stbNumber).toBe('307070260700322760');
    expect(c.currentAgent.agentCode).toBe('AGC');
    expect(res.body.data.warnings).toEqual([]);
  });

  it('rejects a duplicate customer ID (case-insensitive) and an STB already in use', async () => {
    const dupId = await admin.post('/api/v1/customers', base('322760', { mobile: '9000011111', stbNumber: 'X123456' }));
    expect(dupId.status).toBe(409);
    expect(dupId.body.error.code).toBe('CUSTOMER_CODE_EXISTS');
    const dupStb = await admin.post('/api/v1/customers', base('322761', { mobile: '9000011112', stbNumber: '307070260700322760' }));
    expect(dupStb.status).toBe(409);
    expect(dupStb.body.error.code).toBe('STB_IN_USE');
  });

  it('asks for confirmation when a mobile is shared (e.g. family members), then accepts it', async () => {
    const first = await admin.post('/api/v1/customers', base('327018', { mobile: '9726939410' })).expect(201);
    expect(first.body.data.warnings).toEqual([]);
    const second = await admin.post('/api/v1/customers', base('324499', { mobile: '9726939410' }));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(second.body.error.details.warnings[0]).toMatchObject({ code: 'DUPLICATE_MOBILE' });
    expect(second.body.error.details.warnings[0].customers[0].customerCode).toBe('327018');
    const confirmed = await admin.post('/api/v1/customers', base('324499', { mobile: '9726939410', acknowledgeWarnings: true }));
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.warnings[0].code).toBe('DUPLICATE_MOBILE');
  });

  it('blocks duplicate mobiles when the business setting says so', async () => {
    await admin.put('/api/v1/settings/customers.duplicateRules', { mobile: 'block', stb: 'warn' }).expect(200);
    const res = await admin.post('/api/v1/customers', base('325968', { mobile: '9726939410', acknowledgeWarnings: true }));
    expect(res.body.error.code).toBe('DUPLICATE_MOBILE');
    await admin.put('/api/v1/settings/customers.duplicateRules', { mobile: 'warn', stb: 'block' }).expect(200);
  });

  it('keeps an invalid mobile as typed (never invents digits) but flags it', async () => {
    const res = await admin.post('/api/v1/customers', base('327107', { mobile: '999837003', acknowledgeWarnings: true }));
    expect(res.status).toBe(201);
    expect(res.body.data.customer).toMatchObject({ mobile: '999837003', mobileValid: false });
    expect(res.body.data.warnings.map((w: { code: string }) => w.code)).toContain('INVALID_MOBILE');
  });

  it('searches by name, customer ID, mobile and STB number', async () => {
    const q = async (term: string) =>
      ((await admin.get(`/api/v1/customers?q=${encodeURIComponent(term)}`).expect(200)).body.data as { customerCode: string }[])
        .map((c) => c.customerCode)
        .sort();
    expect(await q('3227')).toEqual(['322760']);
    expect(await q('99983')).toEqual(['327107']);
    expect(await q('9726939410')).toEqual(['324499', '327018']);
    expect(await q('260700327107')).toEqual(['327107']);
    expect(await q('prajapati')).toHaveLength(4);
    expect(await q('100%')).toEqual([]); // LIKE wildcards are escaped
  });

  it('paginates with total counts and sorts', async () => {
    const res = await admin.get('/api/v1/customers?pageSize=2&page=2&sort=-code').expect(200);
    expect(res.body.meta).toEqual({ page: 2, pageSize: 2, total: 4 });
    expect(res.body.data.map((c: { customerCode: string }) => c.customerCode)).toEqual(['324499', '322760']);
  });

  it('deactivates and reactivates without deleting anything, with an audited reason', async () => {
    const c = await createCustomer(h, society);
    const off = await admin.post(`/api/v1/customers/${c.id}/deactivate`, { reason: 'Service discontinued' }).expect(200);
    expect(off.body.data.status).toBe('INACTIVE');
    const twice = await admin.post(`/api/v1/customers/${c.id}/deactivate`, { reason: 'Again' });
    expect(twice.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    const noReason = await admin.post(`/api/v1/customers/${c.id}/reactivate`, {});
    expect(noReason.status).toBe(400);
    await admin.post(`/api/v1/customers/${c.id}/reactivate`, { reason: 'Customer returned' }).expect(200);

    const filtered = await admin.get('/api/v1/customers?status=INACTIVE').expect(200);
    expect(filtered.body.data).toEqual([]);
    const audit = await h.db
      .selectFrom('auditLogs')
      .select(['action', 'before', 'after', 'reason'])
      .where('entityId', '=', c.id)
      .where('action', 'in', ['customer.deactivate', 'customer.reactivate'])
      .orderBy('id')
      .execute();
    expect(audit).toEqual([
      { action: 'customer.deactivate', before: { status: 'ACTIVE' }, after: { status: 'INACTIVE' }, reason: 'Service discontinued' },
      { action: 'customer.reactivate', before: { status: 'INACTIVE' }, after: { status: 'ACTIVE' }, reason: 'Customer returned' },
    ]);
  });

  it('updates fields with a before/after audit and re-routes on society change', async () => {
    const c = await createCustomer(h, society);
    const res = await admin
      .patch(`/api/v1/customers/${c.id}`, { landmark: 'Near temple', societyId: otherSociety, reason: 'Moved house' })
      .expect(200);
    expect(res.body.data.customer).toMatchObject({ landmark: 'Near temple', society: { id: otherSociety } });
    // The new society has no area owner yet, so the customer keeps the current agent.
    expect(res.body.data.customer.currentAgent.agentCode).toBe('AGC');
    const audit = await h.db
      .selectFrom('auditLogs')
      .select(['before', 'after', 'reason'])
      .where('entityId', '=', c.id)
      .where('action', '=', 'customer.update')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ before: { landmark: null, societyId: society }, after: { landmark: 'Near temple', societyId: otherSociety }, reason: 'Moved house' });
  });

  it('replaces a set-top box and keeps the old one in history', async () => {
    const c = await createCustomer(h, society);
    const today = businessDateOf(new Date());
    const tooEarly = await admin.post(`/api/v1/customers/${c.id}/connections/replace`, {
      stbNumber: 'NEWBOX0001',
      effectiveDate: addDays(today, -30),
      reason: 'Box replaced',
    });
    expect(tooEarly.body.error.code).toBe('EFFECTIVE_DATE_TOO_EARLY');
    await admin
      .post(`/api/v1/customers/${c.id}/connections/replace`, { stbNumber: 'newbox0001', effectiveDate: today, reason: 'Faulty box' })
      .expect(201);
    const list = await admin.get(`/api/v1/customers/${c.id}/connections`).expect(200);
    expect(list.body.data).toHaveLength(2);
    const active = list.body.data.filter((x: { activeTo: string | null }) => x.activeTo === null);
    expect(active.map((x: { stbNumber: string }) => x.stbNumber)).toEqual(['NEWBOX0001']);

    // The old box was used before: new customers with it need it unblocked (setting stb=block).
    const old = list.body.data.find((x: { activeTo: string | null }) => x.activeTo !== null).stbNumber;
    const reuse = await admin.post('/api/v1/customers', base('399999', { mobile: '9000022222', stbNumber: old }));
    expect(reuse.body.error.code).toBe('STB_PREVIOUSLY_USED');
  });

  it('rejects malformed input with field-level details', async () => {
    const res = await admin.post('/api/v1/customers', { customerCode: 'bad code!', name: '', societyId: 'nope' });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['customerCode', 'name', 'addressLine', 'societyId']));
  });
});
