# Cable Network — Subscription & Field Collection Platform

Replaces the Excel workbook used to run the cable TV business: customers, agents, assignments, billing, collections, cash reconciliation.

Design documents live in [docs/](docs/). Start with [BUSINESS_REQUIREMENTS.md](docs/BUSINESS_REQUIREMENTS.md) and [DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md).

## Status

| Phase | State |
|---|---|
| 1. Analysis & design | ✅ done |
| 2. Backend foundation (auth, RBAC, customers, areas/societies, agents, assignments, audit, settings) | ✅ done |
| 3. Financial engine (billing, payments, ledger, receipts, cash, reconciliation) | ✅ done — defaults pending Q4, Q6–Q9 |
| 4. Admin web dashboard + reports, field ops, receipts PDF | ✅ done |
| 5. Agent mobile app (online) | ✅ done — Android checked on an emulator; physical-phone check pending |
| 6. Offline sync | ✅ done — see the roadmap for what still needs a real phone |
| 7. Excel migration | ✅ done — real workbook reconciles; the business must still choose Option A or B (Q2) at go-live |
| 8. Production readiness | ✅ built and verified (security review, production stack, backups + restore drill, 20k load test); **UAT sign-off and the parallel-run month are with the business** ([UAT_PLAN.md](docs/UAT_PLAN.md)) |

## Repository layout

```
apps/api            NestJS REST API (/api/v1) + CLI (migrations, bootstrap, run-jobs)
  db/migrations     plain SQL migrations (applied in order, checksum-verified; server refuses to start if any are pending)
  src/modules       auth, people, geography, customers, assignments, finance, fieldops, reports, collections, sync, imports, core
  test/             integration tests against real PostgreSQL (Testcontainers)
apps/admin          React admin web (Vite, Tailwind, TanStack Query, Recharts)
  e2e/              Playwright end-to-end tests + demo seed (synthetic data, via the API)
apps/agent          Expo (React Native) Android app for field agents, English + Gujarati
  src/app           screens (expo-router): login, PIN, home, today's list, customer, collect, receipt, visit, follow-ups, collections, cash, sync, profile
  src/lib/offline   local store (SQLite/SQLCipher), outbox, sync engine, derived views (unit-tested)
  e2e/              Playwright tests on the web build of the same code (phone viewport)
packages/domain     pure business rules (permissions, dates, money, billing periods, FIFO allocation)
packages/contracts  shared zod request schemas and types (API, admin web, agent app)
docker/             local PostgreSQL (compose.dev.yml) and the production stack (compose.prod.yml, Dockerfiles, Caddyfile, backup + restore-drill scripts)
docs/               requirements, architecture, database, financial logic, migration mapping
```

## Prerequisites

- Node.js ≥ 22.12 (24 recommended), pnpm 12 (`corepack enable`)
- Docker (local database and integration tests)

## Local setup

```bash
pnpm install
pnpm db:up                                   # PostgreSQL 18 on localhost:55432
cp apps/api/.env.example apps/api/.env       # then set JWT_ACCESS_SECRET (see comment in file)
pnpm --filter @cablenet/domain build && pnpm --filter @cablenet/contracts build
pnpm --filter @cablenet/api db:migrate

# First super admin (password from BOOTSTRAP_PASSWORD in .env; must be changed at first login)
pnpm --filter @cablenet/api cli create-super-admin --mobile 9xxxxxxxxx --name "Owner"

pnpm --filter @cablenet/api dev              # http://localhost:3000/api/v1, docs at /api/v1/docs
pnpm --filter @cablenet/admin dev            # http://localhost:5173 (proxies /api to :3000)

# Optional: demo data (synthetic customers, 2 agents, bills, payments) through the API
node apps/admin/e2e/seed.ts http://localhost:3000 <super-admin-mobile> <current-password>
```

### Agent app (Android)

The app runs in **Expo Go** (no custom native code yet), so no Android build is needed to try it.

```bash
# API must be running (above). Then, from apps/agent:
EXPO_PUBLIC_API_URL=http://10.0.2.2:3000 pnpm start      # Android emulator: 10.0.2.2 is the host machine
EXPO_PUBLIC_API_URL=http://<pc-lan-ip>:3000 pnpm start   # physical phone on the same Wi-Fi; scan the QR code in Expo Go
```

- Sign in with an **agent** account (office staff are turned away). The first sign-in replaces the temporary password, then the agent sets a 4-digit PIN. After that, opening the app asks for the PIN or fingerprint.
- Demo agents from the seed: `9800000001` / `9800000002`, password `Agent1234`.
- **Windows:** run Expo commands from a path that starts with an uppercase drive letter (`D:\cablenetwork\apps\agent`). A lowercase `d:\` working directory makes Metro fail with `d:\D:\…` paths.
- **Offline.** Everything the agent records is saved on the phone first and sent automatically (on reconnect, on unlock, every 15 minutes, or with "Sync now"). Without a signal, the agent gets a provisional receipt (`P-AG1-000001`) to share. It becomes the final receipt once the entry reaches the office. Entries the office must check appear under **Offline entries** in the admin site.
- **Encryption.** Expo Go has no SQLCipher, so data on the phone is *not* encrypted there; the app shows this in Profile and Sync. Real builds (`pnpm --filter @cablenet/agent android:build` locally, or EAS) include SQLCipher. The generated `android/` folder is not committed.
- Receipt links shared on WhatsApp open `/api/v1/public/receipts/<token>` (signed, valid 30 days). Set `PUBLIC_BASE_URL` on the API so the links use the public address.

## Tests

```bash
pnpm test        # domain unit + API integration + admin unit tests (throwaway PostgreSQL container)
pnpm typecheck
pnpm e2e         # browser tests: PostgreSQL + API + built admin app, then the agent app's web build (includes airplane-mode tests)
                 # (first: pnpm --filter @cablenet/admin exec playwright install chromium)
```

Set `TEST_DATABASE_SERVER_URL=postgres://user:pass@host:port` to use an existing server instead of a container.

## Excel import (go-live)

Admin site → **Excel import** (super admin). Upload the workbook, then:
1. Read the findings.
2. Correct customers if needed. AMP/BOSS/DC/blank rates can get a rate from cutover, or stay "needs decision".
3. Choose **Option A (full history)** or **Option B (opening balance)** and the cutover month, and run a **dry run**. Nothing is saved; you get the reconciliation report.
4. Approve that exact result, then **Import now**.

Details: [EXCEL_MIGRATION_MAPPING.md §7](docs/EXCEL_MIGRATION_MAPPING.md).

The real workbook (`DOC-20261117-WA0003.xlsx`) contains customer names and mobile numbers. Its reconciliation test runs only where the file is present, and the file should not be committed to a shared repository.

## Production

One server with Docker Compose: Caddy (HTTPS, office site, `/api` proxy), API, PostgreSQL 18, nightly backups.

```bash
cp docker/prod.env.example docker/prod.env          # secrets, domain
docker compose -f docker/compose.prod.yml --env-file docker/prod.env up -d --build
```

- [RUNBOOK.md](docs/RUNBOOK.md): installation, releases, backups and the restore drill, monitoring, incidents.
- [SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md): the ASVS L2 review and how each finding was handled.
- [UAT_PLAN.md](docs/UAT_PLAN.md): acceptance tests, the parallel-run month and the go-live checklist.

## API conventions

- Base path `/api/v1`; success `{ data, meta? }`, failure `{ error: { code, message, details?, requestId } }`.
- `Authorization: Bearer <accessToken>` (15 min). Renew with `POST /auth/refresh` (rotating refresh token; replaying an old one ends the session).
- Every route has an explicit permission rule; agents only ever see customers currently assigned to them (others return 404).
- Money is sent as decimal strings ("1500.00"); floats are rejected.
- Financial POSTs need an `Idempotency-Key` header (payments use `clientTxnId` instead).
- Agents: `GET /collections/today` (their work list) and `GET /dashboard/me` (their day). Office staff pass `?agentId=`.
- `pnpm --filter @cablenet/api cli run-jobs` runs one scheduler pass (billing, reminders, reconciliation).
