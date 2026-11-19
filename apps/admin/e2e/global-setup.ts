import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { seed } from './seed';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, '../../api');
const adminDir = resolve(here, '..');
export const STATE_FILE = join(here, '.state.json');
const API_PORT = 3101;
const WEB_PORT = 4174;

async function waitFor(url: string, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
}

export default async function globalSetup() {
  const pg = await new PostgreSqlContainer('postgres:18-alpine').withDatabase('cablenet').withUsername('e2e').withPassword('e2e').start();
  const databaseUrl = pg.getConnectionUri();
  const adminPassword = 'Bootstrap123';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
    PORT: String(API_PORT),
    LOG_LEVEL: 'warn',
    JOBS_ENABLED: 'false',
    RATE_LIMIT_PER_MINUTE: '100000',
    LOGIN_RATE_LIMIT_PER_MINUTE: '100000',
    BOOTSTRAP_PASSWORD: adminPassword,
  };
  const register = ['-r', '@swc-node/register'];
  run([...register, 'src/cli.ts', 'migrate'], apiDir, env);
  run([...register, 'src/cli.ts', 'create-super-admin', '--mobile', '9000000001', '--name', 'E2E Owner'], apiDir, env);

  const procs: ChildProcess[] = [];
  const api = spawn(process.execPath, [...register, 'src/main.ts'], { cwd: apiDir, env, stdio: ['ignore', 'inherit', 'inherit'] });
  procs.push(api);
  await waitFor(`http://localhost:${API_PORT}/api/v1/health`);

  run([join(adminDir, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], adminDir, process.env);
  const web = spawn(process.execPath, [join(adminDir, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: adminDir,
    env: { ...process.env, API_URL: `http://localhost:${API_PORT}` },
    stdio: 'ignore',
  });
  procs.push(web);
  await waitFor(`http://localhost:${WEB_PORT}/login`);

  const seeded = await seed(`http://localhost:${API_PORT}`, '9000000001', adminPassword);
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ databaseUrl, adminMobile: '9000000001', adminPassword: seeded.adminPassword, agentMobile: seeded.agents[0]!.mobile, agentPassword: 'Agent1234', apiBase: `http://localhost:${API_PORT}` }),
  );

  return async () => {
    for (const p of procs) p.kill();
    await pg.stop();
  };
}
