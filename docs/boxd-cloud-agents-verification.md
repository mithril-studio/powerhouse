# Cloud agents: execution evidence

## Status

2026-09-20: slices 0–3 and 5 are implemented and verified with the fake agent
against real boxd machines; slice 4 (headless Claude) and the laptop-off
acceptance test are **implemented but not cloud-verified** because no
credential has been provisioned into the runner (approval-gated, see the
runbook). Everything lives on `feature/boxd-cloud-runs`. The 2026-09-18 boot
failure is diagnosed below; it was platform-side and never involved Powerhouse
code. Operational guidance: `docs/boxd-cloud-agents-runbook.md`.

### Credential model (2026-09-21)

Decisions: Powerhouse stays single-user; no separate boxd org; ambient boxd org
secrets are removed by hand; Powerhouse machines are named `powerhouse-<branch>`.
Implemented: credentials come only from the macOS Keychain (`Powerhouse` /
`claude_oauth_token`, `github_token`), are rendered per run with only what the
run needs, uploaded next to the manifest, taken into root-only custody by
`submit --credentials`, delivered separately (model token → agent env, Git
token → trusted publisher env), and shredded at every terminal state. The base
never holds a secret. Evidence on the base (Linux suite, 69/69): drop location
shredded, custody file `600:root` while live, agent saw the model token and not
the Git token, brief present and excluded from the published tree, token value
absent from events, file destroyed after completion and after cancel, empty
credential files rejected. The GitHub token pasted in chat on 2026-09-21 was
rejected by GitHub (401) and was **not** stored anywhere; a valid fine-grained
token has to be entered in the cloud form.

Second desktop e2e (2026-09-21 10:18 UTC): run
`931241ff-84f2-40ba-b5c0-522785b5de46` on `powerhouse-main`
(`16b7f280-75cf-4413-bb95-5f3b7b14c95a`, fork of the base), accepted after 82 s,
recovered by id from a fresh store, completed with result `625b818b…`, brief
present at `.powerhouse/cloud-task.md` in the workspace, `pending_credentials`
0, idle policy restored to 300/900 s. The earlier evidence fork `ph-d3408a6f`
was destroyed to keep the two-machine footprint.

### Slice evidence (2026-09-20)

| Slice | Evidence |
| --- | --- |
| 1 Contracts & durable identity | `cloud/protocol` (5 tests: digest stability, validation, state ranks, envelope) and `cloud/runner` store (7 tests: idempotent submit, digest conflict, single claim, terminal-wins-once, cursor paging, payload bounds, cancel-once). Desktop store tests: stale snapshots never regress, event dedupe/contiguous cursor, atomic file round-trip. Frontend test: a pre-cloud `powerhouse.json` hydrates with repos, chats, workflow and merge history intact and no cloud fields added. |
| 2 Runner with fake agent | `cloud/runner/tests/vm-integration.sh` on `powerhouse-cloud-base` (Linux, root, real systemd + cgroup v2, local `git daemon` as remote): **57/57 checks** across 17 scenarios — completion+publication, duplicate and concurrent submits (one claim), no checks configured, failing check (published, failed at validating, skip), check that mutates the tree (pre-check tree published, flagged), agent exit 23 with partial work kept, blocked (max turns), prose-only "success" rejected, unchanged result (sha == source, published), cancel of a CPU-only hang (children gone, second cancel harmless), 60 s deadline, executor SIGKILL → interrupted with one claim, boot reconcile of an orphan row, 30 k-line output bounded with `output.truncated`, malformed manifests/ids/digest/foreign branch rejected, agent escape attempt denied and runner state unreadable (uid 997). |
| 3 boxd provisioning & transport | Desktop backend e2e (`cargo test cloud_e2e -- --ignored`) with the real CLI: forked the base into `ph-d3408a6f` (`851a1946-ee26-41fc-9dd3-c0574c3d72d3`), disabled idle timers, probed, uploaded the manifest, received a digest-matching receipt after 73 s; a **fresh store instance** then recovered run `d3408a6f-9a81-42ff-bbf1-eaa2a84b9da7` by id, followed it to `completed` (result `06dda8ac…`, branch `powerhouse/cloud/<id>` present on the remote, check passed, one `run.claimed`), and restored 300/900 s idle policy on the fork (verified with `boxd machine get`). Fake-transport unit tests cover dirty/unpushed rejection before any cloud call, persistence before each side effect, missing-credential refusal with VM retained, lost fork ack → reuse, sync regression guard and single idle restore, transport errors keeping cache, forget refusing active runs. |
| 4 Claude, validation, publication | Adapter, prompt, stream-json classification (`error_max_turns`/budget → blocked, exit 0 without result → failed, denials → concerns), trusted-git snapshot/commit/publish with HTTPS token via env-only `http.extraHeader`, idempotent publish (existing identical ref = success, different ref = refuse) are implemented and unit-tested. **No real Claude call was made**; credentials are not provisioned. |
| 5 Cloud-run view & import | Cloud tab, run cards, form with source verification and base probe, Cancel/Fetch changes/Forget, startup reconciliation (`startCloudSync`), 5 s polling of live runs only, offline banner with last-confirmed time. `cloud_import` fetches the run branch, refuses a revision mismatch, and creates a new worktree via the existing git flow. Not exercised end-to-end in the running app during this session (backend verified via e2e test; UI via type-check, build, and presentation tests). |
| 6 Failure matrix & handoff | See the matrix below and the runbook. |

### Verification matrix status

| Scenario | Status |
| --- | --- |
| Old `powerhouse.json` without cloud fields | ✅ automated (vitest) |
| Duplicate submit incl. concurrent | ✅ Linux suite (#2, #3) |
| Lost create/submit acknowledgement | ✅ fake-transport tests (fork reuse; inspect-by-id after failed submit); e2e recovered by id from a fresh store |
| Quit app after durable acceptance | ✅ e2e: new store instance, run finished and published without the submitting process |
| Disconnect while streaming | ✅ event paging with contiguous cursor + dedupe (unit); e2e cursor 11 → 23 across syncs |
| Laptop sleeps during CPU-only checks | ◐ idle timers disabled/verified on the fork and restored after; a real multi-hour sleep test was not run |
| Runner crash / VM reboot | ✅ SIGKILL → interrupted (#13); boot reconcile of orphan (#14); real VM reboot not exercised |
| Cancel incl. subprocesses | ✅ #11 |
| Cancel races completion | ✅ store test (terminal wins once); runner `finish()` guard |
| Agent asks for unavailable input | ✅ `block` script → blocked (#8); real Claude denial path not exercised |
| Deadline expires | ✅ #12 (60 s) |
| Validation fails / not configured | ✅ #5, #4 |
| Push fails / ack lost | ✅ unit (refuse foreign branch, ls-remote verify); no-credential path refuses before submission |
| Dirty/unpublished source | ✅ unit (rejected before any cloud call) |
| Malformed events / oversized logs / unsafe paths | ✅ #15, #16, store payload bound |
| Agent reads runner state | ✅ every run's isolation probe; #17 escape attempt |
| Local import with unrelated edits | ◐ implemented (new worktree only); not exercised against a real remote in this session |
| Close cloud view / startup PTY cleanup | ✅ by construction: cloud module is not referenced by `pty_kill_all`, exit handler, or terminal disposal; e2e process exit did not affect the run |

### Decisive real-world acceptance test

**Not run.** It requires a real Claude task, which requires provisioning
credentials into the base runner (approval pending). With the fake agent, the
equivalent sequence (submit → receipt → submitting process gone → recover by id
→ Ready for review → branch present → one execution → idle policy restored) is
the e2e above. Report the milestone as **implemented but not cloud-verified for
Claude**.

### Retained resources after this session

`powerhouse-cloud-base` (stopped) and `powerhouse-main` (stopped, holds the
2026-09-21 e2e evidence and its workspace). `powerhouse-cloud-spike`,
`powerhouse-cloud-probe-iso`, `powerhouse-cloud-fork-probe` and `ph-d3408a6f`
were destroyed after their tests. No model call was made; no credential was
copied anywhere.

### 2026-09-18 boot failure: diagnosis

Evidence source: the kernel ring buffer of `powerhouse-cloud-base`, which was
never rebooted since the golden image was built and therefore still held the
failed first boot. Journald in the image is `Storage=none`, the exec server is
in-kernel (`lttle` module, port 57073, no userspace process), and the public
console-log API is unimplemented, so `dmesg` is the only in-guest record.

| UTC | Guest-side event |
| --- | --- |
| 2026-09-17 15:10 | Template `tpl-prep-computer-2x8-0.1.50` boots and is checkpointed with memory. |
| 2026-09-18 23:33:01 | Fresh isolated VM = memory restore of that template. `lttle` re-inits kvmclock, prints the RCU "stall" expected from a 32-hour clock jump, logs `fork detected` with the new IP/name; systemd resumes. |
| 23:33:01.8 | Isolation strip runs: `boxd-automations.service` removed, `jobs.json` emptied, entries removed from `/usr/local/bin`, `/etc/profile.d`, `~/.config/boxd`, `~/.claude/skills`. |
| 23:33–23:42 | No further kernel output while the control plane reported `starting` and wake timeouts. The `reboot` request never reached the guest (a real reboot would have cleared `dmesg`). |
| 2026-09-19 20:23 | `boxd machine start` restores the VM; `fork detected`; running in <25 s. Only identity files change. |

Conclusion: the guest booted and ran on 2026-09-18; the platform never moved the
new machine from `pending/starting` to `running`. The only guest-visible
difference between the failed first boot and every later successful boot is the
first-boot isolation strip, so the fault sits in boxd's first-provisioning path
for isolated machines (or a server-side incident that coincided with it), not in
isolation itself, the image generation, or anything in this repository.

Confirming experiment (2026-09-20 06:56 UTC): `powerhouse-cloud-probe-iso`
(fresh, `--isolated`, same template btime) reported `boot: 5ms`, was `running`
after 26 s and executed commands after 36 s. The failure no longer reproduces.
The empty diagnostic VM `powerhouse-cloud-spike` was destroyed to free the
slot; the probe was destroyed after the test. Fork results are recorded below.

Operational rule adopted for the provisioning adapter: on `boot: timeout`
never create another machine. Keep the identity, wait, then `stop`/`start` the
same VM. On 2026-09-18 an immediate stop/start did not help; 21 hours later it
did, so the retry must be patient or escalate to the user.

### Slice 0 fixture results (2026-09-20, `powerhouse-cloud-base`)

Base: Ubuntu 24.04.5, Linux 6.1.0+ x86_64, systemd 255, cgroup v2, Python
3.12.3, git 2.43.0, node 24.20.0, Claude Code 2.1.263 preinstalled; no Rust
toolchain (installed rustup 1.98.1 + build-essential for runner builds).
Exec runs as `boxd` (uid 1000, passwordless sudo, docker group).

| Scenario | Result |
| --- | --- |
| `detach01 complete` | `start` returned 20:29:54 UTC; supervisor outcome written 20:30:04 UTC after the connection closed; `service_result=success`, exit 0; artifact present; `runner_state_denied` emitted; child stopped. |
| duplicate `start detach01` | Refused: reservation exists. |
| `failure01 fail` | `service_result=exit-code`, `exit_status=23` retained; artifact present. |
| `deadline01 wait` (CPU-only) | `service_result=timeout`, killed TERM at RuntimeMaxSec; child stopped. |
| `cancel01 wait` | `systemctl stop` → cgroup empty, `exit_status=TERM`, history retained. |
| stray `sleep 900` children after all runs | none. |

Idle policy: `config set auto-suspend.timeout 0` / `auto-hibernate.timeout 0`
took effect (`get` showed `off`) and restoring 300/900 took effect. Only the
external CLI can do this; the in-VM CLI is absent on isolated machines, so
cloud-owned restoration needs an org-fenced API key (`boxd auth keys create
--org … --expires-in-secs …`) provisioned into the runner's root-only state.
Not done; requires user approval.

Credential audit (names only): `boxd machine exec` sessions on the isolated
base carry `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_PAT_TOKEN`, `OPENROUTER_API_KEY`,
`VOYAGE_API_KEY` injected by boxd org secrets. Per boxd docs isolated machines
get them "in exec and SSH sessions only, never at boot", which matches: the
fixture's systemd unit saw none of them. The runner therefore receives secrets
only through an explicit root-only credentials file, and the agent identity
only what the run needs.

### Fork path (2026-09-20 06:57 UTC)

`boxd machine fork powerhouse-cloud-base powerhouse-cloud-fork-probe` (source
`running`, isolated) returned in 11 s with `boot: 230ms`; the fork
(`0a1d1ba9-ab82-48d8-90b8-3c49c4dc43ab`, `isolated: yes`,
`source: fork/powerhouse-cloud-base`) was `running` at +26 s. A detached fixture
run (`forkcheck complete`) on the fork completed after the connection closed,
with `runner_state_denied` and the child stopped; the base's control directory
was unchanged. The 2026-09-18 `couldn't fork that machine` error was a symptom
of the never-booted base, not of forking.

Observation that matters for the runner: the fork copied the base's systemd
state verbatim, including two **failed** transient units and all fixture
reservations. A base must be swept clean (no reserved run IDs, no loaded
transient units) before it is used as a fork source, and the runner must scope
its state by VM identity rather than assume an empty store on a fresh fork.

Retained resources after the session: `powerhouse-cloud-base` and
`powerhouse-cloud-fork-probe` (both stopped; 300/900 s idle policy). Both probe
VMs created for the boot test were destroyed.

## Local baseline

Source: `db2b7c51b4cb9f64816e15675f2453fdb86a977f` on `main`.
Host: macOS, arm64. The existing untracked `docs/` files were preserved.

| Command | Observed result |
| --- | --- |
| `pnpm build` | Pass; existing warning about a JavaScript chunk larger than 500 kB. |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Pass; **zero tests** in the existing Rust suite. |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Pass. |
| `boxd version` | `boxd 0.2.9`. |
| `claude --version` | `2.1.277 (Claude Code)`, on the laptop only. |

No frontend test script currently exists. These checks establish a starting
point; they provide no evidence of Linux supervision or cloud durability.

## Installed CLI observations

The installed help, rather than older skill examples, established these forms:

```sh
boxd version
boxd auth --json
boxd manage billing --json
boxd machine list --json
boxd machine get VM --json
boxd machine fork VM NAME --isolated --auto-suspend-timeout 0 --auto-hibernate-timeout 0 --json
boxd machine exec VM --timeout SECONDS -- COMMAND
boxd machine cp SOURCE DEST --json
boxd machine config set VM auto-suspend.timeout SECONDS --json
boxd machine config set VM auto-hibernate.timeout SECONDS --json
```

The initial inspection used only version/help, identity, billing, and inventory.
The later resource operations and their failures are recorded above. These syntax
references do not imply that execution, transfer, or idle restoration succeeded.
`boxd --version`, `boxd whoami`, and `boxd auth org` are rejected by this version.

- Actual machine-list entries contain `name`, `status`, `url`, `source`, and
  `sharing`; they do **not** contain the `vm_id` claimed by older skill examples.
  Capture and validate stable identity from real create/get responses during
  the approved spike; never substitute a display name for a durable VM ID.
- `boxd auth --json` returned account `gh-mithril-studio`, `active_org: null`,
  and an organization entry marked active. The separate billing query resolved
  the effective context to organization **mithril-studio**, with 8 of 20 VM
  slots occupied. A null top-level organization is not proof of personal billing.
- New/fork help exposes both idle timeouts and `--isolated`. Their actual
  effect, response schemas, and reconciliation behavior remain untested.
- API-key creation help exposes organization fencing and expiry, but no
  per-machine permission option. No key was created. Do not claim a root-owned
  organization key would be restricted to one machine by the platform.
- `exec` help does not promise stdin forwarding. Transfer manifests using `cp`
  and atomic finalization, as required by the brief.

## Capability risks to resolve on Linux

boxd documents that `--isolated` removes saved coding-agent logins, connected
integrations, the in-VM CLI, and the laptop bridge. It also excludes the default
private network. Isolation is inherited by descendants. Therefore automatic
cloud login and in-VM lifecycle access cannot be presumed on an isolated fork.
See [Sandboxes](https://docs.boxd.sh/use-cases/sandboxes).

Both idle timers observe inbound network activity, not CPU activity. They must
remain disabled while work is active. A timer inside a frozen VM cannot recover
the task. The supervisor's independent restoration mechanism still needs proof.
See [Suspend, resume, and hibernate](https://docs.boxd.sh/guides/suspend-resume).

Forks can copy running processes as well as disk and memory. A prepared base
must have no active task, and forked execution ownership must be initialized
deliberately. See [Fork](https://docs.boxd.sh/guides/fork).

Local Claude help supports `--print`, `--output-format stream-json`,
`--permission-mode dontAsk`, `--permission-prompts none`, `--allowedTools`, and
`--max-budget-usd`. These are candidate capabilities, not a verified adapter.
Verify the VM's installed version, actual denial/result events, and child-process
termination. No paid model call has been made.

`--bare` skips ambient customizations but requires API authentication rather
than a subscription login. The credential choice must precede selection of this
mode. Reported usage is an estimate, not an infrastructure billing cap. See
[Claude programmatic usage](https://code.claude.com/docs/en/headless).

## Approved spike resource setup

| Item | Proposal |
| --- | --- |
| Billing | Existing `mithril-studio` organization; private resources only. |
| Base | New dedicated `powerhouse-cloud-base`; do not reuse an unrelated application VM. |
| Capacity | Two new VMs maximum: one base and one test fork; one active task. |
| Repository | `mithril-studio/powerhouse`, exact source SHA recorded above; verify remote availability before execution. |
| Credentials | Explicitly configured cloud Claude and GitHub sources only; availability remains unverified. No laptop login-directory, SSH-key, or `.env` copies. |
| Limits | At most 60 minutes of active VM time for the spike, 15 minutes per run, and a $1 Claude API limit per model test. These are approved ceilings, not a total euro cost guarantee. The base was stopped about 10 minutes after provisioning started; no workload or model test ran. |
| Retention | Preserve the base, task VM, and artifacts; restore approved idle policies independently of the laptop; no automatic deletion. |

Credential availability and the trusted lifecycle capability still need verification.
Resolve the trusted lifecycle capability before disabling both idle policies for
detached work. If it requires credential provisioning, explain its actual scope
and obtain the approval required by the brief. Do not substitute a laptop-owned
cleanup timer or silently relax isolation.

Perform the spike in this order:

1. Create only the approved dedicated environment. Record stable IDs, effective
   billing/sharing/isolation, Linux architecture, systemd/cgroup support, and
   installed tool versions without secret values.
2. Establish the unprivileged agent identity and protected supervisor state.
   Audit inherited credential paths, privileged sockets, and platform access.
   Verify denials under the agent identity, not just environment filtering.
3. Prove an authorized, cloud-owned way to restore both idle policies. Verify
   effective settings and the cleanup path before any unattended run.
4. Submit a supervised fake workload that writes a deterministic artifact and
   spawns a child. Close the submitting connection before it finishes. Reattach
   later and verify durable evidence, single execution, and idle restoration.
5. Exercise cancellation, deadline expiry, and reboot/recovery on that test
   fork. Verify child termination and honest interruption without blind retry.
6. Using the approved credentials, verify exact-source read access, unique task
   branch publication, and bounded noninteractive Claude behavior. If publication
   credentials grant broader access, document that and seek explicit approval.

## Integration boundaries confirmed in the current source

- `src/store/persist.ts` writes after a 300 ms debounce. Submission identity needs
  a separate explicitly awaited durable write before remote side effects.
- `src/store/appStore.ts` converts live **local queue** entries to `interrupted`
  during hydration. Cloud runs need separate reconciliation semantics.
- `src/App.tsx`, `src-tauri/src/lib.rs`, and `src/lib/terminalRegistry.ts` own
  local PTY cleanup. Add cloud observation without connecting it to those kills.
- `Branch.worktreePath` is consumed by local Git and file operations. Remote
  workspaces need a separate reference; local import can create a new worktree
  only after the remote result SHA is verified.

## Outstanding verification

The fixture in `scripts/cloud-spike/` is ready for review and Linux execution.
It reserves a test ID before launching a transient systemd unit, runs a fake
agent under `DynamicUser` with restricted privileges, and writes the supervisor's
outcome through a root-owned `ExecStopPost` hook. It includes completion,
nonzero-exit, CPU-only deadline, and cancellation cases. It is not the production
runner and does not claim restart recovery or idle-policy restoration.

`bash -n` and Python AST parsing passed. The driver also rejects this macOS host
before attempting installation or launching a process. **No Linux behavior has
been tested.** The README gives the separate-connection procedure and the evidence
to collect once the approved machine can execute commands.

All remote scenarios in section 11 of the execution brief remain **not run**.
There are no real run IDs, task-fork IDs, provider sessions, result commits, or
laptop-off demonstration results to report. The retained base ID is recorded
above. Slice 0's exit condition has not been met. Resume by starting that same
base and verifying runtime access; do not blindly create another base. Then
continue the capability proof above before broad
implementation; keep the deferred roadmap out of this milestone.
