-- Phase 3: subscriptions, billing, invoices, payments, allocations, credits, refunds,
-- receipts, ledger, cash handover, reconciliation alerts, idempotency, job bookkeeping.
-- See docs/FINANCIAL_LOGIC.md and docs/DATABASE_DESIGN.md §5–§9.

-- ---------------------------------------------------------------------------
-- Numbering (gap-free per financial year; row-locked)
-- ---------------------------------------------------------------------------
CREATE TABLE number_sequences (
  name        text NOT NULL,
  fiscal_year text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (name, fiscal_year)
);

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
CREATE TYPE billing_mode AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE billing_timing AS ENUM ('ADVANCE', 'ARREARS');
CREATE TYPE subscription_status AS ENUM ('ACTIVE', 'SUSPENDED', 'ENDED');

CREATE TABLE customer_subscriptions (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_id             uuid NOT NULL REFERENCES customers (id),
  status                  subscription_status NOT NULL DEFAULT 'ACTIVE',
  start_date              date NOT NULL,
  end_date                date,
  billing_mode            billing_mode NOT NULL DEFAULT 'AUTO',
  billing_interval_months smallint NOT NULL DEFAULT 1 CHECK (billing_interval_months BETWEEN 1 AND 24),
  billing_anchor_day      smallint NOT NULL CHECK (billing_anchor_day BETWEEN 1 AND 28),
  billing_timing          billing_timing NOT NULL DEFAULT 'ADVANCE',
  due_days                smallint NOT NULL DEFAULT 10 CHECK (due_days BETWEEN 0 AND 90),
  next_period_start       date NOT NULL,          -- scheduler cursor
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid REFERENCES users (id),
  updated_by              uuid REFERENCES users (id),
  -- end_date = last day of service; start_date - 1 means "ended before it ever started".
  CHECK (end_date IS NULL OR end_date >= start_date - 1)
);
CREATE UNIQUE INDEX customer_subscriptions_one_live ON customer_subscriptions (customer_id) WHERE status <> 'ENDED';
CREATE INDEX customer_subscriptions_due_idx ON customer_subscriptions (next_period_start) WHERE status <> 'ENDED' AND billing_mode = 'AUTO';
CREATE TRIGGER customer_subscriptions_updated_at BEFORE UPDATE ON customer_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subscription_rates (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  subscription_id uuid NOT NULL REFERENCES customer_subscriptions (id),
  monthly_rate    numeric(12, 2) NOT NULL CHECK (monthly_rate >= 0),
  effective_from  date NOT NULL,
  reason          text,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, effective_from)
);
CREATE TRIGGER subscription_rates_append_only BEFORE UPDATE OR DELETE ON subscription_rates
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE subscription_suspensions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  subscription_id uuid NOT NULL REFERENCES customer_subscriptions (id),
  from_date       date NOT NULL,
  to_date         date,                              -- inclusive; NULL = until reactivated
  reason          text NOT NULL,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  ended_by        uuid REFERENCES users (id),
  ended_reason    text,
  cancelled_at    timestamptz,                      -- cancelled before it started: has no effect
  CHECK (to_date IS NULL OR to_date >= from_date),
  EXCLUDE USING gist (subscription_id WITH =, daterange(from_date, to_date, '[]') WITH &&) WHERE (cancelled_at IS NULL)
);

CREATE TABLE billing_runs (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  as_of            date NOT NULL,
  trigger          text NOT NULL CHECK (trigger IN ('SCHEDULED', 'MANUAL')),
  triggered_by     uuid REFERENCES users (id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  invoices_created integer NOT NULL DEFAULT 0,
  periods_skipped  integer NOT NULL DEFAULT 0,
  errors           jsonb NOT NULL DEFAULT '[]'
);

-- ---------------------------------------------------------------------------
-- Invoices (receivables)
-- ---------------------------------------------------------------------------
CREATE TYPE invoice_kind AS ENUM ('SUBSCRIPTION', 'OPENING_BALANCE', 'DEBIT_ADJUSTMENT');
CREATE TYPE invoice_status AS ENUM ('DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

CREATE TABLE invoices (
  id                            uuid PRIMARY KEY DEFAULT uuidv7(),
  invoice_number                varchar(30) UNIQUE,
  kind                          invoice_kind NOT NULL,
  customer_id                   uuid NOT NULL REFERENCES customers (id),
  subscription_id               uuid REFERENCES customer_subscriptions (id),
  period_start                  date,
  period_end                    date,
  billing_date                  date NOT NULL,
  due_date                      date NOT NULL,
  subtotal                      numeric(12, 2) NOT NULL,
  discount_total                numeric(12, 2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  total                         numeric(12, 2) NOT NULL CHECK (total >= 0),
  amount_paid                   numeric(12, 2) NOT NULL DEFAULT 0,
  previous_outstanding_snapshot numeric(12, 2),
  status                        invoice_status NOT NULL,
  description                   text,
  billing_run_id                uuid REFERENCES billing_runs (id),
  source                        text NOT NULL CHECK (source IN ('SCHEDULER', 'ADMIN', 'IMPORT')),
  external_ref                  text UNIQUE,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  created_by                    uuid REFERENCES users (id),
  cancelled_at                  timestamptz,
  cancelled_by                  uuid REFERENCES users (id),
  cancel_reason                 text,
  CHECK (amount_paid >= 0 AND amount_paid <= total),
  CHECK (kind <> 'SUBSCRIPTION' OR (subscription_id IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL)),
  CHECK (period_end IS NULL OR period_end >= period_start),
  CHECK (due_date >= billing_date)
);
CREATE UNIQUE INDEX invoices_period_uq ON invoices (subscription_id, period_start)
  WHERE status <> 'CANCELLED' AND kind = 'SUBSCRIPTION';
CREATE UNIQUE INDEX invoices_one_opening_balance ON invoices (customer_id)
  WHERE kind = 'OPENING_BALANCE' AND status <> 'CANCELLED';
CREATE INDEX invoices_customer_idx ON invoices (customer_id, status);
CREATE INDEX invoices_open_idx ON invoices (customer_id) WHERE status IN ('UNPAID', 'PARTIALLY_PAID');
CREATE INDEX invoices_due_idx ON invoices (due_date) WHERE status IN ('UNPAID', 'PARTIALLY_PAID');

CREATE TABLE invoice_items (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  invoice_id   uuid NOT NULL REFERENCES invoices (id),
  item_type    text NOT NULL CHECK (item_type IN ('SUBSCRIPTION', 'DISCOUNT', 'ADJUSTMENT', 'OPENING_BALANCE')),
  description  text NOT NULL,
  months       smallint,
  unit_rate    numeric(12, 2),
  amount       numeric(12, 2) NOT NULL,
  period_start date,
  period_end   date
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id);
CREATE TRIGGER invoice_items_append_only BEFORE UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Payments and other credits
-- ---------------------------------------------------------------------------
CREATE TYPE payment_mode AS ENUM ('CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE', 'OTHER', 'LEGACY_UNKNOWN');
CREATE TYPE payment_source AS ENUM ('AGENT_COLLECTION', 'ADMIN_COLLECTION', 'ONLINE', 'IMPORT', 'OTHER_AUTHORISED');
CREATE TYPE payment_status AS ENUM ('PENDING_VERIFICATION', 'CONFIRMED', 'FAILED', 'REVERSED');

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  client_txn_id      uuid NOT NULL UNIQUE,
  customer_id        uuid NOT NULL REFERENCES customers (id),
  amount             numeric(12, 2) NOT NULL CHECK (amount > 0),
  payment_date       date NOT NULL,
  received_at        timestamptz,
  mode               payment_mode NOT NULL,
  reference          text,
  source             payment_source NOT NULL,
  status             payment_status NOT NULL,
  collected_by       uuid REFERENCES users (id),
  recorded_by        uuid REFERENCES users (id),
  device_id          uuid,
  recorded_offline   boolean NOT NULL DEFAULT false,
  client_recorded_at timestamptz,
  verified_by        uuid REFERENCES users (id),
  verified_at        timestamptz,
  verification_note  text,
  review_flags       text[] NOT NULL DEFAULT '{}',
  external_ref       text UNIQUE,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_reference_uq ON payments (mode, upper(reference))
  WHERE reference IS NOT NULL AND mode IN ('UPI', 'BANK_TRANSFER', 'CHEQUE') AND status <> 'FAILED';
CREATE INDEX payments_customer_idx ON payments (customer_id, payment_date);
CREATE INDEX payments_collector_idx ON payments (collected_by, payment_date);
CREATE INDEX payments_pending_idx ON payments (created_at) WHERE status = 'PENDING_VERIFICATION';

CREATE TYPE credit_kind AS ENUM ('DISCOUNT', 'CREDIT_ADJUSTMENT', 'OPENING_ADVANCE');

CREATE TABLE credit_notes (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  credit_number     varchar(30) NOT NULL UNIQUE,
  customer_id       uuid NOT NULL REFERENCES customers (id),
  kind              credit_kind NOT NULL,
  amount            numeric(12, 2) NOT NULL CHECK (amount > 0),
  credit_date       date NOT NULL,
  target_invoice_id uuid REFERENCES invoices (id),
  reason            text NOT NULL,
  approved_by       uuid NOT NULL REFERENCES users (id),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
  external_ref      text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  reversed_at       timestamptz,
  reversed_by       uuid REFERENCES users (id),
  reverse_reason    text
);
CREATE UNIQUE INDEX credit_notes_one_opening_advance ON credit_notes (customer_id)
  WHERE kind = 'OPENING_ADVANCE' AND status = 'ACTIVE';
CREATE INDEX credit_notes_customer_idx ON credit_notes (customer_id);

CREATE TABLE refunds (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  refund_number varchar(30) NOT NULL UNIQUE,
  customer_id   uuid NOT NULL REFERENCES customers (id),
  amount        numeric(12, 2) NOT NULL CHECK (amount > 0),
  refund_date   date NOT NULL,
  mode          payment_mode NOT NULL,
  reference     text,
  reason        text NOT NULL,
  approved_by   uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- (payment | credit note) → (invoice | refund). Append-only; corrections are negative rows.
CREATE TABLE allocations (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_id            uuid NOT NULL REFERENCES customers (id),
  payment_id             uuid REFERENCES payments (id),
  credit_note_id         uuid REFERENCES credit_notes (id),
  invoice_id             uuid REFERENCES invoices (id),
  refund_id              uuid REFERENCES refunds (id),
  amount                 numeric(12, 2) NOT NULL CHECK (amount <> 0),
  reverses_allocation_id uuid UNIQUE REFERENCES allocations (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES users (id),
  CHECK (num_nonnulls(payment_id, credit_note_id) = 1),
  CHECK (num_nonnulls(invoice_id, refund_id) = 1),
  CHECK ((amount > 0) = (reverses_allocation_id IS NULL))
);
CREATE INDEX allocations_invoice_idx ON allocations (invoice_id);
CREATE INDEX allocations_payment_idx ON allocations (payment_id);
CREATE INDEX allocations_credit_idx ON allocations (credit_note_id);
CREATE INDEX allocations_customer_idx ON allocations (customer_id);
CREATE TRIGGER allocations_append_only BEFORE UPDATE OR DELETE ON allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE payment_reversals (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  payment_id  uuid NOT NULL UNIQUE REFERENCES payments (id),
  reason      text NOT NULL,
  approved_by uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payment_reversals_append_only BEFORE UPDATE OR DELETE ON payment_reversals
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE receipts (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  receipt_number        varchar(30) NOT NULL UNIQUE,
  payment_id            uuid NOT NULL REFERENCES payments (id),
  status                text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'CANCELLED')),
  snapshot              jsonb NOT NULL,
  issued_at             timestamptz NOT NULL DEFAULT now(),
  issued_by             uuid REFERENCES users (id),
  reissue_of_receipt_id uuid REFERENCES receipts (id),
  cancelled_at          timestamptz,
  cancelled_by          uuid REFERENCES users (id),
  cancel_reason         text
);
CREATE UNIQUE INDEX receipts_one_active ON receipts (payment_id) WHERE status = 'ISSUED';

-- ---------------------------------------------------------------------------
-- Ledger (append-only source of truth for balances)
-- ---------------------------------------------------------------------------
CREATE TYPE ledger_type AS ENUM ('OPENING_BALANCE', 'CHARGE', 'PAYMENT', 'DISCOUNT',
  'DEBIT_ADJUSTMENT', 'CREDIT_ADJUSTMENT', 'REFUND', 'REVERSAL');

CREATE TABLE ledger_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id       uuid NOT NULL REFERENCES customers (id),
  entry_date        date NOT NULL,
  posted_at         timestamptz NOT NULL DEFAULT now(),
  type              ledger_type NOT NULL,
  amount            numeric(12, 2) NOT NULL CHECK (amount <> 0),   -- + owes, − credit
  invoice_id        uuid REFERENCES invoices (id),
  payment_id        uuid REFERENCES payments (id),
  credit_note_id    uuid REFERENCES credit_notes (id),
  refund_id         uuid REFERENCES refunds (id),
  reverses_entry_id bigint UNIQUE REFERENCES ledger_entries (id),
  description       text NOT NULL,
  created_by        uuid REFERENCES users (id)
);
CREATE INDEX ledger_entries_customer_idx ON ledger_entries (customer_id, entry_date, id);
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE VIEW customer_balances AS
SELECT customer_id,
       sum(amount)               AS balance,
       greatest(sum(amount), 0)  AS outstanding,
       greatest(-sum(amount), 0) AS advance
FROM ledger_entries
GROUP BY customer_id;

-- ---------------------------------------------------------------------------
-- Guard: financial documents may change status, never their money/identity columns
-- ---------------------------------------------------------------------------
CREATE FUNCTION guard_financial_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := TG_ARGV;
BEGIN
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION '% is immutable except for: %', TG_TABLE_NAME, array_to_string(allowed, ', ')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payments_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION
  guard_financial_update('status', 'verified_by', 'verified_at', 'verification_note', 'review_flags');
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION
  guard_financial_update('status', 'amount_paid', 'cancelled_at', 'cancelled_by', 'cancel_reason');
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TRIGGER credit_notes_guard BEFORE UPDATE ON credit_notes FOR EACH ROW EXECUTE FUNCTION
  guard_financial_update('status', 'reversed_at', 'reversed_by', 'reverse_reason');
CREATE TRIGGER credit_notes_no_delete BEFORE DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TRIGGER receipts_guard BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION
  guard_financial_update('status', 'cancelled_at', 'cancelled_by', 'cancel_reason');
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Cash accountability
-- ---------------------------------------------------------------------------
CREATE TABLE cash_handovers (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  handover_number varchar(30) NOT NULL UNIQUE,
  agent_id        uuid NOT NULL REFERENCES users (id),
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  expected_amount numeric(12, 2) NOT NULL CHECK (expected_amount >= 0),
  declared_amount numeric(12, 2) NOT NULL CHECK (declared_amount >= 0),
  received_amount numeric(12, 2) CHECK (received_amount >= 0),
  difference      numeric(12, 2),
  status          text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'CONFIRMED', 'REJECTED')),
  notes           text,
  verified_by     uuid REFERENCES users (id),
  verified_at     timestamptz,
  mismatch_reason text
);
CREATE UNIQUE INDEX cash_handovers_one_open ON cash_handovers (agent_id) WHERE status = 'SUBMITTED';
CREATE INDEX cash_handovers_agent_idx ON cash_handovers (agent_id, submitted_at DESC);
CREATE TRIGGER cash_handovers_guard BEFORE UPDATE ON cash_handovers FOR EACH ROW EXECUTE FUNCTION
  guard_financial_update('status', 'received_amount', 'difference', 'verified_by', 'verified_at', 'mismatch_reason');
CREATE TRIGGER cash_handovers_no_delete BEFORE DELETE ON cash_handovers FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A cash payment belongs to at most one live handover; rows are removed only when a handover is rejected.
CREATE TABLE cash_handover_items (
  handover_id uuid NOT NULL REFERENCES cash_handovers (id),
  payment_id  uuid NOT NULL UNIQUE REFERENCES payments (id),
  amount      numeric(12, 2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (handover_id, payment_id)
);

CREATE TABLE cash_adjustments (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  agent_id    uuid NOT NULL REFERENCES users (id),
  handover_id uuid REFERENCES cash_handovers (id),
  -- Positive reduces what the agent owes (recovery, write-off); negative increases it (correction).
  amount      numeric(12, 2) NOT NULL CHECK (amount <> 0),
  kind        text NOT NULL CHECK (kind IN ('RECOVERY', 'WRITE_OFF', 'CORRECTION')),
  reason      text NOT NULL,
  approved_by uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cash_adjustments_append_only BEFORE UPDATE OR DELETE ON cash_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Platform
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  key             text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  route           text NOT NULL,
  request_hash    char(64) NOT NULL,
  status          text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE system_alerts (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  type        text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  entity_type text,
  entity_id   text,
  message     text NOT NULL,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id),
  resolution  text
);
CREATE INDEX system_alerts_open_idx ON system_alerts (created_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE job_runs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  job         text NOT NULL,
  business_date date NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  detail      jsonb
);
CREATE INDEX job_runs_job_idx ON job_runs (job, business_date DESC);

ALTER TABLE temp_reassignments
  ADD COLUMN start_notified_at timestamptz,
  ADD COLUMN end_notified_at timestamptz;
