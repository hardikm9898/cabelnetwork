import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, Page, test } from '@playwright/test';
import { Client } from 'pg';

interface State {
  apiBase: string;
  databaseUrl: string;
  adminPassword: string;
  agents: { id: string; mobile: string; code: string }[];
  agentPassword: string;
  newAgent: { mobile: string; tempPassword: string };
}
const state = JSON.parse(readFileSync(join(__dirname, '.state.json'), 'utf8')) as State;
const PIN = '2580';
const DOT = '·'; // "·" separator used in the UI
const GUJARATI_TODAYS_LIST = 'આજની યાદી'; // "આજની યાદી"

async function enterPin(page: Page, pin = PIN) {
  for (const d of pin) await page.getByTestId(`pin-${d}`).click();
}

async function signIn(page: Page, mobile: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill(mobile);
  await page.getByLabel('Password').fill(password);
  await page.getByTestId('sign-in').click();
}

/** Sign in, set the PIN, land on home with the customer list downloaded. */
async function start(page: Page, agentIndex = 0) {
  await signIn(page, state.agents[agentIndex]!.mobile, state.agentPassword);
  await expect(page.getByText('Set a 4-digit PIN').first()).toBeVisible();
  await enterPin(page);
  await expect(page.getByText('Enter the PIN again')).toBeVisible();
  await enterPin(page);
  await expect(page.getByTestId('collected-today')).toBeVisible();
}

/** Screens stay mounted under the current one; only assert on what is actually shown. */
const visibleText = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: state.databaseUrl });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Opens the first pending "Demo Customer" of the signed-in agent; returns its name and id. */
async function openPendingCustomer(page: Page) {
  await page.getByTestId('go-list').click();
  await page.getByTestId('filter-pending').click();
  const card = page.getByRole('button', { name: /Demo Customer/ }).first();
  const name = (await card.getAttribute('aria-label'))!.split(',')[0]!;
  await card.click();
  const [row] = await query<{ id: string }>('SELECT id FROM customers WHERE name = $1', [name]);
  return { name, id: row!.id };
}

async function collectFullDue(page: Page) {
  await page.getByTestId('collect').click();
  await page.getByTestId('amount-full').click();
  await page.getByTestId('save-payment').click();
}

/** Records URLs the app opens (WhatsApp links) instead of opening them. */
async function captureOpenedUrls(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = ((u: string | URL) => {
      w.__opened.push(String(u));
      return null;
    }) as typeof window.open;
  });
  return async () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
}

async function adminToken() {
  const res = await fetch(`${state.apiBase}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: '9000000001', password: state.adminPassword }) });
  return ((await res.json()) as { data: { accessToken: string } }).data.accessToken;
}

const paymentsByRef = (ref: string) =>
  query<{ id: string; recorded_offline: boolean; review_flags: string[]; collected_by: string; status: string }>('SELECT id, recorded_offline, review_flags, collected_by, status FROM payments WHERE provisional_ref = $1', [ref]);

test.describe.serial('agent app', () => {
  test('first sign-in: replace the temporary password, then set a PIN', async ({ page }) => {
    await signIn(page, state.newAgent.mobile, state.newAgent.tempPassword);
    await expect(page.getByText('Your password is temporary')).toBeVisible();
    await page.getByLabel('Temporary password').fill(state.newAgent.tempPassword);
    await page.getByLabel('New password', { exact: true }).fill('Field2026');
    await page.getByLabel('New password again').fill('Field2026');
    await page.getByTestId('save-password').click();
    await expect(page.getByText('Set a 4-digit PIN').first()).toBeVisible();
    await enterPin(page);
    await enterPin(page);
    await expect(page.getByText('Hello, New Agent')).toBeVisible();
  });

  test('change password from Profile; the new password works at the next sign-in', async ({ page }) => {
    await signIn(page, state.newAgent.mobile, 'Field2026');
    await enterPin(page);
    await enterPin(page);
    await page.getByRole('button', { name: 'Profile' }).click();
    await page.getByTestId('change-password').click();
    await page.getByLabel('Current password').fill('Field2026');
    await page.getByLabel('New password', { exact: true }).fill('Field2027');
    await page.getByLabel('New password again').fill('Field2027');
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('save-password').click();
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await page.getByTestId('sign-out').click();
    await signIn(page, state.newAgent.mobile, 'Field2027');
    await expect(page.getByText('Set a 4-digit PIN').first()).toBeVisible();
  });

  test('office staff cannot use the agent app', async ({ page }) => {
    await signIn(page, '9000000001', state.adminPassword);
    await expect(page.getByText('This app is for field agents')).toBeVisible();
  });

  test('the list shows only the signed-in agent customers', async ({ page }) => {
    await start(page, 0);
    await page.getByTestId('go-list').click();
    await page.getByTestId('filter-all').click();
    const mine = await query<{ customer_code: string }>(
      `SELECT c.customer_code FROM customer_current_agent ca JOIN customers c ON c.id = ca.customer_id WHERE ca.agent_id = $1`,
      [state.agents[0]!.id],
    );
    const theirs = await query<{ customer_code: string }>(
      `SELECT c.customer_code FROM customer_current_agent ca JOIN customers c ON c.id = ca.customer_id WHERE ca.agent_id = $1`,
      [state.agents[1]!.id],
    );
    await expect(page.getByText(`All (${mine.length})`)).toBeVisible();
    const body = await page.locator('body').innerText();
    for (const c of theirs) expect(body).not.toContain(c.customer_code);
    // The phone's own copy holds nothing else either.
    const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cc.kv:customer:')).length);
    expect(stored).toBe(mine.length);
  });

  test('collect a payment: full due to receipt within 15 seconds', async ({ page }) => {
    await start(page, 0);
    const { name } = await openPendingCustomer(page);
    const due = (await page.getByTestId('customer-due').innerText()).trim();

    const started = Date.now();
    await collectFullDue(page);
    await expect(page.getByTestId('payment-result')).toHaveText('Payment saved');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    await expect(page.getByTestId('receipt-number')).toContainText(/RCPT\/\d{4}-\d{2}\/\d{6}/);
    await expect(visibleText(page, 'All dues cleared')).toBeVisible();
    await expect(page.getByText(due, { exact: true }).filter({ visible: true }).first()).toBeVisible();

    // The payment also recorded the visit (outcome decided by the server).
    const visits = await query<{ outcome: string }>(
      `SELECT v.outcome FROM visits v JOIN customers c ON c.id = v.customer_id WHERE c.name = $1 ORDER BY v.created_at DESC LIMIT 1`,
      [name],
    );
    expect(visits[0]?.outcome).toBe('PAYMENT_COLLECTED');
    console.log(`payment entry (automated): ${elapsed} ms`);
  });

  test('record a visit: not available, come back tomorrow', async ({ page }) => {
    await start(page, 0);
    await openPendingCustomer(page);
    await page.getByRole('button', { name: 'Record visit' }).click();
    await page.getByTestId('outcome-NOT_AVAILABLE').click();
    await page.getByRole('button', { name: 'Tomorrow' }).last().click();
    await page.getByTestId('save-visit').click();
    await expect(visibleText(page, new RegExp(`${DOT} Not available`))).toBeVisible();
    await expect
      .poll(async () => Number((await query<{ n: string }>(`SELECT count(*)::text n FROM follow_up_tasks WHERE assigned_to = $1 AND status = 'OPEN'`, [state.agents[0]!.id]))[0]!.n))
      .toBeGreaterThan(0);
  });

  test('cash handover from the phone', async ({ page }) => {
    await start(page, 1);
    await page.getByTestId('go-cash').click();
    const expected = (await page.getByTestId('cash-to-hand-over').innerText()).split(DOT)[0]!.trim();
    await page.getByRole('button', { name: /Full due/ }).click();
    await page.getByTestId('submit-handover').click();
    await expect(visibleText(page, 'Handover submitted')).toBeVisible();
    await expect(visibleText(page, 'Waiting for the office to confirm')).toBeVisible();
    const h = await query<{ expected_amount: string }>(`SELECT expected_amount::text FROM cash_handovers WHERE agent_id = $1 AND status = 'SUBMITTED'`, [state.agents[1]!.id]);
    expect(expected.replace(/[^0-9.]/g, '')).toBe(h[0]!.expected_amount);
  });

  test('reopening the app asks for the PIN; wrong PINs are counted', async ({ page }) => {
    await start(page, 0);
    await page.reload();
    await expect(page.getByText('Enter your PIN')).toBeVisible();
    await enterPin(page, '1111');
    await expect(page.getByText('Wrong PIN (4)')).toBeVisible();
    await enterPin(page);
    await expect(page.getByTestId('collected-today')).toBeVisible();
  });

  test('overdue customers show how long the due has been open', async ({ page }) => {
    await start(page, 0);
    await page.getByTestId('go-list').click();
    await page.getByTestId('filter-overdue').click();
    await expect(visibleText(page, /Due since \d{2}-\d{2}-\d{4}/)).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Phase 6 gate: offline
  // ---------------------------------------------------------------------------

  test('airplane mode: collect offline, share a provisional receipt, post exactly once after reconnecting', async ({ page }) => {
    await start(page, 0);
    const { name } = await openPendingCustomer(page);
    await page.context().setOffline(true);
    await expect(visibleText(page, 'No internet. Entries are saved on the phone')).toBeVisible();

    await collectFullDue(page);
    await expect(page.getByTestId('payment-result')).toHaveText('Provisional receipt');
    const ref = (await page.getByTestId('provisional-ref').innerText()).trim();
    expect(ref).toMatch(new RegExp(`^P-${state.agents[0]!.code}-\\d{6}$`));
    expect(await paymentsByRef(ref)).toHaveLength(0); // nothing reached the office

    const opened = await captureOpenedUrls(page);
    await page.getByTestId('share-provisional').click();
    const [url] = await opened();
    const text = decodeURIComponent(new URL(url!).searchParams.get('text') ?? '');
    expect(text).toContain(`PROVISIONAL receipt ${ref}`);
    expect(text).toContain(name);
    expect(text).not.toMatch(/Balance due/); // the phone never states a balance on its own

    // Back online: sent automatically, the same screen turns into the final receipt.
    await page.context().setOffline(false);
    await expect(page.getByTestId('payment-result')).toHaveText('Payment saved', { timeout: 30_000 });
    await expect(page.getByTestId('receipt-number')).toContainText(/RCPT\//);

    const rows = await paymentsByRef(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recorded_offline: true, collected_by: state.agents[0]!.id, status: 'CONFIRMED' });
    expect(await query('SELECT op_id FROM sync_operations WHERE payment_id = $1', [rows[0]!.id])).toHaveLength(1);
  });

  test('a lost server answer does not post twice', async ({ page }) => {
    await start(page, 0);
    await openPendingCustomer(page);
    // The office receives the first send, but the phone never hears back.
    let lost = 0;
    await page.route('**/api/v1/sync/push', async (route) => {
      if (lost++ === 0) {
        await route.fetch();
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });
    await collectFullDue(page);
    await expect(page.getByTestId('payment-result')).toHaveText('Provisional receipt');
    const ref = (await page.getByTestId('provisional-ref').innerText()).trim();
    expect(await paymentsByRef(ref)).toHaveLength(1); // already posted on the server

    // The automatic retry gets "already received" with the original receipt.
    await expect(page.getByTestId('payment-result')).toHaveText('Payment saved', { timeout: 30_000 });
    expect(lost).toBeGreaterThanOrEqual(2);
    expect(await paymentsByRef(ref)).toHaveLength(1);
  });

  test('reassigned while offline: the payment is posted, flagged for the office, and the customer leaves the list', async ({ page }) => {
    await start(page, 0);
    const { name, id } = await openPendingCustomer(page);
    await page.context().setOffline(true);
    await collectFullDue(page);
    await expect(page.getByTestId('payment-result')).toHaveText('Provisional receipt');
    const ref = (await page.getByTestId('provisional-ref').innerText()).trim();

    // Meanwhile the office moves the customer to the other agent.
    const res = await fetch(`${state.apiBase}/api/v1/assignments/permanent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await adminToken()}` },
      body: JSON.stringify({ agentId: state.agents[1]!.id, customerIds: [id], reason: 'Route change (e2e)' }),
    });
    expect(res.status).toBe(200);

    await page.context().setOffline(false);
    // Held for the office: recorded against this agent, counted once the office verifies it.
    await expect(page.getByTestId('payment-result')).toHaveText('Saved — waiting for office check', { timeout: 30_000 });
    await expect(page.getByTestId('office-will-check')).toBeVisible();
    await expect(visibleText(page, 'moved to another agent')).toBeVisible();
    const [p] = await paymentsByRef(ref);
    expect(p).toMatchObject({ collected_by: state.agents[0]!.id, review_flags: ['REASSIGNED_BEFORE_SYNC'], status: 'PENDING_VERIFICATION' });

    await page.getByTestId('done').click();
    await page.getByTestId('filter-all').click();
    await expect(page.getByRole('button', { name: new RegExp(`^${name},`) })).toHaveCount(0);
  });

  test('old data warns that balances may be out of date', async ({ page }) => {
    await page.clock.install();
    await start(page, 0);
    await expect(page.getByTestId('stale-banner')).toHaveCount(0);
    await page.context().setOffline(true);
    await page.clock.fastForward('13:00:00');
    await expect(page.getByTestId('stale-banner')).toBeVisible();
    await expect(page.getByTestId('stale-banner')).toContainText('Balances may be out of date');
  });

  test('signing out with unsent entries warns, keeps them, and sends them at the next sign-in', async ({ page }) => {
    await start(page, 0);
    await openPendingCustomer(page);
    await page.route('**/api/v1/sync/push', (route) => route.abort('failed')); // no signal for sending
    await collectFullDue(page);
    await expect(page.getByTestId('payment-result')).toHaveText('Provisional receipt');
    const ref = (await page.getByTestId('provisional-ref').innerText()).trim();

    // Reopen the app (PIN) to reach Profile from home.
    await page.reload();
    await enterPin(page);
    await expect(page.getByTestId('sync-status')).toContainText('Waiting to send: 1');
    await page.getByRole('button', { name: 'Profile' }).click();
    await page.getByTestId('sign-out').click();
    await expect(page.getByTestId('unsent-warning')).toContainText('not sent yet');
    await page.getByTestId('sign-out').click();
    await expect(page.getByLabel('Mobile number')).toBeVisible();
    // Customer data left the phone; the unsent entry did not.
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.filter((k) => k.startsWith('cc.kv:customer:'))).toHaveLength(0);
    expect(keys.filter((k) => k.startsWith('cc.kv:op:')).length).toBeGreaterThan(0);
    expect(await paymentsByRef(ref)).toHaveLength(0);

    await page.unroute('**/api/v1/sync/push');
    await page.getByLabel('Mobile number').fill(state.agents[0]!.mobile);
    await page.getByLabel('Password').fill(state.agentPassword);
    await page.getByTestId('sign-in').click();
    await enterPin(page);
    await enterPin(page);
    await expect.poll(async () => (await paymentsByRef(ref)).length, { timeout: 30_000 }).toBe(1);
  });

  test('switches to Gujarati', async ({ page }) => {
    await start(page, 0);
    await page.getByRole('button', { name: 'Profile' }).click();
    await page.getByTestId('lang-gu').click();
    await page.goBack();
    await expect(page.getByTestId('go-list')).toHaveText(GUJARATI_TODAYS_LIST);
  });
});
