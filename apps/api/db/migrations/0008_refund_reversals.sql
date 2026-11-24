-- A refund entered by mistake can be deleted by the office (owner's request, 2026-11-24): like a
-- payment reversal, nothing is erased. The refund's ledger entry is reversed, the advance it used
-- comes back, and this row records who did it and why.

CREATE TABLE refund_reversals (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  refund_id   uuid NOT NULL UNIQUE REFERENCES refunds (id),
  reason      text NOT NULL,
  approved_by uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER refund_reversals_append_only BEFORE UPDATE OR DELETE ON refund_reversals
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
