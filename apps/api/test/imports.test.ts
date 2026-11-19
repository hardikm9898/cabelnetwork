import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, createCustomer, createHarness, createSociety, Harness } from './support/harness';
import { expectBooksBalance, runBilling, today } from './support/finance';
import { buildWorkbook, monthly, WbCustomer, WbPayments } from './support/workbook';

interface Batch {
  id: string;
  status: string;
  dryRunHash: string | null;
  summary: { customers: number; billable: number; monthlyTotal: string; pendingDecision: number; collections: string; historyYear: number; suggestedCutover: string | null; errors: number };
  issues: { code: string; severity: string; customerCode: string | null; message: string }[];
  customers: { code: string; rate: string | null; mobileValid: boolean; corrected: string[] }[];
  report: {
    ok: boolean;
    lines: { key: string; excel: string; system: string; ok: boolean }[];
    perCustomer: { equal: number; total: number; mismatches: unknown[] };
    created: Record<string, number>;
    blockingIssues: { code: string }[];
  } | null;
}

const REAL_WORKBOOK = join(__dirname, '../../../DOC-20261117-WA0003.xlsx');
const YEAR = new Date().getUTCFullYear() - 1; // a complete past year, so the suite never goes stale
const CUTOVER = `${YEAR + 1}-01-01`;

const cust = (code: string, extra: Partial<WbCustomer> = {}): WbCustomer => ({
  code,
  name: `Customer ${code}`,
  address: `${code.slice(-2)}, Test Nagar `,
  mobile: Number(`98${code.padStart(8, '0').slice(-8)}`),
  rate: 300,
  stb: `3070702607${code.padStart(8, '0')}`,
  society: 'TEST NAGAR',
  ...extra,
});

describe('Excel import', () => {
  let h: Harness;

  const upload = async (buffer: Buffer, name = 'customers.xlsx') => {
    const res = await h.http().post('/api/v1/imports').set('authorization', `Bearer ${h.superAdminToken}`).attach('file', buffer, name);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as Batch;
  };
  const dryRun = async (id: string, option: 'FULL_HISTORY' | 'OPENING_BALANCE', cutoverDate = CUTOVER) => {
    const res = await h.as(h.superAdminToken).post(`/api/v1/imports/${id}/dry-run`, { option, cutoverDate });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as Batch;
  };
  const approveAndCommit = async (b: Batch) => {
    await h.as(h.superAdminToken).post(`/api/v1/imports/${b.id}/approve`, { dryRunHash: b.dryRunHash, confirm: true }).expect(200);
    const res = await h.as(h.superAdminToken).post(`/api/v1/imports/${b.id}/commit`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as Batch;
  };
  const customerId = async (code: string) => (await h.db.selectFrom('customers').select('id').where('customerCode', '=', code).executeTakeFirstOrThrow()).id;
  const balanceOf = async (code: string) => (await h.as(h.superAdminToken).get(`/api/v1/customers/${await customerId(code)}/balance`).expect(200)).body.data as { outstanding: string; advance: string };
  const line = (b: Batch, key: string) => b.report!.lines.find((l) => l.key === key)!;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  describe('Option A (full history)', () => {
    const customers: WbCustomer[] = [
      cust('600001'), // pays every month
      cust('600002', { rate: 400 }), // stops after September: 800 due
      cust('600003', { society: 'SECOND PARK' }), // pays 3,900 in January: 300 advance at year end
      cust('600004', { rate: 'AMP', society: 'SECOND PARK' }), // text rate (D-1)
      cust('600005', { rate: null, society: 'SECOND PARK' }), // blank rate (D-2)
      cust('600006', { mobile: 9726939410 }),
      cust('600007', { mobile: 9726939410 }), // same mobile (D-4)
      cust('600008', { mobile: 999837003 }), // 9 digits (D-3)
    ];
    const payments: WbPayments = {
      '600001': monthly(YEAR, 300),
      '600002': monthly(YEAR, 400, 1, 9),
      '600003': { 1: { amount: 3900, date: `${YEAR}-01-10` } },
      '600004': { 1: { date: `${YEAR}-01-07` } }, // date without amount (D-9)
      '600006': monthly(YEAR, 300),
      '600007': monthly(YEAR, 300),
      '600008': monthly(YEAR, 300, 1, 11),
    };
    let batch: Batch;

    it('analyses the workbook: totals and every data-quality finding', async () => {
      batch = await upload(await buildWorkbook(customers, payments));
      expect(batch.status).toBe('ANALYSED');
      expect(batch.summary).toMatchObject({ customers: 8, billable: 6, monthlyTotal: '1900.00', pendingDecision: 2, historyYear: YEAR, suggestedCutover: CUTOVER, errors: 0 });
      expect(batch.summary.collections).toBe('21600.00'); // 3600 + 3600 + 3900 + 3600 + 3600 + 3300
      const codes = (c: string) => batch.issues.filter((i) => i.code === c).map((i) => i.customerCode);
      expect(codes('D-1')).toEqual(['600004']);
      expect(codes('D-2')).toEqual(['600005']);
      expect(codes('D-3')).toEqual(['600008']);
      expect(codes('D-4')).toHaveLength(1);
      expect(codes('D-9')).toEqual(['600004']);
      expect(batch.issues.some((i) => i.code === 'D-7')).toBe(true);
      expect(batch.issues.some((i) => i.code === 'D-11')).toBe(true);
      expect(batch.issues.some((i) => i.code === 'X-CALC')).toBe(false); // saved results agree with the formulas
    });

    it('is for the super admin only', async () => {
      const agent = await createAgent(h, 'IMP1');
      expect((await h.as(agent.token).get(`/api/v1/imports/${batch.id}`)).status).toBe(403);
      expect((await h.as(agent.token).get('/api/v1/imports')).status).toBe(403);
    });

    it('a dry run reconciles every check and leaves nothing behind', async () => {
      const before = await h.db.selectFrom('customers').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
      batch = await dryRun(batch.id, 'FULL_HISTORY');
      expect(batch.status).toBe('DRY_RUN_OK');
      expect(batch.report!.ok).toBe(true);
      expect(batch.report!.lines.every((l) => l.ok)).toBe(true);
      expect(line(batch, 'collections')).toMatchObject({ excel: '21600.00', system: '21600.00' });
      expect(line(batch, 'outstanding')).toMatchObject({ excel: '1500.00', system: '1500.00' }); // 600002: 3×400=1200, 600008: 300
      expect(line(batch, 'advance')).toMatchObject({ excel: '300.00', system: '300.00' }); // 600003
      expect(batch.report!.perCustomer).toMatchObject({ equal: 8, total: 8 });
      expect(batch.report!.created).toMatchObject({ customers: 8, subscriptions: 6, invoices: 72, payments: 57, legacyLines: 96, pendingDecision: 2 });
      const after = await h.db.selectFrom('customers').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
      expect(after.n).toBe(before.n);
      expect(await h.db.selectFrom('legacyStatementLines').selectAll().execute()).toHaveLength(0);
    });

    it('approval is tied to the exact dry run; commit writes it once', async () => {
      expect((await h.as(h.superAdminToken).post(`/api/v1/imports/${batch.id}/approve`, { dryRunHash: '0'.repeat(64), confirm: true })).body.error.code).toBe('DRY_RUN_CHANGED');
      expect((await h.as(h.superAdminToken).post(`/api/v1/imports/${batch.id}/commit`)).body.error.code).toBe('IMPORT_NOT_APPROVED');
      batch = await approveAndCommit(batch);
      expect(batch.status).toBe('COMMITTED');
      expect(batch.report!.ok).toBe(true);
      expect((await h.as(h.superAdminToken).post(`/api/v1/imports/${batch.id}/commit`)).body.error.code).toBe('IMPORT_COMMITTED');
      expect((await h.as(h.superAdminToken).put(`/api/v1/imports/${batch.id}/corrections`, { customerCode: '600001', field: 'name', value: 'X' })).status).toBe(409);
    });

    it('balances, legacy invoices and payments match the workbook', async () => {
      expect(await balanceOf('600002')).toMatchObject({ outstanding: '1200.00', advance: '0.00' });
      expect(await balanceOf('600003')).toMatchObject({ outstanding: '0.00', advance: '300.00' });
      expect(await balanceOf('600001')).toMatchObject({ outstanding: '0.00', advance: '0.00' });
      const inv = await h.db.selectFrom('invoices').select(['invoiceNumber', 'source', 'status']).where('customerId', '=', await customerId('600002')).orderBy('periodStart').execute();
      expect(inv).toHaveLength(12);
      expect(inv[0]).toMatchObject({ invoiceNumber: `XL-600002-${YEAR}-01`, source: 'IMPORT', status: 'PAID' });
      expect(inv.slice(-3).map((i) => i.status)).toEqual(['UNPAID', 'UNPAID', 'UNPAID']);
      const pays = await h.db.selectFrom('payments').select(['mode', 'source', 'collectedBy', 'externalRef']).where('customerId', '=', await customerId('600001')).execute();
      expect(pays).toHaveLength(12);
      expect(pays[0]).toMatchObject({ mode: 'LEGACY_UNKNOWN', source: 'IMPORT', collectedBy: null });
      const sub = await h.db.selectFrom('customerSubscriptions').selectAll().where('customerId', '=', await customerId('600001')).executeTakeFirstOrThrow();
      expect(sub).toMatchObject({ startDate: `${YEAR}-01-01`, nextPeriodStart: CUTOVER, billingTiming: 'ADVANCE' });
      await expectBooksBalance(h);
    });

    it('the Excel month grid is kept read-only on the customer', async () => {
      const res = await h.as(h.superAdminToken).get(`/api/v1/customers/${await customerId('600002')}/legacy-statement`).expect(200);
      const lines = res.body.data as { month: string; received: string; amountDue: string; rateRaw: string }[];
      expect(lines).toHaveLength(12);
      expect(lines[8]).toMatchObject({ month: `${YEAR}-09-01`, received: '400.00', amountDue: '0.00', rateRaw: '400' });
      expect(lines[11]).toMatchObject({ received: '0.00', amountDue: '1200.00' });
      await expect(h.db.updateTable('legacyStatementLines').set({ received: '1.00' }).execute()).rejects.toThrow();
    });

    it('customers without a usable rate wait for a decision; setting up a plan clears it', async () => {
      const pending = (await h.as(h.superAdminToken).get('/api/v1/imports/pending-decisions').expect(200)).body.data as { customerCode: string; pendingDecision: string }[];
      expect(pending.map((p) => p.customerCode)).toEqual(['600004', '600005']);
      expect(pending[0]!.pendingDecision).toContain('"AMP"');
      expect(await h.db.selectFrom('customerSubscriptions').select('id').where('customerId', '=', await customerId('600004')).execute()).toHaveLength(0);
      await h.as(h.superAdminToken).post(`/api/v1/customers/${await customerId('600004')}/subscription`, { startDate: CUTOVER, monthlyRate: '150' }).expect(201);
      const after = (await h.as(h.superAdminToken).get('/api/v1/imports/pending-decisions').expect(200)).body.data as { customerCode: string }[];
      expect(after.map((p) => p.customerCode)).toEqual(['600005']);
    });

    it('billing after the import starts at cutover and never re-bills an imported month', async () => {
      await runBilling(h, today());
      const inv = await h.db.selectFrom('invoices').select(['periodStart', 'source']).where('customerId', '=', await customerId('600001')).orderBy('periodStart').execute();
      const imported = inv.filter((i) => i.source === 'IMPORT');
      const billed = inv.filter((i) => i.source !== 'IMPORT');
      expect(imported).toHaveLength(12);
      expect(billed[0]!.periodStart).toBe(CUTOVER);
      expect(new Set(inv.map((i) => i.periodStart)).size).toBe(inv.length);
      await expectBooksBalance(h);
    });

    it('parallel run: a workbook kept alongside the system is compared month by month', async () => {
      const compare = async (buf: Buffer, month: string) => {
        const res = await h.http().post(`/api/v1/imports/compare?month=${month}`).set('authorization', `Bearer ${h.superAdminToken}`).attach('file', buf, 'parallel.xlsx');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body.data as { compared: number; equal: number; mismatches: { customerCode: string; excelBalance: string; systemBalance: string }[]; onlyInWorkbook: string[]; ok: boolean };
      };
      const same = await compare(await buildWorkbook(customers, payments), `${YEAR}-12`);
      expect(same).toMatchObject({ compared: 8, equal: 8, mismatches: [], onlyInWorkbook: [], ok: true });
      // Excel records a December payment the system does not have.
      const drift = await compare(await buildWorkbook(customers, { ...payments, '600002': { ...payments['600002'], 12: { amount: 400, date: `${YEAR}-12-04` } } }), `${YEAR}-12`);
      expect(drift.ok).toBe(false);
      expect(drift.mismatches).toEqual([expect.objectContaining({ customerCode: '600002', excelBalance: '800.00', systemBalance: '1200.00' })]);
      const bad = await h.http().post(`/api/v1/imports/compare?month=${YEAR - 3}-01`).set('authorization', `Bearer ${h.superAdminToken}`).attach('file', await buildWorkbook(customers, payments), 'x.xlsx');
      expect(bad.body.error.code).toBe('WRONG_YEAR');
    });

    it('the same file cannot be imported twice', async () => {
      const res = await h.http().post('/api/v1/imports').set('authorization', `Bearer ${h.superAdminToken}`).attach('file', await buildWorkbook(customers, payments), 'again.xlsx');
      // Same content but a fresh build has a different file hash; the customers themselves block it.
      expect([201, 409]).toContain(res.status);
      if (res.status === 201) {
        const b = res.body.data as Batch;
        expect(b.issues.filter((i) => i.message.includes('already exists'))).toHaveLength(8);
        const dr = await dryRun(b.id, 'FULL_HISTORY');
        expect(dr.status).toBe('DRY_RUN_FAILED');
      }
    });
  });

  describe('Option B (opening balance), corrections and safety checks', () => {
    const customers = [cust('700001'), cust('700002', { rate: 400 }), cust('700003'), cust('700004', { rate: 'BOSS' })];
    const payments: WbPayments = {
      '700001': monthly(YEAR, 300),
      '700002': monthly(YEAR, 400, 1, 10), // 800 due
      '700003': { 1: { amount: 4200, date: `${YEAR}-01-03` } }, // 600 advance
    };
    let batch: Batch;

    it('a correction sets the rate from cutover and invalidates the dry run', async () => {
      batch = await upload(await buildWorkbook(customers, payments));
      batch = await dryRun(batch.id, 'OPENING_BALANCE');
      expect(batch.status).toBe('DRY_RUN_OK');
      const res = await h.as(h.superAdminToken).put(`/api/v1/imports/${batch.id}/corrections`, { customerCode: '700004', field: 'monthlyRate', value: '250' }).expect(200);
      batch = res.body.data as Batch;
      expect(batch.status).toBe('ANALYSED');
      expect(batch.customers.find((c) => c.code === '700004')).toMatchObject({ rate: '250.00', corrected: ['monthlyRate'] });
      expect(batch.summary).toMatchObject({ billable: 4, pendingDecision: 0 });
      const bad = await h.as(h.superAdminToken).put(`/api/v1/imports/${batch.id}/corrections`, { customerCode: '700004', field: 'monthlyRate', value: 'abc' });
      expect(bad.status).toBe(422);
    });

    it('opening balances carry the Excel closing balance; no history payments are created', async () => {
      batch = await dryRun(batch.id, 'OPENING_BALANCE');
      expect(batch.report!.ok).toBe(true);
      expect(line(batch, 'collections')).toMatchObject({ excel: '11800.00', system: '11800.00' }); // kept as Excel history
      expect(batch.report!.created).toMatchObject({ invoices: 0, payments: 0, openingBalances: 2, subscriptions: 4 });

      // The database changes after approval: commit must refuse and write nothing.
      await h.as(h.superAdminToken).post(`/api/v1/imports/${batch.id}/approve`, { dryRunHash: batch.dryRunHash, confirm: true }).expect(200);
      await createCustomer(h, await createSociety(h, 'Late Society'), { customerCode: '700002', stbNumber: 'LATE-STB-1' });
      const refused = await h.as(h.superAdminToken).post(`/api/v1/imports/${batch.id}/commit`);
      expect(refused.body.error.code).toBe('IMPORT_CHANGED');
      expect(await h.db.selectFrom('customers').select('id').where('customerCode', 'in', ['700001', '700003']).execute()).toHaveLength(0);
    });

    it('commits once the conflict is resolved and a new dry run is approved', async () => {
      const other = await h.db.selectFrom('customers').select('id').where('customerCode', '=', '700002').executeTakeFirstOrThrow();
      // Correct the workbook side instead: the office renames nothing in the system, so drop the clash by discarding and re-uploading without 700002.
      await h.as(h.superAdminToken).post(`/api/v1/imports/${batch.id}/discard`).expect(200);
      expect(other.id).toBeTruthy();
      const b2 = await upload(await buildWorkbook(customers.filter((c) => c.code !== '700002'), payments), 'fixed.xlsx');
      let dr = await dryRun(b2.id, 'OPENING_BALANCE');
      expect(dr.report!.ok).toBe(true);
      dr = await approveAndCommit(dr);
      expect(dr.status).toBe('COMMITTED');
      expect(await balanceOf('700003')).toMatchObject({ advance: '600.00' });
      expect(await balanceOf('700001')).toMatchObject({ outstanding: '0.00', advance: '0.00' });
      const lines = (await h.as(h.superAdminToken).get(`/api/v1/customers/${await customerId('700001')}/legacy-statement`).expect(200)).body.data as unknown[];
      expect(lines).toHaveLength(12);
      expect(await h.db.selectFrom('payments').select('id').where('customerId', '=', await customerId('700001')).execute()).toHaveLength(0);
      await expectBooksBalance(h);
    });

    it('payments typed in months on or after cutover block the import', async () => {
      const b = await upload(await buildWorkbook([cust('800001')], { '800001': monthly(YEAR, 300) }));
      const dr = await dryRun(b.id, 'FULL_HISTORY', `${YEAR}-07-01`);
      expect(dr.status).toBe('DRY_RUN_FAILED');
      expect(dr.report!.blockingIssues.map((i) => i.code)).toContain('V-AFTERCUTOVER');
      expect(await h.db.selectFrom('customers').select('id').where('customerCode', '=', '800001').execute()).toHaveLength(0);
    });

    it('rejects files that are not workbooks', async () => {
      const res = await h.http().post('/api/v1/imports').set('authorization', `Bearer ${h.superAdminToken}`).attach('file', Buffer.from('id,name\n1,x'), 'list.csv');
      expect(res.body.error.code).toBe('NOT_XLSX');
    });
  });

  // Gate (DEVELOPMENT_ROADMAP Phase 7): the business's real workbook reconciles. The file holds
  // customer data and is not part of the repository, so this runs only where it is present.
  describe.runIf(existsSync(REAL_WORKBOOK))('the real workbook (DOC-20261117-WA0003.xlsx)', () => {
    let id: string;
    beforeAll(async () => {
      const h2 = h;
      const res = await h2.http().post('/api/v1/imports').set('authorization', `Bearer ${h2.superAdminToken}`).attach('file', readFileSync(REAL_WORKBOOK), 'DOC-20261117-WA0003.xlsx');
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      id = (res.body.data as Batch).id;
    });

    it('analysis matches EXCEL_MIGRATION_MAPPING §3–4', async () => {
      const b = (await h.as(h.superAdminToken).get(`/api/v1/imports/${id}`).expect(200)).body.data as Batch;
      expect(b.summary).toMatchObject({ customers: 163, billable: 142, monthlyTotal: '52330.00', pendingDecision: 21, collections: '575630.00', historyYear: 2026, suggestedCutover: '2026-12-01', errors: 0 });
      const count = (c: string) => b.issues.filter((i) => i.code === c).length;
      expect(count('D-1')).toBe(20);
      expect(count('D-2')).toBe(1);
      expect(b.issues.filter((i) => i.code === 'D-3').map((i) => i.customerCode)).toEqual(['327107']);
      expect(b.issues.find((i) => i.code === 'D-4')!.message).toContain('9726939410');
      expect(count('X-CALC')).toBe(0);
    });

    it.each(['FULL_HISTORY', 'OPENING_BALANCE'] as const)('dry run %s reconciles 163 customers, ₹5,75,630 and 163/163 balances', async (option) => {
      const b = await dryRun(id, option, '2026-12-01');
      expect(b.report!.ok, JSON.stringify(b.report!.lines)).toBe(true);
      expect(line(b, 'customers')).toMatchObject({ excel: '163', system: '163' });
      expect(line(b, 'billable')).toMatchObject({ excel: '142', system: '142' });
      expect(line(b, 'monthly')).toMatchObject({ excel: '52330.00', system: '52330.00' });
      expect(line(b, 'collections')).toMatchObject({ excel: '575630.00', system: '575630.00' });
      expect(line(b, 'outstanding')).toMatchObject({ excel: '0.00', system: '0.00' });
      expect(b.report!.perCustomer).toMatchObject({ equal: 163, total: 163 });
      if (option === 'FULL_HISTORY') expect(b.report!.created).toMatchObject({ invoices: 1562, payments: 1562 });
    });
  });
});
