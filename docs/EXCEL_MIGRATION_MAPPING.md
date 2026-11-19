# Excel Workbook Analysis & Migration Mapping

Source file: `DOC-20261117-WA0003.xlsx` (repository root)
Analysed: 2026-11-18
Workbook metadata: created 2026-10-31 by a script (`openpyxl`), last modified 2026-11-16.

> Every number in this document was computed directly from the workbook (cell values and formulas), not estimated.

---

## 1. Workbook inventory

| # | Sheet | Purpose | Data entry? | Rows used |
|---|---|---|---|---|
| 1 | **Customer List** | Customer master. Columns A–I are typed; J–O are helper formulas that build the society-grouped ordering for the Accounts sheet. | Yes (A–I) | 3–176 (174 rows: 163 customers + 11 society heading rows) |
| 2 | **January … December** (12 sheets) | One row per Customer List row. Monthly rate, opening balance, payment received, fee adjusted, closing advance, amount due, payment date. | Yes: column **E** (Payment Received), **I** (Payment Date), **J** (Notes) | 2–501, totals on row 503 |
| 3 | **Accounts** | Society-wise, customer-wise Jan–Dec "Received" grid, Total Received, Total Billed, Balance Due. Fully formula-driven. One input: `C2` "Months to bill (1–12)". | Only `C2` | 5–544 |
| 4 | **Customer Card** | Printable single-customer view. Pick ID in `B2` (dropdown), month-wise rate/paid/date/advance/outstanding. | `B2` only | 1–29 |
| 5 | **ID Year Total** | Same as Customer Card with Fee Adjusted column. | `B2` (and `B3` — see bug X-9) | 1–18 |
| 6 | **Monthly Summary** | Month-wise totals (customers, collected, fee adjusted, closing advance, outstanding). | No | 1–16 |
| 7 | **Field Visit Directory** | Copy of Customer List (ID, name, mobile, address, rate, STB, MQ) for field use. | No | 2–501 |
| 8 | **Payment Entry Guide** | Operating instructions (English + romanised Gujarati). | — | — |
| 9 | **Data Quality Report** | **Stale** — describes a different 3-customer workbook ("UNIQUE CABLE / PALLAV", IDs `OK 1`, `A 1`, `C3`). Does not describe this data. | — | — |

No macros, pivots, charts, or named ranges. Data validations: Customer ID dropdowns on Customer Card / ID Year Total; Society dropdown (warning-only, allows new values) on Customer List column I.

---

## 2. How the workbook calculates money (exact formulas)

### 2.1 Monthly sheet (row *r* ↔ Customer List row *r+1*)

| Col | Header | Formula / meaning |
|---|---|---|
| A | Customer ID | `='Customer List'!A{r+1}` |
| B | Customer Name | `='Customer List'!B{r+1}` |
| C | Monthly Rate | `=N('Customer List'!E{r+1})` — **current** rate; text becomes 0 |
| D | Opening Balance (+Advance / −Due) | January: literal `=0`. Feb–Dec: `=PrevMonth!G{r} − PrevMonth!H{r}` |
| E | Payment Received | **typed** amount (one cell per month) |
| F | Fee Adjusted | `=MIN(E + MAX(D,0), C + MAX(−D,0))` |
| G | Closing Advance | `=MAX(D + E − C, 0)` |
| H | Amount Due | `=MAX(C − D − E, 0)` |
| I | Payment Date | **typed** date (one cell per month) |
| J | Notes | typed |
| K | Society | `='Customer List'!I{r+1}` |

**Financial meaning.** Define the running balance `B` (positive = customer owes):

```
B(Dec 2025) = 0                      (January opening hard-coded to 0)
B(m)        = B(m−1) + Rate − Paid(m)
Amount Due(m)      = max(B(m), 0)
Closing Advance(m) = max(−B(m), 0)
Fee Adjusted(m)    = amount of (payment + carried advance) that went toward this month's fee + carried arrears
```

This is a **single net running balance**, i.e. an *oldest-first (FIFO)* model in aggregate. The "Payment Entry Guide" confirms the intent: a ₹1,800 payment in March for Jan+Feb+Mar is typed only in March; Jan/Feb sheets keep showing their month-end dues as historical snapshots.

### 2.2 Accounts sheet

```
H  Monthly Charge   = Customer List rate (current)
I  Opening          = January!D (always 0)
J..U Jan..Dec Rcvd  = <Month>!E
V  Total Received   = SUM of months 1..C2
W  Total Billed     = H × C2                       (C2 = "Months to bill", currently 12)
X  Balance Due      = W − V − I                     (+due / −advance)
```

Society heading rows show sums for the society.

### 2.3 Customer Card / ID Year Total / Monthly Summary

Pure lookups (`INDEX/MATCH`, `SUMIF` by Customer ID) over the month sheets. No independent financial logic.

---

## 3. What the data actually contains

### 3.1 Customers

| Metric | Value |
|---|---|
| Customer rows with an ID | **163** |
| Society heading rows (no ID; society name typed in the *Address* column) | 11 (rows 29, 32, 60, 72, 82, 113, 122, 139, 141, 152, 154) + a stray heading in row 2 (`C2 = AMBIKANAGAR SOOC`) |
| Customer ID format | 6-digit numeric strings, all unique (`320345`–`328919`) |
| STB No | All 163 present, 18 digits, unique, **all = `307070260700` + Customer ID** |
| MQ No | **Empty for every customer** |
| Notes (col H) | Empty for every customer (only a heading row has text) |
| Address | Present for all; 50 cells have leading/trailing spaces |
| Mobile | Present for all 163, stored as numbers (161) or text (2) |

### 3.2 Monthly rates (Customer List col E)

| Rate (₹) | Customers |
|---|---|
| 200 | 3 |
| 250 | 2 |
| 280 | 1 |
| 300 | 45 |
| 350 | 2 |
| 400 | 79 |
| 450 | 1 |
| 500 | 5 |
| 550 | 4 |
| **Numeric total** | **142 customers, ₹52,330 / month** |
| Text `AMP` | 10 |
| Text `BOSS` | 6 |
| Text `DC` | 4 |
| Blank | 1 (`327149` KIRIT KUMAR) |

**Excel treats all 21 non-numeric/blank rates as ₹0** (`N()` of text = 0). They are never billed and never show dues.

### 3.3 Societies (Customer List col I, "Society (Group)")

| Society (as typed) | Customers | Oct-2026 collection day |
|---|---|---|
| LAXMI NAGAR | 30 | 7 |
| BABUNAGAR | 27 | 2 |
| AMBIKANAGAR SOOC | 26 | 2 |
| VARSOYA PARK | 22 | 9 |
| RAJRATN APP | 16 | 7 |
| GOKUL APARTMENT | 11 | 2 |
| SHITAL TENAMENT | 10 | 9 |
| INDRA APARTMENT | 9 | 2 |
| NAYANRAMIY | 8 | 7 |
| ANKIT SWATANTRA PLOT | 2 | 2 |
| RATNADEEP SOCIETY | 1 | 9 |
| SWTSHYAM APP | 1 | 9 |

Observations:
- "Society" behaves like a **collection group/route**, not a strict postal society — e.g. the AMBIKANAGAR group contains addresses in *Kasturi Nagar* and *Ram Krushna Nagar*.
- Spellings look like typing shortcuts (`SOOC`, `TENAMENT`, `APP`, `NAYANRAMIY`, `SWTSHYAM`). We will import them **as typed** and offer an admin-approved display-name cleanup; we will not rename silently.
- Collection dates fall on the same day per society group (3 groups in October). The workbook contains **no agent information** at all.

### 3.4 Payment history (Jan–Dec 2026)

| Month | Payments | Collected (₹) | Date range | Closing outstanding | Closing advance |
|---|---|---|---|---|---|
| January | 142 | 52,330 | 7–12 Jan | 0 | 0 |
| February | 142 | 52,330 | 5–11 Feb | 0 | 0 |
| March | 142 | 52,330 | 5–8 Mar | 0 | 0 |
| April | 142 | 52,330 | 2–10 Apr | 0 | 0 |
| May | 142 | 52,330 | 3–8 May | 0 | 0 |
| June | 142 | 52,330 | 2–8 Jun | 0 | 0 |
| July | 142 | 52,330 | 1–10 Jul | 0 | 0 |
| August | 142 | 52,330 | 2–10 Aug | 0 | 0 |
| September | 142 | 52,330 | **all on 2 Sep** | 0 | 0 |
| October | 142 | 52,330 | 2–9 Oct | 0 | 0 |
| November | 142 | 52,330 | 1–2 Nov | 0 | 0 |
| December | 0 | 0 | — | 52,330 (not yet due) | 0 |
| **Total** | **1,562** | **₹5,75,630** | | | |

Key facts:
- **Every one of the 142 billable customers paid exactly their monthly rate in every month Jan–Nov.** There is not a single partial payment, advance payment, arrear, or multi-month payment in the data.
- Opening balance at 1 Jan 2026 is hard-coded 0 for everyone.
- **As of 30 Nov 2026 the workbook says every customer's outstanding = ₹0 and advance = ₹0.**
- The Accounts sheet currently shows ₹52,330 "Balance Due" only because `Months to bill = 12` bills December in advance.
- For the 20 text-rate customers, rows contain a January payment *date* but no amount (18 cells) and explicit `0` amounts Feb–Nov (15 customers).

This uniformity (every customer, every month, exact amount, an entire month collected on one date, workbook generated by a script on 31 Oct) suggests the Jan–Oct history **may have been reconstructed/back-filled** rather than recorded transaction-by-transaction. → **Open question Q2.**

---

## 4. Data quality issues found

| ID | Issue | Records | Proposed handling |
|---|---|---|---|
| D-1 | Non-numeric "rate" values `AMP`, `BOSS`, `DC` | 20 customers | Import customer; **do not guess a rate**. Hold in import as "needs decision" until Q1 is answered (likely mapping: special status/plan, complimentary, disconnected). |
| D-2 | Blank rate | `327149` KIRIT KUMAR | Same as D-1. |
| D-3 | Mobile has 9 digits | `327107` → `999837003` | Import as-is into `mobile_raw`, flag invalid, require admin correction. |
| D-4 | Same mobile on 3 customers | `9726939410` → `327018`, `324499`, `325968` (3 different societies) | Allowed (duplicate-mobile warning, not error). Confirm whether this is a placeholder number. |
| D-5 | Same name, different customers | `JALARAMBHAI NADODA` → `320680`, `322981` (different mobile/address/STB) | Keep both; flag for review only. |
| D-6 | Leading/trailing spaces | 50 cells (addresses, society headings) | Trim on import; original kept in `import_rows.raw`. |
| D-7 | Society heading rows inside customer list | 11 rows + row 2 | Skip as customers; use only as hints. |
| D-8 | MQ No empty | 163 | Import as null. |
| D-9 | Payment date without amount | 18 cells (January, text-rate customers) + 1 (March, `328056`) | Not a payment. Ignore with warning; listed in import report. |
| D-10 | Mobile stored as number | 161 | Convert to 10-char string (no leading-zero loss occurred; all 10 digits except D-3). |
| D-11 | Stale Data Quality Report sheet | — | Ignore. |

---

## 5. Workbook design defects (why the data model must change)

| ID | Defect | Consequence |
|---|---|---|
| X-1 | Month sheets read the **current** rate from Customer List | Changing a customer's rate silently rewrites all past months' bills and dues. No rate history. |
| X-2 | History is linked to Customer List **by row position**, not by ID | Sorting, inserting or deleting a Customer List row shifts every month's payments onto the wrong customer. |
| X-3 | Guide says "to remove a customer, clear the row (don't delete it)" | The next new customer typed in that row **inherits the previous customer's payment history**. |
| X-4 | One payment cell + one date cell per month | Two payments in a month must be summed; the second date is lost. No time, mode, reference, collector, receipt. |
| X-5 | Text in rate column → `N()` = 0 | 21 customers silently billed ₹0. |
| X-6 | `Months to bill` is a manual global switch (currently 12) | Accounts overstates dues before the month starts (today shows ₹52,330 due that isn't due yet). |
| X-7 | November sheet row 176 has no formulas (A–H) | A new customer typed in the next free Customer List row (177) would **not appear in November**. |
| X-8 | Hard-coded January opening = 0; no next-year mechanism | No carry-forward into 2027 without manual work. |
| X-9 | ID Year Total `B3` (name) is typed text, not a formula | Changing the ID in `B2` shows the wrong name. |
| X-10 | No agent, no mode, no receipt | No accountability for who collected cash. |

None of these defects affect the **current** numbers (verified: December net due per customer equals Accounts Balance Due for all 163 customers; zero mismatches).

---

## 6. Field mapping: Excel → new schema

### 6.1 Customer master (`Customer List`)

| Excel column | Example | Target | Transform / rule |
|---|---|---|---|
| A Customer ID | `322760` | `customers.customer_code` | Trim; keep as **text** (never numeric). Unique. Retained as the business ID. |
| B Customer Name | `BUDHABHAI K PRAJAPATI` | `customers.name` | Trim, collapse inner spaces. Case preserved. |
| C Address | `1/KASTURI NAGAR ,CHANDLODIY, gota` | `customers.address_line` | Trim only. No geocoding. |
| D Mobile | `9998659339` | `customers.mobile` | To string, strip non-digits; valid = `^[6-9]\d{9}$`; invalid → keep raw in `customers.mobile` with `mobile_valid=false` + import warning. |
| E Monthly Rate | `400` / `AMP` | `subscription_rates.monthly_rate` (effective 2026-01-01) | Numeric → rate. Text/blank → **no rate created**; row held for Q1 decision. |
| F STB No | `307070260700322760` | `customer_connections.stb_number` | Text, unique among active connections. |
| G MQ No | (empty) | `customer_connections.mq_number` | Null. |
| H Notes | (empty) | `customers.notes` | — |
| I Society (Group) | `AMBIKANAGAR SOOC` | `societies.name` → `customers.society_id` | Distinct values create societies (exact typed name kept in `societies.legacy_name`). Area assignment done by admin after import. |
| J–O Helpers | — | not imported | — |
| (none) | — | `customers.status` | `ACTIVE` for numeric-rate customers; pending decision for D-1/D-2. |
| (none) | — | agent assignment | **Not in Excel.** Created from admin's society→agent mapping (Q5). |
| (none) | — | billing config | Default: monthly, advance billing on the 1st (pending Q4/Q6). |

### 6.2 Monthly sheets → ledger

Natural key for every imported money row: **`XL:{customer_code}:{YYYY-MM}`** stored in `payments.external_ref` / `invoices.external_ref` (unique). Re-uploading a newer workbook therefore can never import the same month twice.

| Excel | Target (Option A: full history) | Target (Option B: opening balance) |
|---|---|---|
| Month sheet row with rate C > 0 | `invoices` (kind SUBSCRIPTION, period = that month, amount = C, `source=IMPORT`) + `CHARGE` ledger entry | not imported as invoices |
| E Payment Received > 0 | `payments` (source `IMPORT`, mode `UNKNOWN_LEGACY`, collected_by null, payment_date = I) + `PAYMENT` ledger entry + FIFO allocations | not imported as payments |
| I Payment Date | `payments.payment_date` (time unknown → `received_at` null) | — |
| Cutover balance | derived from ledger | `OPENING_BALANCE` invoice (if due) or opening advance credit (if advance) dated cutover − 1 day |
| Full monthly grid | also stored read-only in `legacy_statement_lines` for audit | stored read-only in `legacy_statement_lines` (shown on customer screen as "Excel history") |
| D/F/G/H (derived) | **not imported** — recomputed and reconciled | used only for reconciliation |

**Recommendation:** decide after Q2. If the Jan–Nov history is genuine → Option A (keeps payment dates for reports). If it was back-filled → Option B (opening balance = Excel November closing, which is ₹0 for everyone) and keep the grid as read-only legacy history so we never present reconstructed rows as real collections.

---

## 7. Import workflow (built in Phase 7)

Admin site → **Excel import** (super admin, `import:manage`). API under `/api/v1/imports`. Code: `apps/api/src/modules/imports`.

1. **Upload.** The workbook is stored on the batch (bytes + SHA-256) and parsed at once.
   - Sheets and columns are found by header text, not by position.
   - Society heading rows are skipped.
   - Month rows are matched to customers by the **Customer ID shown in the row**, not by position (X-2).
   - Every money figure is **recomputed** with the workbook's formulas (§2.1). Excel saves zero results as empty cells, so the saved results are only cross-checked; any disagreement is reported as `X-CALC`.
2. **Checks.** Each finding is either *to fix* (blocks the import) or a *note*.
   - D-1 … D-11 from §4.
   - Invalid IDs, duplicate IDs or STBs, missing names or addresses.
   - Payments for unknown customers, non-numeric amounts.
   - Payments without dates (the 1st of the month is used), dates typed in another month's sheet.
   - Customer IDs or STBs that already exist in the system.
3. **Correct.** Name, mobile, address, society and monthly rate can be corrected per customer. Corrections are stored on the batch (`import_batches.corrections`, each one audited) and the workbook itself is not changed. Any correction cancels an earlier dry run and approval.
   - A corrected **rate applies from cutover**. The history keeps the rate Excel used, so the reconciliation against Excel stays exact.
   - An AMP/BOSS/DC/blank rate (Q1) can be given a rate here, or left empty: the customer is then imported **without billing**, with `customers.pending_decision` set. It is listed under "Customers waiting for a rate decision" and cleared when a subscription is set up.
4. **Dry run.** The office picks **Option A (full history)** or **Option B (opening balance)** and a **cutover month** (suggested: the month after the last payments). The whole import then runs inside a transaction that is **rolled back**, and the reconciliation report (§7.1) is computed from the database inside that transaction. A dry run fails if:
   - a payment is typed in a month on or after cutover;
   - the cutover is beyond the workbook's year;
   - any check is *to fix*.
5. **Approve.** The approver ticks "I have checked this report" and approves the **hash** of that exact dry run (file, corrections, option, cutover and report). The same super admin may approve, with that explicit confirmation.
6. **Commit.** The import runs again, for real, in one transaction under an advisory lock. If the result's hash differs from the approved one (for example, someone created one of the customers in the meantime), **nothing is written** and a new dry run is required. A committed batch can no longer be changed (trigger), and the same file cannot be committed twice.

**What a commit creates**

| | Option A — full history | Option B — opening balance |
|---|---|---|
| Customers, set-top boxes, societies | yes (societies reused by name or Excel spelling, else created with the typed name) | same |
| Agent | customers in a society whose area has an owner get that agent; the others wait for the office's assignment (Q5) | same |
| Subscription | monthly, advance billing on the 1st (Q4/Q6 defaults), starting 1 Jan of the workbook year; **next bill = cutover** | starting at cutover |
| Bills before cutover | one per month at the Excel rate: number `XL-{ID}-{YYYY-MM}`, `source = IMPORT`, `external_ref = XL:{ID}:{YYYY-MM}` | none |
| Payments before cutover | one per Excel amount: mode `LEGACY_UNKNOWN`, `source = IMPORT`, no collector, no receipt | none |
| Opening balance | — (follows from bills and payments) | Excel's closing balance of the last month before cutover: an opening-balance bill `XL-OPEN-{ID}` if due, an opening-advance credit if advance |
| Allocation | normal oldest-first (FIFO) | same |
| Excel history | `legacy_statement_lines`: the recomputed month grid before cutover, read-only, shown on the customer as **Excel history** | same |

Balances, bills and payments then behave exactly like ones created in the system. The billing scheduler continues from cutover and never bills an imported month again.

### 7.1 Reconciliation report (must match before approval)

| Check | Excel | System | Expected |
|---|---|---|---|
| Customers with ID | rows with an ID | customers created by the batch | equal |
| Billed from cutover | customers with a rate (after corrections) | subscriptions live at cutover | equal |
| Monthly billing total | Σ rates | Σ subscription rates at cutover | equal |
| Collections before cutover | Σ Payment Received | A: Σ imported payments · B: Σ Excel history lines (no payments) | equal |
| Outstanding at cutover | Σ positive closing balances | Σ positive ledger balances | equal |
| Advance at cutover | Σ negative closing balances | Σ negative ledger balances | equal |
| Per-customer balance | closing balance | ledger balance | all equal |

**Result on the real workbook** (integration test `apps/api/test/imports.test.ts`; it runs wherever the file is present). Both options, cutover 2026-12-01:
- 163 customers; 142 billed; ₹52,330 a month;
- ₹5,75,630 collections;
- ₹0 outstanding and ₹0 advance;
- **163/163** per-customer balances equal;
- Option A creates 1,562 bills and 1,562 payments.

The analysis finds 21 customers waiting for a rate decision (AMP 10, BOSS 6, DC 4, blank 1), one invalid mobile (327107) and one shared mobile (9726939410), and **0** formula disagreements.

## 8. Migration risks

1. **Rate meaning for 21 customers unknown** (D-1/D-2) — blocks their billing setup.
2. **History authenticity** (Q2) — importing back-filled rows as real payments would distort agent/collection reports.
3. **No agent data** — assignment must be supplied by the business before agents can log in.
4. **Parallel running** — if Excel keeps being updated after the import, a second (delta) import is needed. Natural keys make this safe, but rate changes in Excel cannot be detected as dated changes (X-1). Recommend a hard cutover date with Excel frozen read-only.
5. **December 2026** — if go-live is after 1 Dec, December payments collected in Excel must be imported as a delta before cutover.
