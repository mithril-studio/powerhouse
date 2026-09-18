#!/usr/bin/env bash
# Linux/systemd only. A capability fixture, not the production run protocol.
set -euo pipefail

control=/var/lib/powerhouse-spike-control
payload=/opt/powerhouse-cloud-spike/fake-agent.py

die() { echo "$*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || die 'This spike requires Linux.'
[[ $EUID == 0 ]] || die 'Run the trusted spike driver as root.'
command -v systemd-run >/dev/null
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || die 'cgroup v2 is required.'

action=${1:-}
if [[ $action == install ]]; then
  # Upload the reviewed files, then run install before forking the idle base.
  source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
  [[ -f "$source_dir/fake-agent.py" ]] || die 'Missing fake-agent.py.'
  install -d -o root -g root -m 0755 /opt/powerhouse-cloud-spike
  install -o root -g root -m 0644 "$source_dir/fake-agent.py" "$payload"
  install -o root -g root -m 0644 "$source_dir/record-outcome.py" /opt/powerhouse-cloud-spike/record-outcome.py
  install -d -o root -g root -m 0700 "$control"
  printf 'not-a-credential\n' > "$control/canary"
  chmod 0600 "$control/canary"
  exit 0
fi

run_id=${2:-}
[[ $run_id =~ ^[a-z0-9]{1,32}$ ]] || die 'Run ID must be 1–32 lowercase alphanumeric characters.'
unit=powerhouse-spike-$run_id.service
record=$control/$run_id

case "$action" in
  start)
    mode=${3:-complete}
    [[ $mode == complete || $mode == fail || $mode == wait ]] || die 'Invalid fixture mode.'
    [[ -f $payload && -f $control/canary ]] || die 'Install the fixture first.'
    # Atomic reservation: an ambiguous start can never silently run again.
    mkdir -m 0700 "$record" || die 'Run ID already reserved; inspect it, do not retry execution.'
    printf '%s\n' "$mode" > "$record/intent"
    sync
    deadline=30
    [[ $mode != wait ]] || deadline=15
    systemd-run --unit="$unit" --service-type=exec \
      --property=DynamicUser=yes \
      --property=NoNewPrivileges=yes \
      --property=CapabilityBoundingSet= \
      --property=ProtectSystem=strict \
      --property=ProtectHome=yes \
      --property=PrivateTmp=yes \
      --property=PrivateDevices=yes \
      --property=ProtectControlGroups=yes \
      --property=ProtectKernelTunables=yes \
      --property=ProtectKernelModules=yes \
      --property=RestrictSUIDSGID=yes \
      --property=RestrictAddressFamilies=AF_UNIX \
      --property=KillMode=control-group \
      --property=TimeoutStopSec=2 \
      --property=RuntimeMaxSec="$deadline" \
      --property=Restart=no \
      --property=ReadWritePaths="$record" \
      --property="ExecStopPost=+/usr/bin/python3 /opt/powerhouse-cloud-spike/record-outcome.py $run_id" \
      --property=StateDirectory="powerhouse-spike-work-$run_id" \
      --property=WorkingDirectory="/var/lib/powerhouse-spike-work-$run_id" \
      --property=StandardOutput="append:$record/output.jsonl" \
      --property=StandardError="append:$record/stderr.log" \
      /usr/bin/python3 "$payload" "$mode"
    # Persist systemd's invocation identity before returning to the connection.
    systemctl show "$unit" -p InvocationID -p ControlGroup > "$record/invocation"
    sync
    cat "$record/invocation"
    ;;
  inspect)
    [[ -d $record ]] || die 'Unknown run ID.'
    cat "$record/intent"
    if [[ -f $record/invocation ]]; then cat "$record/invocation"; fi
    if [[ -f $record/outcome.json ]]; then cat "$record/outcome.json"; fi
    # A completed transient unit can be unloaded. Absence is not success.
    systemctl show "$unit" -p LoadState -p ActiveState -p SubState \
      -p Result -p ExecMainStatus -p ControlGroup -p InvocationID
    if [[ -f $record/output.jsonl ]]; then head -c 65536 "$record/output.jsonl"; fi
    if [[ -f $record/stderr.log ]]; then head -c 65536 "$record/stderr.log"; fi
    ;;
  cancel)
    [[ -d $record ]] || die 'Unknown run ID.'
    systemctl stop "$unit"
    systemctl show "$unit" -p ActiveState -p SubState -p Result -p ControlGroup
    ;;
  *) die 'Usage: smoke.sh install | start ID [complete|fail|wait] | inspect ID | cancel ID' ;;
esac
