#!/usr/bin/env bash
# Sandbox test for scripts/land.sh: a throwaway bare origin and two clones, no
# network, checks replaced through LAND_CHECKS. Pins the exit-code contract and
# that nothing is ever force-pushed.
set -euo pipefail

LAND="$(cd "$(dirname "$0")" && pwd)/land.sh"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
export GIT_AUTHOR_NAME=land-test GIT_AUTHOR_EMAIL=land@test GIT_COMMITTER_NAME=land-test GIT_COMMITTER_EMAIL=land@test
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
expect() { # name expected-exit actual-exit
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (exit $3, want $2)"; fi
}

git init -q --bare -b main "$SANDBOX/origin.git"
git clone -q "$SANDBOX/origin.git" "$SANDBOX/seed"
( cd "$SANDBOX/seed" && echo base > file && git add file && git commit -qm base \
  && git push -q origin main && git push -q origin main:test )

fresh() { # fresh <name>: a clone on a feature branch cut from origin/test
  rm -rf "$SANDBOX/$1"
  git clone -q "$SANDBOX/origin.git" "$SANDBOX/$1"
  git -C "$SANDBOX/$1" checkout -q -b feature origin/test
}
commit() { # commit <clone> <file> <content> <subject>
  ( cd "$SANDBOX/$1" && echo "$3" > "$2" && git add "$2" && git commit -qm "$4" )
}
origin_test() { git --git-dir="$SANDBOX/origin.git" rev-parse test; }
run() { # run <clone> [args] → sets OUT and CODE
  set +e
  OUT="$(cd "$SANDBOX/$1" && "$LAND" "${@:2}" 2>&1)"
  CODE=$?
  set -e
}

echo "land.sh sandbox"

fresh a
run a
expect "nothing to land exits 0" 0 "$CODE"

commit a a.txt one "add a"
LAND_CHECKS=true run a --no-push
expect "--no-push exits 0" 0 "$CODE"
[ "$(origin_test)" != "$(git -C "$SANDBOX/a" rev-parse HEAD)" ] && pass "--no-push does not push" || fail "--no-push pushed"

LAND_CHECKS=true run a
expect "clean land exits 0" 0 "$CODE"
[ "$(origin_test)" = "$(git -C "$SANDBOX/a" rev-parse HEAD)" ] && pass "origin/test is HEAD" || fail "origin/test not updated"
grep -q '^landed [0-9a-f]* add a$' <<<"$OUT" && pass "prints landed line" || fail "no landed line: $OUT"

fresh b
echo dirty >> "$SANDBOX/b/file"
run b
expect "dirty tree exits 1" 1 "$CODE"

fresh c
git -C "$SANDBOX/c" checkout -q -b main-copy && git -C "$SANDBOX/c" checkout -q main
run c
expect "on main exits 1" 1 "$CODE"
LAND_TARGET=main run a
expect "target main exits 1" 1 "$CODE"

fresh d
commit d fail.txt x "will fail checks"
LAND_CHECKS=false run d
expect "failed checks exit 3" 3 "$CODE"
[ "$(origin_test)" != "$(git -C "$SANDBOX/d" rev-parse HEAD)" ] && pass "failed checks do not push" || fail "pushed despite failed checks"

fresh e
commit e file mine "edit file (e)"
fresh f
commit f file theirs "edit file (f)"
LAND_CHECKS=true run f
before="$(git -C "$SANDBOX/e" rev-parse HEAD)"
LAND_CHECKS=true run e
expect "conflict exits 2" 2 "$CODE"
[ "$(git -C "$SANDBOX/e" rev-parse HEAD)" = "$before" ] && pass "conflict leaves HEAD unchanged" || fail "HEAD moved on conflict"
[ -z "$(git -C "$SANDBOX/e" status --porcelain)" ] && pass "conflict leaves tree clean" || fail "tree dirty after conflict"
grep -q '^file$' <<<"$OUT" && pass "conflict names the file" || fail "conflict file not listed: $OUT"

# Someone lands while our checks run: first push is rejected, retry lands.
fresh g
commit g g.txt g "add g"
fresh other
MARK="$SANDBOX/once"
LAND_CHECKS="[ -f '$MARK' ] || { touch '$MARK'; cd '$SANDBOX/other' && git commit -q --allow-empty -m 'landed meanwhile' && git push -q origin HEAD:test; }" run g
expect "rejected push retried and landed" 0 "$CODE"
# Capture first: under pipefail, `git log | grep -q` fails when grep exits early.
subjects="$(git --git-dir="$SANDBOX/origin.git" log --format=%s test)"
grep -qx 'landed meanwhile' <<<"$subjects" \
  && pass "retry kept the other commit (no force-push)" || fail "other commit lost"

# Someone lands every time: gives up after one retry, never force-pushes.
fresh h
commit h h.txt h "add h"
fresh other
LAND_CHECKS="cd '$SANDBOX/other' && git pull -q --rebase origin test && git commit -q --allow-empty -m race && git push -q origin HEAD:test" run h
expect "persistent rejection exits 4" 4 "$CODE"
[ "$(git --git-dir="$SANDBOX/origin.git" log --format=%s -1 test)" = race ] \
  && pass "persistent rejection does not overwrite" || fail "origin/test overwritten"

[ "$fails" = 0 ] && echo "land.sh: all sandbox checks passed" || { echo "land.sh: $fails failed"; exit 1; }
