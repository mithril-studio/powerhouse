# Workflow script jobs: execution foundation

Implemented 2026-09-23. This is a runner capability, not yet a workflow service or desktop feature. Existing agent submissions remain protocol v2. A script-only submission requires v3; an old runner rejects it rather than silently treating it as agent work.

## Contract

Use the existing `powerhouse-runner` commands: `probe`, `digest`, `submit`, `inspect`, `events`, `result`, `cancel`. Require `probe.ok.script_protocol_version == 3` before submitting scripts. A new base snapshot must contain the updated runner; this change does not upgrade deployed VMs.

Start from [the script manifest fixture](../cloud/protocol/tests/fixtures/script-v3.json). Replace the run UUID, source commit and snapshot identity with the actual pinned values. Script requests require:

- `protocol_version: 3`, `script: { command: "..." }`, no `agent`.
- Empty `output_branch`, no agent `checks` (empty or omitted).
- Existing task, source, workspace and deadline fields. Commands are nonempty Bash source, at most 64 KiB, with no NULs.
- One stable run UUID per logical node attempt. A transport retry repeats the same manifest/UUID. An intentional rerun uses a new UUID. Same UUID with changed manifest content is a conflict.

The caller submits a credential-free manifest file and optional credentials file using the existing `--credentials` transport. Project environment values use `ENV.NAME=value`; repository fetch authentication uses the existing `GIT_PUBLISH_TOKEN` credential name even though script jobs never publish. Do not put secrets into script source, task text or graph JSON. Secrets are not part of the manifest digest and must remain immutable across retries of one logical attempt.

## Execution and results

The trusted supervisor prepares the exact source commit, then runs `/bin/bash -c` as the existing unprivileged `powerhouse-agent` user in the checkout. Standard input is closed. It clears ambient environment variables, supplies project variables and fixed runtime variables, and supplies no model or Git token to the script. Explicit project variables remain available to the script by design. As with agent jobs, use isolated, clean base snapshots.

A script job does not invoke an agent, run a second validation phase, create a result commit or push a branch. Exit 0 means `completed`; nonzero/signal termination means `failed`. Cancellation means `cancelled`; deadline expiry means `failed` with a deadline error; supervisor termination means `interrupted`. No process is blindly restarted. Workspace preparation and cgroup cleanup reuse the existing runner.

Events use the existing ordered cursor API:

- `script.started`: process ID, emitted only after successful spawn.
- `script.output`: `{ offset, text }`, where offset counts retained UTF-8 bytes across combined stdout/stderr. Ordering across the two streams is observed read order, not a total ordering of writes.
- `script.exited`: exit code, stop reason, truncation and retained byte count.

`result.script` contains `exit_code`, `output_tail`, `output_truncated`, `log_bytes`. The result also reports `published: false`, no result SHA, and an empty output branch. Existing v2 agent results omit `script`.

Retain at most 1 MiB of combined output per job and a 16 KiB result tail. Retained output is saved in private `results/<run_id>/script.log` and durable `script.output` events; excess output is drained and discarded. Literal project environment values are redacted before persistence, including values split across reads. This is not protection against deliberately encoded/transformed secret exfiltration. UTF-8 split across reads is preserved; invalid bytes are replaced. This bounded foundation does **not** upload full logs or artifacts to object storage yet.

On cancellation the runner terminates the process group; systemd/cgroup cleanup also reaps descendants which detach. A terminal database row may precede completion of that final unit cleanup: a controller must wait for `inspect.unit_active == false` as well as terminal state before releasing the VM. Do not translate an unknown supervisor state into confirmed termination.

## Verification and remaining work

Local automated coverage includes protocol validation, exact legacy v2 JSON/digest compatibility, real subprocess output/exit behavior, byte caps, redaction, UTF-8 boundaries, cancellation, deadlines, detached pipe handling and SQLite reopen/idempotency. The full application verification suite remains green.

`cloud/runner/tests/vm-integration.sh` now includes script success/isolation, pinned checkout, no publication, duplicate submission, failure and detached-child cancellation. It requires root, Linux/systemd and a **dedicated disposable test VM**; it changes its test repository and runner state. It has not been run for this increment. Local macOS tests do not prove that systemd integration.

Next: run Linux acceptance and publish a clean snapshot, then implement the always-on authenticated DBOS coordinator described in [the workflows plan](workflows-plan.md). VM provisioning, leases, artifact upload and cleanup must be owned by that service, not a desktop polling loop. No DBOS dependency, server, graph editor, SSE endpoint or automatic trigger is included here.
