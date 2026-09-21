# Cloud runs on boxd: setup, recovery, retention

This is the operational companion to `docs/boxd-cloud-agents.md` (the brief) and
`docs/boxd-cloud-agents-verification.md` (evidence). It describes what exists on
`feature/boxd-cloud-runs`, how to set it up, and what to do when something goes
wrong.

## What a cloud run is

1. Powerhouse verifies the source is committed **and** on `origin`, looks the
   base snapshot up (name, current version), records the run locally
   (`~/.powerhouse/cloud-runs.json`, written atomically before any remote
   action), creates the isolated task VM `ph-<run8>` from the snapshot with both
   idle timers at 0 (refusing if the org already has `ceiling` machines, default
   18 of 20), checks that the machine was built from the recorded snapshot
   version, probes the runner, uploads the manifest and the run's credentials by
   file, and calls `submit` with the manifest digest.
2. The runner (`powerhouse-runner`, `cloud/runner`) stores the run in SQLite,
   launches one transient systemd unit, claims ownership exactly once, checks out
   the exact commit into an agent-owned workspace, runs the agent as the
   unprivileged `powerhouse-agent` user, snapshots the tree with a trusted git
   that never reads the agent's `.git`, runs checks, publishes to
   `powerhouse/cloud/<run id>` only, and records a terminal state.
3. Powerhouse polls `inspect`/`events` every 5 s while a run is live, fetches
   the result and the diff once, and offers **Fetch changes** (verified fetch
   into a new worktree) and **Cancel**. A `completed` run's VM is destroyed as
   soon as the local cache is complete and the remote branch verified; any
   other outcome keeps the VM for an hour, then parks it as a snapshot (see
   *Machine lifecycle*).

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

## Publish the base snapshot

The base is a boxd **snapshot**, not a machine, so it holds no slot. Publish it
once and re-publish whenever the runner changes:

```sh
scripts/cloud-base-setup.sh --publish-snapshot powerhouse-base
```

The script creates an isolated build VM `ph-base-build` from scratch, uploads
`cloud/`, builds the runner there, stages Claude for the agent identity, runs
`powerhouse-runner install` (agent user, root-only store, boot reconcile unit),
sweeps (no run units, empty store, no results or credentials, clean history and
`/tmp`), saves the snapshot, prints the version `snapshots list` reports, and
removes the build VM. Re-saving the same name bumps the version (`v1`, `v2`, …);
the form shows the current version and pins it into the run. About eight
minutes end to end, dominated by the runner build.

Settings → Cloud → *Base snapshot* names the snapshot (default
`powerhouse-base`). The refresh mode, `scripts/cloud-base-setup.sh <vm>
[--reset-store]`, still upgrades a running VM in place for debugging.

If a fresh isolated machine reports `boot: timeout` and stays `starting`, do
not create another one. Wait, then `boxd machine stop` / `start` the same
machine (see the verification doc for the 2026-09-18 incident and diagnosis).

### Credentials: Powerhouse's own, per run, destroyed at the end

Decision (2026-09-21): Powerhouse stays single-user for now; no separate boxd
org. Ambient boxd org secrets are being removed by hand; Powerhouse machines are
recognisable by name (`ph-<run8>` machines, `ph-<run8>-park` snapshots, base
snapshot `powerhouse-base`).

How a run gets its credentials:

1. You store secrets once in the cloud form. They live in the macOS Keychain
   under service `Powerhouse`. Claude: `claude_oauth_token`, the token from
   `claude setup-token` on the account you want the cloud agent to bill.
   GitHub: fine-grained personal access tokens with *Contents: read and write*
   (needed to fetch a private repo and to push the run branch). Because
   Powerhouse runs tasks on any repository you develop, and a fine-grained
   token covers exactly one resource owner, store one token per owner under
   `github_token:<owner>` with access to all that owner's repositories. To
   narrow a sensitive repository, add `github_token:<owner>/<repo>`; a plain
   `github_token` is the last fallback. Powerhouse picks the most specific
   entry for a run's remote and the form shows which one applies. Nothing is
   read from boxd, from the base VM, or from your other tools.
   Command-line equivalent:

   ```sh
   security add-generic-password -s Powerhouse -a github_token:mithril-studio -w '<github_pat_…>' -U
   security add-generic-password -s Powerhouse -a claude_oauth_token -w '<token from claude setup-token>' -U
   ```
2. On submit, Powerhouse renders a `KEY=VALUE` file with only what that run
   needs (`CLAUDE_CODE_OAUTH_TOKEN` for Claude runs, `GIT_PUBLISH_TOKEN` for
   HTTPS remotes), uploads it next to the manifest, and passes it to
   `powerhouse-runner submit --credentials`. The runner moves it into
   root-only storage (`/var/lib/powerhouse-runner/credentials/<run id>.env`,
   mode 0600) and shreds the drop location. The laptop copy is shredded
   immediately after upload.
3. During the run the model token goes only into the agent's environment; the
   Git token goes only into the trusted publisher's environment (an in-memory
   `http.extraHeader`). The agent never sees the Git token; the fake agent's
   isolation probe asserts this on every run.
4. At any terminal state (completed, failed, blocked, cancelled, interrupted,
   launch failure, boot reconcile) the runner overwrites and deletes the file.
   `powerhouse-runner probe` reports `pending_credentials` so you can see when
   a live run still holds one.

The base snapshot never contains a secret, so task VMs inherit none. If the exec
session on a machine still carries boxd org secrets, the probe lists their
names (`ambient_secret_names`) and the form shows a warning; runs never receive
them because the runner and the agent do not inherit the exec environment.

Scope caveat: a GitHub token is not branch-scoped by GitHub. The runner enforces
the `powerhouse/cloud/<run id>` destination in code and never force-pushes,
but the token itself could do whatever its permissions allow, so keep it
fine-grained and repository-scoped.

### Context the agent receives

The manifest carries the task, acceptance criteria, checks, permission mode,
tool allowlist, deadline and exact commit, plus a **brief**: markdown written by
Powerhouse into `.powerhouse/cloud-task.md` in the workspace (excluded from the
published tree). The cloud form prefills it from the newest
`.powerhouse/handoff-*.md` in the source worktree, the plan artifact Powerhouse
already produces, and you can edit it before submitting. The prompt tells the
agent to read that file first.

## Machine lifecycle

Every run owns one machine, `ph-<run8>`, created from the base snapshot with
both idle timers at `0` (boxd's timers observe inbound network only; CPU-only
checks must not be frozen). The run card shows the machine state next to the
run state:

| Machine state | Meaning | boxd holds |
| --- | --- | --- |
| VM starting | `machine new --from-snapshot` issued | 1 slot |
| VM active | run live | 1 slot |
| VM active · release pending | run completed; waiting for the cache-and-verify gate (reason shown) | 1 slot |
| VM held · parks in N min | run ended failed/blocked/cancelled/interrupted; workspace inspectable | 1 slot |
| Parked (snapshot 8.8G) | VM snapshotted to `ph-<run8>-park` and destroyed | 1 snapshot |
| Restoring VM | new VM being created from the park snapshot | 1 slot + 1 snapshot |
| Released | nothing held | none |
| VM … not managed | record from before the lifecycle (fork era); clean up by hand | — |

Rules the desktop enforces:

- A **completed** run releases its VM once the result manifest, every event
  page and `diff.patch` are cached under `~/.powerhouse/cloud-runs/<run id>/`
  and `git ls-remote origin` shows the recorded result SHA on
  `powerhouse/cloud/<run id>`. Until then the card says *release pending* with
  the reason; **Fetch changes** verifies the remote and releases too.
- Any other terminal state **holds** the VM for one hour, then the lifecycle
  tick (once a minute while the app is open) **parks** it: `snapshots save
  ph-<run8> ph-<run8>-park`, wait for `ready`, `machine remove`. **Restore**
  creates a fresh `ph-<run8>` from the park snapshot and holds it again;
  **Discard workspace** removes the VM and the snapshot. **Forget** refuses while
  either exists and offers Discard first.
- Never remove a VM the runner still reports live (cancel first, wait for
  `cancelled`). Destructive boxd calls only accept `ph-…` names.
- Intent is persisted before each boxd call; a lost acknowledgement is
  reconciled by name on the next sync or tick (`machine get ph-<run8>`,
  `snapshots list`).
- Submission refuses when the org already has `ceiling` machines (default 18 of
  20, Settings → Cloud) and when the base snapshot's version changed between
  opening the form and submitting; a machine built from a different version
  than recorded is removed and the run refused.

**Limitation:** timers run in the desktop. With the app closed a held VM stays
up until you reopen it (or park/remove it by hand). The always-on Powerhouse
instance takes this loop over later.

## Retention and cost

Per run you keep the remote branch `powerhouse/cloud/<run id>` and the local
cache (`~/.powerhouse/cloud-runs.json`, `~/.powerhouse/cloud-runs/<run id>/diff.patch`).
A parked run also keeps its snapshot, roughly the size of the base (8–9 GB)
until you Restore-and-discard or Discard it. The Cloud tab footer lists every
Powerhouse machine and snapshot against the org's 20 slots.

Manual cleanup, if ever needed:

```sh
boxd machine remove ph-<run8> --confirm
boxd snapshots remove ph-<run8>-park --confirm
git push origin --delete powerhouse/cloud/<run id>
```

Runs recorded before this lifecycle (`powerhouse-<branch>` machines) show as
*not managed*; remove those machines by hand.

## Recovery

| Symptom | What happened | What to do |
| --- | --- | --- |
| Card says *Preparing cloud environment* after restart | Submission died before a receipt. | Powerhouse asks the runner on `ph-<run8>` by run id and either recovers the receipt or marks it *Not submitted* and removes the VM (nothing of value is on a machine that never accepted a run). |
| *Submission outcome unknown* | `submit` did not answer. | Each sync calls `inspect <run id>`; a found run becomes accepted, a missing one becomes *Not submitted*. Nothing is re-sent. |
| *Interrupted* | Executor lost (VM reboot, `SIGKILL`, supervisor gone). | Partial work stays in the workspace; the VM is held for an hour, then parked. Restore to inspect; the run is never rerun automatically. |
| *Blocked* | Provider hit a turn/budget limit or asked for input. | Read the activity; raise limits or clarify the task; start a new run. |
| *Failed* at `validating` | A check failed. The result is still published for review. | Fetch changes and fix locally, or start a new run. |
| *Failed* at `publishing` | No/insufficient publication credential, or the branch already exists at another revision. | Provision credentials or delete the stale branch; the result is intact on the held VM (`powerhouse-runner result <id>`) and survives parking. |
| *VM active · release pending* for long | The cache-and-verify gate is not satisfied (offline, remote branch missing, events still paging). | The reason is on the card; the tick retries every minute. Fetch changes verifies and releases; Discard workspace releases without verifying. |
| Park or Discard says *still live* | The runner reports an active unit. | Cancel the run, wait for `cancelled`, retry. |
| Restore fails | Machine ceiling reached or platform issue. | Free a slot or wait; the park snapshot is intact and the run goes back to *Parked*. |
| Offline banner | boxd or network unreachable. | Cached state stays; sync retries every 30 s. |
| Machine stuck `starting` | Platform provisioning issue. | `boxd machine stop <vm>` then `start`; never create a duplicate — Powerhouse reuses `ph-<run8>` by name. |

Manual inspection on a held or restored VM:

```sh
boxd machine exec ph-<run8> -- sudo powerhouse-runner list
boxd machine exec ph-<run8> -- sudo powerhouse-runner inspect <run id>
boxd machine exec ph-<run8> -- sudo powerhouse-runner events <run id> --after 0 --limit 200
boxd machine exec ph-<run8> -- sudo powerhouse-runner result <run id>
```

## Tests

```sh
# contracts + runner unit tests (macOS or Linux)
cargo test --manifest-path cloud/Cargo.toml
# desktop backend incl. fake-transport submission tests
cargo test --manifest-path src-tauri/Cargo.toml
# frontend
pnpm test && pnpm build
# runner integration on a VM created from the base snapshot (Linux, root, real systemd, fake agent, local git daemon)
boxd machine new ph-runner-test --from-snapshot powerhouse-base --isolated --auto-suspend-timeout 0 --auto-hibernate-timeout 0 --json
boxd machine exec ph-runner-test --timeout 900 -- sudo bash /home/boxd/powerhouse-cloud/cloud/runner/tests/vm-integration.sh
boxd machine remove ph-runner-test --confirm
# real-cloud desktop e2e with the fake agent: creates ph-<run8> from the snapshot, ends with the VM released
POWERHOUSE_CLOUD_E2E_SNAPSHOT=powerhouse-base POWERHOUSE_CLOUD_E2E_SOURCE=<repo whose origin the VM can fetch and push> \
  cargo test --manifest-path src-tauri/Cargo.toml cloud_e2e -- --ignored --nocapture
# hold → park → restore → discard, with a 30 s hold instead of an hour
POWERHOUSE_CLOUD_E2E_SCRIPT=fail POWERHOUSE_CLOUD_HOLD_SECS=30 POWERHOUSE_CLOUD_E2E_SNAPSHOT=powerhouse-base POWERHOUSE_CLOUD_E2E_SOURCE=<repo> \
  cargo test --manifest-path src-tauri/Cargo.toml cloud_e2e -- --ignored --nocapture
```

## Not in this milestone

Live process migration, dirty-tree uploads, other providers, follow-up
conversations, approval flows, a cloud scheduler, remote file editing,
automatic merging or deployment, a public runner endpoint, follow-up runs on a
restored workspace, and an always-on owner for the hold/park timers. See
section 12 of the brief and the lifecycle plan.
