# Cloud runs on boxd: setup, recovery, retention

This is the operational companion to `docs/boxd-cloud-agents.md` (the brief) and
`docs/boxd-cloud-agents-verification.md` (evidence). It describes what exists on
`feature/boxd-cloud-runs`, how to set it up, and what to do when something goes
wrong.

## What a cloud run is

1. Powerhouse verifies the source is committed **and** on `origin`, records the
   run locally (`~/.powerhouse/cloud-runs.json`, written atomically before any
   remote action), forks the base VM into `ph-<first 8 chars of run id>`,
   disables both idle timers on the fork, probes the runner, uploads the
   manifest by file, and calls `submit` with the manifest digest.
2. The runner (`powerhouse-runner`, `cloud/runner`) stores the run in SQLite,
   launches one transient systemd unit, claims ownership exactly once, checks out
   the exact commit into an agent-owned workspace, runs the agent as the
   unprivileged `powerhouse-agent` user, snapshots the tree with a trusted git
   that never reads the agent's `.git`, runs checks, publishes to
   `powerhouse/cloud/<run id>` only, and records a terminal state.
3. Powerhouse polls `inspect`/`events` every 5 s while a run is live, fetches
   the result once, restores the base's idle policy on the fork, and offers
   **Fetch changes** (verified fetch into a new worktree) and **Cancel**.

States: `accepted → preparing → running → validating → publishing → completed`,
plus `blocked`, `failed`, `cancelled`, `interrupted`. `completed` is shown as
*Ready for review*; nothing is merged or deployed.

## Requirements

| Component | Version verified |
| --- | --- |
| boxd external CLI | 0.2.9 (0.2.17 available; same command surface) |
| Base VM image | `computer:0.1.50` — Ubuntu 24.04, systemd 255, cgroup v2, x86_64 |
| Runner build toolchain on the base | rustup stable (1.98.1), build-essential |
| Claude Code on the base | 2.1.263 preinstalled |
| Desktop | macOS Tauri app from this branch; `pnpm build`, `cargo test` |

## Set up a base VM

Create once (isolated, private) and keep it idle; it is a fork source, never a
workspace:

```sh
boxd machine new powerhouse-cloud-base --isolated --auto-suspend-timeout 300 --auto-hibernate-timeout 900 --json
scripts/cloud-base-setup.sh powerhouse-cloud-base --reset-store
```

The script uploads `cloud/`, builds the runner on the VM, installs it to
`/usr/local/bin/powerhouse-runner`, creates the `powerhouse-agent` system user,
the root-only store `/var/lib/powerhouse-runner`, and a boot-time reconcile
unit. Re-run it to upgrade the runner. `--reset-store` wipes old runs so forks
start clean. **Fork only an idle base**: forks copy running processes and the
runner store.

If a fresh isolated machine reports `boot: timeout` and stays `starting`, do
not create another one. Wait, then `boxd machine stop` / `start` the same
machine (see the verification doc for the 2026-09-18 incident and diagnosis).

### Credentials (not yet provisioned — needs your approval)

The runner reads `/etc/powerhouse-runner/credentials.env` (root, 0600):

- `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`): passed only into the
  agent's environment.
- `GIT_PUBLISH_TOKEN`: used only by the trusted publisher for HTTPS remotes,
  via an in-memory `http.extraHeader`; never visible to the agent.

boxd injects your org secrets into `exec` sessions on the base (names seen:
`CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_PAT_TOKEN`). To copy exactly those two into
the runner's file, run `scripts/cloud-base-setup.sh <base> --credentials-from-env`.
Scope caveat: a GitHub PAT is not restricted to one branch by the platform;
the runner enforces the `powerhouse/cloud/<run id>` destination in code and
refuses to force-push, but the token itself could do more. Prefer a
fine-grained PAT limited to the target repository with contents:write.

Until credentials are provisioned, Powerhouse refuses Claude runs on that base
with an actionable error. The fake agent (`provider: fake`) needs none and is
used by the tests.

## Idle policy and cost

boxd's auto-suspend/hibernate timers observe inbound network only, so a fork is
created with both set to `0` and Powerhouse restores the base's values when it
next syncs a finished run. **Limitation:** an isolated VM has no in-VM boxd CLI
and the runner has no boxd credential, so if the laptop never reconnects the
fork stays running until you restore the policy or stop it by hand:

```sh
boxd machine config set ph-xxxxxxxx auto-suspend.timeout 300
boxd machine config set ph-xxxxxxxx auto-hibernate.timeout 900
# or
boxd machine stop ph-xxxxxxxx
```

Cloud-owned restoration needs an org-fenced API key (`boxd auth keys create
--org <org> --expires-in-secs …`) stored in the runner's root-only state and a
gRPC call at run end. This is a deferred, approval-gated increment.

## Retention and cleanup

Nothing is deleted automatically. Per run you keep: the fork VM (`ph-*`), the
remote branch `powerhouse/cloud/<run id>`, and on the fork
`/var/lib/powerhouse-runner/results/<run id>/` (result.json, diff.patch,
agent.jsonl, check logs) plus the workspace `/var/lib/powerhouse-runner-work/<run id>`.

Cleanup, when you are done reviewing:

```sh
boxd machine remove ph-xxxxxxxx --confirm
git push origin --delete powerhouse/cloud/<run id>
```

"Forget" in the Cloud tab removes only the local record and refuses while a run
may still be active (unless you confirm).

## Recovery

| Symptom | What happened | What to do |
| --- | --- | --- |
| Card says *Preparing cloud environment* after restart | Submission died before a receipt. | Powerhouse marks it *Not submitted* if no VM was created; if a `ph-*` VM exists it asks the runner by run id and either recovers the receipt or marks it *Not submitted*. The VM is retained. |
| *Submission outcome unknown* | `submit` did not answer. | Each sync calls `inspect <run id>`; a found run becomes accepted, a missing one becomes *Not submitted*. Nothing is re-sent. |
| *Interrupted* | Executor lost (VM reboot, `SIGKILL`, supervisor gone). | Partial work stays in the workspace on the fork; the run is never rerun automatically. Start a new run if needed. |
| *Blocked* | Provider hit a turn/budget limit or asked for input. | Read the activity; raise limits or clarify the task; start a new run. |
| *Failed* at `validating` | A check failed. The result is still published for review. | Fetch changes and fix locally, or start a new run. |
| *Failed* at `publishing` | No/insufficient publication credential, or the branch already exists at another revision. | Provision credentials or delete the stale branch; the local result on the fork is intact (`powerhouse-runner result <id>`). |
| Offline banner | boxd or network unreachable. | Cached state stays; sync retries every 30 s. |
| Fork stuck `starting` | Platform provisioning issue. | `boxd machine stop <vm>` then `start`; never create a duplicate. |

Manual inspection on a fork:

```sh
boxd machine exec ph-xxxxxxxx -- sudo powerhouse-runner list
boxd machine exec ph-xxxxxxxx -- sudo powerhouse-runner inspect <run id>
boxd machine exec ph-xxxxxxxx -- sudo powerhouse-runner events <run id> --after 0 --limit 200
boxd machine exec ph-xxxxxxxx -- sudo powerhouse-runner result <run id>
```

## Tests

```sh
# contracts + runner unit tests (macOS or Linux)
cargo test --manifest-path cloud/Cargo.toml
# desktop backend incl. fake-transport submission tests
cargo test --manifest-path src-tauri/Cargo.toml
# frontend
pnpm test && pnpm build
# runner integration on the base VM (Linux, root, real systemd, fake agent, local git daemon)
boxd machine exec powerhouse-cloud-base --timeout 900 -- sudo bash /home/boxd/powerhouse-cloud/cloud/runner/tests/vm-integration.sh
# real-cloud desktop e2e with the fake agent (forks the base)
POWERHOUSE_CLOUD_E2E_BASE=powerhouse-cloud-base POWERHOUSE_CLOUD_E2E_SOURCE=<repo whose origin the fork can fetch> \
  cargo test --manifest-path src-tauri/Cargo.toml cloud_e2e -- --ignored --nocapture
```

## Not in this milestone

Live process migration, dirty-tree uploads, other providers, follow-up
conversations, approval flows, a cloud scheduler, remote file editing,
automatic merging or deployment, automatic VM deletion, a public runner
endpoint. See section 12 of the brief.
