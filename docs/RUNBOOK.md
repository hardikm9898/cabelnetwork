# Runbook

For whoever runs the server: setup, releases, backups, monitoring and what to do when something goes wrong. Commands assume the repository is checked out on the server and use:

```bash
C="docker compose -f docker/compose.prod.yml --env-file docker/prod.env"
```

## 1. What runs where

One server (2 vCPU / 4 GB is ample; Indian region), Docker Compose:

| Service | What it does | Data |
|---|---|---|
| `web` | Caddy: HTTPS (automatic Let's Encrypt certificate), the office website, `/api` → `api` | `caddy_data` volume (certificates) |
| `api` | The API and the scheduler (bills on the 1st, nightly reconciliation, reminders) | — |
| `migrate` | Runs once at every start: applies new database migrations, then exits | — |
| `db` | PostgreSQL 18, not reachable from outside | `pgdata` volume |
| `backup` | Nightly dump at 02:15 IST into `docker/backups/` (`BACKUP_HOST_DIR`) | dumps |

Phones and the office site reach only `https://<SITE_ADDRESS>`. Ports 80 and 443 must be open; nothing else.

## 2. First installation

1. Point the domain's DNS A record at the server. Install Docker.
2. Configure:

   ```bash
   cp docker/prod.env.example docker/prod.env
   openssl rand -hex 32   # run once each for POSTGRES_PASSWORD (24 is enough), JWT_ACCESS_SECRET, RECEIPT_LINK_SECRET
   ```

   Fill in `SITE_ADDRESS`, `PUBLIC_BASE_URL=https://<SITE_ADDRESS>`, the three secrets and a temporary `BOOTSTRAP_PASSWORD` (letters + digits, 8+). The API refuses to start with placeholder secrets.
3. Start the stack: `$C up -d --build`, then check `curl https://<SITE_ADDRESS>/api/v1/health/ready`. It should report `"status":"ok"`.
4. Create the owner account:

   ```bash
   $C run --rm --no-deps api node apps/api/dist/src/cli.js create-super-admin --mobile <10 digits> --name "<Owner name>"
   ```

   Sign in at `https://<SITE_ADDRESS>` with `BOOTSTRAP_PASSWORD`. The site forces a new password: 12+ characters, not containing the mobile number. Then delete `BOOTSTRAP_PASSWORD` from `prod.env`.
5. In the office site:
   - **Settings:** business name, address and phone (printed on receipts), billing defaults.
   - **Agents:** one per agent, each with a temporary password.
   - **Areas & societies:** which agent owns which area (Q5).
6. **Excel import** (super admin): follow EXCEL_MIGRATION_MAPPING §7 and the cutover plan in UAT_PLAN.md. Use the office site's **Import** page, or the same import from the server's command line:

   ```bash
   # Report only (saves nothing). A plain customer list (no month sheets) is imported with zero
   # balances and billed from --cutover (default: the 1st of next month).
   $C exec -T api node apps/api/dist/src/cli.js import-customers - --cutover 2026-12-01 < customers.xlsx
   # The same with --commit imports it (once; the same file is refused afterwards).
   $C exec -T api node apps/api/dist/src/cli.js import-customers - --cutover 2026-12-01 --commit < customers.xlsx
   ```

   Back up first (§4.2). Delete the workbook from the server afterwards: it holds customer data.
7. **Agent phones:**
   - Install the release build (`eas build --profile production`). `apps/agent/eas.json` must contain the real `https://` address; release builds refuse plain `http`.
   - Each agent signs in, replaces the temporary password and sets a PIN.
8. **Monitoring** (§5) and **off-site backups** (§4) are not optional. Set both up before go-live.

## 3. Releasing a new version

```bash
git pull
$C build                 # new images
$C up -d                 # migrate runs first; api starts only if migrations succeeded
curl -fsS https://<SITE_ADDRESS>/api/v1/health/ready
```

- Migrations only ever add things. If a release has to be undone, deploy the previous version: `git checkout <tag> && $C up -d --build`. If its migrations already ran and must be undone, restore the backup taken before the release (§4.4).
- **Take a backup right before every release** (§4.2).
- The agent app's JavaScript can be updated over the air (`eas update`). A native change needs a new build installed on the phones.

## 4. Backups

### 4.1 What is kept
- Every night at 02:15 IST, `docker/backups/` gets three files:
  - `cablenet-<UTC timestamp>.dump` (PostgreSQL custom format, compressed);
  - `.dump.sha256` (checksum);
  - `.dump.json` (row counts at backup time).
- Retention: every dump for 35 days; the first dump of each month for 12 months. Change it with `BACKUP_KEEP_DAYS` and `BACKUP_KEEP_MONTHS`.
- **Off-site copy (required).** Set `BACKUP_UPLOAD_CMD` in `prod.env`, for example `rclone copy {} remote:cablenet-backups` (`{}` is the dump path). The command runs inside the backup container, so mount rclone's config. Alternatively copy `docker/backups/` from another machine with a nightly `rsync`. A server failure must never take the backups with it.

### 4.2 Backup now (before a release, the import, or risky work)

```bash
$C exec backup sh /scripts/backup.sh
```

### 4.3 Restore drill (monthly, and after any backup change)

```bash
docker/scripts/restore-drill.sh docker/backups/<latest>.dump cablenet-api:latest
```

The drill:
1. Checks the checksum.
2. Restores into a throwaway PostgreSQL.
3. Runs `verify-db`: migrations complete; every customer's ledger equals bills minus credits; no invoice or allocation mismatch.
4. Compares the row counts with the backup's manifest.

It prints `DRILL PASSED`. Record the date and the result in the log in §8.

### 4.4 Restoring production (real incident)

1. `$C stop api web`. Phones keep working offline and send their entries later.
2. Take a dump of the broken database too, for analysis: `$C exec backup sh /scripts/backup.sh`.
3. Restore:

   ```bash
   $C exec -T db dropdb -U cablenet cablenet
   $C exec -T db createdb -U cablenet cablenet
   docker cp docker/backups/<file>.dump cablenet-db-1:/tmp/r.dump
   $C exec -T db pg_restore --no-owner -U cablenet -d cablenet /tmp/r.dump
   ```

4. `$C run --rm --no-deps api node apps/api/dist/src/cli.js verify-db` must print `"ok": true`.
5. `$C up -d`. Entries made on phones after the backup are re-sent automatically:
   - Each entry's id is remembered on the phone until the server confirms it.
   - Entries the server already confirmed before the restore are **not** re-sent. Compare the agents' "My collections" and provisional receipts with the restored data, and enter missing payments in the office site.

## 5. Monitoring and alerts

- **Uptime monitor (required).** Any external service (UptimeRobot, Healthchecks, Better Stack) polling `https://<SITE_ADDRESS>/api/v1/health/ready` every 5 minutes, alerting the owner by SMS or WhatsApp on anything other than HTTP 200. The endpoint shows only states and counts:

| Check | Not OK means | Do |
|---|---|---|
| `database` | The API cannot reach PostgreSQL | `$C ps`, `$C logs db`; disk space (`df -h`) |
| `scheduler` | No successful job pass for 3 intervals | `$C logs api` for `job tick failed`; the Alerts page shows `JOB_FAILED` |
| `criticalAlerts` | An unresolved critical alert | Office site → **Alerts** |
| `nightlyReconciliation` | Last night's check failed or did not run | Office site → **Alerts** → "Check the books now"; investigate any mismatch before more money is entered |

- **Logs:** `$C logs --since 1h api` (JSON; request ids match the `x-request-id` header users can report). Query strings and receipt tokens are not logged.
- **Inside the office site:**
  - **Alerts:** reconciliation mismatches, possible duplicate payments, cash write-offs, job failures.
  - **Offline entries:** payments from phones that were held or flagged.
  - **Agents → device "Last synced":** a phone that has not synced for a day while its agent is working probably has unsent entries.
- **Disk:** alert above 80 % (the monitoring service or a cron job running `df`).

## 6. Incidents and routine tasks

| Situation | What to do |
|---|---|
| **Lost or stolen phone** | **Agents → agent → Devices → Revoke**, **and** reset the agent's password. Device ids are chosen by the phone, so revoking alone is not enough (security review I-3). Data on the phone is encrypted and locked by the PIN. Unsent entries on that phone are lost: ask the agent which payments were collected since the last sync (shown under **Agents → Last synced**) and enter them in the office. |
| **Agent leaves** | Move their customers (Assignments), confirm their last cash handover, then **Deactivate**. That signs them out everywhere. |
| **Agent forgot password or PIN** | PIN: "Forgot PIN" in the app signs out; unsent entries stay on the phone. Password: **Agents → Reset password** gives a temporary one. |
| **Owner (only super admin) locked out** | On the server: set `BOOTSTRAP_PASSWORD` in `prod.env`, then run `$C run --rm --no-deps api node apps/api/dist/src/cli.js reset-password --mobile <m>`. The owner signs in with it and must choose a new password. Remove the variable afterwards. |
| **Cash handover short or excess** | Confirm with the counted amount and the reason; the difference stays on the agent until recovered or written off (Cash). A write-off raises an alert for the owner. |
| **"Possible duplicate payment" alert** | Open the payment. If it was entered twice, **Reverse** one (never delete). |
| **Offline entry held** | **Offline entries** shows why. Check with the agent, then **Payments → To verify → Verify**; or reject it and record the cash another way. |
| **Reconciliation mismatch** | Do not correct the database by hand. Note the customer, then check their Ledger and the audit log. Corrections are always new entries (reversal, credit, debit). |
| **Large billing catch-up** (e.g. after the server was down over the 1st) | The scheduler catches up by itself within 5 minutes. To run it now, use `$C run --rm --no-deps api node apps/api/dist/src/cli.js run-jobs` rather than **Billing → Run** in the browser: at 20,000 customers a month takes about 2 minutes and a multi-month catch-up longer than a browser request waits. Runs are safe to overlap. |
| **Wrong bill** | **Bills → Cancel** with a reason. Admins: within the daily approval limit; above it, the super admin. |
| **Certificate problems** | `$C logs web`. DNS must point at the server and ports 80 and 443 must be open. |
| **Server lost** | New server, §2 steps 1–3 with the same `prod.env`, then §4.4 with the latest off-site dump. |

## 7. Secrets

| Secret | Rotating it |
|---|---|
| `JWT_ACCESS_SECRET` | Everyone's 15-minute access tokens stop working. They renew themselves from their refresh tokens, so users notice nothing. |
| `RECEIPT_LINK_SECRET` | Receipt links already sent to customers stop working (they last 7 days anyway). |
| `POSTGRES_PASSWORD` | `$C exec db psql -U cablenet -c "ALTER USER cablenet PASSWORD '<new>'"`, update `prod.env`, then `$C up -d`. |

`docker/prod.env` and `docker/backups/` are git-ignored. Keep a copy of `prod.env` in the owner's password manager. Without it, backups can still be restored, but the configuration must be recreated.

## 8. Logs to keep

| Date | Task | Result | By |
|---|---|---|---|
| 2026-11-19 | Restore drill on the local production stack (load-test data: 20,000 customers, 80,000 bills, 139 MB) | `DRILL PASSED` in 7 s: restored in 3 s, 0 reconciliation mismatches, row counts and ledger total equal to the manifest | Claude Code |
