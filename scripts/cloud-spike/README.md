# Slice 0 process fixture

This is a credential-free Linux/systemd capability test, not the production
runner. It does not implement cloud acceptance, idempotent submission receipts,
repository checkout, Claude, publication, boot recovery, or idle restoration.
Use only on the dedicated approved spike machines.

Upload this directory with `boxd machine cp -r` to the base, then invoke
`sudo bash /path/to/smoke.sh install`. Installation places root-owned Python
payloads in `/opt/powerhouse-cloud-spike` and a harmless protected canary in
`/var/lib/powerhouse-spike-control`. Fork only after installation finishes and
while no fixture is running.

Run each command through a separate `boxd machine exec` connection in the fork:

```sh
sudo bash /path/to/smoke.sh start detach01 complete
# The start command returns while the fixture is still working.
# Close the submitting connection; wait at least 15 seconds without polling.
sudo bash /path/to/smoke.sh inspect detach01

sudo bash /path/to/smoke.sh start failure01 fail
# Inspect after 15 seconds: nonzero exit status 23 must be retained.
sudo bash /path/to/smoke.sh inspect failure01

sudo bash /path/to/smoke.sh start deadline01 wait
# Inspect after 20 seconds: systemd must record timeout and stop the child too.
sudo bash /path/to/smoke.sh inspect deadline01

sudo bash /path/to/smoke.sh start cancel01 wait
sudo bash /path/to/smoke.sh cancel cancel01
sudo bash /path/to/smoke.sh inspect cancel01
```

Each start reserves an ID on disk before launching. Reusing it refuses execution,
including after ambiguous launch failure; this fixture is deliberately not the
production duplicate-submit protocol. The supervisor's `ExecStopPost` writes an
atomic, fsynced outcome independently of the connection. Its result records
systemd's process outcome, not task success.

Record the following evidence for each run:

- Protected `outcome.json`, ordered `output.jsonl`, and invocation/cgroup identity.
- `runner_state_denied` in the fake agent's output.
- Artifact content for completion and failure cases. The per-run state directory
  is `/var/lib/powerhouse-spike-work-ID` (systemd manages its dynamic ownership).
- Empty/absent recorded cgroup after termination. Also verify that the emitted
  child PID has exited; a still-running child fails the test.
- For the completion case, the submitting command returned before the outcome
  timestamp; reconnecting did not start a second execution.

Network address families are restricted to Unix sockets for this fixture. The
production Claude adapter needs separate verified network and credential policy.
The fake's `wait` mode is CPU-only, but its 15-second timeout alone does **not**
prove safety across platform idle thresholds. Test both effective idle settings
and cloud-owned restoration separately before claiming that capability.

Local syntax checks (they do not prove systemd behavior):

```sh
bash -n scripts/cloud-spike/smoke.sh
python3 -c 'import ast,pathlib; [ast.parse(p.read_text()) for p in pathlib.Path("scripts/cloud-spike").glob("*.py")]'
```
