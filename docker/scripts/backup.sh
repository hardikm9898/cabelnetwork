#!/bin/sh
# One backup: custom-format dump + checksum + row-count manifest, then retention.
# Env: PGHOST PGUSER PGDATABASE PGPASSWORD BACKUP_DIR [BACKUP_KEEP_DAYS=35] [BACKUP_KEEP_MONTHS=12]
#      [BACKUP_UPLOAD_CMD]  e.g. "rclone copy {} remote:cablenet-backups" ({} = dump path)
set -eu
DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-35}"
KEEP_MONTHS="${BACKUP_KEEP_MONTHS:-12}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/cablenet-$STAMP.dump"
mkdir -p "$DIR"

COUNTS="SELECT json_build_object(
  'customers', (SELECT count(*) FROM customers),
  'invoices', (SELECT count(*) FROM invoices),
  'payments', (SELECT count(*) FROM payments),
  'ledger_entries', (SELECT count(*) FROM ledger_entries),
  'ledger_total', (SELECT coalesce(sum(amount),0)::text FROM ledger_entries),
  'audit_logs', (SELECT count(*) FROM audit_logs))"

before="$(psql -Atq -c "$COUNTS")"
pg_dump --format=custom --compress=6 --no-owner --file="$FILE.part"
after="$(psql -Atq -c "$COUNTS")"
mv "$FILE.part" "$FILE"
# The dump must be readable, not just present.
pg_restore --list "$FILE" > /dev/null
sha256sum "$FILE" | awk '{print $1}' > "$FILE.sha256"
# Counts are exact when nothing changed during the dump (normal at night); the drill compares them.
if [ "$before" = "$after" ]; then exact=true; else exact=false; fi
printf '{"file":"%s","createdUtc":"%s","exact":%s,"counts":%s}\n' "$(basename "$FILE")" "$STAMP" "$exact" "$after" > "$FILE.json"
echo "backup ok: $FILE ($(du -h "$FILE" | cut -f1))"

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  sh -c "$(echo "$BACKUP_UPLOAD_CMD" | sed "s#{}#$FILE#g")" && echo "uploaded: $FILE"
fi

# Retention: every dump for KEEP_DAYS days; the first dump of each month for KEEP_MONTHS months.
now="$(date -u +%s)"
for f in "$DIR"/cablenet-*.dump; do
  [ -e "$f" ] || continue
  name="$(basename "$f" .dump)"; ts="${name#cablenet-}"
  ymd="$(echo "$ts" | cut -c1-8)"
  epoch="$(date -u -d "$(echo "$ymd" | sed 's/\(....\)\(..\)\(..\)/\1-\2-\3/')" +%s 2>/dev/null || echo "$now")"
  age_days=$(( (now - epoch) / 86400 ))
  if [ "$age_days" -le "$KEEP_DAYS" ]; then continue; fi
  first_of_month="$(ls "$DIR"/cablenet-"$(echo "$ymd" | cut -c1-6)"*.dump | head -1)"
  if [ "$f" = "$first_of_month" ] && [ "$age_days" -le $(( KEEP_MONTHS * 31 )) ]; then continue; fi
  rm -f "$f" "$f.sha256" "$f.json"
  echo "removed old backup: $f"
done
