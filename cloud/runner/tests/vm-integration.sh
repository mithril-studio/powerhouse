#!/usr/bin/env bash
# Linux/systemd integration test for powerhouse-runner. Run as root on the
# dedicated base VM after `powerhouse-runner install`. Uses the fake agent and
# a local git daemon as the "remote"; no credentials, no model calls.
set -euo pipefail

RUNNER=${RUNNER:-/usr/local/bin/powerhouse-runner}
SRV=/srv/powerhouse-test-git
REMOTE="git://127.0.0.1/test.git"
export POWERHOUSE_RUNNER_ROOT=${POWERHOUSE_RUNNER_ROOT:-/var/lib/powerhouse-runner}
pass=0; fail=0
ok()   { echo "  ✓ $*"; pass=$((pass+1)); }
bad()  { echo "  ✗ $*"; fail=$((fail+1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1 :: $2"; fi; }
j()    { jq -r "$1"; }

[[ $EUID == 0 ]] || { echo "run as root"; exit 1; }
command -v jq >/dev/null

# --- test remote --------------------------------------------------------------
setup_remote() {
  pkill -f "git daemon --base-path=$SRV" || true
  rm -rf "$SRV"; mkdir -p "$SRV/work"
  git -C "$SRV/work" init -q -b main
  git -C "$SRV/work" -c user.name=t -c user.email=t@t config commit.gpgsign false
  cat > "$SRV/work/check.sh" <<'SH'
#!/bin/sh
test -f CLOUD_RUN.md
SH
  chmod +x "$SRV/work/check.sh"
  echo "hello" > "$SRV/work/README.md"
  git -C "$SRV/work" add -A
  git -C "$SRV/work" -c user.name=t -c user.email=t@t commit -q -m init
  git clone -q --bare "$SRV/work" "$SRV/test.git"
  git -C "$SRV/test.git" config daemon.receivepack true
  git -C "$SRV/test.git" config uploadpack.allowAnySHA1InWant true
  git daemon --base-path="$SRV" --export-all --enable=receive-pack --reuseaddr --detach --listen=127.0.0.1
  sleep 1
  SHA=$(git -C "$SRV/work" rev-parse HEAD)
}

manifest() { # id script deadline checks_json
  local id=$1 script=$2 deadline=$3 checks=$4
  jq -nc --arg id "$id" --arg script "$script" --arg sha "$SHA" --arg remote "$REMOTE" --argjson deadline "$deadline" --argjson checks "$checks" '{
    protocol_version: 1, run_id: $id,
    task: { text: "Add CLOUD_RUN.md", acceptance_criteria: ["file exists"] },
    source: { repo_name: "test", remote_url: $remote, commit_sha: $sha, source_branch: "main" },
    output_branch: ("powerhouse/cloud/" + $id),
    workspace: { base_vm_id: "test-base", base_vm_name: "test-base" },
    agent: { provider: "fake", permission_mode: "dontAsk", allowed_tools: [], fake_script: $script },
    checks: $checks, deadline_seconds: $deadline, created_at_ms: 1
  }'
}
newid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
submit() { # manifest-json -> receipt json (stdout), exit code preserved
  local f; f=$(mktemp /tmp/manifest.XXXXXX.json); echo "$1" > "$f"
  local digest; digest=$("$RUNNER" digest --manifest "$f" | jq -r .ok.digest)
  "$RUNNER" submit --manifest "$f" --expect-digest "$digest" || true
}
wait_terminal() { # id timeout
  local id=$1 t=${2:-90} s
  for _ in $(seq 1 "$t"); do
    s=$("$RUNNER" inspect "$id" | j '.ok.state')
    case "$s" in completed|failed|blocked|cancelled|interrupted) echo "$s"; return;; esac
    sleep 1
  done
  echo "TIMEOUT($s)"
}
events() { # page through every event
  local after=0 page
  while :; do
    page=$("$RUNNER" events "$1" --after "$after" --limit 500)
    echo "$page" | jq -c '.ok.events[]'
    [[ $(echo "$page" | jq -r .ok.has_more) == true ]] || break
    after=$(echo "$page" | jq -r .ok.next_after)
  done
}
kinds()  { events "$1" | jq -r '.kind'; }

setup_remote
echo "remote at $REMOTE sha=$SHA"
echo; echo "## probe"
P=$("$RUNNER" probe); echo "$P" | jq -c .ok
check "probe reports protocol 1 and systemd/cgroup" '[[ $(echo "$P" | j .ok.protocol_version) == 1 && $(echo "$P" | j .ok.systemd) == true && $(echo "$P" | j .ok.agent_user_ready) == true ]]'

# ---------------------------------------------------------------------------
echo; echo "## 1. complete + passing check → completed, published"
ID=$(newid); R=$(submit "$(manifest "$ID" complete 300 '[{"name":"file exists","command":"./check.sh"}]')")
check "receipt accepted" '[[ $(echo "$R" | j .ok.state) == accepted && $(echo "$R" | j .ok.duplicate) == false ]]'
S=$(wait_terminal "$ID"); check "state completed ($S)" '[[ $S == completed ]]'
RES=$("$RUNNER" result "$ID")
check "published to unique branch" '[[ $(echo "$RES" | j .ok.published) == true ]]'
RSHA=$(echo "$RES" | j .ok.result_sha)
check "result sha differs from source" '[[ $RSHA != "$SHA" && ${#RSHA} == 40 ]]'
check "remote branch matches result sha" '[[ $(git ls-remote "$REMOTE" "refs/heads/powerhouse/cloud/$ID" | cut -f1) == "$RSHA" ]]'
check "changed_files lists CLOUD_RUN.md" '[[ $(echo "$RES" | j ".ok.changed_files[]") == CLOUD_RUN.md ]]'
check "check passed" '[[ $(echo "$RES" | j ".ok.checks[0].status") == passed ]]'
check "summary came from structured result" '[[ $(echo "$RES" | j .ok.summary) == *CLOUD_RUN.md* ]]'
check "isolation probe: runner state unreadable by agent" '[[ $(events "$ID" | jq -r "select(.kind==\"agent.fake\" and .payload.subtype==\"isolation\") | .payload.runner_state_readable") == false ]]'
check "agent ran as unprivileged uid" '[[ $(events "$ID" | jq -r "select(.kind==\"agent.fake\" and .payload.subtype==\"isolation\") | .payload.uid") != 0 ]]'
CHILD=$(events "$ID" | jq -r 'select(.kind=="agent.fake" and .payload.subtype=="child") | .payload.pid')
check "agent child (sleep 900) is gone" '! kill -0 "$CHILD" 2>/dev/null'
check "diff available" '[[ $("$RUNNER" diff "$ID" | j .ok.bytes) -gt 0 ]]'
check "exactly one claim event" '[[ $(kinds "$ID" | grep -c "^run.claimed$") == 1 ]]'
check "event seqs strictly increasing" 'events "$ID" | jq -s "[.[].seq] == ([.[].seq] | sort) and ([.[].seq] | unique | length) == length" | grep -q true'

echo; echo "## 2. duplicate submit → same receipt, one execution; mismatched digest rejected"
R2=$(submit "$(manifest "$ID" complete 300 '[{"name":"file exists","command":"./check.sh"}]')")
check "duplicate flagged" '[[ $(echo "$R2" | j .ok.duplicate) == true && $(echo "$R2" | j .ok.run_id) == "$ID" ]]'
R3=$(submit "$(manifest "$ID" fail 300 '[]')")
check "different manifest same id → conflict" '[[ $(echo "$R3" | j .error.code) == conflict ]]'
check "still exactly one claim" '[[ $(kinds "$ID" | grep -c "^run.claimed$") == 1 ]]'

echo; echo "## 3. concurrent submits → one execution"
ID=$(newid); M=$(manifest "$ID" complete 300 '[]')
submit "$M" > /tmp/c1.json & submit "$M" > /tmp/c2.json & submit "$M" > /tmp/c3.json & wait
S=$(wait_terminal "$ID"); check "completed ($S)" '[[ $S == completed ]]'
check "one claim, at most two duplicate receipts" '[[ $(kinds "$ID" | grep -c "^run.claimed$") == 1 && $(cat /tmp/c1.json /tmp/c2.json /tmp/c3.json | jq -s "[.[] | .ok.duplicate] | map(select(. == false)) | length") == 1 ]]'

echo; echo "## 4. no checks configured → completed, checks_configured=false"
ID=$(newid); submit "$(manifest "$ID" complete 300 '[]')" >/dev/null
S=$(wait_terminal "$ID"); check "completed ($S)" '[[ $S == completed ]]'
check "checks_configured false and no check entries" '[[ $("$RUNNER" result "$ID" | j .ok.checks_configured) == false ]]'
check "checks.none_configured event present" 'kinds "$ID" | grep -q "^checks.none_configured$"'

echo; echo "## 5. failing check → failed at validating, still published for review"
ID=$(newid); submit "$(manifest "$ID" complete 300 '[{"name":"always fails","command":"echo boom >&2; exit 7"},{"name":"skipped","command":"true"}]')" >/dev/null
S=$(wait_terminal "$ID"); check "failed ($S)" '[[ $S == failed ]]'
SNAP=$("$RUNNER" inspect "$ID"); RES=$("$RUNNER" result "$ID")
check "error stage validating with exit 7" '[[ $(echo "$SNAP" | j .ok.error.stage) == validating && $(echo "$SNAP" | j .ok.error.message) == *"exit 7"* ]]'
check "second check skipped" '[[ $(echo "$RES" | j ".ok.checks[1].status") == skipped ]]'
check "check output tail captured" '[[ $(echo "$RES" | j ".ok.checks[0].output_tail") == *boom* ]]'
check "result published despite failed check" '[[ $(echo "$RES" | j .ok.published) == true ]]'

echo; echo "## 6. check modifies tree → tested tree is what gets published"
ID=$(newid); submit "$(manifest "$ID" complete 300 '[{"name":"mutates","command":"echo tampered >> README.md"}]')" >/dev/null
S=$(wait_terminal "$ID"); RES=$("$RUNNER" result "$ID")
check "tree_changed_after_checks flagged" '[[ $(echo "$RES" | j .ok.tree_changed_after_checks) == true ]]'
check "published README unchanged (pre-check tree)" '[[ $(git -C "$SRV/test.git" show "$(echo "$RES" | j .ok.result_sha):README.md") == hello ]]'

echo; echo "## 7. agent fails (exit 23) → failed at agent, partial work preserved"
ID=$(newid); submit "$(manifest "$ID" fail 300 '[]')" >/dev/null
S=$(wait_terminal "$ID"); SNAP=$("$RUNNER" inspect "$ID")
check "failed at agent with exit 23 ($S)" '[[ $S == failed && $(echo "$SNAP" | j .ok.error.stage) == agent && $(echo "$SNAP" | j .ok.error.message) == *23* ]]'
check "partial work preserved on disk" '[[ -f /var/lib/powerhouse-runner-work/$ID/repo/PARTIAL.md ]]'

echo; echo "## 8. agent blocked (max turns) → blocked, no publication"
ID=$(newid); submit "$(manifest "$ID" block 300 '[]')" >/dev/null
S=$(wait_terminal "$ID"); check "blocked ($S)" '[[ $S == blocked ]]'
check "no branch published" '[[ -z $(git ls-remote "$REMOTE" "refs/heads/powerhouse/cloud/$ID") ]]'

echo; echo "## 9. prose success without structured result → failed, not completed"
ID=$(newid); submit "$(manifest "$ID" lying 300 '[]')" >/dev/null
S=$(wait_terminal "$ID"); check "failed ($S)" '[[ $S == failed ]]'

echo; echo "## 10. no-change run → completed, result sha == source"
ID=$(newid); submit "$(manifest "$ID" no-change 300 '[]')" >/dev/null
S=$(wait_terminal "$ID"); RES=$("$RUNNER" result "$ID")
check "completed with unchanged sha ($S)" '[[ $S == completed && $(echo "$RES" | j .ok.result_sha) == "$SHA" && $(echo "$RES" | j .ok.published) == true ]]'

echo; echo "## 11. cancel a hanging agent → cancelled, children gone, repeat cancel harmless"
ID=$(newid); submit "$(manifest "$ID" hang 600 '[]')" >/dev/null
for _ in $(seq 1 30); do [[ $("$RUNNER" inspect "$ID" | j .ok.state) == running ]] && break; sleep 1; done
CHILD=$(events "$ID" | jq -r 'select(.kind=="agent.fake" and .payload.subtype=="child") | .payload.pid')
C1=$("$RUNNER" cancel "$ID"); S=$(wait_terminal "$ID" 40)
check "cancelled ($S)" '[[ $S == cancelled ]]'
check "unit gone" '! systemctl is-active --quiet "powerhouse-run-$ID.service"'
check "agent child gone" '! kill -0 "$CHILD" 2>/dev/null'
check "history retained" '[[ $(kinds "$ID" | grep -c "^agent.assistant$") -ge 1 ]]'
C2=$("$RUNNER" cancel "$ID"); check "second cancel harmless" '[[ $(echo "$C2" | j .ok.state) == cancelled && $(kinds "$ID" | grep -c "^run.cancel_requested$") == 1 ]]'
check "partial work preserved" '[[ -f /var/lib/powerhouse-runner-work/$ID/repo/PARTIAL.md && $("$RUNNER" result "$ID" | j .ok.partial_work_preserved) == true ]]'

echo; echo "## 12. deadline (60s) on CPU-only hang → failed, processes stopped"
ID=$(newid); submit "$(manifest "$ID" hang 60 '[]')" >/dev/null
S=$(wait_terminal "$ID" 120); SNAP=$("$RUNNER" inspect "$ID")
check "failed by deadline ($S)" '[[ $S == failed && $(echo "$SNAP" | j .ok.error.message) == *deadline* ]]'
for _ in $(seq 1 30); do systemctl is-active --quiet "powerhouse-run-$ID.service" || break; sleep 1; done
check "unit stopped after deadline" '! systemctl is-active --quiet "powerhouse-run-$ID.service"'
check "no agent processes left for run" '[[ -z $(ps -eo pid,user,args | awk -v u="powerhouse-agent" "\$2==u") ]]'

echo; echo "## 13. executor killed (crash) → interrupted, never rerun"
ID=$(newid); submit "$(manifest "$ID" hang 600 '[]')" >/dev/null
for _ in $(seq 1 30); do [[ $("$RUNNER" inspect "$ID" | j .ok.state) == running ]] && break; sleep 1; done
systemctl kill --signal=SIGKILL --kill-whom=main "powerhouse-run-$ID.service" || bad "unit was not running when killed"
S=$(wait_terminal "$ID" 40); check "interrupted ($S)" '[[ $S == interrupted ]]'
check "single claim (no blind rerun)" '[[ $(kinds "$ID" | grep -c "^run.claimed$") == 1 ]]'
check "unit.finished recorded by finalize" 'kinds "$ID" | grep -q "^unit.finished$"'

echo; echo "## 14. reconcile marks orphaned live rows interrupted"
ID=$(newid)
sqlite3 "$POWERHOUSE_RUNNER_ROOT/runner.db" "INSERT INTO runs(run_id,manifest_digest,manifest_json,state,accepted_at_ms,updated_at_ms,launch_attempted_at_ms,unit_name,last_event_seq) VALUES('$ID','x','$(manifest "$ID" complete 300 '[]' | sed "s/'/''/g")','running',1,1,1,'powerhouse-run-$ID.service',0)" 2>/dev/null || echo "  (sqlite3 CLI missing; skipping direct insert)"
if "$RUNNER" inspect "$ID" >/dev/null 2>&1; then
  R=$("$RUNNER" reconcile --reason boot); S=$("$RUNNER" inspect "$ID" | j .ok.state)
  check "orphan became interrupted ($S)" '[[ $S == interrupted ]]'
fi

echo; echo "## 15. huge output → bounded events, run still completes"
ID=$(newid); submit "$(manifest "$ID" huge-output 300 '[]')" >/dev/null
S=$(wait_terminal "$ID" 120); check "completed ($S)" '[[ $S == completed ]]'
check "output.truncated recorded" 'kinds "$ID" | grep -q "^output.truncated$"'
check "event count bounded" '[[ $("$RUNNER" inspect "$ID" | j .ok.last_event_seq) -lt 20100 ]]'

echo; echo "## 16. malformed input"
echo '{"protocol_version": 99}' > /tmp/bad.json
check "bad manifest rejected" '[[ $("$RUNNER" submit --manifest /tmp/bad.json | j .error.code) == manifest_invalid ]]'
check "path-like run id rejected" '[[ $("$RUNNER" inspect "../etc" | j .error.code) == invalid ]]'
M=$(manifest "$(newid)" complete 300 '[]'); echo "$M" > /tmp/m.json
check "digest mismatch rejected" '[[ $("$RUNNER" submit --manifest /tmp/m.json --expect-digest 00 | j .error.code) == digest_mismatch ]]'
BADID=$(newid); echo "$M" | jq --arg id "$BADID" '.run_id=$id | .output_branch="main"' > /tmp/m2.json
check "foreign output branch rejected" '[[ $("$RUNNER" submit --manifest /tmp/m2.json | j .error.code) == manifest_invalid ]]'

echo; echo "## 17. write-outside attempt fails under agent identity"
ID=$(newid); submit "$(manifest "$ID" write-outside 300 '[]')" >/dev/null
S=$(wait_terminal "$ID"); check "completed, escape failed ($S)" '[[ $S == completed && $(events "$ID" | jq -r "select(.payload.subtype==\"escape_attempt\") | .payload.succeeded") == false ]]'

echo; echo "## 18. per-run credentials: custody, delivery, and destruction"
ID=$(newid); M=$(manifest "$ID" complete 300 '[]'); f=$(mktemp /tmp/manifest.XXXXXX.json); echo "$M" > "$f"
CF=/home/boxd/powerhouse-$ID.creds; printf 'CLAUDE_CODE_OAUTH_TOKEN=fake-oauth-token-value\nGIT_PUBLISH_TOKEN=fake-git-token\n' > "$CF"
D=$("$RUNNER" digest --manifest "$f" | jq -r .ok.digest)
R=$("$RUNNER" submit --manifest "$f" --expect-digest "$D" --credentials "$CF")
check "accepted with credentials" '[[ $(echo "$R" | j .ok.state) == accepted ]]'
check "drop location shredded" '[[ ! -e $CF ]]'
check "root-only custody while live" '[[ $(stat -c %a:%U "$POWERHOUSE_RUNNER_ROOT/credentials/$ID.env") == 600:root ]]'
S=$(wait_terminal "$ID"); check "completed ($S)" '[[ $S == completed ]]'
ISO=$(events "$ID" | jq -c 'select(.kind=="agent.fake" and .payload.subtype=="isolation") | .payload')
check "agent received the model token but not the git token" '[[ $(echo "$ISO" | jq -r .has_model_token) == true && $(echo "$ISO" | jq -r .has_git_token) == false ]]'
check "brief present in workspace" '[[ $(echo "$ISO" | jq -r .brief_present) == true ]]'
check "credentials destroyed at terminal state" '[[ ! -e $POWERHOUSE_RUNNER_ROOT/credentials/$ID.env ]]'
check "brief not published" '! git -C "$SRV/test.git" ls-tree -r --name-only "$("$RUNNER" result "$ID" | j .ok.result_sha)" | grep -q "^.powerhouse/"'
check "token value absent from events" '! events "$ID" | grep -q fake-oauth-token-value'
echo '{"protocol_version": 1}' > /tmp/empty.creds
ID2=$(newid); M2=$(manifest "$ID2" complete 300 '[]'); echo "$M2" > /tmp/m3.json
check "empty credentials rejected" '[[ $("$RUNNER" submit --manifest /tmp/m3.json --credentials /tmp/empty.creds | j .error.code) == credentials_empty ]]'
echo; echo "## 19. cancelled run also destroys credentials"
ID=$(newid); M=$(manifest "$ID" hang 600 '[]'); f=$(mktemp /tmp/manifest.XXXXXX.json); echo "$M" > "$f"
CF=/home/boxd/powerhouse-$ID.creds; printf 'CLAUDE_CODE_OAUTH_TOKEN=x\n' > "$CF"
"$RUNNER" submit --manifest "$f" --credentials "$CF" >/dev/null
for _ in $(seq 1 30); do [[ $("$RUNNER" inspect "$ID" | j .ok.state) == running ]] && break; sleep 1; done
check "credentials present during run" '[[ -e $POWERHOUSE_RUNNER_ROOT/credentials/$ID.env ]]'
"$RUNNER" cancel "$ID" >/dev/null; S=$(wait_terminal "$ID" 40)
check "cancelled ($S) and credentials gone" '[[ $S == cancelled && ! -e $POWERHOUSE_RUNNER_ROOT/credentials/$ID.env ]]'

echo; echo "## summary: $pass passed, $fail failed"
pkill -f "git daemon --base-path=$SRV" || true
[[ $fail == 0 ]]
