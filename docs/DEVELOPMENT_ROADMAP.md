# Development Roadmap

Each phase ends with a **verification gate**. The next phase starts only when the gate passes. Estimates assume one full-time senior engineer working with Claude Code. They are indicative and should be revisited after Phase 2.

| Phase | Scope | Exit gate | Est. |
|---|---|---|---|
| **1. Analysis & design** ✅ (this delivery) | Repo + Excel analysis; 6 design docs; open questions | Business answers Q1–Q6; docs approved | — |
| **2. Backend foundation** ✅ (2026-11-18) | Monorepo scaffold, Docker Compose Postgres, Kysely + SQL migrations (triggers, exclusion constraints), auth (login/refresh/rotation/sessions/devices), RBAC guard + customer access guard, audit interceptor, users/agents, areas/societies, customers + connections, assignments (permanent + temporary + effective view), settings, OpenAPI, CI | Integration tests: auth flows, IDOR attempts return 404, overlapping assignments rejected by DB, temporary assignment expiry restores original | 2–3 wks |
| **3. Financial engine** ✅ (2026-11-18) | `packages/domain` (Money, periods, FIFO, cash), subscriptions + rate history + suspensions, billing scheduler (in-process, advisory-locked) + manual invoices, invoices, payments (idempotent), allocations, credit notes, adjustments, refunds, reversals, receipts + numbering, ledger, reconciliation job | All FINANCIAL_LOGIC §9 tests green (unit + property + Postgres integration + concurrency); immutability triggers verified | 3–4 wks |
| **4. Admin web** ✅ (2026-11-19) | Shell + design tokens, dashboard (real queries), customers, profile + ledger, admin collection, interactions/follow-ups, invoices/billing runs, payment verification & reversals, agents/areas/assignments wizard, cash handover verification, 18 reports with xlsx/pdf export, settings, audit | Playwright e2e: create customer → bill → collect → receipt → reverse; dashboard totals equal SQL ground truth | 3–4 wks |
| **5. Agent app (online)** ✅ (2026-11-19) | Expo app, login + PIN, home, today list, customer screen, visit, collect payment, receipt PDF + WhatsApp share, follow-ups, my collections, cash handover | Maestro smoke on a physical Android device; payment entry ≤ 15 s; agent sees only assigned customers | 2–3 wks |
| **6. Offline sync** ✅ (2026-11-19) | SQLCipher store, pull/push sync, outbox, provisional receipts, conflict flags, stale indicators, admin review queue | Tests: airplane-mode collection → reconnect → exactly-once posting; duplicate replay; reassignment while offline; out-of-order ops | 2 wks |
| **7. Excel migration** ✅ (2026-11-19) | Import wizard (analyse/map/validate/correct/dry-run/approve/commit), legacy statement view, reconciliation report | Dry-run on the real workbook reconciles 163 customers / ₹5,75,630 / per-customer balances 163/163 | 1–2 wks |
| **8. Production readiness** ✅ built and verified (2026-11-19); UAT and parallel run with the business | Security review (ASVS L2 checklist), load test at 20k customers, backups + restore drill, monitoring/alerts, staging UAT with both agents, runbooks, go-live cutover | UAT sign-off; restore drill passed; parallel-run month reconciles with Excel | 1–2 wks |

## Cutover plan (proposal)

1. Pick a go-live month start (e.g. 1 January 2027). ⚠ Q16
2. T−7 days: final Excel import dry-run on a staging copy; business reviews the reconciliation report.
3. T−1 day: Excel frozen (read-only). Final import committed and reconciled. Agents trained and logged in. Their customer lists are verified against their route sheets.
4. Day 0: the scheduler issues the month's invoices. Agents collect in the app.
5. Month 1: daily reconciliation review. Excel is kept read-only for reference.

## Phase 2 delivered (2026-11-18)

1. `pnpm` monorepo with `apps/api`, `apps/admin`, `apps/agent`, `packages/domain`, `packages/contracts`.
2. `docker/compose.dev.yml` with PostgreSQL.
3. SQL migration `0001_foundation.sql` for identity, geography, customers, assignments, audit, notifications and settings, with exclusion constraints and immutability triggers.
4. Auth (rotating refresh tokens, lockout, device revoke), deny-by-default RBAC, customer access check, transactional audit trail.
5. Gate evidence: 55 automated tests (15 domain unit + 40 API integration against PostgreSQL 18). These cover IDOR attempts returning 404, overlapping assignments rejected by the DB, temporary assignment expiry/revoke restoring the original agent, history immutability, and refresh-token replay revoking the session.

Not yet built (planned later): push delivery (Phase 5), Excel import (Phase 7). Temporary-assignment start/end notifications shipped in Phase 3.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Unanswered business rules (Q1–Q6) | Wrong bills | Phase 3 does not start until answered; defaults are documented |
| History authenticity (Q2) | Misleading reports | Option B (opening balance + legacy view) |
| Agents' device quality and connectivity | Lost entries | Offline outbox, encrypted local DB, sync center, admin alert on stale devices |
| UPI fraud (fake screenshots) | Revenue loss | Pending verification or gateway confirmation |
| Single maintainer / bus factor | Ops risk | Docs, runbooks, CI, managed backups |
| Scope size (18 reports, notifications) | Delays | Reports and customer messaging can ship incrementally after go-live; finance core first |
| Regulatory (GST invoices, SMS DLT) | Compliance | Q10. DLT registration before SMS goes live |

## Phase 3 delivered (2026-11-18)

- Migration `0002_financial.sql`: subscriptions, rate history, suspensions, billing runs, invoices and items, payments, credit notes, refunds, allocations, reversals, receipts, ledger, cash handovers and adjustments, idempotency keys, system alerts, job runs. Money and history tables are protected by append-only or status-only triggers.
- Engine: exact paise arithmetic, billing-period planner, strict oldest-first allocation with reflow, per-customer row locks, gap-free numbering per financial year, idempotent payments and commands, receipts with frozen snapshots, cash accountability, nightly reconciliation with alerts, in-process scheduler (`pnpm cli run-jobs`).
- Gate evidence: **135 automated tests** (48 domain unit and property tests + 87 API integration tests on PostgreSQL 18). They cover every FINANCIAL_LOGIC §9 scenario except Excel migration and historical reconciliation (Phase 7) and offline sync (Phase 6). Scale check: 163 customers × 12 months catch-up, 163 payments, list and reconciliation ran in about 25 s.
- Defaults pending business confirmation (all configurable per customer or setting): advance billing, anchor = start day, no proration, agent UPI pending until verified, cash shortage stays with the agent (Q4, Q6–Q9).

## Phase 4 delivered (2026-11-19)

- **Backend additions:** migration `0003_field_ops.sql` adds visits, interactions (calls and promises to pay) and follow-up tasks. A confirmed payment automatically completes open promises and their follow-ups. Also added: a dashboard API (KPIs, daily and monthly trends, agent performance, society collection, ageing, modes, billing frequency), a generic engine for all **18 reports** (search, sort, pagination, totals, Excel and PDF export), and a receipt PDF (A6, ₹ with Indian grouping). The API now refuses to start while migrations are pending.
- **Admin web (`apps/admin`):**
  - Dashboard with filters.
  - Customers: list, profile, subscription controls, bills, payments, ledger, activity, agent history, set-top boxes and audit.
  - Collect payment, with a receipt PDF and WhatsApp share text.
  - Follow-ups and promises; payments with a verification queue and reversals; bills and billing runs.
  - Cash with agents, and handover counting with shortage recording.
  - Reports viewer with exports; agents (sessions, devices, password reset, status); areas and societies; assignments (temporary cover, permanent moves).
  - Alerts (with "check the books now"), audit log, settings and office users.
- **Charts** follow the dataviz method: the validated categorical palette (blue, orange, aqua), an ordinal blue ramp for ageing, a legend and a table view on every chart, and tooltips showing exact amounts. Only the API calculates money; the web app formats.
- **Gate evidence:** 151 unit/integration tests (49 domain, 101 API, 1 admin) and **6 Playwright end-to-end tests** on the real stack:
  - create customer → bill → collect → receipt → reverse;
  - dashboard totals equal SQL ground truth;
  - reports Excel export;
  - cash handover with shortage;
  - temporary cover set up and ended;
  - agents turned away from the office site.

  The e2e suite also caught a real accessibility bug: the agent and society dropdowns announced a generic name instead of their visible label.
- **Not in Phase 4:** dark mode for the admin web (light only for now), and moving the refresh token to an httpOnly cookie (to be reviewed in the Phase 8 security pass).

## Phase 5 delivered (2026-11-19)

- **Backend additions** (no new migration):
  - `GET /collections/today` returns the agent's work list for the day. Each customer gets a status (paid today, partly paid, visited, pending, settled), due-today and overdue flags, the open follow-up, and whether the cover is temporary. The list supports filters and five sort orders. Agents always get their own list; office staff must name the agent.
  - `GET /dashboard/me` returns the agent's day: expected today, collected today, remaining, cash in hand, and open follow-ups.
  - Signed receipt links: `GET /receipts/:id/link` returns a link valid for 30 days, with an HMAC token. Agents can only get links for their own customers' receipts. `GET /public/receipts/:token` serves the PDF without signing in. A changed or expired token returns 404. `PUBLIC_BASE_URL` sets the public address used in the links.
- **Agent app (`apps/agent`, Expo SDK 58, runs in Expo Go):**
  - Sign-in for agents only. Office staff are turned away.
  - Forced replacement of a temporary password, then a 4-digit PIN with fingerprint unlock where available. After 5 wrong PINs the app signs out.
  - Home, today's list (search, filters, sorting), and customer screen (call, directions, dues, history).
  - Collect payment: Full due and 1 month buttons, cash, UPI or other. The payment records the visit automatically and is safe to retry, because it reuses the same `clientTxnId`.
  - Receipt screen with WhatsApp share (message plus signed PDF link). Record visit with promise date. Follow-ups, my collections (reopen and reshare receipts), cash handover, and profile (language, change password, sign out).
  - English and Gujarati throughout. Large touch targets and an offline banner.
- **Gate evidence:**
  - 114 unit and integration tests: 49 domain, 109 API (8 new for collections and receipt links), 5 agent-app (including a check that every Gujarati string is present), 1 admin.
  - **10 Playwright tests** on the agent app's web build against real PostgreSQL and the API, on a Pixel 7 viewport:
    - first sign-in, password change and PIN;
    - password change from Profile;
    - office staff turned away;
    - **the list contains exactly the agent's own customers, checked against the database;**
    - **full-due payment to receipt in about 1.8 s (limit 15 s);**
    - visit creates a follow-up;
    - cash handover equals the database figure;
    - PIN relock and wrong-PIN count;
    - overdue label;
    - Gujarati.
  - Android check on an emulator (Android 16 / API 36, Expo Go, against the dev API): sign-in, PIN, home with live figures, today's list, customer screen, collect ₹1,600 → receipt `RCPT/2026-27/000025` with the months it paid. The customer then left the Pending list, and the PDF link opened in the phone's browser.
- **Gate deviations (stated plainly):**
  - The roadmap asked for a **Maestro smoke test on a physical Android phone**. That was not run, because no phone was connected to this machine. The same flows were checked on the Android emulator instead, and automated with Playwright on the web build. Before sign-off, run the app on one of the agents' phones in Expo Go (README → Agent app) and time a real payment entry.
  - Push notifications are not in the app yet. Agents see follow-ups and temporary covers in the app itself. Push comes with Phase 6, because the device registration and sync work is shared.
- **Moved to Phase 6:** encrypted local store, outbox, provisional receipts, sync center, and stale-data indicators. Until then the app needs a connection to save anything; while offline it shows a banner and blocks saving.

## Phase 6 delivered (2026-11-19)

- **Backend:**
  - Migration `0004_sync.sql`: `sync_operations` (one row per phone operation id; fixed except the office review), `payments.provisional_ref`, `devices.last_sync_at`.
  - `GET /sync/pull` sends the agent's whole working set, with an etag so an unchanged set is not downloaded again.
  - `POST /sync/push` handles payments (the visit included), visits and "follow-up done". Each entry is applied once, in device order, inside its own transaction under an advisory lock.
  - Answers per entry: APPLIED / NEEDS_REVIEW / DUPLICATE / REJECTED / RETRY.
  - The server corrects a wrong phone clock and posts collected money even after a reassignment, flagging it (FINANCIAL_LOGIC §7).
  - Office queue: `GET /sync/review`, `POST /sync/review/:opId`.
- **Agent app:**
  - Every entry is saved on the phone first (outbox), then sent automatically.
  - Local store: SQLite with SQLCipher in real builds; key in the Android Keystore.
  - Offline: today's list, customer screen, collect, visit and follow-ups all work.
  - Provisional receipts `P-AG1-000001` are shared as WhatsApp text. The same receipt screen turns into the final receipt after sync.
  - Sync bar and sync center: waiting entries, entries the office will check, entries not accepted (until acknowledged), and storage encryption status.
  - "Balances may be out of date" warning after 12 hours (office setting).
  - Signing out removes customer data but keeps unsent entries, and warns first.
  - Cash handover stays online-only and sends waiting payments first.
- **Admin web:**
  - **Offline entries** page: each entry with its reason in plain words and what to do, plus "Mark checked" with a note.
  - A count badge in the menu.
  - "Last synced" per agent phone.
  - Settings for the out-of-date warning.
- **Gate evidence** (the roadmap gate: airplane-mode collection → reconnect → exactly-once posting; duplicate replay; reassignment while offline; out-of-order operations):
  - **API, 16 new integration tests** on PostgreSQL 18:
    - an offline payment posted once, with receipt, provisional reference and visit;
    - a replay returns the original result;
    - **4 simultaneous retries post exactly once**;
    - a shuffled batch is applied in device order;
    - an older payment synced late still lands on the oldest bill, and the books balance;
    - reassignment while offline is posted, attributed to the collector, flagged, and sent to the review queue;
    - a never-assigned customer is rejected, and replays say the same;
    - invalid entries don't block the rest of the batch;
    - clock correction;
    - possible duplicates;
    - another user's operation id;
    - history immutability.
  - **Agent app, 17 new unit tests**:
    - the real SQL run on SQLite (`node:sqlite`), all-or-nothing writes;
    - outbox and counters survive a restart, never going below the server floor;
    - airplane mode with back-off, then exactly once;
    - a lost response;
    - rejected and retry answers;
    - another user's entries are not sent;
    - views never recalculate balances;
    - temporary cover expiry;
    - the stale warning.
  - **Browser end-to-end on the app's web build** (15 tests, 5 new for this gate):
    - airplane mode: provisional receipt and WhatsApp text, reconnect, exactly one payment;
    - a lost server answer (the request reaches the API, the response is dropped) does not post twice;
    - reassigned while offline: posted, flagged, and the customer leaves the list;
    - the stale warning;
    - sign-out keeps unsent entries and sends them at the next sign-in.
  - **Admin end-to-end:** the Offline entries page lists a flagged entry and marks it checked.
  - **Android emulator** (Android 16, Expo Go):
    - real airplane mode: collected ₹3,300 and got provisional receipt `P-AG1-000001`;
    - **force-stopped the app while offline** (the server had 0 payments);
    - reconnected, reopened and unlocked: posted once as `RCPT/2026-27/000026` with `recorded_offline = true` and one `sync_operations` row; home showed the new totals.
  - Totals: 124 API + 49 domain + 22 agent + 1 admin unit/integration tests; 15 agent + 7 admin browser tests; all passing.
- **Not verified (stated plainly):**
  - **SQLCipher encryption on a real build.** The plugin and the key handling are configured, and the app reports whether the file is encrypted. Expo Go has no SQLCipher, so the emulator run used plain SQLite and said so on screen. A local Android build (`expo run:android`) failed on Windows' 260-character path limit: CMake nests pnpm's long `node_modules\.pnpm\…` path inside itself. Options: enable Windows long paths (one-time admin setting) and rebuild, build from a short folder, or build in the cloud with EAS. Then check the Profile line and that the database file does not start with `SQLite format 3`.
  - Still no physical phone (as in Phase 5).
  - Push notifications are still not built; the in-app sync bar and sync center cover the offline states.
- **Decisions:**
  - A full snapshot rather than "changes since", for correctness (SYSTEM_ARCHITECTURE §6).
  - Provisional receipts as text rather than a local PDF.
  - Cash handover online-only.
  - Visits for a payment are recorded by the server inside the payment operation, so its outcome uses the server's figures.

## Phase 7 delivered (2026-11-19)

- **Backend:**
  - Migration `0005_import.sql`: `import_batches`, `legacy_statement_lines`, `customers.pending_decision`, and the FK on `customers.import_batch_id`.
  - Workbook parser: sheets and columns found by header text; months matched by the ID shown in each row; every figure recomputed with the workbook's formulas and cross-checked against the saved results.
  - Checks for every data-quality issue in EXCEL_MIGRATION_MAPPING §4, plus database conflicts.
  - Per-customer corrections.
  - Dry run in a rolled-back transaction, with the §7.1 reconciliation report.
  - Approval tied to the dry-run hash; commit re-checks it and writes nothing if anything changed.
  - Both migration options; the Excel month grid is kept read-only; the scheduler continues from cutover.
- **Admin web:**
  - **Excel import** page: upload, findings, corrections, option and cutover, report, approve with confirmation, import, and the list of customers waiting for a rate decision.
  - **Excel history** tab and a "needs a rate decision" notice on the customer page.
- **Gate evidence:**
  - **The real workbook reconciles with both options (cutover 2026-12-01):** 163 customers / 142 billed / ₹52,330 a month / **₹5,75,630** collections / **163/163** per-customer balances / ₹0 outstanding and advance. Option A creates 1,562 bills and 1,562 payments. The parser found 0 disagreements with Excel's own formula results.
  - 17 new API integration tests on generated workbooks, covering: data-quality findings; super-admin only; the dry run leaves nothing behind; a wrong hash cannot be approved; commit once only; balances and legacy bills; Excel history read-only; Q1 customers wait for a decision until a plan is set; billing after import never re-bills a month; Option B opening due and advance; corrections invalidate the dry run; commit refused when the database changed after approval; payments after cutover block the import; non-workbooks refused.
  - 1 new admin browser test: the whole wizard, then the customer's Excel history.
  - Totals: 141 API + 49 domain + 22 agent + 1 admin unit/integration tests; 8 admin + 15 agent browser tests; all passing.
- **Still the business's decision (nothing defaults silently):**
  - **Q2: Option A or B.** The import requires an explicit choice. Recommendation unchanged: B, unless the Jan–Nov payments are real collections with real dates.
  - **Q1: the 21 AMP/BOSS/DC/blank customers.** They are imported without billing and listed for decision. A rate can be entered during the import or later by setting up a subscription.
  - **Q5: agents per society.** Imported societies have no area or agent until the office assigns them.
  - **Q16: cutover month.** The suggested cutover is the month after the last payments. Payments typed in Excel on or after the chosen cutover block the import, so December collections need a later workbook and cutover.
- **Not built:** delta imports (re-importing a later workbook into already-imported customers). The plan is a single import at go-live with Excel frozen (cutover plan above). A second workbook is refused for customers that already exist.

## Phase 8 delivered (2026-11-19)

**Security review (OWASP ASVS L2)** — [SECURITY_REVIEW.md](SECURITY_REVIEW.md)
- An independent read-only review of the whole code base found no critical or high issues: 6 medium, 11 low and 9 informational findings.
- All six mediums are fixed:
  - production refuses placeholder secrets, and receipt links have their own key;
  - the proxy is trusted by hop count only;
  - public receipt links carry less data, last 7 days and die with a reversal;
  - offline payments that depend on the phone's clock or a past assignment are **held for office verification**;
  - office sessions end after 12 h;
  - one cumulative daily approval limit covers credits, refunds and bill cancellations.
- Lows fixed: no account enumeration; throttled password changes; capped password hashing; no caching of API data; logs without tokens or search terms; maker-checker on cash; zip-bomb guard; 12-character office passwords.
- The remaining items are documented as accepted, with reasons.
- 11 new security tests.

**Production packaging** — `docker/compose.prod.yml`, `api.Dockerfile`, `web.Dockerfile`, `Caddyfile`, `prod.env.example`
- Caddy serves HTTPS with automatic certificates and the office site with CSP, HSTS and frame protection, and proxies `/api`.
- Migrations run before the API starts; PostgreSQL is not exposed; health checks on every service.
- The stack was built and run locally: migrations applied, owner bootstrapped through the CLI, Swagger off, all headers present.
- CI now also builds both images and checks that the API refuses unsafe settings.

**Monitoring**
- `GET /health/ready`, for an external uptime monitor, reports four checks: database, scheduler heartbeat, unresolved critical alerts, and last night's reconciliation. Only states and counts are shown; it answers 503 when a human is needed.
- A failing scheduler raises a critical alert.

**Backups and restore drill**
- Nightly `pg_dump` with checksum and row-count manifest; 35 daily and 12 monthly copies kept; optional off-site upload command; failures retried every 15 minutes.
- `restore-drill.sh` restores into a throwaway database and runs the new `verify-db` command (migrations, reconciliation, row counts against the manifest).
- **Drill passed** on a 20,000-customer backup: restored in 3 s, 0 mismatches, counts and ledger total identical.

**Load test at 20,000 customers** (`apps/api/scripts/load-test.ts`)
- Run against the production stack through Caddy, on a developer PC (16 cores; the database had no special tuning).
- Setup: 2 agents with 10,000 customers each, 4 months billed (80,000 bills), 6,000 payments, 2,000 offline entries.

| Measure | Result |
|---|---|
| Billing run, 80,000 bills | 432 s (≈185 bills/s; a normal month of 20,000 ≈ 2 min), 0 errors |
| Payments, 20 concurrent clients | 146/s, p50 0.10 s, p95 0.30 s, 0 errors |
| Agent sync download, 10,000 customers | p95 0.52 s; 10 MB JSON, **1.05 MB gzipped** |
| Offline sync upload, 50 entries | p95 0.77 s |
| Agent work list / my day | p95 0.29 s / 0.21 s |
| Admin dashboard | p95 0.37 s |
| Customer search / page 200 of the list | p95 0.10 s / 0.12 s |
| Outstanding report / customer master Excel export (20,000 rows) | 0.10 s / 1.2 s |
| Reconciliation over 20,000 customers | < 1 s, 0 mismatches |
| Database size | 139 MB |

- **Bug found and fixed:** the agent work list had a hidden cap of 2,000 rows. At 10,000 customers per agent, the list and the offline snapshot silently left out 8,000 customers.
- **Operational note:** a multi-month billing catch-up takes longer than a browser request waits, so start it with the `run-jobs` CLI (RUNBOOK §6).

**Runbook, UAT and go-live** — [RUNBOOK.md](RUNBOOK.md), [UAT_PLAN.md](UAT_PLAN.md)
- RUNBOOK: installation, releases, backups and off-site copies, restoring production, monitoring, incident playbooks (lost phone, agent leaves, cash mismatch, held entries), secret rotation.
- New emergency command `reset-password` for a locked-out owner.
- UAT plan:
  - office and agent test scripts, including airplane mode and the 15-second payment target;
  - the **parallel-run** procedure, using the new **Compare with the workbook** check (per-customer balance and collections for a month);
  - cutover timeline;
  - sign-off sheet.

**Gate status**
- **Restore drill: passed.**
- **UAT sign-off and the parallel-run month need the owner, the office and both agents.** Everything they need is ready: the UAT plan, and the comparison tool that proves the parallel month reconciles.
- **Also still open:**
  - the real-phone check (no physical phone was available during development);
  - the SQLCipher release build (blocked on this PC by Windows' path-length limit; build with EAS or with long paths enabled);
  - the business answers Q1, Q2, Q5 and Q16.
