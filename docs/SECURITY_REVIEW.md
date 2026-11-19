# Security Review (Phase 8)

Date: 2026-11-19. Standard: OWASP ASVS 4.0, Level 2.

**Method.** An independent, read-only review of the whole code base (API, office web, agent app, migrations) by a separate reviewer who was not shown the design's own assumptions, plus `pnpm audit --prod`. Every finding below was then fixed or consciously accepted. Each fix has an automated test (`apps/api/test/security.test.ts` and the updated suites).

**Result.** No critical or high findings. 6 medium, 11 low and 9 informational findings. All mediums are fixed; the open items are listed under *Accepted / open*.

## Findings and status

| ID | Sev. | Finding | Status |
|---|---|---|---|
| M-1 | Medium | The JWT secret check accepted the example placeholder; receipt links were signed with a key derived from the same secret | **Fixed.** In production the API refuses to start with a placeholder or low-variety secret. Receipt links use their own `RECEIPT_LINK_SECRET`, which must differ from the JWT secret. |
| M-2 | Medium | `TRUST_PROXY=true` trusted every hop, so a client could pick its own IP via `X-Forwarded-For` and escape the login rate limit | **Fixed.** `TRUST_PROXY` takes a hop count (`1` behind Caddy) or a CIDR list; `true` is refused. Caddy replaces any client-sent `X-Forwarded-For`. |
| M-3 | Medium | A forwarded receipt link showed address, full mobile and balances for 30 days and could not be revoked | **Fixed.** The public PDF masks the mobile (`98xxxxxx12`) and leaves out the address, collector, previous balance and advance. Links last 7 days (`RECEIPT_LINK_TTL_DAYS`). A reversed or reissued (cancelled) receipt's link returns 404. Responses are `Cache-Control: no-store`. |
| M-4 | Medium | Offline sync trusted the phone's timestamps for both the access check and the payment date, so a reassigned agent could post confirmed cash to a former customer and read its balance | **Fixed.** Payments flagged `REASSIGNED_BEFORE_SYNC`, `NOT_ASSIGNED_AT_COLLECTION`, `LATE_SYNC` or `CLOCK_SKEW` are **held as pending verification** (no ledger entry or receipt until the office verifies them). The sync answer then carries no balance. A collector without current access sees only their own payment, without balance or receipt details, and cannot create share links. Online `receivedAt` is bounded to the back-date window. |
| M-5 | Medium | Office web sessions never expired while in use; refresh token in `localStorage` | **Fixed (partly).** Office sessions end 12 h after sign-in however active (`ADMIN_SESSION_MAX_HOURS`, ASVS 3.3.2). The site ships a strict CSP and has no HTML-injection sinks. *Open:* moving the office refresh token to an HttpOnly cookie. |
| M-6 | Medium | The credit approval limit could be bypassed by cancelling bills or splitting credits | **Fixed.** One cumulative limit per office admin, per customer, per day, over credits + refunds + cancelled bills (`credits.limits.adminMaxAmount`). The super admin is not limited. |
| L-1 | Low | Password policy below ASVS L2 | **Fixed for office accounts.** 12+ characters; common patterns and the user's own mobile number are refused. Agents keep 8+ (PIN-locked, device-bound app, lockout). |
| L-2 | Low | Lockout revealed which mobiles have accounts | **Fixed.** A locked account answers exactly like a wrong password, with the same timing. |
| L-3 | Low | Wrong current passwords on change-password were not throttled or counted | **Fixed.** Throttled like sign-in; failures count toward the lockout. |
| L-4 | Low | Unbounded argon2 work (64 MiB each) | **Fixed.** At most 4 hash/verify operations at once; the rest queue. |
| L-5 | Low | No `Cache-Control` on authenticated data | **Fixed.** `no-store` on every API response. The office site's HTML is `no-cache`, and its hashed assets are immutable. |
| L-6 | Low | Receipt tokens, search terms and DB error details in logs | **Fixed.** Request logs drop query strings and mask `/public/receipts/<token>`; `err.detail` is redacted. |
| L-7 | Low | Receipt-link base URL taken from the request when unset | **Fixed.** `PUBLIC_BASE_URL` (https) is required in production. |
| L-8 | Low | No maker-checker on cash | **Fixed (partly).** Nobody can confirm their own handover, and every cash write-off or recovery raises an owner alert. *Accepted:* write-offs are not amount-limited; the owner sees each one. |
| L-9 | Low | The refresh grace window (60 s) allows a silent takeover with a token captured in that window | **Accepted.** Exploiting it needs a refresh token captured within 60 s, which is already a full compromise of that token; the window prevents lockouts on bad mobile networks. Revisit if refresh requests start carrying the device id. |
| L-10 | Low | Excel upload could exhaust memory (zip bomb) | **Fixed.** The declared uncompressed size is read from the zip directory before anything is unpacked, with a 300 MB limit. Super admin only. |
| L-11 | Low | Two moderate dependency advisories (`exceljs>uuid`, `expo>…>minimatch`) | **Accepted.** Neither code path is used (exceljs never passes a buffer to `uuid`; minimatch is build tooling). Re-check with `pnpm audit --prod` at each release. |
| I-1 | Info | `NODE_ENV` defaulted to development (Swagger on) | **Fixed.** `NODE_ENV` is required; Swagger is off in production (verified: 404). |
| I-2 | Info | Constraint names in error details | **Accepted.** Schema names only, no data. |
| I-3 | Info | Device blocking is advisory (the phone chooses its id) | **Accepted and documented** (RUNBOOK: for a lost phone, revoke the device **and** reset the agent's password). |
| I-4 | Info | Session revoke route did not check the user is an agent | **Accepted.** The family id is never exposed to other users. |
| I-5 | Info | The uploaded workbook (all customer data) kept forever | **Fixed.** Its bytes are purged on commit or discard; the hash is kept. |
| I-6 | Info | Agents can list all societies with customer counts | **Accepted.** No customer-level data. |
| I-7 | Info | Agent app: database recreated on key mismatch; release builds must use https | **Fixed (partly).** Release builds refuse a non-https API address, and EAS profiles point at https. *Accepted:* the key-mismatch recreate (the file is unreadable either way). |
| I-8 | Info | In-memory rate limits are per instance | **Accepted.** There is a single instance (SYSTEM_ARCHITECTURE §9). |
| I-9 | Info | Large sync payloads stored as-is | **Fixed.** Entries over 4 KB are rejected and not stored. |

## Areas checked and passed

- **V2 authentication.**
  - argon2id (64 MiB, t=3), with a dummy verify against timing-based enumeration.
  - Lockout and rate limits.
  - Forced change of temporary passwords, enforced server-side on every route.
- **V3 sessions.**
  - HS256 pinned, issuer and expiry checked.
  - Every request re-checks the session row and the user's status, so logout, reset, deactivation and device revoke act at once.
  - Refresh tokens are 256-bit random, stored as SHA-256, rotated under row lock; reuse revokes the whole session family.
- **V4 access control.**
  - Deny by default: every route declares a permission or is deliberately public. The only public routes are login, refresh, health, ready and the public receipt.
  - Agents only reach customers currently assigned to them; others return 404 (IDOR-proof). This covers balances, ledgers, invoices, payments, receipts, visits, follow-ups, handovers, sync operations and Excel history.
  - No mass assignment: zod strips unknown fields.
- **V5 validation.**
  - All SQL is parameterised; the only `sql.raw` uses are constants, and sort columns come from an allow-list.
  - Money is strict decimal (no floats, no negatives), with DB `CHECK` constraints.
  - Exports write text cells, never formulas.
  - Uploads: size limit, extension and magic-byte check, and the zip-bomb guard.
- **V7 errors and logging.**
  - No stack traces or SQL text reach clients.
  - Authorization headers are redacted.
  - The audit trail is written in the same transaction as each money action and is append-only.
- **V8/V9 data protection.**
  - TLS through Caddy (automatic certificates), HSTS, CSP, frame-ancestors none, nosniff, referrer policy.
  - CORS off unless configured.
  - Agent phone data in SQLCipher, keyed from the Android Keystore; PIN lock with wipe after 5 failures.
- **V11 business logic.**
  - Exactly-once payments (`client_txn_id` unique, per-customer lock, per-operation advisory lock in sync).
  - Idempotency keys bound to the request body for office financial commands.
  - Append-only money tables enforced by triggers.
  - Reversal is blocked while a payment is in a pending handover.
- **V14 configuration.**
  - The API refuses to start with pending migrations or unsafe production settings.
  - `.env`, production env files, backups and Excel/CSV files are git-ignored.
  - No high or critical dependency advisories.
