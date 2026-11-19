import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { seed } from '../../admin/e2e/seed';

/**
 * Agent app e2e: PostgreSQL 18 (Testcontainers) → API :3102 → agent web build (Expo export)
 * served on :4175. The web build is the same React Native code rendered with react-native-web.
 */
const here = __dirname;
const apiDir = resolve(here, '../../api');
const agentDir = resolve(here, '..');
export const STATE_FILE = join(here, '.state.json');
const API_PORT = 3102;
const WEB_PORT = 4175;

async function waitFor(url: string, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npx' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
}

/** Static server with single-page-app fallback. */
function serve(dir: string, port: number): Promise<Server> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let file = join(dir, path);
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

export default async function globalSetup() {
  const pg = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('cablenet').withUsername('e2e').withPassword('e2e').start();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: pg.getConnectionUri(),
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
    PORT: String(API_PORT),
    LOG_LEVEL: 'warn',
    JOBS_ENABLED: 'false',
    RATE_LIMIT_PER_MINUTE: '100000',
    LOGIN_RATE_LIMIT_PER_MINUTE: '100000',
    CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
    BOOTSTRAP_PASSWORD: 'Bootstrap123',
  };
  const register = ['-r', '@swc-node/register'];
  run(process.execPath, [...register, 'src/cli.ts', 'migrate'], apiDir, env);
  run(process.execPath, [...register, 'src/cli.ts', 'create-super-admin', '--mobile', '9000000001', '--name', 'E2E Owner'], apiDir, env);

  const procs: ChildProcess[] = [];
  procs.push(spawn(process.execPath, [...register, 'src/main.ts'], { cwd: apiDir, env, stdio: ['ignore', 'inherit', 'inherit'] }));
  await waitFor(`http://localhost:${API_PORT}/api/v1/health`);

  // Web build with the API location baked in (EXPO_PUBLIC_*).
  run('npx', ['expo', 'export', '--platform', 'web', '--output-dir', 'dist-e2e', '--clear'], agentDir, { ...process.env, EXPO_PUBLIC_API_URL: `http://localhost:${API_PORT}`, CI: '1' });
  const web = await serve(join(agentDir, 'dist-e2e'), WEB_PORT);

  const base = `http://localhost:${API_PORT}`;
  const seeded = await seed(base, '9000000001', 'Bootstrap123');

  // A brand-new agent with a temporary password (first sign-in flow).
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mobile: '9000000001', password: seeded.adminPassword }) });
  const admin = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
  await fetch(`${base}/api/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
    body: JSON.stringify({ fullName: 'New Agent', mobile: '9800000099', agentCode: 'AGNEW', temporaryPassword: 'Temp12345' }),
  });

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      apiBase: base,
      databaseUrl: pg.getConnectionUri(),
      adminPassword: seeded.adminPassword,
      agents: seeded.agents.map((a) => ({ id: a.id, mobile: a.mobile, code: a.code })),
      agentPassword: 'Agent1234',
      newAgent: { mobile: '9800000099', tempPassword: 'Temp12345' },
    }),
  );

  return async () => {
    for (const p of procs) p.kill();
    web.close();
    await pg.stop();
  };
}
