import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { addDays, businessDateOf } from '@cablenet/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createArea, createCustomer, createHarness, createSociety, Harness } from './support/harness';

const today = () => businessDateOf(new Date());

async function visibleCodes(h: Harness, token: string): Promise<string[]> {
  const res = await h.as(token).get('/api/v1/customers?pageSize=100').expect(200);
  return (res.body.data as { customerCode: string }[]).map((c) => c.customerCode).sort();
}

describe('agent data isolation and assignment workflows', () => {
  let h: Harness;
  let ag1: Awaited<ReturnType<typeof createAgent>>;
  let ag2: Awaited<ReturnType<typeof createAgent>>;
  let areaA: string;
  let areaB: string;
  let ambika: string;
  let kasturi: string;
  let laxmi: string;
  const a: { id: string; customerCode: string }[] = [];
  const b: { id: string; customerCode: string }[] = [];

  beforeAll(async () => {
    h = await createHarness();
    ag1 = await createAgent(h, 'AG1', 'Ramesh');
    ag2 = await createAgent(h, 'AG2', 'Suresh');
    areaA = await createArea(h, 'Area A', ag1.id);
    areaB = await createArea(h, 'Area B', ag2.id);
    ambika = await createSociety(h, 'Ambika Nagar Society', areaA);
    kasturi = await createSociety(h, 'Kasturi Nagar', areaA);
    laxmi = await createSociety(h, 'Laxmi Nagar', areaB);
    a.push(await createCustomer(h, ambika), await createCustomer(h, ambika), await createCustomer(h, kasturi));
    b.push(await createCustomer(h, laxmi), await createCustomer(h, laxmi));
  });
  afterAll(() => h.close());

  const codes = (list: { customerCode: string }[]) => list.map((c) => c.customerCode).sort();

  it('assigns new customers to the area default agent', async () => {
    expect(await visibleCodes(h, ag1.token)).toEqual(codes(a));
    expect(await visibleCodes(h, ag2.token)).toEqual(codes(b));
    expect(await visibleCodes(h, h.superAdminToken)).toEqual(codes([...a, ...b]));
  });

  it("an agent cannot open another agent's customer, or probe for IDs", async () => {
    const other = await h.as(ag1.token).get(`/api/v1/customers/${b[0]!.id}`);
    const random = await h.as(ag1.token).get(`/api/v1/customers/${randomUUID()}`);
    expect(other.status).toBe(404);
    expect(random.status).toBe(404);
    expect(other.body.error.code).toBe(random.body.error.code);
    expect((await h.as(ag1.token).get(`/api/v1/customers/${b[0]!.id}/connections`)).status).toBe(404);
    // Filtering by another agent cannot widen an agent's view.
    const filtered = await h.as(ag1.token).get(`/api/v1/customers?agentId=${ag2.id}`).expect(200);
    expect(filtered.body.data).toEqual([]);
    await h.as(ag1.token).get(`/api/v1/customers/${a[0]!.id}`).expect(200);
  });

  describe('temporary reassignment', () => {
    let tempId: string;

    it('covers all of AG1’s customers by AG2 from today, without touching the primary assignment', async () => {
      const res = await h.as(h.superAdminToken).post('/api/v1/assignments/temporary', {
        fromAgentId: ag1.id,
        toAgentId: ag2.id,
        scope: 'ALL_OF_AGENT',
        startsOn: today(),
        endsOn: addDays(today(), 2),
        reason: 'AG1 unavailable for three days',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.customerCount).toBe(3);
      tempId = res.body.data.id;

      expect(await visibleCodes(h, ag1.token)).toEqual([]);
      expect(await visibleCodes(h, ag2.token)).toEqual(codes([...a, ...b]));

      const detail = await h.as(h.superAdminToken).get(`/api/v1/customers/${a[0]!.id}`).expect(200);
      expect(detail.body.data.currentAgent).toMatchObject({ agentId: ag2.id, kind: 'TEMPORARY' });
      expect(detail.body.data.primaryAgent).toMatchObject({ agentId: ag1.id, source: 'AREA_DEFAULT' });
    });

    it('notifies both agents', async () => {
      const n2 = await h.as(ag2.token).get('/api/v1/notifications').expect(200);
      const n1 = await h.as(ag1.token).get('/api/v1/notifications').expect(200);
      expect(n2.body.data.map((n: { type: string }) => n.type)).toContain('TEMP_ASSIGNMENT_RECEIVED');
      expect(n1.body.data.map((n: { type: string }) => n.type)).toContain('TEMP_ASSIGNMENT_GIVEN');
    });

    it('rejects an overlapping temporary assignment for the same customers', async () => {
      const ag3 = await createAgent(h, 'AG3');
      const res = await h.as(h.superAdminToken).post('/api/v1/assignments/temporary', {
        fromAgentId: ag1.id,
        toAgentId: ag3.id,
        scope: 'CUSTOMERS',
        customerIds: [a[0]!.id],
        startsOn: addDays(today(), 1),
        endsOn: addDays(today(), 5),
        reason: 'Overlapping cover',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TEMPORARY_ASSIGNMENT_CONFLICT');
      expect(res.body.error.details.conflicts[0].customerCode).toBe(a[0]!.customerCode);
    });

    it('rejects customers that do not belong to the source agent, and past start dates', async () => {
      const notOwned = await h.as(h.superAdminToken).post('/api/v1/assignments/temporary', {
        fromAgentId: ag2.id,
        toAgentId: ag1.id,
        scope: 'CUSTOMERS',
        customerIds: [a[1]!.id],
        startsOn: addDays(today(), 10),
        endsOn: addDays(today(), 11),
        reason: 'Wrong customer',
      });
      expect(notOwned.body.error.code).toBe('CUSTOMERS_NOT_ASSIGNED_TO_AGENT');
      const past = await h.as(h.superAdminToken).post('/api/v1/assignments/temporary', {
        fromAgentId: ag2.id,
        toAgentId: ag1.id,
        scope: 'ALL_OF_AGENT',
        startsOn: addDays(today(), -1),
        endsOn: today(),
        reason: 'Backdated',
      });
      expect(past.body.error.code).toBe('START_IN_PAST');
    });

    it('revoking early restores the original agent immediately', async () => {
      await h
        .as(h.superAdminToken)
        .post(`/api/v1/assignments/temporary/${tempId}/revoke`, { reason: 'AG1 back early' })
        .expect(200);
      expect(await visibleCodes(h, ag1.token)).toEqual(codes(a));
      expect(await visibleCodes(h, ag2.token)).toEqual(codes(b));
      const again = await h.as(h.superAdminToken).post(`/api/v1/assignments/temporary/${tempId}/revoke`, { reason: 'twice' });
      expect(again.body.error.code).toBe('ALREADY_REVOKED');

      const history = await h.as(h.superAdminToken).get(`/api/v1/customers/${a[0]!.id}/assignments`).expect(200);
      const temp = history.body.data.find((r: { kind: string }) => r.kind === 'TEMPORARY');
      expect(temp).toMatchObject({ agentId: ag2.id, endedReason: 'AG1 back early', isCurrent: false });
    });

    it('a scheduled reassignment has no effect until its start date and can be cancelled', async () => {
      const res = await h.as(h.superAdminToken).post('/api/v1/assignments/temporary', {
        fromAgentId: ag1.id,
        toAgentId: ag2.id,
        scope: 'SOCIETIES',
        societyIds: [kasturi],
        startsOn: addDays(today(), 3),
        endsOn: addDays(today(), 4),
        reason: 'Planned leave',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'SCHEDULED', customerCount: 1 });
      expect(await visibleCodes(h, ag2.token)).toEqual(codes(b));

      const list = await h.as(h.superAdminToken).get('/api/v1/assignments/temporary?status=SCHEDULED').expect(200);
      expect(list.body.data.map((t: { id: string }) => t.id)).toContain(res.body.data.id);

      await h
        .as(h.superAdminToken)
        .post(`/api/v1/assignments/temporary/${res.body.data.id}/revoke`, { reason: 'Leave cancelled' })
        .expect(200);
      const history = await h.as(h.superAdminToken).get(`/api/v1/customers/${a[2]!.id}/assignments`).expect(200);
      const cancelled = history.body.data.find((r: { tempReassignmentId: string }) => r.tempReassignmentId === res.body.data.id);
      expect(cancelled.cancelledBeforeStart).toBe(true);
    });

    it('an expired temporary assignment no longer applies: the primary agent resumes automatically', async () => {
      // Simulate a reassignment that ran last week (no job is needed to "restore" anything).
      const header = await h.db
        .insertInto('tempReassignments')
        .values({
          fromAgentId: ag1.id,
          toAgentId: ag2.id,
          scope: 'CUSTOMERS',
          scopeIds: [a[1]!.id],
          startsOn: addDays(today(), -8),
          endsOn: addDays(today(), -6),
          reason: 'Past cover',
          customerCount: 1,
          createdBy: ag1.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await h.db
        .insertInto('customerAgentAssignments')
        .values({
          customerId: a[1]!.id,
          agentId: ag2.id,
          kind: 'TEMPORARY',
          source: 'TEMP_REASSIGNMENT',
          validDuring: sql<string>`tstzrange(now() - interval '8 days', now() - interval '5 days')`,
          tempReassignmentId: header.id,
          createdBy: ag1.id,
        })
        .execute();
      const detail = await h.as(h.superAdminToken).get(`/api/v1/customers/${a[1]!.id}`).expect(200);
      expect(detail.body.data.currentAgent).toMatchObject({ agentId: ag1.id, kind: 'PRIMARY' });
      const status = await h.as(h.superAdminToken).get(`/api/v1/assignments/temporary/${header.id}`).expect(200);
      expect(status.body.data.status).toBe('ENDED');
    });
  });

  describe('permanent assignment', () => {
    it('manual overrides survive an area owner change unless explicitly included', async () => {
      // Pin one Area-A customer to AG2 manually.
      await h
        .as(h.superAdminToken)
        .post('/api/v1/assignments/permanent', { agentId: ag2.id, customerIds: [a[0]!.id], reason: 'Customer prefers AG2' })
        .expect(200);
      const ag4 = await createAgent(h, 'AG4');

      const res = await h
        .as(h.superAdminToken)
        .put(`/api/v1/areas/${areaA}/owner`, { agentId: ag4.id, reason: 'AG4 takes over Area A' })
        .expect(200);
      expect(res.body.data.customersMoved).toBe(2);
      expect(await visibleCodes(h, ag4.token)).toEqual(codes([a[1]!, a[2]!]));
      const pinned = await h.as(h.superAdminToken).get(`/api/v1/customers/${a[0]!.id}`).expect(200);
      expect(pinned.body.data.primaryAgent).toMatchObject({ agentId: ag2.id, source: 'MANUAL' });

      // Reset the override: customer follows the area default again.
      await h
        .as(h.superAdminToken)
        .post('/api/v1/assignments/reset-to-area-default', { customerIds: [a[0]!.id], reason: 'Back to area routing' })
        .expect(200);
      expect(await visibleCodes(h, ag4.token)).toEqual(codes(a));

      // Hand Area A back to AG1 including overrides.
      await h
        .as(h.superAdminToken)
        .put(`/api/v1/areas/${areaA}/owner`, { agentId: ag1.id, reason: 'AG1 back', applyToManualOverrides: true })
        .expect(200);
      expect(await visibleCodes(h, ag1.token)).toEqual(codes(a));
    });

    it('moving a society to another area re-routes its customers', async () => {
      const res = await h
        .as(h.superAdminToken)
        .patch(`/api/v1/societies/${kasturi}`, { areaId: areaB, reason: 'Route change' })
        .expect(200);
      expect(res.body.data.customersMoved).toBe(1);
      expect(await visibleCodes(h, ag2.token)).toEqual(codes([...b, a[2]!]));
      const noReason = await h.as(h.superAdminToken).patch(`/api/v1/societies/${kasturi}`, { areaId: areaA });
      expect(noReason.body.error.code).toBe('REASON_REQUIRED');
    });

    it('moves a whole society permanently and refuses to deactivate an agent who still has customers', async () => {
      await h
        .as(h.superAdminToken)
        .post('/api/v1/assignments/permanent', { agentId: ag1.id, societyId: laxmi, reason: 'Merge routes' })
        .expect(200);
      expect(await visibleCodes(h, ag1.token)).toEqual(codes([...a.slice(0, 2), ...b]));

      const res = await h
        .as(h.superAdminToken)
        .post(`/api/v1/agents/${ag1.id}/status`, { status: 'DEACTIVATED', reason: 'Left the company' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('AGENT_HAS_ASSIGNMENTS');
      expect(res.body.error.details.primaryCustomers).toBe(4);
    });
  });

  describe('database guarantees', () => {
    it('assignment history cannot be deleted, rewritten or extended', async () => {
      const row = await h.db
        .selectFrom('customerAgentAssignments')
        .select(['id'])
        .where('customerId', '=', b[0]!.id)
        .where(sql<boolean>`NOT upper_inf(valid_during)`)
        .executeTakeFirstOrThrow();
      await expect(sql`DELETE FROM customer_agent_assignments WHERE id = ${row.id}`.execute(h.db)).rejects.toThrow(/append-only/);
      await expect(
        sql`UPDATE customer_agent_assignments SET agent_id = ${ag1.id} WHERE id = ${row.id}`.execute(h.db),
      ).rejects.toThrow(/Only the end/);
      await expect(
        sql`UPDATE customer_agent_assignments SET valid_during = tstzrange(lower(valid_during), NULL) WHERE id = ${row.id}`.execute(h.db),
      ).rejects.toThrow(/only be shortened/);
    });

    it('two simultaneous primary agents for one customer are impossible', async () => {
      await expect(
        h.db
          .insertInto('customerAgentAssignments')
          .values({
            customerId: b[1]!.id,
            agentId: ag2.id,
            kind: 'PRIMARY',
            source: 'MANUAL',
            validDuring: sql<string>`tstzrange(now() - interval '1 day', NULL)`,
            createdBy: ag2.id,
          })
          .execute(),
      ).rejects.toMatchObject({ code: '23P01' });
    });

    it('every assignment change is audited with before/after and reason', async () => {
      const rows = await h.db
        .selectFrom('auditLogs')
        .select(['action', 'before', 'after', 'reason'])
        .where('entityId', '=', a[0]!.id)
        .where('action', 'like', 'assignment.%')
        .orderBy('id')
        .execute();
      expect(rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['assignment.initial', 'assignment.permanent_move', 'assignment.reset_to_area_default']),
      );
      const manual = rows.find((r) => r.action === 'assignment.permanent_move');
      expect(manual).toMatchObject({ before: { agentId: ag1.id }, after: { agentId: ag2.id }, reason: 'Customer prefers AG2' });
    });
  });
});
