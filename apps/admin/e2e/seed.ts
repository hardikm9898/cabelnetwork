/**
 * Demo / e2e seed through the public API (never touches the DB directly).
 * Synthetic customers only — no real customer data. Society names follow the workbook's
 * collection groups so the demo looks familiar.
 *
 * Usage (dev): node apps/admin/e2e/seed.ts http://localhost:3000 9000000001 <password>
 * Plain erasable TypeScript so Node can run it directly.
 */

export interface SeedResult {
  adminPassword: string;
  agents: { id: string; mobile: string; code: string; token: string }[];
  customers: { id: string; code: string; rate: string }[];
}

const AGENT_PASSWORD = 'Agent1234';
const SOCIETIES = [
  'Ambikanagar Society',
  'Ankit Swatantra Plot',
  'Babunagar',
  'Gokul Apartment',
  'Indra Apartment',
  'Laxmi Nagar',
  'Nayanramiy',
  'Rajratn Apartment',
  'Ratnadeep Society',
  'Shital Tenament',
  'Swetshyam Apartment',
  'Varsoya Park',
];

const pad = (n: number) => String(n).padStart(2, '0');
function istToday(): string {
  const d = new Date(Date.now() + 330 * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function monthStart(offset: number): string {
  const [y, m] = istToday().split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + offset;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}-01`;
}

export async function seed(base: string, adminMobile: string, password: string, newPassword = 'Office2026Seed'): Promise<SeedResult> {
  const call = async <T>(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text ? ((JSON.parse(text) as { data: T }).data as T) : (undefined as T);
  };
  const login = async (mobile: string, pwd: string) => (await call<{ accessToken: string; user: { mustChangePassword: boolean } }>(null, 'POST', '/auth/login', { mobile, password: pwd }));

  // Admin: replace the bootstrap password if needed.
  let adminPassword = password;
  let session = await login(adminMobile, password);
  if (session.user.mustChangePassword) {
    await call(session.accessToken, 'POST', '/auth/change-password', { currentPassword: password, newPassword });
    adminPassword = newPassword;
    session = await login(adminMobile, adminPassword);
  }
  const admin = session.accessToken;

  await call(admin, 'PUT', '/settings/business.profile', { name: 'Demo Cable Network', address: 'Chandlodia, Ahmedabad', phone: '9000000001', receiptFooter: 'Thank you for your payment.' });

  // Agents (password changed so they can sign in to the app).
  const agents: SeedResult['agents'] = [];
  for (const [i, name] of ['Ramesh Patel', 'Suresh Rathod'].entries()) {
    const mobile = `98000000${pad(i + 1)}`;
    const code = `AG${i + 1}`;
    const a = await call<{ id: string }>(admin, 'POST', '/agents', { fullName: name, mobile, agentCode: code, temporaryPassword: 'Temp12345' });
    const t = await login(mobile, 'Temp12345');
    await call(t.accessToken, 'POST', '/auth/change-password', { currentPassword: 'Temp12345', newPassword: AGENT_PASSWORD });
    agents.push({ id: a.id, mobile, code, token: (await login(mobile, AGENT_PASSWORD)).accessToken });
  }

  const areaA = await call<{ id: string }>(admin, 'POST', '/areas', { name: 'Area A' });
  const areaB = await call<{ id: string }>(admin, 'POST', '/areas', { name: 'Area B' });
  await call(admin, 'PUT', `/areas/${areaA.id}/owner`, { agentId: agents[0]!.id, reason: 'Initial setup' });
  await call(admin, 'PUT', `/areas/${areaB.id}/owner`, { agentId: agents[1]!.id, reason: 'Initial setup' });
  const societies: string[] = [];
  for (const [i, name] of SOCIETIES.entries()) {
    const s = await call<{ id: string }>(admin, 'POST', '/societies', { name, areaId: i < 6 ? areaA.id : areaB.id, collectionDay: [2, 7, 9][i % 3] });
    societies.push(s.id);
  }

  // Customers with subscriptions starting three months ago.
  const rates = ['400', '300', '500', '250', '550', '400', '300'];
  const customers: SeedResult['customers'] = [];
  for (let i = 0; i < 36; i++) {
    const code = String(500100 + i);
    const c = await call<{ customer: { id: string } }>(admin, 'POST', '/customers', {
      customerCode: code,
      name: `Demo Customer ${i + 1}`,
      mobile: `97${String(10000000 + i * 7919).slice(0, 8)}`,
      addressLine: `${i + 1}, ${SOCIETIES[i % SOCIETIES.length]}`,
      societyId: societies[i % societies.length],
      stbNumber: `307070260700${code}`,
      acknowledgeWarnings: true,
    });
    const rate = rates[i % rates.length]!;
    await call(admin, 'POST', `/customers/${c.customer.id}/subscription`, {
      monthlyRate: rate,
      startDate: monthStart(-3),
      billingIntervalMonths: i % 9 === 4 ? 3 : 1,
    });
    customers.push({ id: c.customer.id, code, rate });
  }
  await call(admin, 'POST', '/billing/runs', { asOf: istToday() });

  // Payment patterns: none / full / partial / advance / UPI pending / office payment.
  const agentFor = (i: number) => agents[SOCIETIES.indexOf(SOCIETIES[i % SOCIETIES.length]!) < 6 ? 0 : 1]!;
  for (const [i, c] of customers.entries()) {
    const balance = await call<{ outstanding: string }>(admin, 'GET', `/customers/${c.id}/balance`);
    const date = addDays(istToday(), -(i % 6));
    const pay = (token: string, amount: string, extra: Record<string, unknown> = {}) =>
      call(token, 'POST', '/payments', { clientTxnId: crypto.randomUUID(), customerId: c.id, amount, paymentDate: date, mode: 'CASH', ...extra });
    switch (i % 6) {
      case 1:
        await pay(agentFor(i).token, balance.outstanding);
        break;
      case 2:
        await pay(agentFor(i).token, c.rate);
        break;
      case 3:
        await pay(agentFor(i).token, String(Number(balance.outstanding) + Number(c.rate) * 2));
        break;
      case 4:
        await pay(agentFor(i).token, c.rate, { mode: 'UPI', reference: `UTR${500100 + i}` });
        break;
      case 5:
        await pay(admin, balance.outstanding, { mode: 'UPI', reference: `OFF${500100 + i}` });
        break;
      default:
        break; // no payment: overdue
    }
  }

  // A promise, a visit, and a cash handover waiting for the office.
  await call(admin, 'POST', `/customers/${customers[0]!.id}/interactions`, {
    channel: 'CALL',
    interactionType: 'PAYMENT_PROMISE',
    expectedAmount: '800',
    promiseDate: addDays(istToday(), 3),
    notes: 'Will pay after salary',
  });
  await call(agents[0]!.token, 'POST', `/customers/${customers[1]!.id}/visits`, { clientId: crypto.randomUUID(), outcome: 'NOT_AVAILABLE', followUpDate: addDays(istToday(), 1) });
  await call(agents[0]!.token, 'POST', '/cash/handovers', { declaredAmount: '1000' }, { 'idempotency-key': crypto.randomUUID() });

  return { adminPassword, agents, customers };
}

// CLI entry: node apps/admin/e2e/seed.ts <apiBase> <adminMobile> <password>
if (process.argv[1]?.endsWith('seed.ts') && process.argv.length >= 5) {
  seed(process.argv[2]!, process.argv[3]!, process.argv[4]!)
    .then((r) => console.log(`seeded ${r.customers.length} customers, ${r.agents.length} agents; admin password: ${r.adminPassword}; agent password: ${AGENT_PASSWORD}`))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
