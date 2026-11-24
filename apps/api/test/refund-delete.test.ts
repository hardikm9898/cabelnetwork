import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCustomer, createHarness, Harness } from './support/harness';
import { balance, expectBooksBalance, idem, pay, setupSociety } from './support/finance';

/**
 * A test payment that was then "removed" with a refund (owner, 2026-11-24): the payment cannot be
 * deleted while its money is refunded; deleting the refund first makes it deletable.
 */
describe('delete a refund, then the payment', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('explains which refund blocks the delete, deletes the refund, then the payment', async () => {
    const society = await setupSociety(h, 'Refund Delete Nagar');
    const c = await createCustomer(h, society);
    const sa = h.as(h.superAdminToken);
    const p400 = (await pay(h, h.superAdminToken, c.id, '400').expect(201)).body.data;
    const p800 = (await pay(h, h.superAdminToken, c.id, '800').expect(201)).body.data;
    expect((await balance(h, c.id)).advance).toBe('1200.00');
    const refund = (await sa.post(`/api/v1/customers/${c.id}/refunds`, { amount: '1200', mode: 'CASH', reason: 'Remove test money' }, idem()).expect(201)).body.data;
    expect((await balance(h, c.id)).advance).toBe('0.00');

    const blocked = await sa.post(`/api/v1/payments/${p400.id}/reverse`, { reason: 'Test entry' }, idem());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PAYMENT_REFUNDED');
    expect(blocked.body.error.message).toContain(refund.refundNumber);

    await sa.post(`/api/v1/refunds/${refund.id}/reverse`, { reason: 'Test entry' }, idem()).expect(200);
    expect((await balance(h, c.id)).advance).toBe('1200.00');
    const again = await sa.post(`/api/v1/refunds/${refund.id}/reverse`, { reason: 'Test entry' }, idem());
    expect(again.body.error.code).toBe('REFUND_ALREADY_REVERSED');

    await sa.post(`/api/v1/payments/${p400.id}/reverse`, { reason: 'Test entry' }, idem()).expect(200);
    await sa.post(`/api/v1/payments/${p800.id}/reverse`, { reason: 'Test entry' }, idem()).expect(200);
    const b = await balance(h, c.id);
    expect([b.outstanding, b.advance]).toEqual(['0.00', '0.00']);
    const ledger = (await sa.get(`/api/v1/customers/${c.id}/ledger`).expect(200)).body.data.entries as { type: string; refundId: string | null }[];
    expect(ledger.find((e) => e.type === 'REFUND')?.refundId).toBe(refund.id);
    await expectBooksBalance(h);
  });
});
