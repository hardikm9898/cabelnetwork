-- Phase 4: field visits, customer interactions (calls, promises to pay) and follow-up tasks.
-- See docs/DATABASE_DESIGN.md §8 and BUSINESS_REQUIREMENTS FR-ADMC / FR-COLL.

CREATE TYPE visit_outcome AS ENUM ('PAYMENT_COLLECTED', 'PARTIAL_PAYMENT', 'NOT_AVAILABLE', 'REFUSED',
  'WILL_PAY_LATER', 'ALREADY_PAID_ADMIN', 'WRONG_ADDRESS', 'SERVICE_DISCONTINUED', 'OTHER');

CREATE TABLE visits (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  client_id       uuid NOT NULL UNIQUE,              -- offline idempotency
  customer_id     uuid NOT NULL REFERENCES customers (id),
  agent_id        uuid NOT NULL REFERENCES users (id),
  visited_at      timestamptz NOT NULL,
  outcome         visit_outcome NOT NULL,
  payment_id      uuid REFERENCES payments (id),
  promised_amount numeric(12, 2) CHECK (promised_amount > 0),
  promised_date   date,
  follow_up_date  date,
  notes           text,
  gps_lat         numeric(9, 6),
  gps_lng         numeric(9, 6),
  gps_accuracy_m  integer,
  device_id       uuid,
  recorded_offline boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visits_customer_idx ON visits (customer_id, visited_at DESC);
CREATE INDEX visits_agent_idx ON visits (agent_id, visited_at DESC);
CREATE TRIGGER visits_append_only BEFORE UPDATE OR DELETE ON visits
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TYPE interaction_status AS ENUM ('PENDING', 'PROMISE_TO_PAY', 'FOLLOW_UP_REQUIRED', 'COMPLETED', 'NOT_INTERESTED');

CREATE TABLE interactions (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_id         uuid NOT NULL REFERENCES customers (id),
  channel             text NOT NULL CHECK (channel IN ('CALL', 'WHATSAPP', 'WALK_IN', 'VISIT', 'OTHER')),
  interaction_type    text NOT NULL CHECK (interaction_type IN ('PAYMENT_PROMISE', 'COMPLAINT', 'QUERY', 'DISCONNECTION_REQUEST', 'RECONNECTION_REQUEST', 'OTHER')),
  expected_amount     numeric(12, 2) CHECK (expected_amount > 0),
  promise_date        date,
  follow_up_date      date,
  status              interaction_status NOT NULL,
  notes               text,
  recorded_by         uuid NOT NULL REFERENCES users (id),
  resolved_payment_id uuid REFERENCES payments (id),
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users (id)
);
CREATE INDEX interactions_customer_idx ON interactions (customer_id, created_at DESC);
CREATE INDEX interactions_open_promises_idx ON interactions (promise_date) WHERE status = 'PROMISE_TO_PAY';
CREATE TRIGGER interactions_updated_at BEFORE UPDATE ON interactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE follow_up_tasks (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_id  uuid NOT NULL REFERENCES customers (id),
  -- NULL = whoever is the customer's agent when the task is due (shown to admins too).
  assigned_to  uuid REFERENCES users (id),
  due_date     date NOT NULL,
  title        text NOT NULL,
  source_type  text NOT NULL CHECK (source_type IN ('VISIT', 'INTERACTION', 'MANUAL')),
  source_id    uuid,
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'CANCELLED')),
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_by uuid REFERENCES users (id),
  outcome_note text
);
CREATE INDEX follow_up_tasks_open_idx ON follow_up_tasks (due_date) WHERE status = 'OPEN';
CREATE INDEX follow_up_tasks_customer_idx ON follow_up_tasks (customer_id);
CREATE INDEX follow_up_tasks_assignee_idx ON follow_up_tasks (assigned_to) WHERE status = 'OPEN';

-- Reporting helpers
CREATE INDEX payments_date_idx ON payments (payment_date) WHERE status = 'CONFIRMED';
CREATE INDEX ledger_entries_charge_date_idx ON ledger_entries (entry_date) WHERE type = 'CHARGE';
