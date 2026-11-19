-- Phase 7: Excel workbook import (EXCEL_MIGRATION_MAPPING §6–7).
-- A batch moves ANALYSED → DRY_RUN_OK / DRY_RUN_FAILED → APPROVED → COMMITTED (or DISCARDED).
-- Approval is tied to the exact dry-run result (hash); commit re-checks it.

CREATE TABLE import_batches (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  file_name        text NOT NULL,
  file_sha256      char(64) NOT NULL,
  file_size        integer NOT NULL,
  file_data        bytea NOT NULL,                    -- the uploaded workbook, kept for audit
  status           text NOT NULL DEFAULT 'ANALYSED'
                   CHECK (status IN ('ANALYSED', 'DRY_RUN_OK', 'DRY_RUN_FAILED', 'APPROVED', 'COMMITTED', 'DISCARDED')),
  analysis         jsonb NOT NULL,                    -- parsed customers, month grid, issues, totals
  corrections      jsonb NOT NULL DEFAULT '{}',       -- { customerCode: { field: value } }
  option           text CHECK (option IN ('FULL_HISTORY', 'OPENING_BALANCE')),
  cutover_date     date,                              -- first day the new system bills
  dry_run_report   jsonb,
  dry_run_hash     char(64),
  dry_run_at       timestamptz,
  dry_run_by       uuid REFERENCES users (id),
  approved_hash    char(64),
  approved_at      timestamptz,
  approved_by      uuid REFERENCES users (id),
  committed_at     timestamptz,
  committed_by     uuid REFERENCES users (id),
  commit_report    jsonb,
  uploaded_by      uuid NOT NULL REFERENCES users (id),
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'APPROVED' OR approved_hash IS NOT NULL),
  CHECK (status <> 'COMMITTED' OR (approved_hash IS NOT NULL AND committed_at IS NOT NULL))
);
CREATE INDEX import_batches_uploaded_idx ON import_batches (uploaded_at DESC);
-- At most one committed import of the same file.
CREATE UNIQUE INDEX import_batches_committed_file_uq ON import_batches (file_sha256) WHERE status = 'COMMITTED';
CREATE TRIGGER import_batches_updated_at BEFORE UPDATE ON import_batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A committed batch is history: nothing about it may change any more.
CREATE FUNCTION guard_committed_import() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'COMMITTED' THEN
    RAISE EXCEPTION 'A committed import cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER import_batches_committed_guard BEFORE UPDATE OR DELETE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION guard_committed_import();

ALTER TABLE customers ADD CONSTRAINT customers_import_batch_fk FOREIGN KEY (import_batch_id) REFERENCES import_batches (id);
-- Imported customers whose Excel rate could not be used (AMP/BOSS/DC/blank, Q1). Cleared when a
-- subscription is set up for the customer.
ALTER TABLE customers ADD COLUMN pending_decision text;

-- The Excel month grid, read-only, shown as "Excel history" on the customer (both import options).
CREATE TABLE legacy_statement_lines (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  customer_id      uuid NOT NULL REFERENCES customers (id),
  import_batch_id  uuid NOT NULL REFERENCES import_batches (id),
  month            date NOT NULL,                     -- first day of the month
  rate_raw         text,                              -- as typed: '400', 'AMP', ''
  rate             numeric(12, 2) NOT NULL,           -- what Excel used (text = 0)
  opening          numeric(12, 2) NOT NULL,           -- + advance / − due (Excel column D)
  received         numeric(12, 2) NOT NULL,
  fee_adjusted     numeric(12, 2) NOT NULL,
  closing_advance  numeric(12, 2) NOT NULL,
  amount_due       numeric(12, 2) NOT NULL,
  payment_date     date,
  notes            text,
  UNIQUE (customer_id, month)
);
CREATE TRIGGER legacy_statement_lines_append_only BEFORE UPDATE OR DELETE ON legacy_statement_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
