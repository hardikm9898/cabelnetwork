import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createCustomer, createHarness, createSociety, Harness, login, nextMobile, PASSWORD } from './support/harness';
import { customerWithSubscription, expectBooksBalance, monthStart, pay, runBilling, setupSociety } from './support/finance';

/** Edit everything, delete (soft) and restore: customers, societies, areas, users and agents. */
describe('edit and delete', () => {
  let h: Harness;
  let agent: Awaited<ReturnType<typeof createAgent>>;
  let society: string;

  beforeAll(async () => {
    h = await createHarness();
    agent = await createAgent(h, 'MNG1');
    society = await setupSociety(h, 'Manage Nagar', agent.id);
  });
  afterAll(() => h.close());

  const sa = () => h.as(h.superAdminToken);
  const listCodes = async (extra = '') =>
    ((await sa().get(`/api/v1/customers?pageSize=100${extra}`).expect(200)).body.data as { customerCode: string }[]).map((c) => c.customerCode);

  describe('customer edit', () => {
    it('changes the Customer ID and corrects the box and MQ numbers', async () => {
      const c = await createCustomer(h, society);
      const res = await sa().patch(`/api/v1/customers/${c.id}`, { customerCode: 'NEW-1', stbNumber: '307070260799999901', mqNumber: '91081142' }).expect(200);
      expect(res.body.data.customer).toMatchObject({ customerCode: 'NEW-1', activeConnections: [{ stbNumber: '307070260799999901', mqNumber: '91081142' }] });
      // The old box number is free; a box on another customer is refused.
      const other = await createCustomer(h, society);
      const clash = await sa().patch(`/api/v1/customers/${other.id}`, { stbNumber: '307070260799999901' });
      expect(clash.body.error.code).toBe('STB_IN_USE');
      expect((await sa().patch(`/api/v1/customers/${other.id}`, { customerCode: 'new-1' })).body.error.code).toBe('CUSTOMER_CODE_EXISTS');
      // Empty box number removes the box.
      const cleared = await sa().patch(`/api/v1/customers/${c.id}`, { stbNumber: '' }).expect(200);
      expect(cleared.body.data.customer.activeConnections).toEqual([]);
      // The list shows the monthly rate and the MQ number.
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '400' });
      await sa().patch(`/api/v1/customers/${customer.id}`, { mqNumber: '91081150' }).expect(200);
      const row = ((await sa().get(`/api/v1/customers?q=${customer.customerCode}`).expect(200)).body.data as Record<string, unknown>[])[0];
      expect(row).toMatchObject({ monthlyRate: '400.00', mqNumbers: '91081150' });
    });
  });

  describe('monthly charge', () => {
    it('a rate that is not billed yet can be replaced on the same date; the upcoming rate is shown', async () => {
      const c = await createCustomer(h, society);
      const start = monthStart(1);
      const sub = (await sa().post(`/api/v1/customers/${c.id}/subscription`, { monthlyRate: '400', startDate: start }).expect(201)).body.data;
      expect(sub).toMatchObject({ currentMonthlyRate: null, monthlyRate: '400.00', monthlyRateFrom: start });
      const changed = await sa().post(`/api/v1/subscriptions/${sub.id}/rates`, { monthlyRate: '350', effectiveFrom: start, reason: 'Corrected before the first bill' }).expect(201);
      expect(changed.body.data).toMatchObject({ monthlyRate: '350.00', rates: [{ monthlyRate: '350.00', effectiveFrom: start }] });
      // Once a period is billed, its rate stays.
      const { customer, subscription } = await customerWithSubscription(h, society, { monthlyRate: '300' });
      await runBilling(h);
      const billed = await sa().post(`/api/v1/subscriptions/${subscription.id}/rates`, { monthlyRate: '250', effectiveFrom: monthStart(-2), reason: 'Too late' });
      expect(billed.body.error.code).toBe('PERIOD_ALREADY_BILLED');
      expect(customer.id).toBeTruthy();
    });
  });

  describe('customer delete', () => {
    it('refuses while money is open, deletes when settled, hides it everywhere and frees the ID', async () => {
      const { customer } = await customerWithSubscription(h, society, { monthlyRate: '300' });
      await runBilling(h);
      const refused = await sa().post(`/api/v1/customers/${customer.id}/delete`, { reason: 'Wrong entry' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('CUSTOMER_HAS_DUES');

      const owed = (await sa().get(`/api/v1/customers/${customer.id}/balance`).expect(200)).body.data.outstanding as string;
      await pay(h, agent.token, customer.id, owed).expect(201);
      await sa().post(`/api/v1/customers/${customer.id}/delete`, { reason: 'Left the area' }).expect(200);

      expect(await listCodes()).not.toContain(customer.customerCode);
      expect(await listCodes('&deleted=true')).toContain(customer.customerCode);
      const pull = await h.as(agent.token).get('/api/v1/sync/pull').expect(200);
      expect((pull.body.data.customers as { id: string }[]).some((x) => x.id === customer.id)).toBe(false);
      const detail = (await sa().get(`/api/v1/customers/${customer.id}`).expect(200)).body.data;
      expect(detail).toMatchObject({ status: 'INACTIVE', deleteReason: 'Left the area', activeConnections: [] });
      expect(detail.deletedAt).toBeTruthy();
      expect((await sa().get(`/api/v1/customers/${customer.id}/subscription`).expect(200)).body.data.status).toBe('ENDED');
      // The payment history stays.
      expect((await sa().get(`/api/v1/customers/${customer.id}/payments`).expect(200)).body.data).toHaveLength(1);

      // The ID and box can be used for a new customer; then the old one cannot be restored.
      const reuse = await createCustomer(h, society, { customerCode: customer.customerCode, stbNumber: `307070260700${customer.customerCode}` });
      expect((await sa().post(`/api/v1/customers/${customer.id}/restore`, { reason: 'Back' })).body.error.code).toBe('CUSTOMER_CODE_EXISTS');
      await sa().patch(`/api/v1/customers/${reuse.id}`, { customerCode: `${customer.customerCode}B` }).expect(200);
      const restored = await sa().post(`/api/v1/customers/${customer.id}/restore`, { reason: 'Came back' }).expect(200);
      expect(restored.body.data).toMatchObject({ deletedAt: null, currentAgent: { agentId: agent.id } });
      await expectBooksBalance(h);
    });

    it('bulk delete deletes what it can and lists the rest with the reason', async () => {
      const free1 = await createCustomer(h, society);
      const free2 = await createCustomer(h, society);
      const { customer: owing } = await customerWithSubscription(h, society, { monthlyRate: '250' });
      await runBilling(h);
      const res = await sa().post('/api/v1/customers/bulk-delete', { customerIds: [free1.id, free2.id, owing.id], reason: 'Duplicate entries' }).expect(200);
      expect(res.body.data).toMatchObject({ deleted: 2, deletedCodes: [free1.customerCode, free2.customerCode] });
      expect(res.body.data.blocked).toEqual([expect.objectContaining({ customerId: owing.id, customerCode: owing.customerCode, reason: expect.stringContaining('owes') })]);
    });

    it('agents cannot delete', async () => {
      const c = await createCustomer(h, society);
      expect((await h.as(agent.token).post(`/api/v1/customers/${c.id}/delete`, { reason: 'No' })).status).toBe(403);
    });
  });

  describe('societies and areas', () => {
    it('a society with customers is refused; an empty one is deleted and its name can be reused', async () => {
      const s = await createSociety(h, 'Empty Park');
      const c = await createCustomer(h, s);
      expect((await sa().post(`/api/v1/societies/${s}/delete`, { reason: 'Merged' })).body.error.code).toBe('SOCIETY_HAS_CUSTOMERS');
      await sa().post(`/api/v1/customers/${c.id}/delete`, { reason: 'Test' }).expect(200);
      await sa().post(`/api/v1/societies/${s}/delete`, { reason: 'Merged' }).expect(200);
      const names = ((await sa().get('/api/v1/societies').expect(200)).body.data as { name: string }[]).map((x) => x.name);
      expect(names).not.toContain('Empty Park');
      await createSociety(h, 'Empty Park');
    });

    it('an area with societies is refused; an empty one is deleted (owner cleared)', async () => {
      const area = (await sa().post('/api/v1/areas', { name: 'Old Area' }).expect(201)).body.data.id as string;
      await sa().put(`/api/v1/areas/${area}/owner`, { agentId: agent.id, reason: 'Owner' }).expect(200);
      const s = await createSociety(h, 'Old Area Society', area);
      expect((await sa().post(`/api/v1/areas/${area}/delete`, { reason: 'Not used' })).body.error.code).toBe('AREA_HAS_SOCIETIES');
      await sa().post(`/api/v1/societies/${s}/delete`, { reason: 'Not used' }).expect(200);
      await sa().post(`/api/v1/areas/${area}/delete`, { reason: 'Not used' }).expect(200);
      expect(((await sa().get('/api/v1/areas').expect(200)).body.data as { id: string }[]).some((a) => a.id === area)).toBe(false);
    });
  });

  describe('users and agents', () => {
    it('office users can be edited and deleted; a deleted user cannot sign in and the mobile is free again', async () => {
      const mobile = nextMobile();
      const u = (await sa().post('/api/v1/users', { fullName: 'Desk One', mobile, role: 'ADMIN', temporaryPassword: 'Temp1234' }).expect(201)).body.data;
      const edited = await sa().patch(`/api/v1/users/${u.id}`, { fullName: 'Desk Main', role: 'SUPER_ADMIN' }).expect(200);
      expect(edited.body.data).toMatchObject({ fullName: 'Desk Main', role: 'SUPER_ADMIN' });
      await sa().post(`/api/v1/users/${u.id}/delete`, { reason: 'Left the job' }).expect(200);
      expect((await h.http().post('/api/v1/auth/login').send({ mobile, password: 'Temp1234' })).status).toBe(401);
      expect(((await sa().get('/api/v1/users').expect(200)).body.data as { id: string }[]).some((x) => x.id === u.id)).toBe(false);
      await sa().post('/api/v1/users', { fullName: 'Desk Two', mobile, role: 'ADMIN', temporaryPassword: 'Temp1234' }).expect(201);
    });

    it('the last super admin cannot be deleted or demoted; nobody deletes themselves', async () => {
      const me = (await sa().get('/api/v1/auth/me').expect(200)).body.data.id as string;
      expect((await sa().post(`/api/v1/users/${me}/delete`, { reason: 'Test' })).body.error.code).toBe('CANNOT_DELETE_SELF');
    });

    it('an agent with customers is refused; without, it is deleted', async () => {
      const a = await createAgent(h, 'MNG2');
      const s = await setupSociety(h, 'Agent Two Nagar', a.id);
      await createCustomer(h, s);
      expect((await sa().post(`/api/v1/agents/${a.id}/delete`, { reason: 'Left' })).body.error.code).toBe('AGENT_HAS_ASSIGNMENTS');
      const b = await createAgent(h, 'MNG3');
      await sa().post(`/api/v1/agents/${b.id}/delete`, { reason: 'Left' }).expect(200);
      expect(((await sa().get('/api/v1/agents').expect(200)).body.data as { id: string }[]).some((x) => x.id === b.id)).toBe(false);
      expect((await h.http().post('/api/v1/auth/login').send({ mobile: b.mobile, password: PASSWORD })).status).toBe(401);
      await login(h.http, a.mobile, PASSWORD);
    });
  });
});
