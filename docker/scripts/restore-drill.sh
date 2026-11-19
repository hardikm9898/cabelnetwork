#!/usr/bin/env bash
# Restore drill: proves a backup can be brought back and is complete and consistent.
#   docker/scripts/restore-drill.sh <path/to/cablenet-….dump> [api image, default cablenet-api:latest]
# Steps: checksum → restore into a throwaway PostgreSQL 18 → `verify-db` (migrations + financial
# invariants) → row counts equal to the manifest written at backup time. Exit 0 = PASS.
set -euo pipefail
DUMP="${1:?usage: restore-drill.sh <dump> [image]}"
IMAGE="${2:-cablenet-api:latest}"
NAME="cablenet-drill-$$"
start=$(date +%s)

fail() { echo "DRILL FAILED: $*" >&2; exit 1; }
[ -f "$DUMP" ] || fail "no such file $DUMP"

if [ -f "$DUMP.sha256" ]; then
  want="$(cat "$DUMP.sha256")"; got="$(sha256sum "$DUMP" | awk '{print $1}')"
  [ "$want" = "$got" ] || fail "checksum mismatch"
  echo "checksum ok"
else
  echo "warning: no checksum file next to the dump"
fi

docker run -d --name "$NAME" -e POSTGRES_USER=cablenet -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=cablenet postgres:18-alpine > /dev/null
trap 'docker rm -f "$NAME" > /dev/null 2>&1 || true' EXIT
# The image starts a temporary server during initialisation, then the real one: wait for the second.
for _ in $(seq 1 90); do
  [ "$(docker logs "$NAME" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done

MSYS_NO_PATHCONV=1 docker cp "$DUMP" "$NAME:/tmp/db.dump"
t0=$(date +%s)
MSYS_NO_PATHCONV=1 docker exec "$NAME" pg_restore --no-owner --exit-on-error -U cablenet -d cablenet /tmp/db.dump
echo "restored in $(( $(date +%s) - t0 ))s"

secret="$(head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-48)"
verify="$(docker run --rm --network "container:$NAME" \
  -e NODE_ENV=test -e DATABASE_URL=postgres://cablenet:drill@127.0.0.1:5432/cablenet -e JWT_ACCESS_SECRET="$secret" -e JOBS_ENABLED=false \
  "$IMAGE" node apps/api/dist/src/cli.js verify-db)" || { echo "$verify"; fail "verify-db reported problems"; }
echo "$verify"

if [ -f "$DUMP.json" ]; then
  manifest="$(cat "$DUMP.json")"
  COUNTS="SELECT json_build_object(
  'customers', (SELECT count(*) FROM customers),
  'invoices', (SELECT count(*) FROM invoices),
  'payments', (SELECT count(*) FROM payments),
  'ledger_entries', (SELECT count(*) FROM ledger_entries),
  'ledger_total', (SELECT coalesce(sum(amount),0)::text FROM ledger_entries),
  'audit_logs', (SELECT count(*) FROM audit_logs))"
  restored="$(MSYS_NO_PATHCONV=1 docker exec "$NAME" psql -U cablenet -d cablenet -Atq -c "$COUNTS")"
  expected="$(echo "$manifest" | sed 's/.*"counts":\(.*\)}$/\1/')"
  echo "manifest counts: $expected"
  echo "restored counts: $restored"
  if echo "$manifest" | grep -q '"exact":true'; then
    [ "$expected" = "$restored" ] || fail "restored row counts differ from the backup manifest"
  else
    echo "note: data changed during that backup; counts compared for information only"
  fi
else
  echo "warning: no manifest next to the dump; row counts not compared"
fi
echo "DRILL PASSED in $(( $(date +%s) - start ))s: $(basename "$DUMP")"
