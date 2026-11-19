# Financial Logic Specification

Status: **Implemented in Phase 3 (2026-11-18).** Defaults marked ⚠ Qn are configurable and await business confirmation.
All rules here are implemented only in the backend (`packages/domain` + `apps/api`). Frontends display results; they never calculate money.

---

## 1. Principles

1. **The ledger is the truth.** A customer's balance is the sum of their immutable ledger entries. Cached totals (e.g. `invoices.amount_paid`) exist for speed and are verified against the ledger by a nightly reconciliation job.
2. **Append-only.** Confirmed financial rows are never updated or deleted. Corrections are new rows (reversal, adjustment) carrying a reason and actor. Enforced by database triggers, not just application code.
3. **Money is exact.** Database: `NUMERIC(12,2)`. Application: integer **paise** (`bigint`) inside one `Money` module; conversion only at the DB/API boundary. Floating point is never used for money. API transports amounts as decimal **strings** (`"1500.00"`).
4. **One writer per customer at a time.** Every operation that changes a customer's money takes a transaction-scoped lock on that customer (`SELECT … FOR UPDATE` on the customer row). Different customers post in parallel.
5. **Idempotent posting.** Every payment carries a client-generated UUID (`client_txn_id`, unique). Replaying the same request returns the original result; it never posts twice.
6. **A promise is not a payment.** Only a `CONFIRMED` payment or an approved credit reduces what a customer owes.
7. **Business dates are in `Asia/Kolkata`.** Timestamps are stored as UTC `timestamptz`; billing periods and payment dates are calendar `date`s in IST.

---

## 2. Sign convention

```
balance = Σ ledger_entries.amount
balance > 0  → customer owes  (Outstanding)
balance < 0  → customer has credit (Advance) = −balance
```

| Ledger type | Sign | Created by |
|---|---|---|
| `OPENING_BALANCE` | + (due) or − (advance) | Excel import / admin migration |
| `CHARGE` | + | Invoice issued |
| `DISCOUNT` | − | Discount credit note |
| `DEBIT_ADJUSTMENT` | + | Admin adjustment (e.g. reconnection fee) |
| `CREDIT_ADJUSTMENT` | − | Admin adjustment (e.g. goodwill, waiver) |
| `PAYMENT` | − | Payment confirmed |
| `REFUND` | + | Advance returned to customer |
| `REVERSAL` | opposite of the reversed entry | Payment reversal, invoice cancellation, adjustment reversal |

`Outstanding` and `Advance` shown anywhere in the system are always computed as `max(balance,0)` and `max(−balance,0)`.

**Equivalence with Excel.** Excel's month sheets compute `B(m) = B(m−1) + Rate − Paid(m)`, `Amount Due = max(B,0)`, `Closing Advance = max(−B,0)`. A monthly `CHARGE` of `Rate` plus a `PAYMENT` of `Paid(m)` produces the identical running balance. The migration reconciliation (EXCEL_MIGRATION_MAPPING §7.1) proves this per customer.

---

## 3. Receivables and credits (allocation model)

The ledger answers *"how much?"*. Allocations answer *"which months did this payment settle?"*.

- **Debit documents (receivables):** `invoices` of kind `SUBSCRIPTION`, `OPENING_BALANCE`, `DEBIT_ADJUSTMENT`.
- **Credit documents:** `payments` (when `CONFIRMED`) and `credit_notes` of kind `DISCOUNT`, `CREDIT_ADJUSTMENT`, `OPENING_ADVANCE`.
- **Allocation:** a row `(credit document → invoice, amount)`.

Invariants (checked by tests and nightly job):
```
Σ allocations of a credit document  ≤ credit amount
Σ allocations to an invoice         ≤ invoice total
invoice.balance        = invoice.total − Σ active allocations to it
customer outstanding   = Σ open invoice balances
customer advance       = Σ unallocated credit amounts
ledger balance         = outstanding − advance
```

### 3.1 Allocation algorithm — Oldest Outstanding First (FIFO)

```
allocate(customer):
  lock customer
  credits  = credit docs with unallocated amount > 0, ORDER BY credit_date, created_at, id
  invoices = invoices with balance > 0 and status ∈ {UNPAID, PARTIALLY_PAID},
             ORDER BY (kind = OPENING_BALANCE) DESC, coalesce(period_start, billing_date), billing_date, id
             (OPENING_BALANCE invoices have period_start = NULL → always first)
  for each credit, for each invoice while both have remaining:
      x = min(credit.remaining, invoice.remaining)
      insert allocation(credit, invoice, x)
  update invoice cached amount_paid/status
```

- The function is **deterministic** and keeps allocation **strictly oldest-first**. If an older invoice is open while a newer one holds money (after a reversal, a cancellation or a back-dated opening balance), the newer invoices' allocations are released with compensating (negative) rows and re-applied oldest first. Discounts targeted at a specific invoice stay on it. In normal operation nothing is released. Allocation rows are never updated or deleted, so the full history of where money went is kept.
- It runs after every: payment confirmation, credit note, invoice issue (so advance is consumed automatically), and reversal.
- **Targeted credits:** a discount/credit note created *for a specific invoice* is allocated to that invoice first; any remainder joins FIFO.
- Admin cannot override allocation order in v1 (requirement: agents can't modify allocation rules; admin override is a possible later feature).

### 3.2 Worked examples (these become automated tests)

**E1 — partial covers oldest first.** Rate ₹500. Invoices Jan, Feb, Mar unpaid (₹1,500). Payment ₹1,000.
→ Jan ₹500 PAID, Feb ₹500 PAID, Mar ₹500 UNPAID. Balance +₹500.

**E2 — overpayment becomes advance.** Outstanding ₹500 (one invoice). Payment ₹2,000.
→ Invoice PAID (₹500 allocated). Unallocated ₹1,500. Balance −₹1,500 (Advance ₹1,500).
Next month invoice ₹500 issued → allocation engine applies ₹500 from that payment → invoice PAID on issue, advance ₹1,000.

**E3 — partial within one invoice.** Invoice ₹1,500 (3-month cycle). Payments ₹600 then ₹900.
→ After first: PARTIALLY_PAID, balance ₹900. After second: PAID.

**E4 — Excel guide example.** Rate ₹600; Jan, Feb unpaid; March payment ₹1,800 on 5 Mar.
→ Jan ₹600, Feb ₹600, Mar ₹600 allocated. Balance 0. (Matches the workbook's "Payment Entry Guide".)

**E5 — reversal reopens invoices.** E1, then the ₹1,000 payment is reversed.
→ Its allocations are reversed; Jan and Feb return to UNPAID; FIFO re-runs (no other credit) → balance +₹1,500.
With a later ₹700 payment that had paid March (₹500) and left ₹200 advance: after the reversal that ₹700 is re-applied oldest first → Jan PAID, Feb ₹200, Mar unpaid; balance ₹800.

---

## 4. Billing engine

### 4.1 Separate concepts

| Concept | Where stored | Example |
|---|---|---|
| **Service rate** | `subscription_rates.monthly_rate` (effective-dated) | ₹500/month |
| **Billing interval** | `customer_subscriptions.billing_interval_months` | 3 → one invoice per 3 months |
| **Billing period** | `invoices.period_start/period_end` | 1 Jan – 31 Mar |
| **Billing date / due date** | `invoices.billing_date`, `invoices.due_date` | 1 Jan / 10 Jan |
| **Collection schedule** | `customers.collection_day` / society route day (operational only) | Visit around the 2nd |
| **Payment preference** | `customers.payment_preference_months` (informational) | "Usually pays 4 months together" |

A customer who *prefers* to pay 4 months at once while billed monthly simply accumulates 4 monthly invoices, and one payment settles them FIFO (or pays ahead, creating advance). Their billing interval is **not** changed. Collection reports can then distinguish "due but customer pays quarterly by arrangement" from "overdue" using the preference field. ⚠ Q6

### 4.2 Supported configuration

| Field | Values | Default |
|---|---|---|
| `billing_mode` | `AUTO` (scheduler) / `MANUAL` (admin creates invoices) | `AUTO` |
| `billing_interval_months` | 1, 2, 3, 4, 6, 12, or any integer 1–24 (custom) | 1 |
| `billing_anchor_day` | 1–28 | the start date's day (capped at 28), so a new connection has no unbilled gap. Use 1 for calendar months ⚠ Q4 |
| `billing_timing` | `ADVANCE` (bill at period start) / `ARREARS` (bill at period end) | `ADVANCE` ⚠ Q4 |
| `due_days` | days after billing date | business setting, default 10 |
| `proration` | `NONE` / `DAILY` | `NONE` ⚠ Q7 |

The Excel data is consistent with **monthly, in-advance billing**: November payments were collected 1–2 November and settle the November fee.

### 4.3 Period generation

```
period_start(k) = anchor_date + k × interval months      (day clamped to month length)
period_end(k)   = period_start(k+1) − 1 day
amount          = monthly_rate(effective on period_start) × interval_months
```

- **Rate changes** apply from the next period that *starts* on/after the rate's `effective_from`. Already-issued invoices are never recalculated. (Optional future: split a multi-month period across a mid-period rate change.)
- **Duplicate protection:** unique index on `(subscription_id, period_start)` for non-cancelled invoices. The scheduler uses `INSERT … ON CONFLICT DO NOTHING`.
- **Scheduler:** in-process job tick every 5 minutes (`JOBS_INTERVAL_SECONDS`), guarded by a PostgreSQL advisory lock so only one instance runs it. It also runs on demand via `POST /billing/runs` or `pnpm cli run-jobs`. For every `AUTO` subscription whose cursor is due, it issues invoices one period per transaction until caught up, so a missed day or week self-heals. A `billing_runs` row records counts and errors. Manual runs may bill up to 31 days ahead.
- **Missing rate:** if no rate is in force for a period, that subscription is paused and a `NO_RATE_FOR_PERIOD` alert is raised. Adding a rate closes the alert and billing resumes from the stuck period.
- **Invoice numbers:** `INV/{FY}/{seq}` — e.g. `INV/2026-27/000123` — from a per-financial-year sequence row locked `FOR UPDATE` (gap-free).

### 4.4 Invoice fields and status

`total = Σ items (subscription − discount ± adjustment)`;
`amount_paid = Σ active allocations`;
`balance = total − amount_paid`.

`previous_outstanding` printed on the bill is a **snapshot** of the customer balance just before issue (display only, never used in calculations). The printed "Total payable now" = `previous_outstanding + total − advance_applied`, labelled clearly so the same rupee is never shown as owed twice.

| Status | Rule |
|---|---|
| `DRAFT` | Manual invoice not yet issued; no ledger entry |
| `UNPAID` | Issued, `amount_paid = 0` |
| `PARTIALLY_PAID` | `0 < amount_paid < total` |
| `PAID` | `amount_paid = total` |
| `OVERDUE` | **Derived at read time**: issued, `balance > 0`, `due_date < today` (not stored, so no job can get it wrong) |
| `CANCELLED` | Admin cancels with reason → `REVERSAL` ledger entry; allocations to it are released and FIFO re-runs |

### 4.5 Suspension, reactivation, deactivation

- **Suspend** (temporary, e.g. customer travelling): `subscription_suspensions(from, to?)`. No invoice is generated for a period whose `period_start` falls inside a suspension. Existing dues remain collectable. ⚠ Q7 (proration of partial months)
- **Reactivate:** closes the suspension; next period starts on the next anchor date (or on reactivation date if proration is enabled).
- **Deactivate / disconnect:** subscription `ENDED`; no further billing; customer record and ledger kept forever; outstanding remains visible in reports.

### 4.6 Discounts and adjustments

- **Discount on a future bill**: invoice item of type `DISCOUNT` (negative) at issue time.
- **Discount/waiver on an issued bill**: `credit_note` (kind `DISCOUNT`) targeted at that invoice.
- **Debit adjustment** (e.g. installation, reconnection, STB charge): `invoice` of kind `DEBIT_ADJUSTMENT`.
- **Credit adjustment** (e.g. goodwill, correction): `credit_note` kind `CREDIT_ADJUSTMENT`.
- All require admin role and a reason; above a configurable amount they require Super Admin.

---

## 5. Payments

### 5.1 Posting (single DB transaction)

```
1. Validate: amount > 0, ≤ configured max; date not in future; not before customer start;
   caller authorised for customer (agent: currently assigned incl. temporary; admin: any).
2. Idempotency: if client_txn_id exists → return stored result (HTTP 200, same body).
3. Lock customer row.
4. Snapshot previous balance.
5. INSERT payment (status per §5.2).
6. If CONFIRMED: INSERT ledger PAYMENT entry; run allocate(customer).
7. INSERT receipt (number from FY sequence; frozen JSON snapshot of all printed values).
8. INSERT audit log.
9. COMMIT → enqueue notifications (outside the transaction, via outbox table).
```

### 5.2 Payment status by mode

| Mode | Recorded by agent | Recorded by admin |
|---|---|---|
| Cash | `CONFIRMED` immediately (agent becomes accountable for the cash) | `CONFIRMED` |
| UPI / Bank transfer | Gateway configured: `CONFIRMED` only on verified gateway webhook/status. No gateway: `PENDING_VERIFICATION` — **does not reduce outstanding** until an admin verifies it against the bank statement ⚠ Q8 | `CONFIRMED` (admin attests verification) |
| Cheque | `PENDING_VERIFICATION` until cleared | `PENDING_VERIFICATION` until marked cleared |
| Other | `PENDING_VERIFICATION` | `CONFIRMED` |

A screenshot shown by a customer never confirms a payment by itself.
`PENDING_VERIFICATION → CONFIRMED` posts the ledger entry with the **original** payment date. `→ FAILED` (bounced cheque, unverified UPI) posts nothing; receipt is marked void automatically.

### 5.3 Payment sources

`AGENT_COLLECTION`, `ADMIN_COLLECTION`, `ONLINE` (gateway), `IMPORT` (Excel), `OTHER_AUTHORISED`. Stored on every payment and shown on receipts and reports.

### 5.4 Duplicate prevention

1. Exact replay → `client_txn_id` unique (hard guarantee).
2. Same customer + same amount + same mode within N minutes (setting, default 10) with a different `client_txn_id` → accepted but flagged `possible_duplicate` and surfaced on the admin dashboard (money may genuinely have been paid twice; we do not reject collected cash).
3. Same UPI/bank reference already used → rejected with 409 unless admin overrides with reason.

### 5.5 Reversal / correction

- Agents cannot edit or reverse. They can **request** a correction with reason.
- Admin reverses: `payment_reversals` row (reason mandatory) → `REVERSAL` ledger entry (+amount) → compensating allocation rows → receipt status `CANCELLED` → FIFO re-runs.
- A correct payment is then entered as a new payment. Original and reversal both remain visible.
- If the reversed payment was cash already handed over, the cash reconciliation shows it as an adjustment line (see §6).

### 5.6 Refunds

Only from available advance. `refunds` row + `REFUND` ledger entry (+amount) + allocation of the unallocated credit to the refund. Admin only, reason mandatory.

---

## 6. Cash accountability

```
agent_cash_in_hand(agent, t) =
      Σ CONFIRMED CASH payments collected_by agent up to t
    − Σ cash reversed (reversals of those payments, not yet handed over)
    − Σ received_amount of CONFIRMED handovers up to t
    ± Σ cash_adjustments (admin-approved shortage write-offs / recoveries)
```

- UPI, bank, cheque and other modes **never** enter cash-in-hand.
- Each cash payment belongs to **at most one** handover (`cash_handover_items.payment_id` unique).
- Handover: agent submits (system pre-computes `expected` = un-handed cash payments selected); admin enters `received`; `difference = received − expected`. Mismatch requires a reason. ⚠ Q9: a shortage remains on the agent's balance until the admin records a recovery or write-off (default).
- Daily closing snapshot per agent: opening cash, cash collected, UPI collected, other modes, cash submitted, closing expected cash, declared actual cash, difference.

---

## 7. Offline payments (implemented in Phase 6)

- **On the phone.** A payment is recorded with:
  - an operation id (UUID), which becomes the payment's `client_txn_id`;
  - the device sequence number and the phone's clock time;
  - a provisional receipt reference `P-{AGENTCODE}-{6 digits}`, stored on the payment (`payments.provisional_ref`) so the office can find it.
- **On the phone, before sync.** The payment is shown as "Not sent yet". Q14 default: the provisional receipt may be shared, clearly marked *PROVISIONAL – pending confirmation*. It states no balance, because only the server calculates balances.
- **On sync.** The server records the payment through the same posting code as online entry (`PaymentsService.recordIn`) and allocates oldest-first against the **current** state. Collected money is a fact, so a payment is **not refused** because the balance or the assignment changed meanwhile. It is recorded and flagged (`NEEDS_REVIEW`; the flags are also written to `payments.review_flags`).
- **Held for verification (Phase 8, security review M-4).** Flags that rest on the phone's own timestamps (`REASSIGNED_BEFORE_SYNC`, `NOT_ASSIGNED_AT_COLLECTION`, `CLOCK_SKEW`, `LATE_SYNC`) record the payment as **PENDING_VERIFICATION**: there is no ledger entry or receipt until the office verifies it under Payments, exactly like an agent's UPI payment. The other flags (`POSSIBLE_DUPLICATE`, `CUSTOMER_INACTIVE`) post at once. Flags:

| Flag | When |
|---|---|
| `REASSIGNED_BEFORE_SYNC` | The customer was the agent's when collected, but not any more |
| `NOT_ASSIGNED_AT_COLLECTION` | Not the agent's at the recorded moment, but assigned to them within a day of it (the reassignment happened just before, or the phone clock was wrong) |
| `CUSTOMER_INACTIVE` | The customer is inactive or disconnected |
| `POSSIBLE_DUPLICATE` | §5.4 rule 2, compared around the collection time rather than the sync time |
| `CLOCK_SKEW` | The phone clock was more than 24 h off |
| `LATE_SYNC` | The payment date is older than `payments.rules.agentMaxBackdateDays` |

- **Rejected entries** (nothing is posted):
  - the customer was never the agent's around that time (`CUSTOMER_NOT_ASSIGNED`);
  - invalid data (amount, reference);
  - an amount above `payments.rules.maxAmount`;
  - a duplicate UPI/bank reference (§5.4 rule 3).

  The rejection is stored, shown to the agent until acknowledged, and listed for the office.
- **Payment date.** The business date (IST) of the collection time. If the phone clock was more than 2 minutes off, that time is first corrected by the measured error (server time − phone time at send).
- **Visit.** A payment entry also records the visit. The server decides the outcome: `PAYMENT_COLLECTED` if the amount covered what was due before posting, otherwise `PARTIAL_PAYMENT`.
- **Receipt.** The final receipt number is assigned by the server. The phone replaces the provisional view with the final receipt as soon as it has the answer.
- **Office review.** *Offline entries* page (`payments:verify`). The review only records that the office looked (who, when, note). Corrections use the normal tools: reversal (§5.5) or reassignment.

---

## 8. Reconciliation jobs (nightly)

1. Per customer: `ledger balance == Σ open invoice balance − Σ unallocated credit`.
2. Per invoice: cached `amount_paid == Σ active allocations`.
3. Per payment: `Σ allocations ≤ amount`.
4. Per agent: cash-in-hand formula vs handover records.
Any mismatch → `system_alerts` row + admin notification. Nothing is auto-corrected.

---

## 9. Test matrix (minimum; all must pass before Phase 3 is "done")

Monthly / 3-month / 4-month / custom-interval billing; partial; full; advance; FIFO across invoices; multiple payments per invoice; one payment over many invoices; rate change mid-life (old invoices unchanged); suspension; reactivation; deactivation with dues; discount pre-issue and post-issue; debit/credit adjustment; invoice cancellation after partial payment; payment reversal (with and without later advance); refund; duplicate replay; concurrent payments for the same customer (parallel transactions); scheduler re-run/catch-up idempotency; UPI pending → confirmed / failed; cash handover with exact / short / excess; offline sync replay and out-of-order arrival; Excel import reconciliation on the real workbook (163 customers, ₹5,75,630). Property-based tests (fast-check) for allocation invariants in §3.

---

## 10. Implementation decisions (Phase 3)

| Topic | Decision |
|---|---|
| Suspension | Periods whose **start** falls inside a suspension are skipped. A suspension that has not started yet can be cancelled (`cancelled_at`). Reactivating sets its end to the day before reactivation. Subscription and customer status follow today's suspensions (synced on change and by the daily job). |
| Deactivation | Deactivating a customer ends the live subscription (last service day = today). Dues stay collectable. Reactivating the customer requires a new subscription (new rate and terms). |
| Rate change | Allowed only from a date after the last billed period, so issued invoices never need to change. A rate dated into an already-billed period is refused (`PERIOD_ALREADY_BILLED`); cancel that invoice first if it really must change. |
| Anchor change | Applies from the next unbilled period. Any days left uncovered are returned as `unbilledGap` so the admin can raise a debit. |
| Manual invoices | Only for `MANUAL` billing-mode subscriptions, so they can never overlap automatic billing. |
| Receipts | Issued only for **confirmed** payments. Values are frozen in a JSON snapshot; reprints and reissues never recompute them. Reissue = cancel + new number, linked to the original. |
| Payment dates | Agents: today back to `agentMaxBackdateDays` (default 7). Never in the future. A single payment may not exceed `maxAmount` (default ₹1,00,000). Settings: `payments.rules`. |
| Duplicate references | UPI/bank/cheque references are unique (case-insensitive) among non-failed payments. A bounced cheque's number can be presented again. |
| Credit limits | Discounts, credit adjustments, refunds and opening balances above `credits.limits.adminMaxAmount` (default ₹1,000) need the super admin. |
| Idempotency | Payments: `clientTxnId` in the body (works across offline retries). Other financial POSTs: `Idempotency-Key` header. Same key + same body → stored result; same key + different body → 422; failed requests release the key. |
| Cash | Rejecting a handover returns its payments to "not yet handed over". Adjustments: positive amounts reduce what the agent owes (recovery, write-off); negative amounts increase it (correction). A cash payment inside a pending handover cannot be reversed until the handover is settled. |
| Alerts | Possible duplicate payment, cash mismatch, missing rate, billing-run errors and reconciliation mismatches create `system_alerts`, one open alert per type and entity, and notify all admins. |
