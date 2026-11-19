# System Architecture

## 1. Context

- Greenfield: the repository contained only the Excel workbook. No existing code, framework or conventions to preserve.
- Scale today: **163 customers, 12 societies, 2 agents, about 150 payments/month**. Design target: about 20,000 customers and 50 agents without re-architecture.
- Users: 1–3 admins (web, desktop or mobile browser), 2+ agents (Android phones, frequently poor connectivity).
- Money correctness and auditability matter more than raw throughput.

**Architecture style: modular monolith.** One backend service with strict internal module boundaries, one PostgreSQL database, one background worker process (same codebase). At this scale, microservices, Kafka, or separate read stores would add operational risk without benefit.

```
 ┌──────────────────────┐        ┌───────────────────────────┐
 │ Admin Web (React SPA)│──HTTPS─│                           │
 └──────────────────────┘        │   API (NestJS, /api/v1)   │──── PostgreSQL
 ┌──────────────────────┐        │   ├ modules (see §4)      │       ├ app schema
 │ Agent App (Expo/RN)  │──HTTPS─│   └ domain (pure TS)      │       └ job_runs / billing_runs
 │  SQLite (encrypted)  │        └───────────┬───────────────┘
 │  outbox + cache      │                    │ same codebase
 └──────────────────────┘        ┌───────────┴───────────────┐
                                 │ Worker: billing scheduler,│── SMS / WhatsApp / Push providers
                                 │ notifications, reconcile, │── Object storage (backups, logos,
                                 │ assignment start/end      │   import files, receipt PDFs)
                                 └───────────────────────────┘
```

## 2. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere | One language across API, web and mobile. Shared validation schemas and types. |
| Monorepo | **pnpm workspaces** | Shared packages without publishing. No Turborepo/Nx until build times justify it. |
| Backend | **NestJS 11** on Node.js ≥ 22.12 (24 recommended) | Guards and interceptors fit RBAC, idempotency and audit cleanly. DI gives clean controller → service → repository layers. Built-in OpenAPI. |
| Validation | **zod** (shared `packages/contracts`) | The same schemas validate API input and mobile/web forms. |
| Database | **PostgreSQL** | `NUMERIC` money, exclusion constraints for assignment overlaps, ranges, triggers for immutability, strong transactions. |
| Data access | **Kysely** (typed SQL query builder) + plain SQL migrations | *Changed from Prisma in Phase 2.* The schema depends on tstzrange columns, exclusion constraints, immutability triggers and row locks, which Prisma cannot model. Prisma's npm `latest` tag was also a v8 release candidate at the time. Kysely keeps every statement explicit and typed. Migrations are numbered `.sql` files, applied in order and verified by checksum (`apps/api/db/migrations`). |
| Jobs | **In-process scheduler + PostgreSQL advisory lock** (*changed from pg-boss in Phase 3*) | Every job is an idempotent sweep (billing catch-up, suspension status, reminders, daily reconciliation), so a periodic tick is enough and a missed tick self-heals. No queue dependency. A queue (pg-boss) becomes useful when outbound WhatsApp/SMS delivery with retries arrives. |
| Auth | argon2id + short-lived JWT access + rotating opaque refresh tokens (DB-stored, hashed, device-bound) | Revocable sessions per device. Refresh-token reuse detection. |
| Admin web | **React + Vite + TypeScript + Tailwind CSS + TanStack Query/Table + React Hook Form + Recharts** | Fast SPA. Server state handled by Query. Tables need server-side pagination and sorting. |
| Agent app | **Expo SDK 58 (React Native) + expo-router + expo-sqlite (SQLCipher) + expo-secure-store + expo-local-authentication** | Android-first. Encrypted local store with outbox (§6). Secure token and PIN storage, fingerprint unlock. Receipts are shared as WhatsApp text: provisional when offline, final with a signed PDF link once synced. Runs in Expo Go for development (no encryption there); release builds include SQLCipher. |
| Excel I/O | **exceljs** (server) | Reads values and formulas for import. Writes report exports. |
| PDF | **pdfmake** (server), **expo-print** (device) | Pure JS, no headless Chrome. Both render from the same receipt data contract. |
| Testing | **Vitest** (unit and integration), **Testcontainers** (real Postgres), **fast-check** (property tests for allocation), **Playwright** (admin e2e), **Maestro** (mobile e2e smoke) | Financial logic is tested against a real database, not mocks. |
| Logging | **pino** (JSON) with request IDs | Structured logs. Sensitive fields redacted. |
| Deploy | **Docker Compose** on a single VPS (Indian region), Caddy for TLS | Simple, cheap, reproducible. Can move to managed Postgres later. |

Rejected alternatives: MySQL (no exclusion constraints or ranges). Express (would mean hand-building guards, DI and OpenAPI). Firebase/Supabase-only (financial transaction control and audit are harder). Flutter (a second language with no shared contracts).

## 3. Repository layout

```
cablenetwork/
├─ apps/
│  ├─ api/                 NestJS app (HTTP API + worker entrypoint)
│  │  ├─ src/modules/      auth, users, agents, areas, customers, assignments,
│  │  │                    subscriptions, billing, invoices, payments, ledger, receipts,
│  │  │                    collections, visits, followups, reconciliation, reports,
│  │  │                    dashboard, notifications, import-export, sync, settings, audit
│  │  ├─ src/worker.ts     job processors (billing, notifications, reconcile, assignments)
│  │  ├─ db/migrations/    numbered SQL migrations (checksum-verified runner)
│  │  └─ test/             integration tests (Testcontainers)
│  ├─ admin/               React admin web
│  └─ agent/               Expo agent app
├─ packages/
│  ├─ domain/              PURE business logic: Money, billing periods, FIFO allocation,
│  │                       cash-in-hand, permission matrix. No I/O. Exhaustively unit-tested.
│  ├─ contracts/           zod request/response schemas + inferred TS types + enums
│  └─ ui-tokens/           shared design tokens (colors, spacing, type scale)
├─ docs/
├─ docker/                 compose files, Caddyfile, backup scripts
└─ DOC-20261117-WA0003.xlsx  (source workbook; moved to docs/source/ at Phase 7)
```

**Layering inside the API:** `controller` (HTTP, zod validation, auth guards) → `service` (use-case orchestration, transactions, audit) → Kysely queries, plus `packages/domain` for calculations. Controllers never query the database, and no money arithmetic happens outside `packages/domain`.

**Version pinning (Phase 2):** NestJS 11.2 (12.x is new and its decorator/ESM behaviour is unverified), TypeScript 5.9 with `module: node20` (CommonJS output that can `require()` ESM-only packages such as Kysely 0.29), Vitest 4, Zod 4, PostgreSQL 18 (for built-in `uuidv7()`). pnpm's `minimumReleaseAge` supply-chain gate is left on, and only `argon2`, `@swc/core` and `protobufjs` may run install scripts.

## 4. API design

- Base path `/api/v1`. JSON. Amounts are decimal strings. Dates use ISO-8601 (`YYYY-MM-DD` for business dates).
- Standard envelope:
  ```json
  { "data": …, "meta": { "page": 1, "pageSize": 25, "total": 163 } }
  { "error": { "code": "PAYMENT_DUPLICATE_REFERENCE", "message": "…", "details": {…}, "requestId": "…" } }
  ```
- Pagination `?page=&pageSize=` (max 100). Sorting `?sort=-outstanding,name`. Filters are explicit query params, validated by zod.
- Every financial POST requires an `Idempotency-Key` header (UUID). The payment body also carries `clientTxnId`.
- OpenAPI served at `/api/v1/docs` (admin-only in production).

| Module | Representative endpoints | Roles |
|---|---|---|
| auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/sessions`, `DELETE /auth/sessions/:id` | all |
| users / agents | CRUD agents, reset password, deactivate, devices | admin |
| areas / societies | CRUD, set area owner agent, society collection day | admin |
| customers | list/search/filter, create, update, deactivate/reactivate, `GET /:id/ledger`, `/:id/payments`, `/:id/visits` | admin. Agent: read-only, assigned only |
| assignments | `POST /assignments/permanent`, `POST /assignments/temporary`, `POST /assignments/temporary/:id/revoke`, history | admin |
| subscriptions | rate change (effective date), interval/anchor change, suspend/reactivate | admin |
| billing / invoices | billing runs (trigger, view), manual invoice, cancel invoice, list/filter | admin |
| payments | `POST /payments` (agent: assigned customers only), verify UPI/cheque, reversal request/approve, `GET /:id/allocations` | admin, agent (limited) |
| ledger | customer ledger statement | admin, agent (assigned) |
| credits | discounts, credit/debit adjustments, refunds | admin |
| receipts | get, PDF, `GET /receipts/:id/link` (signed 30-day share link), reissue/cancel (admin); `GET /public/receipts/:token` (no sign-in, PDF only) | admin, agent (own); public link |
| collections | `GET /collections/today?filter=&sort=&q=` (agent work list; office staff add `agentId`) | agent, admin |
| sync | `GET /sync/pull?etag=`, `POST /sync/push` (agent); `GET /sync/review`, `GET /sync/review/count`, `POST /sync/review/:opId` (office queue) | agent; admin (`payments:verify`) |
| visits / followups / interactions | create, list, complete | admin, agent (assigned) |
| reconciliation | handover submit (agent), verify (admin), daily closing, cash-in-hand | agent, admin |
| reports | 18 reports, each with `?format=json|xlsx|pdf` | admin |
| dashboard | KPIs, charts | admin. Agent gets own `/dashboard/me` |
| notifications | inbox, mark read, device push token | all |
| imports | `POST /imports` (multipart upload, analysed at once), `GET /imports/:id`, `PUT /imports/:id/corrections`, `POST /imports/:id/dry-run`, `/approve`, `/commit`, `/discard`, `GET /imports/pending-decisions`; `GET /customers/:id/legacy-statement` (Excel history) | super-admin (`import:manage`); Excel history: anyone who may see the customer |
| settings / audit | business settings, audit log search | super-admin / admin |

## 5. Security

- **Authentication:** mobile number + password (argon2id). Account lockout after repeated failures. Forced password change on first login. Optional PIN/biometric unlock on the agent device (local only, guarding the stored refresh token).
- **Tokens:** access JWT valid 15 minutes. Refresh token is opaque, rotated on every use, hashed in `sessions`. Reuse of a rotated token revokes the whole family. An admin can remotely log out a device (lost phone).
- **Authorization:** a global `RolesGuard` reads the permission matrix from `packages/domain`. A `CustomerAccessGuard` resolves `customerId` from the route or body and checks the effective assignment (§DB 3) for agents **on every request**. List queries for agents are always joined to `v_customer_current_agent`, so IDOR by guessing customer IDs returns 404.
- **Financial immutability:** DB triggers (DATABASE_DESIGN §7), so even a bug or a manual SQL session cannot rewrite history. The application database role has no `DELETE` privilege on financial tables.
- **Input:** zod validation on every endpoint. Kysely and parameterised `sql` templates only, never string-built SQL.
- **Rate limiting:** login 5/min per IP+mobile. General 300/min per user. Implemented in-process (single instance), behind a Redis store if scaled out.
- **Transport and data:** HTTPS only (HSTS). Secrets in environment variables, never in the repo. The agent app's SQLite is encrypted with SQLCipher, using a key held in the Android Keystore via secure-store. Customer data is wiped from a device when the agent is deactivated or the session is revoked.
- **Audit:** every service mutation calls `AuditService.record()` in the *same transaction* as the change, so audit rows commit or roll back with it. Rows include actor, role, action, entity, before/after, reason, request ID, IP, user agent, device and session (from a per-request AsyncLocalStorage context). `audit_logs` is append-only (DB trigger). Explicit calls were chosen over a generic interceptor because only the service knows the true before/after values.
- **Privacy:** GPS is captured only at visit check-in and only when the business setting is enabled. There is no background location tracking. Agents see only assigned customers' contact details.

## 6. Offline-first agent app (Phase 6, as built)

**Principle.** Every entry is saved on the phone first, with an id made on the phone, and then sent. There is one code path, whether or not the phone has a signal. The server applies each id at most once and stores the outcome. Every retry gets the same answer, so a lost response can never post twice.

**Local store.** All local data sits behind a small key-value interface (`apps/agent/src/lib/offline/kv.ts`): namespaced keys holding JSON text, and atomic batch writes. The offline logic is written once against that interface.

| Where | Storage | Encrypted |
|---|---|---|
| Phone, development/production build | SQLite with **SQLCipher** (`expo-sqlite`, `useSQLCipher: true`). Random 256-bit key generated on first start and kept in the Android Keystore (`expo-secure-store`). | Yes. `PRAGMA cipher_version` is checked and the result shown in Profile and Sync. |
| Phone, Expo Go | Plain SQLite. Expo Go has no SQLCipher, and `PRAGMA key` is silently ignored there. | No. The app says so. |
| Web build (automated tests only) | Browser storage | No |
| Unit tests | Memory, plus the SQLite implementation run on `node:sqlite` | n/a |

The phone keeps three kinds of data: the last **snapshot** (header plus one row per customer), the **outbox** (one row per entry), and **counters** (device sequence, provisional receipt number).

**Pull** (`GET /sync/pull?etag=`) returns the agent's whole working set, recomputed on the server:
- the customers currently visible to the agent, including temporary covers with their end time;
- each customer's balance, open bills, monthly rate, last 5 payments and last 3 visits;
- the agent's open follow-ups and the day's figures (expected, collected, cash in hand);
- business name, staleness limit, maximum amount, and the floor for the provisional receipt counter.

Customers missing from a new snapshot are removed from the phone in the same write. The `etag` lets an unchanged snapshot skip the download. A full snapshot was chosen over a "changes since" cursor because balances depend on many tables (bills, allocations, verifications, reversals, assignments), and a missed change source would show wrong money. At 2 agents × ~80 customers a full snapshot is small. Phase 8 load-tests it at 20,000 customers.

**Push** (`POST /sync/push`, at most 100 entries per request) sends the entries in device order, together with the phone's clock time.
- Entry types: `PAYMENT_CREATE` (carries the visit id too: the server records the visit and decides "paid / part paid" from its own numbers), `VISIT_CREATE` and `FOLLOWUP_DONE`.
- Each entry is applied in its own transaction, under an advisory lock on its id, together with its `sync_operations` row.
- Answers per entry:

| Answer | Meaning |
|---|---|
| `APPLIED` | Posted |
| `NEEDS_REVIEW` | Posted, with flags for the office |
| `DUPLICATE` | Already received; carries the original outcome |
| `REJECTED` | Invalid; stored, so replays get the same answer |
| `RETRY` | Temporary server fault; nothing was stored |

**Clock.** The server measures the phone's clock error as (server time − phone time at send). If the error is over 2 minutes it corrects the recorded time, and over 24 hours it flags `CLOCK_SKEW`.

**Triggers.** Sync runs:
- after unlock or sign-in;
- when the connection returns;
- when the app comes back to the foreground;
- every 15 minutes;
- right after a new entry while online;
- on "Sync now" and pull-to-refresh.

After a failure, retries back off: 5 s, 10 s, 20 s … up to 5 minutes. Concurrent triggers share one run.

**What the agent sees**
- A sync bar on home and on the list: "Waiting to send: N", "Everything is sent", or "Needs your attention", plus the last sync time.
- A warning when the data is older than `sync.rules.staleAfterHours` (12 by default, set in the office Settings).
- A **sync center** listing entries waiting, entries the office will check (with the reasons in plain words), entries not accepted (shown until the agent taps "OK, understood"), and recent sent entries. It also shows whether the phone's storage is encrypted.
- Balances are never recalculated on the phone. The server's figures are shown "as of" the snapshot, and unsent collections are shown *next to* them ("Collected, not sent yet ₹400"), not subtracted.
- **Provisional receipt** (Q14 default): `P-{AGENTCODE}-{6 digits}`, shared as WhatsApp text marked *PROVISIONAL – pending confirmation*, with no balance quoted. The same receipt screen turns into the final receipt (number, months paid, PDF link) as soon as the server answers. A local PDF (expo-print) was not built, because the text message is what agents send today.
- A customer whose temporary cover has ended disappears from the phone at the end time, even before the next download.

**Sign-out and lost phones.** Signing out, an ended session or 5 wrong PINs removes all customer data from the phone. **Unsent entries stay**, because they record money that was collected.
- A manual sign-out with unsent entries asks for confirmation first.
- Entries are tagged with the agent who made them. Only that agent's session sends them; another agent on the same phone sees a note instead.
- If a phone is lost, the office revokes its session. The local data stays encrypted with a key that never leaves the Android Keystore.

**Online-only by design.** Cash handover, because the office counts the cash against server figures. Before a handover, the phone sends any waiting payments first. "My collections" history also needs a connection; entries still on the phone are listed first.

**Web build.** Async routes are turned off for web (`expo-router` plugin, `asyncRoutes: { web: false }`) so the test build, like the phone, has every screen loaded and works offline.

## 7. Notifications

`NotificationService.emit(event)` writes `notifications` (in-app) and `outbound_messages` (transactional outbox). A worker delivers through provider adapters behind one interface:

```ts
interface MessageProvider { channel: 'PUSH'|'SMS'|'WHATSAPP'; send(msg): Promise<ProviderResult> }
```

- v1: in-app + Expo push for staff. For customers, receipts are shared through the agent's phone (native share sheet or `wa.me` deep link, free, no API approval needed).
- Later: the WhatsApp Business Cloud API and an SMS gateway (DLT-registered templates, required in India) plug in as adapters without changing callers.

## 8. Background jobs

| Job | Schedule | Idempotency |
|---|---|---|
| Billing run | daily 00:30 IST + manual trigger | unique `(subscription_id, period_start)` |
| Temporary assignment start/end notifications | every 15 min | status transitions guarded |
| Follow-up and promise reminders | daily 08:00 IST | one per task per day |
| Notification delivery | continuous | outbox row state |
| Ledger/cash reconciliation | daily 02:00 IST | read-only, writes alerts |
| Backup verification | weekly | — |

## 9. Deployment and operations

- **Environments:** `local` (docker compose: postgres, api, worker, admin dev server), `staging`, `production`.
- **Production:** one VPS (2 vCPU / 4 GB is ample) running Caddy (TLS) → api, worker, static admin. PostgreSQL either in the same compose stack with WAL archiving, or managed Postgres (preferred if budget allows).
- **Backups:** nightly encrypted `pg_dump` plus WAL archiving to off-site object storage. Retention 35 days daily, 12 monthly. Restore drill monthly.
- **Monitoring:** health endpoint, uptime check, error alerts (Sentry or equivalent), disk/DB size alerts, and daily reconciliation alerts.
- **Mobile distribution:** EAS Build → signed APK/AAB. Internal distribution or Play Store (private track). OTA updates for JS-only fixes.
- **CI:** lint, typecheck, unit tests, integration tests (Testcontainers), and build on every push. Migrations are checked against a fresh database.
