# Database Design

Engine: **PostgreSQL 18**. Access: Kysely (typed SQL builder, camelCase ↔ snake_case plugin). Schema: hand-written numbered SQL migrations in `apps/api/db/migrations`. The SQL below is the design; the migrations are authoritative. Implemented so far: §2–§4, §10 (audit_logs, notifications, business_settings), in `0001_foundation.sql`.

Conventions
- Primary keys: `uuid` (UUIDv7, time-ordered) except high-volume append-only tables (`ledger_entries`, `audit_logs`), which use `bigint identity`.
- Money: `numeric(12,2)` with `CHECK (amount >= 0)` unless signed by design.
- Timestamps: `timestamptz` (UTC). Business dates: `date` interpreted in `Asia/Kolkata`.
- Every mutable table has `created_at`, `updated_at`, `created_by`, `updated_by`.
- Soft deletion: masters use `status` + `deactivated_at`; financial tables are **never** deleted (DB trigger blocks `DELETE`, and `UPDATE` of financial columns).
- Enums are Postgres enums (listed inline).

---

## 1. Entity overview

```
              ┌────────┐      ┌───────────┐
              │ areas  │──<───│ societies │──<──┐
              └───┬────┘      └───────────┘     │
                  │ area_agent_assignments      │
┌───────┐   ┌─────┴──────┐                 ┌────┴──────┐   ┌──────────────────────┐
│ users │───│agent_profiles│──<customer_agent_assignments>──│ customers │──<│ customer_connections │
└───┬───┘   └────────────┘                 └────┬──────┘   └──────────────────────┘
    │ sessions/devices                          │
    │                         ┌─────────────────┼────────────────────┬──────────────┐
    │                customer_subscriptions  invoices ──< invoice_items     visits / interactions
    │                   │  subscription_rates   │  ^                         follow_up_tasks
    │                   │  subscription_suspensions                          
    │                   │                      allocations >── payments ──── receipts
    │                   │                       │            credit_notes    payment_reversals
    │                   │                       │            refunds
    │                ledger_entries (append-only, every money event)
    │
    └── cash_handovers ──< cash_handover_items >── payments
        agent_daily_closings, cash_adjustments
audit_logs · notifications · outbound_messages · import_batches/import_rows · legacy_statement_lines
business_settings · number_sequences · idempotency_keys · sync_operations · billing_runs · system_alerts
```

Changes from the suggested entity list (and why):
- **Roles / Permissions** → a `role` enum on `users` plus a permission matrix in code (`packages/domain/permissions.ts`), unit-tested. There are three fixed roles; DB-driven permissions add complexity without benefit now. Can be added later without schema churn elsewhere.
- **Customer Addresses** → single address on `customers` (one service address per customer in all data). Connections (STB/MQ) get their own table because set-top boxes get replaced and the business ID is derived from the STB number.
- **Collection Agents** → `agent_profiles` (1:1 with `users`) so agents and admins share one login system.
- **Subscription Plans** → optional `plans` table (label + default rate); the actual price always lives on the customer's `subscription_rates` because every customer has an individual rate.
- **Cash Reconciliation** → `agent_daily_closings` (snapshot) + derived views.
- Added: `credit_notes`, `refunds`, `payment_reversals`, `allocations` (generalised payment allocations), `billing_runs`, `number_sequences`, `idempotency_keys`, `legacy_statement_lines`, `system_alerts`, `outbound_messages`.

---

## 2. Identity & access

```sql
CREATE TYPE user_role   AS ENUM ('SUPER_ADMIN','ADMIN','AGENT');
CREATE TYPE user_status AS ENUM ('ACTIVE','SUSPENDED','DEACTIVATED');

CREATE TABLE users (
  id              uuid PRIMARY KEY,
  full_name       text NOT NULL,
  mobile          varchar(15) NOT NULL UNIQUE,      -- login id
  email           citext UNIQUE,
  password_hash   text NOT NULL,                    -- argon2id
  role            user_role NOT NULL,
  status          user_status NOT NULL DEFAULT 'ACTIVE',
  must_change_password boolean NOT NULL DEFAULT true,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at, updated_at, created_by, updated_by
);

CREATE TABLE agent_profiles (
  user_id           uuid PRIMARY KEY REFERENCES users(id),
  agent_code        varchar(10) NOT NULL UNIQUE,     -- e.g. 'AG01' (used in provisional receipt refs)
  photo_url         text,
  joining_date      date,
  employment_status text NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | ON_LEAVE | LEFT
  notes             text
);

CREATE TABLE devices (
  id            uuid PRIMARY KEY,                    -- generated on device at install
  user_id       uuid NOT NULL REFERENCES users(id),
  platform      text, model text, app_version text,
  push_token    text,
  first_seen_at timestamptz, last_seen_at timestamptz,
  last_sync_at  timestamptz,                         -- Phase 6: last pull/push (office: "not synced since")
  revoked_at    timestamptz
);

CREATE TABLE sessions (                              -- refresh-token families
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id),
  device_id          uuid REFERENCES devices(id),
  refresh_token_hash text NOT NULL UNIQUE,           -- sha256 of opaque token
  family_id          uuid NOT NULL,                  -- rotation family (reuse ⇒ revoke family)
  ip inet, user_agent text,
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  rotated_at timestamptz, revoked_at timestamptz, revoke_reason text
);
```

## 3. Geography & assignment

```sql
CREATE TABLE areas (
  id uuid PRIMARY KEY, name text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'ACTIVE', ...
);

CREATE TABLE societies (
  id            uuid PRIMARY KEY,
  area_id       uuid REFERENCES areas(id),           -- nullable until admin groups them
  name          text NOT NULL,                       -- display name (admin may clean up)
  legacy_name   text,                                -- exactly as typed in Excel
  collection_day smallint CHECK (collection_day BETWEEN 1 AND 31),  -- usual route day
  status        text NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (lower(name))
);

-- Default owner of an area (effective-dated history)
CREATE TABLE area_agent_assignments (
  id uuid PRIMARY KEY,
  area_id   uuid NOT NULL REFERENCES areas(id),
  agent_id  uuid NOT NULL REFERENCES agent_profiles(user_id),
  valid_during tstzrange NOT NULL,
  created_by uuid NOT NULL, reason text,
  EXCLUDE USING gist (area_id WITH =, valid_during WITH &&)   -- one owner at a time
);

CREATE TYPE assignment_kind AS ENUM ('PRIMARY','TEMPORARY');
CREATE TYPE assignment_source AS ENUM ('AREA_DEFAULT','MANUAL','IMPORT','TEMP_REASSIGNMENT');

-- The per-customer source of truth for "who may collect from this customer, when"
CREATE TABLE customer_agent_assignments (
  id uuid PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers(id),
  agent_id     uuid NOT NULL REFERENCES agent_profiles(user_id),
  kind         assignment_kind NOT NULL,
  source       assignment_source NOT NULL,
  valid_during tstzrange NOT NULL,                   -- [from, to)  to=NULL ⇒ open-ended
  temp_reassignment_id uuid REFERENCES temp_reassignments(id),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL,
  ended_by uuid, ended_reason text,
  EXCLUDE USING gist (customer_id WITH =, kind WITH =, valid_during WITH &&)
);
CREATE INDEX ON customer_agent_assignments USING gist (agent_id, valid_during);

-- Header for a temporary reassignment action (bulk)
CREATE TABLE temp_reassignments (
  id uuid PRIMARY KEY,
  from_agent_id uuid NOT NULL, to_agent_id uuid NOT NULL CHECK (to_agent_id <> from_agent_id),
  scope        text NOT NULL,                        -- ALL_OF_AGENT | SOCIETIES | CUSTOMERS
  scope_ids    uuid[],                               -- society or customer ids
  starts_on    date NOT NULL, ends_on date NOT NULL CHECK (ends_on >= starts_on),
  reason       text NOT NULL,
  status       text NOT NULL,                        -- SCHEDULED | ACTIVE | ENDED | REVOKED
  created_by uuid NOT NULL, created_at timestamptz NOT NULL,
  revoked_by uuid, revoked_at timestamptz, revoke_reason text
);
```

**Effective agent** = active `TEMPORARY` row if any, else active `PRIMARY` row. The `PRIMARY` row is untouched during a temporary reassignment, so the original assignment is preserved and **automatically resumes when the temporary row's range ends** — no job has to "restore" anything. A scheduled job only sends start/end notifications and flips `temp_reassignments.status`. Early revoke = close the temporary rows' range at `now()`.

The exclusion constraints make conflicting assignments impossible at the database level.

```sql
CREATE VIEW v_customer_current_agent AS
SELECT DISTINCT ON (customer_id) customer_id, agent_id, kind
FROM customer_agent_assignments
WHERE valid_during @> now()
ORDER BY customer_id, (kind = 'TEMPORARY') DESC;
```

Authorization for every agent request on a customer: `EXISTS (… WHERE customer_id=$1 AND agent_id=$2 AND valid_during @> now() AND <is effective>)`.

## 4. Customers

```sql
CREATE TYPE customer_status AS ENUM ('ACTIVE','SUSPENDED','INACTIVE','DISCONNECTED');

CREATE TABLE customers (
  id              uuid PRIMARY KEY,
  customer_code   varchar(20) NOT NULL UNIQUE,       -- existing Excel ID, e.g. '322760'
  name            text NOT NULL,
  mobile          varchar(15),
  mobile_valid    boolean NOT NULL DEFAULT true,
  alt_mobile      varchar(15),
  address_line    text NOT NULL,
  landmark        text,
  society_id      uuid NOT NULL REFERENCES societies(id),
  latitude numeric(9,6), longitude numeric(9,6),
  collection_day  smallint,                          -- override of society route day
  payment_preference_months smallint,                -- informational ("pays 4 months together")
  status          customer_status NOT NULL DEFAULT 'ACTIVE',
  status_reason   text,
  notes           text,
  import_batch_id uuid REFERENCES import_batches(id),
  pending_decision text,                             -- Excel rate AMP/BOSS/DC/blank (Q1); cleared when a subscription is set up
  created_at, updated_at, created_by, updated_by, deactivated_at
);
CREATE INDEX ON customers (society_id);
CREATE INDEX ON customers (mobile);
CREATE INDEX customers_search ON customers USING gin (
  (name || ' ' || customer_code || ' ' || coalesce(mobile,'')) gin_trgm_ops);

CREATE TABLE customer_connections (                  -- set-top boxes (history kept)
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  stb_number  varchar(30) NOT NULL,
  mq_number   varchar(30),
  active_from date NOT NULL, active_to date,
  notes text
);
CREATE UNIQUE INDEX ON customer_connections (stb_number) WHERE active_to IS NULL;
```

Duplicate mobile / STB **warnings** (configurable) are application checks; duplicate `customer_code` and active STB are hard DB constraints.

## 5. Subscriptions & billing

```sql
CREATE TYPE billing_mode   AS ENUM ('AUTO','MANUAL');
CREATE TYPE billing_timing AS ENUM ('ADVANCE','ARREARS');

CREATE TABLE plans (id uuid PRIMARY KEY, name text UNIQUE NOT NULL, default_monthly_rate numeric(12,2), active boolean);

CREATE TABLE customer_subscriptions (
  id uuid PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers(id),
  plan_id      uuid REFERENCES plans(id),
  status       text NOT NULL,                       -- ACTIVE | SUSPENDED | ENDED
  start_date   date NOT NULL, end_date date,
  billing_mode billing_mode NOT NULL DEFAULT 'AUTO',
  billing_interval_months smallint NOT NULL DEFAULT 1 CHECK (billing_interval_months BETWEEN 1 AND 24),
  billing_anchor_day smallint NOT NULL DEFAULT 1 CHECK (billing_anchor_day BETWEEN 1 AND 28),
  billing_timing billing_timing NOT NULL DEFAULT 'ADVANCE',
  due_days     smallint,                             -- null ⇒ business default
  proration    text NOT NULL DEFAULT 'NONE',
  next_period_start date NOT NULL,                   -- scheduler cursor
  created_at, updated_at, created_by, updated_by
);
CREATE UNIQUE INDEX one_live_subscription ON customer_subscriptions (customer_id) WHERE status <> 'ENDED';

CREATE TABLE subscription_rates (                    -- price history
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES customer_subscriptions(id),
  monthly_rate    numeric(12,2) NOT NULL CHECK (monthly_rate >= 0),
  effective_from  date NOT NULL,
  reason text, created_by uuid NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE (subscription_id, effective_from)
);

CREATE TABLE subscription_suspensions (
  id uuid PRIMARY KEY, subscription_id uuid NOT NULL,
  during daterange NOT NULL, reason text NOT NULL, created_by uuid NOT NULL,
  EXCLUDE USING gist (subscription_id WITH =, during WITH &&)
);

CREATE TABLE billing_runs (
  id uuid PRIMARY KEY, run_for_date date NOT NULL, trigger text NOT NULL,  -- SCHEDULED | MANUAL
  started_at timestamptz, finished_at timestamptz, status text,
  invoices_created int, errors jsonb
);

CREATE TYPE invoice_kind   AS ENUM ('SUBSCRIPTION','OPENING_BALANCE','DEBIT_ADJUSTMENT');
CREATE TYPE invoice_status AS ENUM ('DRAFT','UNPAID','PARTIALLY_PAID','PAID','CANCELLED');  -- OVERDUE derived

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  invoice_number varchar(30) UNIQUE,                 -- null while DRAFT
  kind           invoice_kind NOT NULL,
  customer_id    uuid NOT NULL REFERENCES customers(id),
  subscription_id uuid REFERENCES customer_subscriptions(id),
  period_start date, period_end date,
  billing_date date NOT NULL, due_date date NOT NULL,
  subtotal numeric(12,2) NOT NULL, discount_total numeric(12,2) NOT NULL DEFAULT 0,
  total    numeric(12,2) NOT NULL CHECK (total >= 0),
  amount_paid numeric(12,2) NOT NULL DEFAULT 0,     -- cache of Σ allocations
  previous_outstanding_snapshot numeric(12,2),       -- display only
  status invoice_status NOT NULL,
  billing_run_id uuid REFERENCES billing_runs(id),
  external_ref  text UNIQUE,                         -- 'XL:322760:2026-03' for imports
  source text NOT NULL,                              -- SCHEDULER | ADMIN | IMPORT
  cancelled_at timestamptz, cancelled_by uuid, cancel_reason text,
  created_at, created_by,
  CHECK (amount_paid <= total)
);
CREATE UNIQUE INDEX invoice_period_unique ON invoices (subscription_id, period_start)
  WHERE status <> 'CANCELLED' AND kind = 'SUBSCRIPTION';
CREATE INDEX ON invoices (customer_id, status);
CREATE INDEX open_invoices ON invoices (customer_id, period_start) WHERE status IN ('UNPAID','PARTIALLY_PAID');

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY, invoice_id uuid NOT NULL REFERENCES invoices(id),
  item_type text NOT NULL,                           -- SUBSCRIPTION | DISCOUNT | ADJUSTMENT | PRORATION
  description text NOT NULL,
  months numeric(5,2), unit_rate numeric(12,2),
  amount numeric(12,2) NOT NULL,                     -- signed (discount negative)
  period_start date, period_end date
);
```

## 6. Payments, credits, allocations, receipts

```sql
CREATE TYPE payment_mode   AS ENUM ('CASH','UPI','BANK_TRANSFER','CHEQUE','OTHER','LEGACY_UNKNOWN');
CREATE TYPE payment_source AS ENUM ('AGENT_COLLECTION','ADMIN_COLLECTION','ONLINE','IMPORT','OTHER_AUTHORISED');
CREATE TYPE payment_status AS ENUM ('PENDING_VERIFICATION','CONFIRMED','FAILED','REVERSED');

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  client_txn_id  uuid NOT NULL UNIQUE,               -- idempotency (generated by client)
  customer_id    uuid NOT NULL REFERENCES customers(id),
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_date   date NOT NULL,
  received_at    timestamptz,                        -- device/server time of collection
  mode           payment_mode NOT NULL,
  reference      text,                               -- UPI UTR / cheque no / bank ref
  source         payment_source NOT NULL,
  status         payment_status NOT NULL,
  collected_by   uuid REFERENCES users(id),          -- agent or admin; null for IMPORT
  recorded_by    uuid REFERENCES users(id),
  device_id      uuid REFERENCES devices(id),
  recorded_offline boolean NOT NULL DEFAULT false,
  client_recorded_at timestamptz,                    -- phone clock when recorded (sync time: sync_operations.received_at)
  provisional_ref varchar(30),                       -- P-AG01-000042 shown to the customer before the final receipt (indexed, not unique)
  verified_by uuid, verified_at timestamptz, verification_note text,
  review_flags   text[] NOT NULL DEFAULT '{}',       -- POSSIBLE_DUPLICATE, REASSIGNED_BEFORE_SYNC, CLOCK_SKEW… (FINANCIAL_LOGIC §7)
  external_ref   text UNIQUE,                        -- imports
  gateway_txn_id text UNIQUE,
  notes text,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX payment_reference_unique ON payments (mode, reference)
  WHERE reference IS NOT NULL AND mode IN ('UPI','BANK_TRANSFER') AND status <> 'FAILED';
CREATE INDEX ON payments (customer_id, payment_date);
CREATE INDEX ON payments (collected_by, payment_date) WHERE status = 'CONFIRMED';

CREATE TYPE credit_kind AS ENUM ('DISCOUNT','CREDIT_ADJUSTMENT','OPENING_ADVANCE');
CREATE TABLE credit_notes (
  id uuid PRIMARY KEY, credit_number varchar(30) UNIQUE NOT NULL,
  customer_id uuid NOT NULL, kind credit_kind NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  credit_date date NOT NULL, target_invoice_id uuid REFERENCES invoices(id),
  reason text NOT NULL, approved_by uuid NOT NULL, external_ref text UNIQUE,
  status text NOT NULL DEFAULT 'ACTIVE',             -- ACTIVE | REVERSED
  created_at timestamptz NOT NULL
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY, customer_id uuid NOT NULL, amount numeric(12,2) NOT NULL CHECK (amount > 0),
  refund_date date NOT NULL, mode payment_mode NOT NULL, reference text,
  reason text NOT NULL, approved_by uuid NOT NULL, created_at timestamptz NOT NULL
);

-- Generalised allocation: (payment | credit_note) → (invoice | refund). Append-only.
CREATE TABLE allocations (
  id uuid PRIMARY KEY,
  customer_id    uuid NOT NULL,
  payment_id     uuid REFERENCES payments(id),
  credit_note_id uuid REFERENCES credit_notes(id),
  invoice_id     uuid REFERENCES invoices(id),
  refund_id      uuid REFERENCES refunds(id),
  amount         numeric(12,2) NOT NULL,             -- negative ⇒ compensating row
  reverses_allocation_id uuid REFERENCES allocations(id),
  created_at timestamptz NOT NULL, created_by uuid,
  CHECK (num_nonnulls(payment_id, credit_note_id) = 1),
  CHECK (num_nonnulls(invoice_id, refund_id) = 1)
);
CREATE INDEX ON allocations (invoice_id); CREATE INDEX ON allocations (payment_id);

CREATE TABLE payment_reversals (
  id uuid PRIMARY KEY, payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
  reason text NOT NULL, requested_by uuid, approved_by uuid NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE receipts (
  id uuid PRIMARY KEY,
  receipt_number varchar(30) NOT NULL UNIQUE,        -- RCPT/2026-27/000001
  payment_id uuid NOT NULL REFERENCES payments(id),
  status text NOT NULL,                              -- ISSUED | CANCELLED
  snapshot jsonb NOT NULL,                           -- frozen printed values
  issued_at timestamptz NOT NULL,
  reissue_of_receipt_id uuid REFERENCES receipts(id),
  cancelled_at timestamptz, cancelled_by uuid, cancel_reason text
);
CREATE UNIQUE INDEX one_active_receipt ON receipts (payment_id) WHERE status = 'ISSUED';
```

## 7. Ledger (append-only)

```sql
CREATE TYPE ledger_type AS ENUM ('OPENING_BALANCE','CHARGE','PAYMENT','DISCOUNT',
  'DEBIT_ADJUSTMENT','CREDIT_ADJUSTMENT','REFUND','REVERSAL');

CREATE TABLE ledger_entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   uuid NOT NULL REFERENCES customers(id),
  entry_date    date NOT NULL,                       -- business date
  posted_at     timestamptz NOT NULL DEFAULT now(),
  type          ledger_type NOT NULL,
  amount        numeric(12,2) NOT NULL CHECK (amount <> 0),  -- + owes, − credit
  invoice_id uuid, payment_id uuid, credit_note_id uuid, refund_id uuid,
  reverses_entry_id bigint UNIQUE REFERENCES ledger_entries(id),
  description   text NOT NULL,
  created_by    uuid,
  import_batch_id uuid
);
CREATE INDEX ON ledger_entries (customer_id, entry_date, id);

-- Hard immutability
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
-- Same trigger on allocations, audit_logs, payment_reversals.
-- payments/invoices/receipts: a trigger allows only whitelisted status transitions and
-- forbids changing amount/customer/date columns once CONFIRMED/issued.
```

Balance queries:
```sql
CREATE VIEW v_customer_balance AS
SELECT customer_id, sum(amount) AS balance,
       greatest(sum(amount),0) AS outstanding, greatest(-sum(amount),0) AS advance
FROM ledger_entries GROUP BY customer_id;
```
At this scale (hundreds of customers, a few thousand entries/year) the view is instant. If the business grows to tens of thousands of customers, add a `customer_balances` table maintained in the same posting transaction and verified nightly.

## 8. Field operations

```sql
CREATE TYPE visit_outcome AS ENUM ('PAYMENT_COLLECTED','PARTIAL_PAYMENT','NOT_AVAILABLE','REFUSED',
  'WILL_PAY_LATER','ALREADY_PAID_ADMIN','WRONG_ADDRESS','SERVICE_DISCONTINUED','OTHER');

CREATE TABLE visits (
  id uuid PRIMARY KEY, client_id uuid NOT NULL UNIQUE,   -- offline idempotency
  customer_id uuid NOT NULL, agent_id uuid NOT NULL,
  visited_at timestamptz NOT NULL, outcome visit_outcome NOT NULL,
  payment_id uuid REFERENCES payments(id),
  promised_amount numeric(12,2), promised_date date, follow_up_date date,
  notes text, gps_lat numeric(9,6), gps_lng numeric(9,6), gps_accuracy_m int,  -- only if setting enabled
  device_id uuid, synced_at timestamptz, created_at timestamptz
);

CREATE TYPE interaction_status AS ENUM ('PENDING','PROMISE_TO_PAY','FOLLOW_UP_REQUIRED','COMPLETED','NOT_INTERESTED');
CREATE TABLE interactions (
  id uuid PRIMARY KEY, customer_id uuid NOT NULL,
  channel text NOT NULL,                            -- CALL | WHATSAPP | WALK_IN | OTHER
  interaction_type text NOT NULL,                   -- PAYMENT_PROMISE | COMPLAINT | QUERY | DISCONNECTION_REQUEST …
  expected_amount numeric(12,2), promise_date date, follow_up_date date,
  status interaction_status NOT NULL, notes text,
  recorded_by uuid NOT NULL, resolved_payment_id uuid REFERENCES payments(id),
  created_at, updated_at
);

CREATE TABLE follow_up_tasks (
  id uuid PRIMARY KEY, customer_id uuid NOT NULL,
  assigned_to uuid REFERENCES users(id),            -- null ⇒ current agent of customer
  due_date date NOT NULL, source_type text, source_id uuid,   -- VISIT | INTERACTION | MANUAL
  status text NOT NULL,                             -- OPEN | DONE | CANCELLED
  completed_at timestamptz, completed_by uuid, outcome_note text
);
CREATE INDEX ON follow_up_tasks (status, due_date);
```

## 9. Cash management

```sql
CREATE TABLE cash_handovers (
  id uuid PRIMARY KEY, handover_number varchar(30) UNIQUE NOT NULL,
  agent_id uuid NOT NULL, submitted_at timestamptz NOT NULL, client_id uuid UNIQUE,
  expected_amount numeric(12,2) NOT NULL,           -- Σ items (server computed)
  declared_amount numeric(12,2) NOT NULL,           -- agent says
  received_amount numeric(12,2),                    -- admin counted
  difference numeric(12,2),                         -- received − expected
  status text NOT NULL,                             -- SUBMITTED | CONFIRMED | DISPUTED | REJECTED
  verified_by uuid, verified_at timestamptz, mismatch_reason text, notes text
);
CREATE TABLE cash_handover_items (
  handover_id uuid NOT NULL REFERENCES cash_handovers(id),
  payment_id  uuid NOT NULL UNIQUE REFERENCES payments(id),  -- each cash payment handed over once
  amount numeric(12,2) NOT NULL
);
CREATE TABLE cash_adjustments (                     -- shortage recovery / write-off / excess
  id uuid PRIMARY KEY, agent_id uuid NOT NULL, handover_id uuid,
  amount numeric(12,2) NOT NULL, kind text NOT NULL, reason text NOT NULL,
  approved_by uuid NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE agent_daily_closings (
  id uuid PRIMARY KEY, agent_id uuid NOT NULL, business_date date NOT NULL,
  opening_cash, cash_collected, upi_collected, other_collected, cash_submitted,
  expected_closing_cash, declared_cash, difference  numeric(12,2),
  submitted_at timestamptz, reviewed_by uuid, reviewed_at timestamptz,
  UNIQUE (agent_id, business_date)
);
```

## 10. Platform tables

| Table | Key columns | Notes |
|---|---|---|
| `audit_logs` | `id bigint`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `before jsonb`, `after jsonb`, `reason`, `ip`, `user_agent`, `device_id`, `session_id`, `created_at` | Append-only trigger. Indexed by `(entity_type, entity_id)` and `(actor_user_id, created_at)`. |
| `notifications` | `user_id`, `type`, `title`, `body`, `data jsonb`, `read_at` | In-app inbox. |
| `outbound_messages` | `channel` (PUSH/SMS/WHATSAPP), `recipient`, `template`, `payload`, `provider`, `status`, `attempts`, `next_attempt_at`, `provider_message_id`, `error` | Transactional outbox; a worker sends via provider adapters. |
| `import_batches` | `file_name`, `file_sha256`, `file_data bytea`, `status` (ANALYSED/DRY_RUN_OK/DRY_RUN_FAILED/APPROVED/COMMITTED/DISCARDED), `analysis jsonb` (parsed workbook), `corrections jsonb`, `option` (FULL_HISTORY/OPENING_BALANCE), `cutover_date`, `dry_run_report`, `dry_run_hash`, `approved_hash/by/at`, `committed_by/at`, `commit_report` | Migration `0005_import.sql`. A committed batch cannot change (trigger); one commit per file hash. |
| `legacy_statement_lines` | `customer_id`, `import_batch_id`, `month`, `rate_raw`, `rate`, `opening`, `received`, `fee_adjusted`, `closing_advance`, `amount_due`, `payment_date`, `notes` | Read-only copy of the Excel month grid (recomputed with the workbook's formulas), unique per customer and month, append-only. Rows live on the batch instead of a separate `import_rows` table: the parsed workbook is small (163 customers × 12 months). |
| `business_settings` | `key` PK, `value jsonb`, `updated_by`, `updated_at` | Business name/logo/address, due days, GPS check-in on/off, duplicate warning rules, receipt footer, thresholds. Changes audited. |
| `number_sequences` | `(name, fiscal_year)` PK, `next_value` | Gap-free numbering (`SELECT … FOR UPDATE`). |
| `idempotency_keys` | `key`, `user_id`, `request_hash`, `response_status`, `response_body`, `created_at` | 30-day retention for all financial POSTs. |
| `sync_operations` | `op_id` PK (phone UUID), `user_id`, `device_id`, `op_type` (PAYMENT_CREATE/VISIT_CREATE/FOLLOWUP_DONE), `device_seq`, `client_created_at`, `effective_at` (clock-corrected), `clock_skew_seconds`, `recorded_offline`, `payload`, `status` (APPLIED/NEEDS_REVIEW/REJECTED; DUPLICATE is only a response), `flags[]`, `error_code/message`, `customer_id`, `payment_id`, `visit_id`, `result`, `received_at`, `reviewed_by/at`, `review_note` | Migration `0004_sync.sql`. One row per operation id, written in the same transaction as its effect. Immutable except the review columns (`guard_financial_update`); no deletes. Partial index on open reviews. |
| `system_alerts` | `type`, `severity`, `entity`, `details`, `resolved_by`, `resolved_at` | Reconciliation mismatches, sync failures, suspicious activity. |

## 11. Reporting

Reports are SQL over the normalised tables (with the indexes above). Ageing buckets come from open invoices by `due_date` (0–30, 31–60, 61–90, 90+). If any report becomes slow, add materialised views refreshed after posting, never denormalised money columns used as truth.

## 12. Backup & retention

- Nightly `pg_dump` (encrypted) + continuous WAL archiving to off-site object storage (point-in-time recovery).
- Monthly restore drill into a scratch database with the reconciliation job run against it.
- Financial and audit data retained indefinitely (minimum 8 years for Indian tax records).
