# User Acceptance Test, Parallel Run and Go-Live

The last gate before the system replaces Excel (DEVELOPMENT_ROADMAP Phase 8):
1. **UAT sign-off.**
2. **Restore drill passed.**
3. **One parallel-run month that reconciles with Excel.**

The software side of each is ready. These steps need the owner, the office and both agents.

## 1. Before starting

| # | Item | Who | Done |
|---|---|---|---|
| 1 | Server running with HTTPS at the real address (RUNBOOK §2); uptime monitor and off-site backups set up | Owner / IT | |
| 2 | Business answers recorded: **Q1** (AMP/BOSS/DC/blank customers), **Q2** (Option A or B), **Q5** (agent per society), **Q16** (cutover month). Defaults for Q4, Q6–Q15 accepted or changed in Settings | Owner | |
| 3 | Settings: business name, address and phone (on receipts), billing defaults, payment rules, "out of date" warning hours | Office | |
| 4 | Both agents created; areas with owners; release app installed on both agents' phones (`eas build --profile production`) | Office / IT | |
| 5 | Excel import done (§4, step T−1) | Owner | |

## 2. Test scripts (UAT)

Run on the real server with real customers, in the first days of the parallel month. Mark ✅ / ❌ and write down anything unexpected. A ❌ is fixed and retested before sign-off.

### Office (admin)

| # | Do | Expect | ✅/❌ |
|---|---|---|---|
| O1 | Sign in; open Dashboard | Totals match the customer count and this month's bills | |
| O2 | Find a customer by name, by ID and by mobile | Found; profile shows bills, payments, ledger and **Excel history** | |
| O3 | Record a cash payment for a customer at the office; open the receipt PDF | Receipt number, months paid, remaining due | |
| O4 | Record a UPI payment with a reference; verify it under Payments → To verify | Counts only after verification | |
| O5 | Reverse a wrongly entered payment (with a reason) | Payment shows reversed, receipt cancelled, balance back | |
| O6 | Add a promise to pay and a follow-up for a customer | Appears under Follow-ups and in the agent's app | |
| O7 | Cover one agent with the other for two days (Assignments → temporary) | The other agent sees those customers; they go back afterwards | |
| O8 | Confirm an agent's cash handover; record a ₹10 shortage with a reason | Shortage stays on the agent; an alert appears | |
| O9 | Reports: Outstanding, Daily collection, Agent collection; export one to Excel | Numbers match Dashboard | |
| O10 | Alerts → "Check the books now" | "Books balance" | |
| O11 | Offline entries | Any held entry can be verified under Payments | |

### Each agent (A and B)

| # | Do | Expect | A | B |
|---|---|---|---|---|
| A1 | Sign in with the temporary password; set own password and PIN | Home shows today's figures | | |
| A2 | Today's list: Pending, Overdue, search by name and mobile | Only own customers | | |
| A3 | Collect full due from a customer; share on WhatsApp | Receipt with number; the customer receives the link | | |
| A4 | Part payment (one month) | Shown as part paid; remaining due correct | | |
| A5 | **Airplane mode on**: collect from a customer; share the provisional receipt | "Provisional receipt P-…"; WhatsApp text says PROVISIONAL | | |
| A6 | Close the app completely, reopen (PIN) while still offline | The entry is still there, "Waiting to send: 1" | | |
| A7 | Airplane mode off | Within a minute: "Everything is sent"; the receipt screen shows the final receipt | | |
| A8 | Record a visit: not available, come back tomorrow | Follow-up appears for tomorrow | | |
| A9 | Cash handover at the end of the day | Amount equals cash collected; the office confirms | | |
| A10 | Switch the app to Gujarati and back | All screens translated | | |
| A11 | Time a full-due payment entry from opening the customer to the saved receipt | Under 15 seconds | | |

## 3. Parallel run (one billing month)

Purpose: prove the system's books equal what Excel would have said, for every customer, before Excel is retired.

1. From the cutover date, the **system is the record**. Agents collect only in the app.
2. Every day, the office copies the day's collections into Excel as before. Use the **Daily collection** report, or **Payments** filtered by date, so it is a copy of the app, not a second entry by the agents.
3. At month end, office site → **Excel import → Compare with the workbook (parallel run)**: upload the month's workbook and choose the month.
   - **"All N customers agree"** → the parallel run passes.
   - **Differences** → for each listed customer, compare the system's Ledger with the Excel row. Usual causes: a payment typed in only one place, a different date, a rate change made in only one place. Fix the side that is wrong (the system by reversal or adjustment, Excel by editing) and compare again until it agrees.
4. Record the result and sign off (§5). Excel then becomes read-only for good.

## 4. Cutover (from DEVELOPMENT_ROADMAP)

| When | Step | Who | Done |
|---|---|---|---|
| T−7 days | Import **dry run** of the current workbook on the server (Excel import page). The owner reviews the reconciliation report and the "needs decision" list (Q1). Then **Discard** | Owner | |
| T−7 days | Restore drill on a backup of the server (RUNBOOK §4.3) → `DRILL PASSED` | IT | |
| T−1 day | **Excel frozen.** Take a backup (RUNBOOK §4.2) | Office / IT | |
| T−1 day | Final import: upload, check findings, choose **Option A or B** (Q2), cutover = 1st of next month, dry run, approve, **Import now**. Reconciliation must show 163/163 (or the current count) | Owner | |
| T−1 day | Agents' customer lists checked against their route sheets (Today's list → All) | Agents | |
| Day 0 | The scheduler issues the month's bills overnight. Check Dashboard and Billing → runs | Office | |
| Day 0 → month end | Agents collect in the app; parallel run (§3) | All | |
| Month end | Parallel-run compare passes; sign-off | Owner | |

## 5. Sign-off

| Gate | Evidence | Result | Signed (name, date) |
|---|---|---|---|
| UAT | §2 tables all ✅ | | Owner: |
| UAT | | | Agent A: |
| UAT | | | Agent B: |
| Restore drill | RUNBOOK §8 log entry with `DRILL PASSED` | | IT: |
| Parallel run | "All N customers agree" for the month | | Owner: |
