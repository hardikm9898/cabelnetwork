import { randomUUID } from 'node:crypto';
import { addMonths, businessDateOf } from '@cablenet/domain';
import { expect } from 'vitest';
import { createArea, createCustomer, createSociety, Harness } from './harness';

/** Dates relative to the real "today" so the suite never goes stale. */
export const today = () => businessDateOf(new Date());
export const monthStart = (n = 0) => addMonths(`${today().slice(0, 8)}01`, n);
export const idem = () => ({ 'Idempotency-Key': randomUUID() });

export async function setupSociety(h: Harness, name: string, agentId?: string) {
  const area = await createArea(h, `Area ${name}`, agentId);
  return createSociety(h, name, area);
}

/** Customer + subscription. `start` defaults to two months ago (3 monthly periods due today). */
export async function customerWithSubscription(
  h: Harness,
  societyId: string,
  sub: { monthlyRate: string; startDate?: string; billingIntervalMonths?: number; billingTiming?: 'ADVANCE' | 'ARREARS'; billingMode?: 'AUTO' | 'MANUAL'; billingAnchorDay?: number },
) {
  const customer = await createCustomer(h, societyId);
  const res = await h
    .as(h.superAdminToken)
    .post(`/api/v1/customers/${customer.id}/subscription`, { startDate: monthStart(-2), ...sub });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { customer, subscription: res.body.data as { id: string; nextPeriodStart: string } };
}

export async function runBilling(h: Harness, asOf = today()) {
  const res = await h.as(h.superAdminToken).post('/api/v1/billing/runs', { asOf });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { invoicesCreated: number; periodsSkipped: number; errors: unknown[] };
}

export async function balance(h: Harness, customerId: string, token = h.superAdminToken) {
  const res = await h.as(token).get(`/api/v1/customers/${customerId}/balance`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as {
    balance: string;
    outstanding: string;
    advance: string;
    openInvoices: { id: string; balance: string; periodStart: string }[];
    pendingVerification: unknown[];
  };
}

export async function invoicesOf(h: Harness, customerId: string) {
  const res = await h.as(h.superAdminToken).get(`/api/v1/customers/${customerId}/invoices?pageSize=100`).expect(200);
  return (res.body.data as { id: string; periodStart: string; total: string; amountPaid: string; status: string; kind: string }[]).sort(
    (a, b) => (a.periodStart ?? '').localeCompare(b.periodStart ?? ''),
  );
}

export function pay(
  h: Harness,
  token: string,
  customerId: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  return h.as(token).post('/api/v1/payments', {
    clientTxnId: randomUUID(),
    customerId,
    amount,
    paymentDate: today(),
    mode: 'CASH',
    ...extra,
  });
}

export async function reconcile(h: Harness) {
  const res = await h.as(h.superAdminToken).post('/api/v1/reconciliation/run').expect(200);
  return res.body.data as { customerMismatches: unknown[]; invoiceCacheMismatches: unknown[]; overAllocatedCredits: unknown[] };
}

export async function expectBooksBalance(h: Harness) {
  const r = await reconcile(h);
  expect(r.customerMismatches).toEqual([]);
  expect(r.invoiceCacheMismatches).toEqual([]);
  expect(r.overAllocatedCredits).toEqual([]);
}
