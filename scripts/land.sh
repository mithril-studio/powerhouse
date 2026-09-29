#!/usr/bin/env bash
# Land the current branch on the target branch (default: test):
#   fetch → rebase onto origin/<target> → checks → push HEAD:<target>.
# A rejected push (someone landed first) is retried once: fetch, rebase,
# re-check, push. Never force-pushes. Prints one `landed <sha> <subject>` line
# per commit, matching the Merge tab.
#
# Usage: scripts/land.sh [--no-push]
#   LAND_TARGET  target branch (default: test; never main)
#   LAND_CHECKS  override the check command (used by scripts/land.test.sh)
#
# Exit: 0 landed or nothing to land · 1 not landable (dirty tree, wrong branch)
#       2 rebase conflict (rebase aborted, tree unchanged) · 3 checks failed
#       4 push still rejected after one retry
set -euo pipefail

TARGET="${LAND_TARGET:-test}"
PUSH=1
[ "${1:-}" = "--no-push" ] && PUSH=0

cd "$(git rev-parse --show-toplevel)"
LOG="$(git rev-parse --absolute-git-dir)/land.log"
: > "$LOG"

die() { echo "land: $2" >&2; exit "$1"; }

[ "$TARGET" = "main" ] && die 1 "main is production; it only changes through the test → main PR"
BRANCH="$(git symbolic-ref --quiet --short HEAD || echo HEAD)"
[ "$BRANCH" = "main" ] && die 1 "on main; land from a worktree branch"
git diff --quiet && git diff --cached --quiet \
  || die 1 "uncommitted changes; commit (or discard) them first:
$(git status --short --untracked-files=no)"

# Rebase onto the fresh target. On conflict, report the files and abort so the
# tree is left exactly as it was; the caller resolves with a manual rebase.
rebase_onto_target() {
  git fetch -q origin "$TARGET" || die 1 "fetch of origin/$TARGET failed"
  if ! git rebase -q "origin/$TARGET" >>"$LOG" 2>&1; then
    local files
    files="$(git diff --name-only --diff-filter=U)"
    git rebase --abort >/dev/null 2>&1 || true
    die 2 "rebase onto origin/$TARGET conflicts in:
$files
Resolve with: git rebase origin/$TARGET (fix, git add, git rebase --continue), then run scripts/land.sh again."
  fi
}

run_checks() {
  if [ -n "${LAND_CHECKS:-}" ]; then
    echo "checks: $LAND_CHECKS"
    bash -c "$LAND_CHECKS" >>"$LOG" 2>&1 || { tail -40 "$LOG" >&2; die 3 "checks failed (full log: $LOG)"; }
    return
  fi
  [ -d node_modules ] || { echo "checks: pnpm install"; pnpm install --frozen-lockfile >>"$LOG" 2>&1 \
    || { tail -40 "$LOG" >&2; die 3 "pnpm install failed (full log: $LOG)"; }; }
  echo "checks: pnpm build && pnpm test"
  { pnpm build && pnpm test; } >>"$LOG" 2>&1 || { tail -40 "$LOG" >&2; die 3 "checks failed (full log: $LOG)"; }
  if ! git diff --quiet "origin/$TARGET" HEAD -- src-tauri; then
    echo "checks: cargo test (src-tauri changed)"
    (cd src-tauri && cargo test --quiet) >>"$LOG" 2>&1 || { tail -40 "$LOG" >&2; die 3 "cargo test failed (full log: $LOG)"; }
  fi
}

rebase_onto_target
if [ "$(git rev-list --count "origin/$TARGET..HEAD")" = 0 ]; then
  echo "nothing to land: HEAD is already on origin/$TARGET"
  exit 0
fi
run_checks

if [ "$PUSH" = 0 ]; then
  echo "checks passed; not pushed (--no-push). Would land:"
  git log --reverse --format='  %h %s' "origin/$TARGET..HEAD"
  exit 0
fi

attempt=1
while true; do
  BASE="$(git rev-parse "origin/$TARGET")"
  if git push -q origin "HEAD:$TARGET" >>"$LOG" 2>&1; then
    git log --reverse --format='landed %h %s' "$BASE..HEAD"
    echo "pushed to origin/$TARGET; the beta build starts from it"
    exit 0
  fi
  [ "$attempt" = 2 ] && { tail -20 "$LOG" >&2; die 4 "push to origin/$TARGET still rejected after a retry (full log: $LOG). Never force-push; fetch and run scripts/land.sh again."; }
  echo "push rejected (someone landed first); rebasing and re-checking"
  attempt=2
  before="$(git rev-parse HEAD)"
  rebase_onto_target
  [ "$(git rev-parse HEAD)" = "$before" ] || run_checks
done
