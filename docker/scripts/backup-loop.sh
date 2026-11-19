#!/bin/sh
# Runs backup.sh at start, then every day at BACKUP_AT_UTC (HH:MM, UTC).
# A failed backup is retried every 15 minutes until one succeeds (and logged as BACKUP FAILED).
set -u
AT="${BACKUP_AT_UTC:-20:45}"
run() {
  until sh /scripts/backup.sh; do
    echo "BACKUP FAILED $(date -u); retrying in 15 minutes"
    sleep 900
  done
}
run
while true; do
  now="$(date -u +%s)"
  target="$(date -u -d "$(date -u +%Y-%m-%d) $AT" +%s 2>/dev/null || echo $((now + 86400)))"
  [ "$target" -le "$now" ] && target=$((target + 86400))
  sleep $((target - now))
  run
done
