#!/usr/bin/env bash
# Live activity monitor for manual testing: keep this running in a terminal
# while you use the app. Shows capture flowing in real time plus a periodic
# integrity check. The authoritative invariant battery is the in-app health
# strip (Telemetry page) — this is the glanceable heartbeat.
set -euo pipefail
DB="${1:-$HOME/.powerhouse/telemetry.db}"
command -v sqlite3 >/dev/null || { echo "sqlite3 not found"; exit 1; }

TICK=0
while true; do
  clear
  echo "── powerhouse telemetry watch · $(date '+%H:%M:%S') · $DB"
  if [ ! -f "$DB" ]; then
    echo "waiting for database (launch the app)…"
  else
    sqlite3 -readonly "$DB" "
      SELECT '  runs total     ' || COUNT(*)
          || '   open ' || SUM(CASE WHEN ended_at IS NULL AND end_reason IS NULL THEN 1 ELSE 0 END)
          || '   interrupted ' || SUM(CASE WHEN end_reason='interrupted' THEN 1 ELSE 0 END)
      FROM runs;
      SELECT '  events         ' || COUNT(*)
          || '   last ' || CAST((strftime('%s','now')*1000 - MAX(ingest_time))/1000 AS INT) || 's ago'
      FROM events;
      SELECT '  evidence gaps  dropped ' || COALESCE(SUM(dropped_events),0)
          || '   unparsed ' || COALESCE(SUM(parse_errors),0)
      FROM runs;"
    echo "── last 8 events"
    sqlite3 -readonly "$DB" \
      "SELECT '  ' || substr(run_id,1,6) || '  #' || seq || '  ' || direction || '  '
              || COALESCE(method,'') || COALESCE(' · '||update_kind,'')
              || CASE WHEN parse_status!='ok' THEN '  [' || parse_status || ']' ELSE '' END
       FROM events ORDER BY ingest_time DESC, seq DESC LIMIT 8;"
    if [ $((TICK % 15)) -eq 0 ]; then
      INTEGRITY=$(sqlite3 -readonly "$DB" "PRAGMA quick_check;")
      echo "── integrity: $INTEGRITY"
    fi
  fi
  TICK=$((TICK + 1))
  sleep 2
done
