/**
 * Load test at production scale (DEVELOPMENT_ROADMAP Phase 8: 20,000 customers).
 *
 * Runs against the production stack (docker/compose.prod.yml) through Caddy, like real clients:
 *   node -r @swc-node/register scripts/load-test.ts --base http://localhost:8088 \
 *     --admin 9000000001 --password <admin password> --customers 20000 --months 4
 *
 * 1. Two agents, two areas (one per agent), 100 societies — through the API.
 * 2. Customers, set-top boxes, agent assignments and subscriptions — bulk SQL via the db container
 *    (20,000 API calls would only measure the seeding).
 * 3. Everything else through the API: the billing run creates the bills; agents post payments
 *    concurrently and through offline sync; reads, reports, sync downloads, the reconciliation.
 * Prints a JSON summary (also written to scripts/load-test-result.json).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:8088' },
    admin: { type: 'string', default: '9000000001' },
    password: { type: 'string' },
    customers: { type: 'string', default: '20000' },
    months: { type: 'string', default: '4' },
    payments: { type: 'string', default: '2000' },
    concurrency: { type: 'string', default: '20' },
    compose: { type: 'string', default: 'docker/compose.prod.yml' },
    envFile: { type: 'string', default: 'docker/prod.env.local' },
    /** Continue after steps 1–2 (agents and customers already seeded by an earlier run). */
    resume: { type: 'boolean', default: false },
  },
});
const BASE = `${args.base!.replace(/\/$/, '')}/api/v1`;
const N = Number(args.customers);
const MONTHS = Number(args.months);

type Json = Record<string, unknown>;
async function call<T = Json>(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; data: T; bytes: number; ms: number; text: string }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  let data: T = {} as T;
  try {
    data = (JSON.parse(text) as { data: T }).data;
  } catch {
    /* binary */
  }
  return { status: res.status, data, bytes: Buffer.byteLength(text), ms, text };
}
async function must<T = Json>(method: string, path: string, token: string | null, body?: unknown) {
  const r = await call<T>(method, path, token, body);
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${r.text.slice(0, 300)}`);
  return r;
}
const login = async (mobile: string, password: string) => (await must<{ accessToken: string }>('POST', '/auth/login', null, { mobile, password })).data.accessToken;

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1]!) };
}
async function timed(n: number, fn: () => Promise<{ ms: number; bytes?: number }>) {
  const ms: number[] = [];
  let bytes = 0;
  for (let i = 0; i < n; i++) {
    const r = await fn();
    ms.push(r.ms);
    bytes = r.bytes ?? bytes;
  }
  return { ...stats(ms), bytes };
}
async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}
function psql(sqlText: string) {
  return execFileSync('docker', ['compose', '-f', args.compose!, '--env-file', args.envFile!, 'exec', '-T', 'db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'cablenet', '-d', 'cablenet', '-Atq'], {
    input: sqlText,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const monthStart = (back: number) => {
  const d = new Date(Date.now() + 330 * 60_000);
  const idx = d.getUTCFullYear() * 12 + d.getUTCMonth() - back;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
};

async function main() {
  const result: Json = { customers: N, months: MONTHS, at: new Date().toISOString() };
  const admin = await login(args.admin!, args.password!);

  const agents: { id: string; mobile: string; token: string }[] = [];
  if (args.resume) {
    const rows = psql(`SELECT u.id || ',' || u.mobile FROM users u JOIN agent_profiles a ON a.user_id = u.id WHERE a.agent_code LIKE 'LT%' ORDER BY a.agent_code;`).split('\n');
    for (const r of rows) {
      const [id, mobile] = r.split(',') as [string, string];
      agents.push({ id, mobile, token: await login(mobile, 'LoadTest2026') });
    }
  } else {
    await setup(admin, agents, result);
  }

  // --- 3. billing run: started through the API, measured from the database ---------------------
  // (A 20,000-customer catch-up takes minutes; the HTTP client would give up waiting for the
  // response while the server carries on, so completion is read from billing_runs.)
  if (!args.resume) void call('POST', '/billing/runs', admin, { asOf: istToday() }).catch(() => undefined);
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const running = Number(psql(`SELECT count(*) FROM billing_runs WHERE status = 'RUNNING';`));
    if (running === 0) break;
  }
  result.billingRun = JSON.parse(
    psql(`SELECT json_build_object('invoices', (SELECT count(*) FROM invoices), 'runs', count(*), 'seconds', extract(epoch FROM max(finished_at) - min(started_at))::int,
      'errors', sum(jsonb_array_length(coalesce(errors, '[]'::jsonb)))) FROM billing_runs;`),
  );
  await reads(admin, agents, result);
}

async function setup(admin: string, agents: { id: string; mobile: string; token: string }[], result: Json) {
  // --- 1. agents, areas, societies (API) -------------------------------------------------------
  for (const [i, code] of ['LT1', 'LT2'].entries()) {
    const mobile = `97000000${i}${Date.now() % 10}`.slice(0, 10);
    const a = await must<{ id: string }>('POST', '/agents', admin, { fullName: `Load Agent ${code}`, mobile, agentCode: `${code}${Date.now() % 1000}`, temporaryPassword: 'Temp12345' });
    const temp = await login(mobile, 'Temp12345');
    await must('POST', '/auth/change-password', temp, { currentPassword: 'Temp12345', newPassword: 'LoadTest2026' });
    agents.push({ id: a.data.id, mobile, token: await login(mobile, 'LoadTest2026') });
  }
  const areas: string[] = [];
  for (const [i, ag] of agents.entries()) {
    const area = await must<{ id: string }>('POST', '/areas', admin, { name: `Load Area ${i + 1} ${Date.now()}` });
    await must('PUT', `/areas/${area.data.id}/owner`, admin, { agentId: ag.id, reason: 'Load test' });
    areas.push(area.data.id);
  }
  const societies: string[] = [];
  for (let s = 0; s < 100; s++) {
    societies.push((await must<{ id: string }>('POST', '/societies', admin, { name: `Load Society ${s} ${Date.now()}`, areaId: areas[s % 2] })).data.id);
  }
  const adminId = psql(`SELECT id FROM users WHERE role = 'SUPER_ADMIN' ORDER BY created_at LIMIT 1;`);

  // --- 2. customers + subscriptions (bulk SQL) -------------------------------------------------
  const start = monthStart(MONTHS - 1);
  const t0 = performance.now();
  psql(`
    BEGIN;
    CREATE TEMP TABLE soc(n int, id uuid, area uuid);
    INSERT INTO soc VALUES ${societies.map((id, n) => `(${n}, '${id}', '${areas[n % 2]}')`).join(',')};
    CREATE TEMP TABLE own(area uuid, agent uuid);
    INSERT INTO own VALUES ${areas.map((a, i) => `('${a}', '${agents[i]!.id}')`).join(',')};
    WITH c AS (
      INSERT INTO customers (customer_code, name, mobile, address_line, society_id, created_by, updated_by)
      SELECT 'L' || lpad(g::text, 7, '0'), 'Load Customer ' || g, '9' || lpad(g::text, 9, '0'), g || ', Load Nagar', s.id, '${adminId}', '${adminId}'
      FROM generate_series(1, ${N}) g JOIN soc s ON s.n = g % 100
      RETURNING id, customer_code, society_id
    ), conn AS (
      INSERT INTO customer_connections (customer_id, stb_number, active_from, created_by)
      SELECT id, 'LSTB' || substr(customer_code, 2), '${start}', '${adminId}' FROM c
    ), asg AS (
      INSERT INTO customer_agent_assignments (customer_id, agent_id, kind, source, valid_during, reason, created_by)
      SELECT c.id, own.agent, 'PRIMARY', 'AREA_DEFAULT', tstzrange(now() - interval '400 days', NULL), 'Load test', '${adminId}'
      FROM c JOIN soc ON soc.id = c.society_id JOIN own ON own.area = soc.area
    ), sub AS (
      INSERT INTO customer_subscriptions (customer_id, start_date, billing_anchor_day, next_period_start, created_by, updated_by)
      SELECT id, '${start}', 1, '${start}', '${adminId}', '${adminId}' FROM c
      RETURNING id, customer_id
    )
    INSERT INTO subscription_rates (subscription_id, monthly_rate, effective_from, reason, created_by)
    SELECT sub.id, CASE WHEN c.customer_code::text ~ '[13579]$' THEN 300 ELSE 400 END, '${start}', 'Load test', '${adminId}'
    FROM sub JOIN c ON c.id = sub.customer_id;
    COMMIT;
  `);
  result.seedSeconds = Math.round((performance.now() - t0) / 1000);
}

async function reads(admin: string, agents: { id: string; mobile: string; token: string }[], result: Json) {
  // --- 4. reads ----------------------------------------------------------------------------------
  const a0 = agents[0]!;
  const pull = await must<{ customers: unknown[] }>('GET', '/sync/pull', a0.token);
  result.syncPull = {
    ...(await timed(5, () => call('GET', '/sync/pull', a0.token))),
    customers: pull.data.customers.length,
    jsonBytes: pull.bytes,
    gzipBytes: gzipSync(pull.text).length,
  };
  result.worklist = await timed(10, () => call('GET', '/collections/today?filter=pending&sort=outstanding', a0.token));
  result.myDay = await timed(10, () => call('GET', '/dashboard/me', a0.token));
  result.adminDashboard = await timed(5, () => call('GET', '/dashboard', admin));
  result.customerSearch = await timed(10, () => call('GET', `/customers?q=Customer%2012&pageSize=25`, admin));
  result.customerList = await timed(10, () => call('GET', `/customers?page=200&pageSize=50`, admin));
  result.outstandingReport = await timed(3, () => call('GET', '/reports/outstanding?pageSize=100', admin));
  const tx = performance.now();
  const xlsx = await call('GET', '/reports/customer-master?format=xlsx', admin);
  result.customerMasterXlsx = { ms: Math.round(performance.now() - tx), status: xlsx.status, bytes: xlsx.bytes };

  // --- 5. payments: concurrent agents (API) ----------------------------------------------------
  const worklists = await Promise.all(agents.map((a) => must<{ items: { id: string; outstanding: string }[] }>('GET', '/collections/today?filter=pending', a.token)));
  const P = Number(args.payments);
  const jobs = agents.flatMap((a, i) => worklists[i]!.data.items.slice(0, P / 2).map((c) => ({ a, c })));
  const payMs: number[] = [];
  let payErrors = 0;
  const tp = performance.now();
  await pool(jobs, Number(args.concurrency), async ({ a, c }) => {
    const r = await call('POST', '/payments', a.token, { clientTxnId: randomUUID(), customerId: c.id, amount: c.outstanding, paymentDate: istToday(), mode: 'CASH' });
    if (r.status !== 201) payErrors++;
    payMs.push(r.ms);
  });
  result.payments = { ...stats(payMs), errors: payErrors, perSecond: Math.round(jobs.length / ((performance.now() - tp) / 1000)) };

  // --- 6. offline sync pushes (API) --------------------------------------------------------------
  const pushMs: number[] = [];
  const remaining = worklists[1]!.data.items.slice(P / 2, P / 2 + 1000);
  const pullAgent = await must<{ nextProvisionalSeq: number; agent: { code: string } }>('GET', '/sync/pull', agents[1]!.token);
  let seq = pullAgent.data.nextProvisionalSeq;
  for (let b = 0; b < remaining.length; b += 50) {
    const ops = remaining.slice(b, b + 50).map((c, k) => ({
      opId: randomUUID(),
      type: 'PAYMENT_CREATE',
      seq: b + k + 1,
      createdAt: new Date().toISOString(),
      offline: true,
      payload: { customerId: c.id, amount: '100', mode: 'CASH', provisionalRef: `P-${pullAgent.data.agent.code}-${String(seq++).padStart(6, '0')}`, visitId: randomUUID() },
    }));
    const r = await must<{ results: { status: string }[] }>('POST', '/sync/push', agents[1]!.token, { deviceTime: new Date().toISOString(), ops });
    if (r.data.results.some((x) => x.status !== 'APPLIED')) throw new Error(`sync push: ${JSON.stringify(r.data.results.filter((x) => x.status !== 'APPLIED').slice(0, 3))}`);
    pushMs.push(r.ms);
  }
  result.syncPushBatchesOf50 = stats(pushMs);

  // --- 7. reconciliation over everything ---------------------------------------------------------
  const tr = performance.now();
  const rec = await must<{ checkedCustomers: number; customerMismatches: unknown[]; invoiceCacheMismatches: unknown[]; overAllocatedCredits: unknown[] }>('POST', '/reconciliation/run', admin);
  result.reconciliation = {
    seconds: Math.round((performance.now() - tr) / 1000),
    checkedCustomers: rec.data.checkedCustomers,
    mismatches: rec.data.customerMismatches.length + rec.data.invoiceCacheMismatches.length + rec.data.overAllocatedCredits.length,
  };
  result.volume = JSON.parse(
    psql(`SELECT json_build_object('customers', (SELECT count(*) FROM customers), 'invoices', (SELECT count(*) FROM invoices), 'payments', (SELECT count(*) FROM payments),
      'ledger_entries', (SELECT count(*) FROM ledger_entries), 'allocations', (SELECT count(*) FROM allocations), 'db_size', pg_size_pretty(pg_database_size('cablenet')));`),
  );

  console.log(JSON.stringify(result, null, 2));
  writeFileSync(join(__dirname, 'load-test-result.json'), JSON.stringify(result, null, 2));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
