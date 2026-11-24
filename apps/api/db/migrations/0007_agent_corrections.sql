-- Agents delete a payment entered by mistake from the phone (owner's request, 2026-11-24).
-- It travels through offline sync like a payment; the server reverses the payment (nothing is
-- erased), cancels the receipt and raises an alert for the office.

ALTER TABLE sync_operations DROP CONSTRAINT sync_operations_op_type_check;
ALTER TABLE sync_operations ADD CONSTRAINT sync_operations_op_type_check
  CHECK (op_type IN ('PAYMENT_CREATE', 'VISIT_CREATE', 'FOLLOWUP_DONE', 'PAYMENT_CANCEL'));
