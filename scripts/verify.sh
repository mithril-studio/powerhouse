#!/usr/bin/env bash
# One-command verification gate: everything a machine can check, fail-fast.
# The checks a human must perform live in docs/VERIFICATION.md.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

step "rust: unit tests (telemetry store, projector, metrics, migration)"
(cd src-tauri && cargo test --quiet)

step "ts: typecheck"
npx tsc

step "ts: unit tests (formatting rules, digest, transcripts)"
npx vitest run

step "build: production bundle"
npx vite build --logLevel warn

# Runtime data integrity — only when a live telemetry database exists.
DB="$HOME/.powerhouse/telemetry.db"
if [ -f "$DB" ] && command -v sqlite3 >/dev/null; then
  step "sqlite: integrity + schema version of live telemetry.db"
  RESULT=$(sqlite3 "$DB" "PRAGMA integrity_check;")
  [ "$RESULT" = "ok" ] || { echo "integrity_check failed: $RESULT"; exit 1; }
  VERSION=$(sqlite3 "$DB" "SELECT value FROM meta WHERE key='schema_version';")
  echo "integrity ok, schema v$VERSION"
  # No run may be simultaneously 'live' (no end_reason) with a boot that's over:
  # reconciliation marks those interrupted at startup, so lingering ones after
  # a fresh app launch indicate a bug. Informational only (app may be running).
  OPEN=$(sqlite3 "$DB" "SELECT COUNT(*) FROM runs WHERE ended_at IS NULL AND end_reason IS NULL;")
  echo "runs currently open: $OPEN (should be your live agent count, 0 if app closed)"
else
  echo "(no live telemetry.db — runtime integrity check skipped)"
fi

printf '\n\033[1;32m✓ all automated checks passed\033[0m\n'
echo "manual smoke checklist: docs/VERIFICATION.md"
