# Business Requirements

## 1. Business summary

A local cable TV operator in the Chandlodia / Gota area of Ahmedabad (per the customer addresses in the workbook) serves **163 customer connections** across **12 societies/collection groups**. Each customer has an individual monthly rate (₹200–₹550; ₹52,330/month across the 142 billable customers). Two collection agents visit societies on route days, usually between the 1st and 12th of each month, and collect payments, mostly cash. All records live today in one Excel workbook that is updated by hand.

**Goal:** replace Excel with a central backend, an admin web dashboard, and an offline-capable Android app for agents. The new system must:

- keep money exact and auditable,
- show at any moment each customer's true outstanding or advance,
- show what each agent collected and is holding in cash,
- support the flexible billing and payment habits the business already has.

## 2. What the Excel workbook tells us (see EXCEL_MIGRATION_MAPPING.md)

- Monthly, in-advance billing. Running balance per customer, with oldest-first settlement of arrears.
- No partial payments, advances, or multi-month payments appear in the 2026 data. Every billable customer paid exactly one month's rate each month (Jan–Nov). All balances are **₹0 as of 30 Nov 2026**.
- 21 customers have no numeric rate (`AMP` 10, `BOSS` 6, `DC` 4, blank 1) and are billed ₹0 by Excel.
- There is no agent, payment mode, receipt, or follow-up data. These are new capabilities.

## 3. Roles and permissions

| Capability | Super Admin | Admin | Agent |
|---|---|---|---|
| Dashboard (business-wide) | ✓ | ✓ | own only |
| Customers: view | all | all | assigned (incl. temporary) |
| Customers: create/edit/deactivate | ✓ | ✓ | ✗ |
| Change rate / billing config | ✓ | ✓ | ✗ |
| Areas, societies, agents | ✓ | ✓ | ✗ |
| Assign / temporarily reassign | ✓ | ✓ | ✗ (cannot self-assign) |
| Record payment | any customer | any customer | assigned customers |
| Verify UPI / cheque | ✓ | ✓ | ✗ |
| Reverse payment / cancel receipt | ✓ | ✓ (reason) | request only |
| Discounts / adjustments / refunds | ✓ | ✓ up to limit | ✗ |
| Visits, promises, follow-ups | ✓ | ✓ | assigned customers |
| Cash handover | verify | verify | submit |
| Reports & exports | ✓ | ✓ | own collection history |
| Excel import / approval | ✓ | ✗ | ✗ |
| Business settings, users, audit log | ✓ | view audit | ✗ |

All checks are enforced by the backend on every request.

## 4. Functional requirements (summary; detail in the brief and FINANCIAL_LOGIC.md)

**FR-CUST: Customers.** Keep the existing 6-digit IDs. Fields: name, mobile, alternate mobile, address, landmark, society, STB number, MQ number, status, notes, collection day, and payment preference. Search by ID, name, mobile, or STB. Filter by society, area, agent, status, and outstanding amount. Soft-deactivate/reactivate only. Hard error on duplicate ID or active STB. Configurable warning on duplicate mobile.

**FR-BILL: Billing.** Per-customer billing interval (1, 2, 3, 4, 6, 12 months, or custom). Auto or manual mode, anchor day, advance or arrears timing. Effective-dated rate history. Suspension and reactivation. Discounts and adjustments. Invoice statuses Draft, Unpaid, Partially Paid, Paid, Overdue (derived), Cancelled. Scheduler cannot create duplicates.

**FR-LEDG: Ledger and allocation.** Append-only ledger. FIFO allocation. Advance consumed automatically. Reversal-only corrections. Idempotent posting. Allocation visible per payment.

**FR-AGNT: Agents and assignment.** Agent profiles. Area default assignment plus customer-level overrides. Temporary reassignment by agent, society, or customer list, with date range and reason. Original assignment preserved and restored automatically. Early revoke. Full history. Agents notified.

**FR-COLL: Field collection.** Today's list with filters and sorts. Customer card with call, maps navigation, history, and outstanding. Visit outcomes with notes and follow-up date. Payment entry in under 15 seconds. Receipt generated and shared on WhatsApp. Optional GPS at check-in.

**FR-ADMC: Admin collection and interactions.** Admin records direct payments (source = Admin). Logs calls and promises (expected amount, promise date, follow-up). Promises never change balances. Pending follow-ups appear on the dashboard.

**FR-CASH: Cash control.** Per-agent cash in hand (cash only). Handover submit and verify. Mismatches recorded with a reason. Daily closing snapshot. Full deposit history.

**FR-RPT: Reports.** The 18 reports listed in the brief. Each has date filters, search, sort, pagination, and Excel export, plus PDF where useful.

**FR-OFFL: Offline.** Agents can view assigned customers, record visits and payments offline, and see a pending-sync count, last sync time, and stale-balance warning. Sync is idempotent.

**FR-NOTF: Notifications.** Admin and agent events in-app and by push. Customer messages through pluggable WhatsApp/SMS providers (later phase).

**FR-MIGR: Excel migration.** Upload, analyse, map, validate, correct, dry-run, approve, commit, and reconcile. Imports are idempotent by `customer + month`.

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Correctness | Ledger invariants hold 100% (nightly check). Zero tolerance for money drift. |
| Performance | Agent list loads in under 1 s from local cache. API p95 under 300 ms at target scale. |
| Availability | 99.5% (single region). Offline mode covers outages for agents. |
| Security | OWASP ASVS L2 practices. Agent data isolation. Immutable financial history. |
| Auditability | Every mutation is attributable to user, device, time, and reason. |
| Usability | Agent app works one-handed with large touch targets. UI language to be decided (Q15). |
| Data protection | Customer PII is visible only to authorised users. Encrypted device storage. Backups encrypted. |
| Recoverability | RPO ≤ 5 min (WAL). RTO ≤ 4 h. |

## 6. Screen list

### Admin web
1. Login, forgot/reset password
2. Dashboard: KPI cards, collection trend, agent performance, ageing, mode split, pending follow-ups, pending handovers, alerts
3. Customers: list with search and filters → profile with tabs (Overview, Ledger, Invoices, Payments, Visits & Interactions, Assignments history, Connections/STB, Audit)
4. Customer create/edit, rate change, billing config, suspend/reactivate/deactivate dialogs
5. Admin collection: quick customer search → payment entry → receipt
6. Interactions and follow-ups board (Today, Overdue, Upcoming, Promise-to-pay)
7. Invoices and billing runs (with manual run trigger and per-run results)
8. Payments: list, pending verification queue (UPI/cheque), reversal requests, allocations view
9. Adjustments, discounts, refunds
10. Agents: list → profile (assigned customers, performance, cash, devices, sessions)
11. Areas and societies (with area owner and route day)
12. Assignments: permanent bulk move, temporary reassignment wizard, history and calendar
13. Cash: handovers to verify, agent cash-in-hand, daily closings, mismatch log
14. Reports: 18 reports with export
15. Excel import wizard: upload → analysis → mapping → validation and corrections → dry-run reconciliation → approve → commit
16. Settings: business profile and logo, receipt format, billing defaults, duplicate rules, GPS toggle, notification templates, users and roles
17. Audit log and system alerts

### Agent app (Android)
1. Login (plus PIN/biometric unlock)
2. Home dashboard: today's targets, collected, remaining, cash in hand, follow-ups, sync status
3. Today's list: filter chips, sort, search
4. Customer screen: outstanding/advance, last payments, call, navigate, history, follow-ups
5. Record visit (outcome, notes, follow-up date)
6. Collect payment (amount pad, mode, reference) → success → receipt share
7. Receipts history (reprint/share)
8. My collections and daily cash summary
9. Cash handover submit and status
10. Follow-ups and promises
11. Sync center: pending ops, errors, last sync, sync now
12. Notifications and profile/settings (change password, logout)

## 7. Open questions

**Blocking for Phase 2–3 design (needed now)**

| # | Question | Why it matters / default if no answer |
|---|---|---|
| Q1 | What do the rate values **AMP**, **BOSS** and **DC** mean (20 customers), and what is the rate for **327149 KIRIT KUMAR** (blank)? Should these customers be billed? | Excel bills them ₹0. We will not guess. Default: import as customers without a billing rate, marked "needs decision". |
| Q2 | Is the Jan–Nov 2026 payment history **real recorded collections** (real dates) or **filled in afterwards**? Every billable customer paid exactly 1 month every month, all of September on one date, and the file was generated by a script on 31 Oct. | Decides migration Option A (import history) vs Option B (opening balance + read-only legacy view). |
| Q3 | Were there any balances (dues/advance) **before January 2026**? Excel forces 0. | Opening balances. |
| Q4 | Billing timing: does a payment collected on 1–12 November pay for **November** (advance billing) or **October**? Should bills be dated the 1st of each month? | Default: advance billing on the 1st, due on the 10th. |
| Q5 | Agent names, and which **societies belong to which agent**? Should we group societies into "Area A / Area B"? | Agents cannot log in until assignments exist. |
| Q6 | Which customers are on **2/3/4/6-month billing**? Is that a billing arrangement (one ₹1,500 invoice per quarter) or only a payment habit (billed monthly, pays every 3 months)? | Affects overdue reporting and reminders. The Excel data shows all customers monthly. |

**Needed before Phase 3 completes**

| # | Question | Default if no answer |
|---|---|---|
| Q7 | Proration for new connections, suspensions and reactivations in the middle of a month? | No proration. Full-month charges by period start. |
| Q8 | UPI: do you use a payment gateway or a business UPI/QR? Without one, agent-entered UPI payments stay **pending until admin verifies** against the bank statement. Acceptable? | Pending verification. |
| Q9 | If an agent hands over less cash than expected, does the shortage stay as the agent's liability until resolved? | Yes, shown until recovered or written off by admin. |
| Q10 | Are you GST-registered? Do invoices/receipts need GSTIN, tax breakup, or HSN/SAC? Business legal name, address, logo for receipts? | Plain receipts, no tax lines. |
| Q11 | Mobile `9726939410` is on 3 customers (327018, 324499, 325968), and `327107` has a 9-digit mobile (`999837003`). Correct values? | Import as-is with warnings. |
| Q12 | Customer ID = last 6 digits of the STB number. If a box is replaced, should the customer keep the old ID? | Yes. ID is permanent; STB history is kept separately. |
| Q13 | May we clean up society display names (e.g. `AMBIKANAGAR SOOC` → `Ambika Nagar Society`) while keeping the original text? | Keep as typed until approved. |
| Q14 | May agents share a **provisional** receipt (made offline, before sync) with customers? | Yes, clearly marked "Provisional – pending confirmation". The final receipt is sent after sync. *(Built this way in Phase 6; the provisional text quotes no balance.)* |
| Q15 | App language for agents: English, Gujarati, or both? | English + Gujarati (the Excel guide uses Gujarati). |
| Q16 | Target go-live and hosting: is there a date (e.g. January 2027 collections)? Will Excel and the app run in parallel for a month? Any hosting preference or budget? | Go-live at a month start with Excel frozen. Single VPS in India. |
