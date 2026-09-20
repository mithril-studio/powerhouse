#!/usr/bin/env bash
# Prepare (or refresh) a boxd base VM for Powerhouse cloud runs.
#
#   scripts/cloud-base-setup.sh <base-vm> [--reset-store] [--credentials-from-env]
#
# What it does, from your laptop with the external `boxd` CLI:
#   1. uploads cloud/ (protocol + runner sources) to the VM
#   2. installs a Rust toolchain there if missing and builds the runner
#   3. runs `powerhouse-runner install` (agent user, root-only store, boot reconcile unit)
#   4. optionally wipes the runner store so the base is a clean fork source
#   5. optionally copies the boxd-injected CLAUDE_CODE_OAUTH_TOKEN / GITHUB_PAT_TOKEN
#      from the exec session into the runner's root-only credentials file
#      (/etc/powerhouse-runner/credentials.env). Nothing from your laptop is copied.
#
# It never creates, deletes, or reconfigures machines. Forks are made per run.
set -euo pipefail

VM=${1:-}
[[ -n $VM ]] || { echo "usage: $0 <base-vm> [--reset-store] [--credentials-from-env]" >&2; exit 2; }
shift
RESET=0; CREDS=0
for a in "$@"; do
  case $a in
    --reset-store) RESET=1;;
    --credentials-from-env) CREDS=1;;
    *) echo "unknown flag $a" >&2; exit 2;;
  esac
done

here=$(cd "$(dirname "$0")/.." && pwd)
tgz=$(mktemp -t powerhouse-cloud.XXXXXX)
trap 'rm -f "$tgz"' EXIT
COPYFILE_DISABLE=1 tar czf "$tgz" -C "$here" --exclude=target --exclude=.DS_Store cloud

filter() { grep -v -e 'new version' -e 'install.sh' -e 'client-utilities' || true; }
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

echo "→ starting $VM if needed"
boxd machine start "$VM" --json 2>&1 | filter >/dev/null || true
for _ in $(seq 1 24); do
  st=$(boxd machine get "$VM" --json 2>&1 | filter | python3 -c 'import sys,json; r=sys.stdin.read(); print(json.loads(r[r.index("{"):]).get("status"))' 2>/dev/null || echo unknown)
  [[ $st == running || $st == standby ]] && break
  sleep 5
done

echo "→ uploading runner sources"
boxd machine cp "$tgz" "$VM:/home/boxd/powerhouse-cloud-src.tgz" --json 2>&1 | filter >/dev/null
x sh -c 'rm -rf ~/powerhouse-cloud && mkdir -p ~/powerhouse-cloud && tar xzf ~/powerhouse-cloud-src.tgz -C ~/powerhouse-cloud 2>/dev/null && ls ~/powerhouse-cloud/cloud'

echo "→ ensuring a Rust toolchain and build tools"
x sh -c 'command -v ~/.cargo/bin/cargo >/dev/null || (curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh && sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable >/tmp/rustup.log 2>&1); ~/.cargo/bin/cargo --version; command -v gcc >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq build-essential >/dev/null); command -v jq >/dev/null || sudo apt-get install -y -qq jq >/dev/null; gcc --version | head -1'

echo "→ building the runner (release)"
x sh -c 'cd ~/powerhouse-cloud/cloud && ~/.cargo/bin/cargo build --release 2>&1 | tail -2'

if [[ $RESET == 1 ]]; then
  echo "→ resetting the runner store (clean fork source)"
  x sudo sh -c 'systemctl stop "powerhouse-run-*.service" 2>/dev/null; rm -rf /var/lib/powerhouse-runner/runner.db* /var/lib/powerhouse-runner/results /var/lib/powerhouse-runner/publish /var/lib/powerhouse-runner-work/*; echo reset'
fi

echo "→ installing"
if [[ $CREDS == 1 ]]; then
  x sudo --preserve-env=CLAUDE_CODE_OAUTH_TOKEN,GITHUB_PAT_TOKEN /home/boxd/powerhouse-cloud/cloud/target/release/powerhouse-runner install --credentials-from-env
else
  x sudo /home/boxd/powerhouse-cloud/cloud/target/release/powerhouse-runner install
fi

echo "→ probe"
x sudo /usr/local/bin/powerhouse-runner probe
echo "done. Fork this base per run from Powerhouse (Cloud tab → Run in cloud)."
