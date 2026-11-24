-- Delete for customers, societies, areas and office/agent accounts (owner's request, 2026-11-24).
--
-- Money and history tables are append-only (triggers), so "delete" is a soft delete: the row is
-- kept with deleted_at / deleted_by / delete_reason, hidden from lists, phones and billing, and
-- its ID, name or mobile number can be used again. A deleted customer can be restored.

ALTER TABLE customers
  ADD COLUMN deleted_at    timestamptz,
  ADD COLUMN deleted_by    uuid REFERENCES users (id),
  ADD COLUMN delete_reason text;
ALTER TABLE societies
  ADD COLUMN deleted_at    timestamptz,
  ADD COLUMN deleted_by    uuid REFERENCES users (id);
ALTER TABLE areas
  ADD COLUMN deleted_at    timestamptz,
  ADD COLUMN deleted_by    uuid REFERENCES users (id);
ALTER TABLE users
  ADD COLUMN deleted_at    timestamptz,
  ADD COLUMN deleted_by    uuid REFERENCES users (id);

-- Names, IDs and mobile numbers stay unique among the rows that are not deleted.
DROP INDEX customers_code_uq;
CREATE UNIQUE INDEX customers_code_uq ON customers (lower(customer_code)) WHERE deleted_at IS NULL;
DROP INDEX societies_name_uq;
CREATE UNIQUE INDEX societies_name_uq ON societies (lower(name)) WHERE deleted_at IS NULL;
DROP INDEX areas_name_uq;
CREATE UNIQUE INDEX areas_name_uq ON areas (lower(name)) WHERE deleted_at IS NULL;
DROP INDEX users_mobile_uq;
CREATE UNIQUE INDEX users_mobile_uq ON users (mobile) WHERE deleted_at IS NULL;

-- A deleted customer has no current agent: it leaves the agents' phones and work lists.
CREATE OR REPLACE VIEW customer_current_agent AS
SELECT DISTINCT ON (a.customer_id)
       a.customer_id, a.agent_id, a.kind, a.source, a.id AS assignment_id, a.temp_reassignment_id
FROM customer_agent_assignments a
JOIN customers c ON c.id = a.customer_id AND c.deleted_at IS NULL
WHERE a.valid_during @> now()
ORDER BY a.customer_id, (a.kind = 'TEMPORARY') DESC;

CREATE OR REPLACE VIEW customer_primary_agent AS
SELECT a.customer_id, a.agent_id, a.source, a.id AS assignment_id
FROM customer_agent_assignments a
JOIN customers c ON c.id = a.customer_id AND c.deleted_at IS NULL
WHERE a.kind = 'PRIMARY' AND a.valid_during @> now();

-- A rate that no bill has used yet may be replaced on the same date (e.g. the imported rate that
-- starts at cutover, corrected before cutover). The service allows this only when nothing is
-- billed from that date on, and sets the flag for that one statement's transaction.
CREATE FUNCTION subscription_rates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('cablenet.replace_unbilled_rate', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;
DROP TRIGGER subscription_rates_append_only ON subscription_rates;
CREATE TRIGGER subscription_rates_append_only BEFORE UPDATE OR DELETE ON subscription_rates
  FOR EACH ROW EXECUTE FUNCTION subscription_rates_guard();
