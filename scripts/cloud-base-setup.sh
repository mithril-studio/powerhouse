#!/usr/bin/env bash
# Prepare a boxd base for Powerhouse cloud runs.
#
# Publish a versioned base snapshot (the normal path; no VM holds a slot afterwards):
#   scripts/cloud-base-setup.sh --publish-snapshot <name>          # e.g. powerhouse-base
#
# Refresh an existing VM in place (development / debugging):
#   scripts/cloud-base-setup.sh <vm> [--reset-store]
#
# --publish-snapshot, from your laptop with the external `boxd` CLI:
#   1. creates a fresh isolated build VM `ph-base-build` (removed if it exists)
#   2. uploads cloud/ (protocol + runner sources), installs a Rust toolchain if
#      missing, builds the runner, stages Claude for the agent identity, runs
#      `powerhouse-runner install` (agent user, root-only store, boot reconcile unit)
#   3. sweeps: stops all powerhouse-run-* units, verifies the runner store is
#      empty, clears shell history and /tmp
#   4. `boxd snapshots save ph-base-build <name>` (re-saving bumps the version),
#      reads the version back from `snapshots list`
#   5. removes `ph-base-build`
#
# Credentials are never placed on the base: Powerhouse sends each run its own
# from the macOS Keychain and the runner destroys them when the run ends.
# The refresh mode never creates, deletes, or reconfigures machines.
set -euo pipefail

usage() { echo "usage: $0 --publish-snapshot <name> | $0 <vm> [--reset-store]" >&2; exit 2; }

MODE=refresh
VM=
SNAPSHOT=
RESET=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --publish-snapshot) MODE=publish; SNAPSHOT=${2:-}; [[ -n $SNAPSHOT ]] || usage; shift 2;;
    --reset-store) RESET=1; shift;;
    -h|--help) usage;;
    -*) echo "unknown flag $1" >&2; usage;;
    *) VM=$1; shift;;
  esac
done
if [[ $MODE == publish ]]; then
  VM=ph-base-build; RESET=1
  [[ $SNAPSHOT =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "snapshot name must be lowercase letters, digits and dashes" >&2; exit 2; }
else
  [[ -n $VM ]] || usage
fi

here=$(cd "$(dirname "$0")/.." && pwd)
tgz=$(mktemp -t powerhouse-cloud.XXXXXX)
trap 'rm -f "$tgz"' EXIT
COPYFILE_DISABLE=1 tar czf "$tgz" -C "$here" --exclude=target --exclude=.DS_Store cloud

filter() { grep -v -e 'new version' -e 'install.sh' -e 'client-utilities' || true; }
j() { # first JSON document on stdin, or nothing
  python3 -c '
import sys,json
r=sys.stdin.read()
i=[x for x in (r.find("{"), r.find("[")) if x>=0]
if not i: sys.exit(0)
d,_=json.JSONDecoder().raw_decode(r[min(i):]); print(json.dumps(d))'
}
x() { # exec on the VM, print output, propagate exit code
  local out; out=$(boxd machine exec "$VM" --timeout 900 --json -- "$@" 2>&1 | filter)
  python3 - "$out" <<'PY'
import json,sys
raw=sys.argv[1].strip()
try:
    d=json.loads(raw[raw.index('{'):])
except Exception:
    print(raw); sys.exit(1)
print(d.get("output","").rstrip())
sys.exit(int(d.get("exit_code",1)))
PY
}
status_of() { # running | stopped | … | absent
  local out; out=$(boxd machine get "$1" --json 2>&1 || true)
  echo "$out" | filter | j | python3 -c 'import sys,json; r=sys.stdin.read(); print(json.loads(r).get("status","unknown") if r.strip() else "absent")'
}
wait_running() {
  for _ in $(seq 1 36); do
    st=$(status_of "$1")
    [[ $st == running || $st == standby ]] && return 0
    sleep 5
  done
  echo "$1 did not become running (last: $st)" >&2; return 1
}

if [[ $MODE == publish ]]; then
  if [[ $(status_of "$VM") != absent ]]; then
    echo "→ removing stale $VM"
    (boxd machine remove "$VM" --confirm --json 2>&1 || true) | filter | j >/dev/null
  fi
  echo "→ creating $VM (isolated, from scratch)"
  boxd machine new "$VM" --isolated --auto-suspend-timeout 0 --auto-hibernate-timeout 0 --json 2>&1 | filter | j
  wait_running "$VM"
else
  echo "→ starting $VM if needed"
  boxd machine start "$VM" --json 2>&1 | filter >/dev/null || true
  wait_running "$VM"
fi

echo "→ uploading runner sources"
boxd machine cp "$tgz" "$VM:/home/boxd/powerhouse-cloud-src.tgz" --json 2>&1 | filter >/dev/null
x sh -c 'rm -rf ~/powerhouse-cloud && mkdir -p ~/powerhouse-cloud && tar xzf ~/powerhouse-cloud-src.tgz -C ~/powerhouse-cloud 2>/dev/null && ls ~/powerhouse-cloud/cloud'

echo "→ ensuring a Rust toolchain and build tools"
x sh -c 'command -v ~/.cargo/bin/cargo >/dev/null || (curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh && sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable >/tmp/rustup.log 2>&1); ~/.cargo/bin/cargo --version; command -v gcc >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq build-essential >/dev/null); command -v jq >/dev/null || sudo apt-get install -y -qq jq >/dev/null; gcc --version | head -1'

echo "→ building the runner (release)"
x sh -c 'cd ~/powerhouse-cloud/cloud && ~/.cargo/bin/cargo build --release 2>&1 | tail -2'

if [[ $RESET == 1 ]]; then
  echo "→ resetting the runner store (clean base)"
  x sudo sh -c 'systemctl stop "powerhouse-run-*.service" 2>/dev/null; rm -rf /var/lib/powerhouse-runner/runner.db* /var/lib/powerhouse-runner/results /var/lib/powerhouse-runner/publish /var/lib/powerhouse-runner/credentials /var/lib/powerhouse-runner-work/*; echo reset'
fi

echo "→ staging Claude for the unprivileged agent identity (/opt/powerhouse/bin)"
# The image installs Claude under /home/boxd, which powerhouse-agent cannot
# traverse. Copy the native binary (or wrapper + node) to a world-readable path.
x sudo sh -c 'set -e; install -d -m 0755 /opt/powerhouse/bin; src=$(readlink -f /usr/local/bin/claude || readlink -f /home/boxd/.local/bin/claude); if head -c 2 "$src" | grep -q "#!"; then node=$(readlink -f /usr/local/bin/node); install -d -m 0755 /opt/powerhouse/node; cp -a "$(dirname "$(dirname "$node")")"/. /opt/powerhouse/node/; chmod -R a+rX /opt/powerhouse/node; ln -sfn /opt/powerhouse/node/bin/node /opt/powerhouse/bin/node; fi; install -m 0755 "$src" /opt/powerhouse/bin/claude; chmod -R a+rX /opt/powerhouse; su -s /bin/sh -c "/opt/powerhouse/bin/claude --version" powerhouse-agent 2>/dev/null || echo "agent user not created yet; verified after install"'

echo "→ installing"
x sudo /home/boxd/powerhouse-cloud/cloud/target/release/powerhouse-runner install

echo "→ probe"
x sudo /usr/local/bin/powerhouse-runner probe

if [[ $MODE != publish ]]; then
  echo "done. Refreshed $VM in place."
  exit 0
fi

echo "→ sweep: no run units, empty store, no reserved runs, clean history and /tmp"
x sudo sh -c 'set -e
systemctl stop "powerhouse-run-*.service" 2>/dev/null || true
units=$(systemctl list-units --all --plain --no-legend "powerhouse-run-*" | wc -l); [ "$units" -eq 0 ] || { echo "run units still present: $units"; exit 1; }
runs=$(/usr/local/bin/powerhouse-runner list | python3 -c "import sys,json; print(len(json.load(sys.stdin).get(\"ok\",[])))"); [ "$runs" -eq 0 ] || { echo "runner store not empty: $runs runs"; exit 1; }
ls /var/lib/powerhouse-runner/results /var/lib/powerhouse-runner/credentials 2>/dev/null | grep -q . && { echo "results or credentials present"; exit 1; } || true
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true
rm -f /root/.bash_history /home/boxd/.bash_history; history -c 2>/dev/null || true
rm -f /home/boxd/powerhouse-cloud-src.tgz
echo "sweep ok"'

echo "→ saving snapshot $SNAPSHOT from $VM"
boxd snapshots save "$VM" "$SNAPSHOT" --json 2>&1 | filter | j
row=$(boxd snapshots list --json 2>&1 | filter | j | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(next((s for s in d if s['name']=='$SNAPSHOT'), {})))")
[[ $row != '{}' ]] || { echo "snapshot $SNAPSHOT not listed after save" >&2; exit 1; }
echo "   $row"

echo "→ removing $VM"
boxd machine remove "$VM" --confirm --json 2>&1 | filter | j

ver=$(echo "$row" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("version",""))')
size=$(echo "$row" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("size",""))')
echo "done. Base snapshot: $SNAPSHOT $ver ($size). Powerhouse creates one VM per run from it (Cloud tab → Run in cloud)."
