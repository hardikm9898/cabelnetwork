import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, Page, test } from '@playwright/test';
import { Client } from 'pg';
import { formatInr } from '../../../packages/domain/src/format';
import { buildWorkbook, monthly } from '../../api/test/support/workbook';

interface State {
  databaseUrl: string;
  adminMobile: string;
  adminPassword: string;
  agentMobile: string;
  agentPassword: string;
  apiBase: string;
}
const state = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '.state.json'), 'utf8')) as State;

const pad = (n: number) => String(n).padStart(2, '0');
function monthStart(offset: number) {
  const d = new Date(Date.now() + 330 * 60_000);
  const idx = d.getUTCFullYear() * 12 + d.getUTCMonth() + offset;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}-01`;
}

async function signIn(page: Page, mobile = state.adminMobile, password = state.adminPassword) {
  await page.goto('/login');
  await page.getByLabel('Mobile number').fill(mobile);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Click a sidebar item (dashboard tiles also contain words like "Customers"). */
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

async function sqlValue(query: string): Promise<string> {
  const c = new Client({ connectionString: state.databaseUrl });
  await c.connect();
  try {
    const r = await c.query<{ v: string }>(query);
    return r.rows[0]!.v;
  } finally {
    await c.end();
  }
}

test.describe.serial('admin web', () => {
  test('field agents are turned away from the office site', async ({ page }) => {
    await signIn(page, state.agentMobile, state.agentPassword);
    await expect(page.getByText('Please use the Cable Network agent app')).toBeVisible();
  });

  test('customer lifecycle: create → bill → collect → receipt → reverse', async ({ page }) => {
    await signIn(page);
    await expect(page.getByTestId('kpis')).toBeVisible();

    // Create the customer with billing from last month (two monthly periods due).
    await nav(page, 'Customers');
    await page.getByRole('button', { name: 'Add customer' }).click();
    const form = page.getByRole('dialog', { name: 'Add customer' });
    await form.getByLabel('Customer ID').fill('777001');
    await form.getByLabel('Name').fill('E2E Test Customer');
    await form.getByLabel('Mobile', { exact: true }).fill('9876500001');
    await form.getByLabel('Address').fill('7, Laxmi Nagar');
    await form.getByLabel('Society').selectOption({ label: 'Laxmi Nagar' });
    await form.getByLabel('Monthly rate').fill('450');
    await form.getByLabel('Start date').fill(monthStart(-1));
    await page.getByRole('button', { name: 'Save customer' }).click();
    await expect(page.getByRole('heading', { name: 'E2E Test Customer' })).toBeVisible();
    const customerUrl = page.url();

    // Raise the bills.
    await nav(page, 'Bills & billing');
    await page.getByRole('button', { name: 'Run billing now' }).click();
    await page.getByRole('dialog', { name: 'Run billing' }).getByRole('button', { name: 'Run' }).click();
    await expect(page.getByText(/bill\(s\) raised/)).toBeVisible();

    await page.goto(customerUrl);
    await expect(page.getByTestId('customer-balance')).toContainText('₹900.00');

    // Collect at the office.
    await page.getByRole('button', { name: 'Collect payment' }).click();
    await expect(page.getByTestId('collect-outstanding')).toHaveText('₹900.00');
    await page.getByLabel('Amount received').fill('900');
    await page.getByRole('button', { name: 'Record payment' }).click();
    const success = page.getByTestId('payment-success');
    await expect(success).toContainText('Payment recorded');
    await expect(page.getByTestId('receipt-number')).toHaveText(/^RCPT\/\d{4}-\d{2}\/\d{6}$/);
    await expect(success).toContainText('All dues cleared.');

    const popup = page.waitForEvent('popup');
    await success.getByRole('button', { name: 'Receipt PDF' }).click();
    await (await popup).close();

    // Reverse it (wrong entry): bills reopen.
    await page.goto(customerUrl);
    await expect(page.getByTestId('customer-balance')).toContainText('Settled');
    await page.getByRole('tab', { name: 'Payments' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Delete/ });
    await dialog.getByRole('button', { name: 'Test entry' }).click();
    await dialog.getByRole('button', { name: 'Delete payment' }).click();
    await expect(page.getByText('Payment deleted')).toBeVisible();
    await expect(page.getByTestId('customer-balance')).toContainText('₹900.00');
    await expect(page.locator('tbody')).toContainText('deleted');
    await expect(page.locator('tbody')).toContainText('Test entry');

    // Several at once from the Payments page: two test entries made at the office.
    const customerId = customerUrl.split('/').pop()!;
    const login = await fetch(`${state.apiBase}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: state.adminMobile, password: state.adminPassword }) });
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    for (const amount of ['111', '222']) {
      const r = await fetch(`${state.apiBase}/api/v1/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ clientTxnId: crypto.randomUUID(), customerId, amount, paymentDate: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10), mode: 'CASH' }),
      });
      expect(r.status).toBe(201);
    }
    await nav(page, 'Payments');
    for (const amount of ['₹111.00', '₹222.00']) await page.getByRole('row').filter({ hasText: amount }).locator('input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Delete selected' }).click();
    const bulk = page.getByRole('dialog', { name: /Delete 2 payments/ });
    await bulk.getByRole('button', { name: 'Test entry' }).click();
    await bulk.getByRole('button', { name: 'Delete payments' }).click();
    await expect(page.getByText('2 payments deleted')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: '₹111.00' })).toHaveCount(0);
  });

  test('dashboard totals equal the database ground truth', async ({ page }) => {
    await signIn(page);
    const kpis = page.getByTestId('kpis');
    await expect(kpis).toBeVisible();
    const outstanding = await sqlValue(
      `SELECT coalesce(sum(greatest(b, 0)), 0)::numeric(14,2)::text v FROM (SELECT sum(amount) b FROM ledger_entries GROUP BY customer_id) x`,
    );
    const advance = await sqlValue(
      `SELECT coalesce(sum(greatest(-b, 0)), 0)::numeric(14,2)::text v FROM (SELECT sum(amount) b FROM ledger_entries GROUP BY customer_id) x`,
    );
    const month = await sqlValue(
      `SELECT coalesce(sum(amount), 0)::numeric(14,2)::text v FROM payments WHERE status = 'CONFIRMED'
         AND date_trunc('month', payment_date) = date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date)`,
    );
    const active = await sqlValue(`SELECT count(*)::text v FROM customers WHERE status IN ('ACTIVE','SUSPENDED')`);
    await expect(kpis.getByRole('link', { name: /Total outstanding/ })).toContainText(formatInr(outstanding));
    await expect(kpis.getByRole('link', { name: /Total advance/ })).toContainText(formatInr(advance));
    await expect(kpis.getByText('Collected this month').locator('..')).toContainText(formatInr(month));
    await expect(kpis.getByRole('link', { name: /Active customers/ })).toContainText(active);
  });

  test('reports render and export to Excel', async ({ page }) => {
    await signIn(page);
    await nav(page, 'Reports');
    await page.getByRole('link', { name: /Customer Outstanding/ }).click();
    await expect(page.getByText('Total (all pages)')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Excel' }).click();
    expect((await download).suggestedFilename()).toMatch(/^outstanding_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  test('cash handover is counted and confirmed with a recorded shortage', async ({ page }) => {
    await signIn(page);
    await nav(page, 'Cash & handovers');
    await page.getByRole('tab', { name: 'Handovers' }).click();
    await page.getByRole('button', { name: 'Count & confirm' }).first().click();
    const dialog = page.getByRole('dialog', { name: /Confirm handover/ });
    await dialog.getByLabel('Cash counted by the office').fill('100');
    await dialog.getByLabel('Why is it different?').fill('Agent brought part of the cash');
    await dialog.getByRole('button', { name: 'Confirm received' }).click();
    await expect(page.getByText('Handover confirmed')).toBeVisible();
    const open = await sqlValue(`SELECT count(*)::text v FROM system_alerts WHERE type = 'CASH_MISMATCH' AND resolved_at IS NULL`);
    expect(Number(open)).toBe(1);
  });

  test('temporary cover can be set up and ended from the Assignments page', async ({ page }) => {
    await signIn(page);
    await nav(page, 'Assignments');
    await page.getByRole('button', { name: 'Temporary cover' }).click();
    const dialog = page.getByRole('dialog', { name: 'Temporary cover' });
    await dialog.getByLabel('Agent who is away').selectOption({ label: 'Ramesh Patel (AG1)' });
    await dialog.getByLabel('Covered by').selectOption({ label: 'Suresh Rathod (AG2)' });
    await dialog.getByLabel('Reason').fill('Ramesh on leave');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/customer\(s\) covered/)).toBeVisible();
    await expect(page.locator('tbody')).toContainText('Suresh Rathod');
    await page.getByRole('button', { name: 'End now' }).click();
    await page.getByRole('dialog', { name: 'End temporary cover now' }).getByLabel('Reason').fill('Back early');
    await page.getByRole('dialog', { name: 'End temporary cover now' }).getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Temporary cover ended')).toBeVisible();
  });
  test('offline entries from agents’ phones are listed with the reason and can be marked checked', async ({ page }) => {
    // An agent's phone sends a payment while its clock is three days behind: posted, flagged CLOCK_SKEW.
    const post = (path: string, body: unknown, token?: string) =>
      fetch(`${state.apiBase}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const login = (await (await post('/auth/login', { mobile: state.agentMobile, password: state.agentPassword })).json()) as { data: { accessToken: string } };
    const token = login.data.accessToken;
    const pull = (await (await fetch(`${state.apiBase}/api/v1/sync/pull`, { headers: { authorization: `Bearer ${token}` } })).json()) as { data: { customers: { id: string; name: string }[]; nextProvisionalSeq: number; agent: { code: string } } };
    const customer = pull.data.customers[0]!;
    const phoneNow = Date.now() - 3 * 86_400_000;
    const push = await post(
      '/sync/push',
      {
        deviceTime: new Date(phoneNow).toISOString(),
        ops: [{ opId: crypto.randomUUID(), type: 'PAYMENT_CREATE', seq: 1, createdAt: new Date(phoneNow).toISOString(), offline: true, payload: { customerId: customer.id, amount: '10', mode: 'CASH', provisionalRef: `P-${pull.data.agent.code}-${String(pull.data.nextProvisionalSeq).padStart(6, '0')}` } }],
      },
      token,
    );
    const outcome = ((await push.json()) as { data: { results: { status: string; flags: string[] }[] } }).data.results[0]!;
    expect(outcome).toMatchObject({ status: 'NEEDS_REVIEW', flags: ['CLOCK_SKEW'] });

    await signIn(page);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByLabel('1 to review')).toBeVisible();
    await page.goto('/offline-entries');
    const row = page.getByRole('row').filter({ hasText: customer.name });
    await expect(row.getByText('Held — verify in Payments')).toBeVisible(); // a wrong phone clock holds the payment
    await expect(row.getByText('The phone clock was more than a day off', { exact: false })).toBeVisible();
    await row.getByRole('button', { name: 'Mark checked' }).click();
    await page.getByRole('dialog', { name: 'Mark as checked' }).getByLabel('Note (what you checked or did)').fill('Agent phone date fixed');
    await page.getByRole('dialog', { name: 'Mark as checked' }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Nothing to check').filter({ visible: true }).first()).toBeVisible();
    expect(await sqlValue(`SELECT review_note AS v FROM sync_operations WHERE customer_id = '${customer.id}'`)).toBe('Agent phone date fixed');
  });
  test('a payment the agent deleted on the phone shows as "deleted by agent" with the reason; the month calendar shows the dues', async ({ page }) => {
    const post = (path: string, body: unknown, token?: string) =>
      fetch(`${state.apiBase}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const login = (await (await post('/auth/login', { mobile: state.agentMobile, password: state.agentPassword })).json()) as { data: { accessToken: string } };
    const token = login.data.accessToken;
    const pull = (await (await fetch(`${state.apiBase}/api/v1/sync/pull`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      data: { customers: { id: string; name: string; outstanding: string }[]; nextProvisionalSeq: number; agent: { code: string } };
    };
    const customer = pull.data.customers.find((c) => c.outstanding !== '0.00')!;
    const payOp = crypto.randomUUID();
    const now = new Date().toISOString();
    const res = await post(
      '/sync/push',
      {
        deviceTime: now,
        ops: [
          { opId: payOp, type: 'PAYMENT_CREATE', seq: 1, createdAt: now, offline: false, payload: { customerId: customer.id, amount: '123', mode: 'CASH', provisionalRef: `P-${pull.data.agent.code}-${String(pull.data.nextProvisionalSeq + 5).padStart(6, '0')}` } },
          { opId: crypto.randomUUID(), type: 'PAYMENT_CANCEL', seq: 2, createdAt: now, offline: false, payload: { customerId: customer.id, paymentOpId: payOp, reason: 'Wrong customer' } },
        ],
      },
      token,
    );
    const results = ((await res.json()) as { data: { results: { status: string }[] } }).data.results;
    expect(results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);

    await signIn(page);
    await expect(page.getByTestId('kpis')).toBeVisible();
    await page.goto(`/customers/${customer.id}`);
    const calendar = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Month by month' }) });
    await expect(calendar).toBeVisible();
    await expect(calendar.getByText(/Not paid|Part paid/).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/office-calendar.png', fullPage: true });
    await page.getByRole('tab', { name: 'Payments' }).click();
    const row = page.getByRole('row').filter({ hasText: '₹123.00' });
    await expect(row.getByText('deleted by agent')).toBeVisible();
    await expect(row.getByText('Wrong customer')).toBeVisible();
    await page.goto('/alerts');
    await expect(page.getByText(/deleted the ₹123\.00 cash payment/).filter({ visible: true }).first()).toBeVisible();
  });

  test('a test payment removed with a refund: delete the refund in the Ledger, then the payment; a discount can be reversed', async ({ page }) => {
    const login = await fetch(`${state.apiBase}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: state.adminMobile, password: state.adminPassword }) });
    const token = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    const call = async (path: string, body: unknown) => {
      const r = await fetch(`${state.apiBase}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
      expect(r.status, await r.clone().text()).toBeLessThan(300);
      return ((await r.json()) as { data: { id: string } }).data;
    };
    const list = await fetch(`${state.apiBase}/api/v1/customers?pageSize=5&balance=SETTLED`, { headers: { authorization: `Bearer ${token}` } });
    const customer = ((await list.json()) as { data: { id: string }[] }).data[0]!;
    const istToday = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    await call('/payments', { clientTxnId: crypto.randomUUID(), customerId: customer.id, amount: '345', paymentDate: istToday, mode: 'CASH' });
    await call(`/customers/${customer.id}/refunds`, { amount: '345', mode: 'CASH', reason: 'Remove test money' });
    await call(`/customers/${customer.id}/credits`, { kind: 'CREDIT_ADJUSTMENT', amount: '55', reason: 'Goodwill' });

    await signIn(page);
    await expect(page.getByTestId('kpis')).toBeVisible();
    await page.goto(`/customers/${customer.id}`);
    // The payment cannot be deleted while it is refunded: the message says what to do.
    await page.getByRole('tab', { name: 'Payments' }).click();
    await page.getByRole('row').filter({ hasText: '₹345.00' }).getByRole('button', { name: 'Delete' }).click();
    let dialog = page.getByRole('dialog', { name: /Delete/ });
    await dialog.getByRole('button', { name: 'Test entry' }).click();
    await dialog.getByRole('button', { name: 'Delete payment' }).click();
    await expect(dialog.getByText(/Delete the refund first/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('tab', { name: 'Ledger' }).click();
    await page.getByRole('row').filter({ hasText: 'Refund' }).getByRole('button', { name: 'Delete' }).click();
    dialog = page.getByRole('dialog', { name: /Delete refund/ });
    await dialog.getByRole('button', { name: 'Test entry' }).click();
    await dialog.getByRole('button', { name: 'Delete refund' }).click();
    await expect(page.getByText('Refund deleted').first()).toBeVisible();
    // The discount/credit Reverse button works too.
    await page.getByRole('row').filter({ hasText: 'Credit adjustment' }).first().getByRole('button', { name: 'Reverse' }).click();
    dialog = page.getByRole('dialog', { name: /Reverse discount/ });
    await dialog.getByRole('button', { name: 'Entered by mistake' }).click();
    await dialog.getByRole('button', { name: 'Reverse' }).click();
    await expect(page.getByText('Credit reversed').first()).toBeVisible();

    await page.getByRole('tab', { name: 'Payments' }).click();
    await page.getByRole('row').filter({ hasText: '₹345.00' }).getByRole('button', { name: 'Delete' }).click();
    dialog = page.getByRole('dialog', { name: /Delete/ });
    await dialog.getByRole('button', { name: 'Test entry' }).click();
    await dialog.getByRole('button', { name: 'Delete payment' }).click();
    await expect(page.getByText('Payment deleted').first()).toBeVisible();
  });

  test('Excel import: check, correct, dry run, approve, import, then see the Excel history', async ({ page }) => {
    const year = new Date().getUTCFullYear() - 1;
    const c = (code: string, rate: number | string) => ({ code, name: `Import ${code}`, address: `${code} Import Nagar`, mobile: Number(`97${code}00`), rate, stb: `XLSTB${code}`, society: 'IMPORT NAGAR' });
    const workbook = await buildWorkbook([c('910001', 300), c('910002', 400), c('910003', 'AMP')], {
      '910001': monthly(year, 300),
      '910002': monthly(year, 400, 1, 10),
    });

    await signIn(page);
    await nav(page, 'Excel import');
    await page.getByLabel('Excel workbook (.xlsx)').setInputFiles({ name: 'customers.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook });
    await page.getByRole('button', { name: 'Upload and check' }).click();
    await expect(page.getByText('Checked — run a dry run').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText('Needs decision (AMP)').filter({ visible: true }).first()).toBeVisible();

    // The office decides the AMP customer's plan during the import.
    await page.getByRole('row').filter({ hasText: '910003' }).getByRole('button', { name: 'Correct' }).click();
    await page.getByRole('dialog').getByLabel('Monthly rate from cutover').fill('250');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('row').filter({ hasText: '910003' }).getByText('monthlyRate')).toBeVisible();

    await page.getByLabel(/Option B/).check();
    await page.getByLabel('Cutover month (the new system bills from the 1st)').fill(`${year + 1}-01`);
    await page.getByRole('button', { name: 'Run dry run' }).click();
    await expect(page.getByText('Dry run reconciles — waiting for approval').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Per-customer balance at cutover' }).getByText('Yes')).toBeVisible();
    expect(await sqlValue(`SELECT count(*)::text AS v FROM customers WHERE customer_code LIKE '9100%'`)).toBe('0'); // dry run saved nothing

    await page.getByLabel('I have checked this report against the workbook.').check();
    await page.getByRole('button', { name: 'Approve this result' }).click();
    await expect(page.getByText('Approved — ready to import').filter({ visible: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Import now' }).click();
    await page.getByRole('dialog', { name: 'Import into the live system?' }).getByRole('button', { name: 'Import' }).click();
    await expect(page.getByText('Imported', { exact: true }).first()).toBeVisible();
    expect(await sqlValue(`SELECT count(*)::text AS v FROM customers WHERE customer_code LIKE '9100%'`)).toBe('3');
    // 910002 paid Jan–Oct at 400: opening balance 800 due.
    expect(await sqlValue(`SELECT b.outstanding::text AS v FROM customer_balances b JOIN customers c ON c.id = b.customer_id WHERE c.customer_code = '910002'`)).toBe('800.00');

    const id = await sqlValue(`SELECT id::text AS v FROM customers WHERE customer_code = '910002'`);
    await page.goto(`/customers/${id}`);
    await page.getByRole('tab', { name: 'Excel history' }).click();
    await expect(page.getByRole('row').filter({ hasText: `${year}-10` }).getByText(formatInr('400'))).toHaveCount(3); // rate, received, fee adjusted
    await expect(page.getByRole('row').filter({ hasText: `${year}-12` }).getByText(formatInr('800'))).toBeVisible(); // amount due
  });
});
