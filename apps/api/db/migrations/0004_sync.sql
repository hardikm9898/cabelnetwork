-- Phase 6: offline sync. Every operation an agent's phone sends is stored once, by the id the
-- phone gave it, together with what the server did with it. See SYSTEM_ARCHITECTURE §6 and
-- FINANCIAL_LOGIC §7.

CREATE TABLE sync_operations (
  op_id              uuid PRIMARY KEY,                       -- generated on the phone
  user_id            uuid NOT NULL REFERENCES users (id),
  device_id          uuid,
  op_type            text NOT NULL CHECK (op_type IN ('PAYMENT_CREATE', 'VISIT_CREATE', 'FOLLOWUP_DONE')),
  device_seq         integer,
  client_created_at  timestamptz NOT NULL,                  -- phone clock when recorded
  effective_at       timestamptz NOT NULL,                  -- corrected for the phone's clock error
  clock_skew_seconds integer NOT NULL DEFAULT 0,            -- server time minus phone time at send
  recorded_offline   boolean NOT NULL DEFAULT false,
  payload            jsonb NOT NULL,
  -- APPLIED: done. NEEDS_REVIEW: done, but something needs a human look (flags).
  -- REJECTED: invalid, nothing was changed. Replays return the stored outcome.
  status             text NOT NULL CHECK (status IN ('APPLIED', 'NEEDS_REVIEW', 'REJECTED')),
  flags              text[] NOT NULL DEFAULT '{}',
  error_code         text,
  error_message      text,
  customer_id        uuid REFERENCES customers (id),
  payment_id         uuid REFERENCES payments (id),
  visit_id           uuid REFERENCES visits (id),
  result             jsonb,
  received_at        timestamptz NOT NULL DEFAULT now(),
  reviewed_by        uuid REFERENCES users (id),
  reviewed_at        timestamptz,
  review_note        text,
  CHECK ((status = 'REJECTED') = (error_code IS NOT NULL)),
  CHECK (status <> 'NEEDS_REVIEW' OR cardinality(flags) > 0)
);
CREATE INDEX sync_operations_open_review_idx ON sync_operations (received_at)
  WHERE status IN ('NEEDS_REVIEW', 'REJECTED') AND reviewed_at IS NULL;
CREATE INDEX sync_operations_user_idx ON sync_operations (user_id, received_at DESC);
CREATE INDEX sync_operations_payment_idx ON sync_operations (payment_id) WHERE payment_id IS NOT NULL;

-- History is fixed; only the office review can be added.
CREATE TRIGGER sync_operations_guard BEFORE UPDATE ON sync_operations FOR EACH ROW EXECUTE FUNCTION
  guard_financial_update('reviewed_by', 'reviewed_at', 'review_note');
CREATE TRIGGER sync_operations_no_delete BEFORE DELETE ON sync_operations FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Reference the phone showed the customer before the final receipt existed (P-AG01-000042).
ALTER TABLE payments ADD COLUMN provisional_ref varchar(30);
-- Not unique: after a reinstall the phone's counter restarts at the floor the next pull sends.
CREATE INDEX payments_provisional_ref_idx ON payments (provisional_ref) WHERE provisional_ref IS NOT NULL;

-- When each phone last sent or fetched data (office: "phone not synced since …").
ALTER TABLE devices ADD COLUMN last_sync_at timestamptz;
