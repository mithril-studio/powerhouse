# Powerhouse × boxd: implementation brief

## 1. Mission and execution boundary

Implement durable cloud agent runs in Powerhouse. The user has approved this architectural direction. This document is the execution brief; do not require the preceding conversation to understand the task.

**Product promise:** once Powerhouse confirms that a run has been accepted in the cloud, closing the app, disconnecting the network, or sleeping the laptop must not stop that run. When the app reopens, it recovers the run's status, history, and results without launching it again.

Build the first milestone described here, not the entire future roadmap. Preserve existing local-agent behavior. Work in small, tested increments and record verification evidence. Do not claim real cloud behavior is verified by mocks alone.

Before creating billable resources, accessing private repositories from a VM, or changing credential configuration, confirm the intended boxd account/billing context, test repository, approved credentials, and resource limits with the user. Never print credentials in implementation notes or test evidence.

## 2. Approved architecture

1. Powerhouse is the delegation, observation, and review interface—not the owner of a cloud agent's process lifetime.
2. boxd provides machines, access, and lifecycle operations. Powerhouse adds a durable run lifecycle on top.
3. A supervised runner inside the VM owns execution, validation, publication, cancellation, and deadlines independently of the desktop connection.
4. Cloud state is authoritative. Desktop persistence is a cache and a record of submitted run identities.
5. Closing a view means detach. Cancellation is a separate, explicit operation.
6. Use isolated task workspaces and exact source revisions. Never silently operate on the golden VM's current checkout or a moving branch tip.
7. Return results for human review. Do not automatically merge to main or deploy.
8. Start with one agent and one complete end-to-end path. Do not turn existing local terminals into a generic execution framework as a prerequisite.

### Vocabulary

- **Task:** the desired outcome, constraints, and acceptance criteria.
- **Workspace:** the checkout and environment in which work happens.
- **Run:** one execution attempt with an immutable request, durable identity, events, and outcome.
- **Agent session:** provider-specific conversation state; its ID is not a process ID or a Powerhouse run ID.
- **Attachment:** a desktop view observing a run; attachments do not own execution.

These distinctions do not require five database tables. In v1, a run can contain its task request and workspace reference directly.

## 3. Repository map and existing constraints

Read the current implementations before editing; this map describes the starting point, not an instruction to refactor every file.

| Path | Relevant behavior |
| --- | --- |
| `src-tauri/src/pty.rs` | Local PTY ownership, launch/write/resize/kill, raw transcript recording. |
| `src-tauri/src/lib.rs` | Tauri commands and app-exit cleanup; kills local PTYs and merge checks. |
| `src/App.tsx` | Startup hydration, local PTY cleanup, pane composition. |
| `src/store/appStore.ts` | Repos, local branches/worktree paths, chats, agent profiles, runtime chat status, persisted merge history. |
| `src/store/persist.ts` | Debounced `powerhouse.json` persistence. Not sufficient by itself for crash-safe submission identity. |
| `src/lib/ipc.ts` | Typed frontend wrappers for Tauri commands. |
| `src/lib/actions.ts` | Branch/chat actions and fresh-session handoff continuation. |
| `src/lib/terminalRegistry.ts` | xterm lifecycle; terminal disposal normally kills its local PTY. |
| `src/components/TerminalPane.tsx` | Starts/resumes local agents; not a cloud run supervisor. |
| `src/components/RightSidebar.tsx` | File/diff operations assume a local worktree. |
| `src/lib/handoff.ts`, `src-tauri/src/handoff.rs` | Handoff document generation and watching. `.powerhouse/` is excluded from Git. |
| `src-tauri/src/git.rs` | Local Git operations with argument vectors. |
| `src-tauri/src/queue.rs`, `src/lib/queueSync.ts` | Local validation/merge queue and snapshot resynchronization. This is not a cloud task scheduler. |
| `package.json`, `src-tauri/Cargo.toml`, `.github/workflows/release.yml` | React/TypeScript and Tauri/Rust tooling; release workflow uses pnpm. |

Important compatibility requirements:

- Keep local chat launch, resume, transcript replay, tab switching, and cleanup working as before.
- Do not make `pty_kill_all`, app shutdown, or view disposal cancel cloud runs.
- Do not apply the merge queue's hydration rule that converts live entries to `interrupted` to cloud runs. Query their runner instead.
- Do not store a remote path in `Branch.worktreePath` and pass it to local Git commands.
- Raw terminal output is not structured agent conversation state and cannot determine reliable task success.

## 4. First milestone: scope and stop condition

### Implement

- A `Run in cloud` action for an existing repository, with a task and an exact committed source revision available from its configured remote.
- A versioned, private base **snapshot** (published by `scripts/cloud-base-setup.sh --publish-snapshot`) and one isolated task VM created from it per run. No Powerhouse machine holds a boxd slot while idle (revised 2026-09-21; see `docs/boxd-cloud-vm-lifecycle-plan.md`).
- One run per task VM (`ph-<run8>`). Each run owns its machine; a second execution cannot mutate the same workspace concurrently.
- One supported headless agent: **Claude**, unless the capability spike establishes a blocker and the user approves a different first agent.
- Durable submission receipts, run state, ordered events, cancellation, deadlines, and results.
- A cloud-run view with status, output, validation results, summary, and diff/artifact access.
- Reconnect and app-restart reconciliation without duplicate execution.
- Result publication to a unique task branch and safe import into a new local worktree.
- A machine lifecycle owned by the desktop: release the VM once a completed run is cached and its remote branch verified; hold, park (snapshot + destroy) and restore VMs of runs that ended any other way; discard on request. Capacity gate against the org's 20 slots.
- Explicit setup, recovery, lifecycle, and cleanup documentation.

### Do not implement in this milestone

- Migration of a live local process or exact provider conversation between machines.
- Uploading dirty working trees, arbitrary untracked files, local home directories, or `.env` files automatically.
- Multiple agent providers, arbitrary command-template compatibility, or remote interactive TUI parity.
- Follow-up conversations, interactive approval workflows, or automatic resumption after an ambiguous crash.
- A fleet-wide cloud scheduler, dependent tasks, multi-device account synchronization, or automatic VM-capacity management.
- Full remote file browsing/editing, live filesystem synchronization, or a rewrite of the local merge queue.
- Automatic merging, production deployments, or a public runner HTTP endpoint. (Automatic VM deletion *is* in scope since the 2026-09-21 lifecycle revision, under the invariants in section 7.)

**Stop when the acceptance tests in section 11 pass.** List remaining roadmap items; do not silently expand scope to implement them.

## 5. Architecture and ownership

```text
Powerhouse desktop
  React view + cached run history
             |
  Tauri cloud module / boxd adapter
             |
  authenticated boxd transport
             |
Isolated task VM
  supervised Powerhouse runner
    - durable run store and ordered events
    - headless agent adapter
    - repository checkout
    - checks and result publisher
    - deadlines, cancellation, recovery
             |
  unique remote Git branch + retained artifacts
```

### Desktop cloud module

Hide provisioning, transport, submission reconciliation, and protocol validation behind a small interface. Use an injectable boxd command transport for deterministic tests; do not add a general plugin framework.

Keep boxd access in the Rust backend. Use machine-readable output, argument vectors, explicit timeouts, bounded responses, and validated schemas. Prompts and manifests are data, not shell program fragments.

Persist the run ID and submission intent **before** the first remote side effect. Persist the VM identity as soon as it is known. A 300 ms debounced UI-store write is not a durable launch receipt. Use an explicit awaited persistence operation for these transitions.

### VM runner

Prefer a standalone Rust binary, separate from the Tauri dependency graph, with SQLite for durable run metadata and ordered events. Keep the implementation small; do not introduce Redis, Kafka, Kubernetes, or a second hosted backend.

Run it under a boot-enabled supervisor such as systemd. The submitting remote command contacts the supervisor/runner and returns a receipt; it must not be the parent connection keeping the agent alive.

A run survives desktop disconnection. A VM reboot may interrupt the agent: persist an honest `interrupted` outcome unless continuation is demonstrably safe. Do not promise transparent survival of arbitrary machine failures.

The runner—not model output—owns state transitions and validation outcomes. Protect its database, result metadata, and supervisor controls from the agent's Unix identity.

### No central coordinator in v1

The desktop provisions and transfers everything before remote acceptance. An accepted run completes its remaining sequence entirely in the VM.

Before acceptance, show `Preparing cloud environment` or `Submission outcome unknown`, not `Safe to close your laptop`. If future requirements include provisioning queued tasks after the laptop closes, move that scheduling into a cloud coordinator then.

## 6. Contracts and state model

Version the runner protocol and reject incompatible versions with an actionable error. The operations below are **proposed Powerhouse runner operations**, not existing boxd commands.

Minimum interface:

- `probe`: protocol/runner version, supported agent capability, environment readiness.
- `submit(manifest)`: durable receipt with run ID, manifest digest, state, and event cursor.
- `inspect(runId)`: authoritative snapshot, including an event high-water mark.
- `events(runId, afterSequence, limit)`: ordered, bounded event pages.
- `cancel(runId)`: persist cancellation intent and report current state.
- `result(runId)`: outcome and artifact manifest, when available.

Store the manifest remotely before submitting it, using an atomic upload/finalization pattern. Do not pipe prompts into `boxd machine exec` without verifying stdin support; the documented external CLI behavior does not forward stdin. Use file transfer for request data.

### Immutable request

Capture at least:

- Protocol version and globally unique `runId`.
- Task text and acceptance criteria.
- Repository identity, credential-free remote reference, and full source commit SHA.
- Intended unique output branch, such as `powerhouse/cloud/<runId>`.
- Workspace/base identity and relevant tool/agent versions.
- Agent/model configuration; no credentials embedded in the request.
- Snapshot of user-approved Linux-compatible validation commands.
- Explicit permission policy and an enforced wall-clock deadline.
- Provider-supported turn/spending limits where available; distinguish enforced limits from estimates.

A retry of submission uses the same ID and identical manifest. A new execution attempt gets a new ID and may reference its predecessor. Provider session IDs are opaque and separate.

### Cloud state

Normal flow:

```text
accepted -> preparing -> running -> validating -> publishing -> completed
```

Other outcomes: `blocked`, `failed`, `cancelled`, `interrupted`.

- `accepted`: request and execution responsibility are durable; no laptop dependency remains.
- `blocked`: required authentication, permission, or clarification prevents progress. In v1, stop the process, preserve the reason, and explain that automatic continuation is unavailable.
- `failed`: include the failing stage and actionable reason, including validation or publication failure.
- `cancelled`: process group is confirmed stopped; do not report this merely because the desktop sent a request.
- `interrupted`: execution ownership was lost or a crash left an ambiguous outcome. Do not blindly rerun the agent.
- `completed`: the agent finished, declared checks passed (or were explicitly not configured), and the result was durably published. Display as `Ready for review`, not `Merged`.

Keep desktop connection state and boxd machine state separate from this state machine. Show last-confirmed state and timestamp while offline. Terminal outcomes must not regress because an older snapshot arrived late.

### Idempotency and recovery invariants

- Duplicate `submit` calls with the same ID and digest return the existing run. A mismatched digest is an error.
- Enforce execution ownership on the VM so simultaneous requests cannot spawn two agents.
- Persist accepted work before returning its receipt. Commit state changes and their corresponding events atomically.
- Checkpoint the launch boundary; on supervisor restart, reconcile process ownership. An ambiguous launch is interrupted, not automatically repeated.
- Use supervised process groups/cgroups, not just a remembered PID susceptible to PID reuse. Cancellation and deadlines stop child tools too.
- If a fork/create response is lost, reconcile using persisted intent and deterministic resource identity before creating another VM. Do not destroy a machine whose ownership is uncertain.
- Reconcile unknown submission outcomes by run ID. Absence of a response is not evidence of absence of a run.
- Event sequence numbers are monotonic per run. Replayed pages are deduplicated. Advance a durable client cursor only after corresponding cached events are durable, or replay from an earlier safe cursor.
- Never infer task completion by searching terminal text or trusting an agent-written status file.

## 7. Workspace, credentials, and machine lifecycle

### Source and environment

- V1 accepts committed, remotely available code only. Reject dirty worktrees or clearly direct the user to commit/push first; do not silently omit their edits.
- Resolve and capture the source SHA locally, fetch it in the VM, and verify the checked-out SHA before executing.
- Start with a clean, idle prepared base. A base accelerates dependency setup; it is not the authoritative source revision.
- Bootstrap and runner installation must be repeatable. A base must not contain active task processes that forks accidentally duplicate.
- Dependencies and toolchains must match the checked-out revision. Never copy host-specific dependencies from macOS.
- Validate agent authentication, repository read access, result publication access, and Linux-compatible checks before promising a runnable task.
- Some projects require macOS. Report unsupported checks honestly; do not silently count omitted platform checks as passing.

### Credential and privilege policy

- Reuse authenticated boxd access initially. Do not implement a new OAuth system as part of this feature.
- Explicitly display/verify billing and organization context. Never silently switch or share the user's VMs.
- Configure cloud model/repository access explicitly. A laptop login or an inherited session ID is not proof that cloud authentication will work.
- Do not blanket-copy `.env`, SSH keys, agent credential directories, or the user's home directory into a base or fork.
- Run agent code and project checks under an unprivileged identity without sudo, Docker-socket access, or access to the runner's control credentials/state.
- Audit credentials and permissions inherited by the fork, including platform-provided in-VM access. An environment-variable allowlist alone is not isolation if credentials remain readable on disk or via machine facilities.
- Keep publication/lifecycle credentials in the trusted supervisor where possible. Give the agent only the capabilities it needs. Never rely on prompt instructions to prevent main-branch pushes or production actions.
- For publication, use narrowly authorized credentials and enforce the unique task-branch destination in code. If credentials cannot enforce desired repository restrictions, state that limitation and obtain explicit approval rather than claiming isolation.
- Run trusted Git operations with controlled configuration and hooks disabled. Agent-editable Git configuration, hooks, credential helpers, or artifact paths must not execute code with the supervisor's privileges or credentials.
- No public unauthenticated command runner. Use existing authenticated boxd access; introduce no inbound public port for v1.
- Validate IDs, paths, URLs, event payloads, and artifact sizes. Prevent traversal and shell interpolation. Treat model output and repository content as untrusted.
- Redact known credentials from diagnostics and never include secrets in manifests, local UI persistence, or test fixtures. Minimize retained sensitive output.

### Suspension, deadlines, and machine lifecycle

Revised 2026-09-21 (`docs/boxd-cloud-vm-lifecycle-plan.md`). The org has 20 machine slots; no Powerhouse machine may hold one while idle. Templates and finished workspaces live as snapshots, which are cheaper to host and boot in seconds.

- The base is a versioned **snapshot**, never a VM. Each run creates `ph-<run8>` from it with `--isolated` and both idle timers at `0` (boxd's idle policies are network-based; CPU-only checks must keep running without laptop traffic). The manifest pins the snapshot name and the version current at submission; boxd cannot create from an older version, so the created machine's `source` is checked against the pinned version and a mismatch is refused and the machine removed.
- Enforce the run deadline in the cloud across agent work, checks, and publication—not with a desktop timer.
- **Release** a `completed` run's VM as soon as the result manifest, all event pages and `diff.patch` are cached locally and `git ls-remote` shows the recorded result SHA on the output branch. The branch and the local cache are the record.
- **Hold** the VM of a run that ended `failed`, `blocked`, `cancelled` or `interrupted` (partial work only exists in its workspace) for one hour, then **park** it: `snapshots save ph-<run8>-park`, confirm `ready`, destroy the VM. **Restore** on request creates a new `ph-<run8>` from the park snapshot and holds it again. **Discard** removes the VM and the park snapshot. Forget refuses while either exists.
- Invariants: never remove a VM whose runner reports a live run (cancel first, confirm `cancelled`); never remove a VM before the cache-and-verify gate; never remove a park snapshot while the run is parked or restoring; persist the intended machine state and resource names before each boxd call and reconcile a lost acknowledgement by name (`machine get`, `snapshots list`); destructive calls only accept `ph-…` names.
- The hold timer and the park/release work run in the desktop while the app is open. A held VM stays up while the app is closed; the always-on Powerhouse instance takes this loop over later without a model change.
- A capacity gate refuses to create a VM when the org already has `ceiling` machines (default 18 of 20). The Cloud tab shows Powerhouse machines and snapshots against the org total.
- Document snapshot costs (a park snapshot is roughly the base size) and the explicit cleanup procedure. Do not claim a provider-reported spend estimate is a hard budget limit.

## 8. Result publication and local return

The runner performs publication without a connected laptop.

Persist a result manifest containing:

- Run ID, base/source SHA, result SHA, and output branch.
- Summary and remaining concerns, explicitly distinguished from verified check results.
- Per-check command, exit status, timestamps/duration, and bounded output/artifact references.
- Diff/patch, relevant artifacts, provider session ID if available, and usage when reported.
- Failure/blockage information and availability of partial work.

Publish only to the run's unique branch; never force-push another branch, merge main, or deploy. Retry publication idempotently: if an acknowledgment is lost, inspect the remote ref before committing/pushing again. Publication failure must not trigger another agent execution. Preserve the checkout and local result so publication can be retried or recovered separately.

A failed check remains a failed check even if the agent's summary says the task is complete. Associate validation with the exact result revision: stop the agent before checking and detect tracked-source changes made by checks. Do not label a different, subsequently modified revision as tested. With no configured checks, say `No validation configured` rather than claiming validation passed. An unchanged successful result is valid and must not require inventing an empty change.

`Fetch changes` verifies the expected result revision and creates a separate local branch/worktree through the existing Git flow. Do not reset, overwrite, or silently merge the user's current worktree. If the remote branch no longer matches the recorded result, surface the discrepancy instead of importing a different revision.

Retain remote history and artifacts until explicit cleanup; do not erase the only copy of a run result when its view closes.

## 9. Desktop experience

Add an additive cloud-run record associated with its repository and, optionally, its source branch. Keep remote workspace references distinct from local `Branch.worktreePath`. Do not force cloud records through `TerminalPane` or the local chat-status lifecycle.

Minimum flow:

1. Select repository/source and choose `Run in cloud`.
2. Enter task and review source SHA, base VM, checks, permissions, and limits.
3. Show preparation/upload progress. Persist pending submission identity immediately.
4. On durable receipt, show `Accepted in cloud — safe to close your laptop`; distinguish acceptance from actual running state.
5. Render a cloud-run pane with status, latest activity, output, checks, summary, and result diff/artifacts.
6. Offer explicit `Cancel` while active and `Fetch changes` when results are available.
7. On reopening the app, render cached history immediately, reconcile with the runner, then fetch missing events.

Use bounded polling initially; durable event pages matter more than WebSocket polish. Polling is observation only and never drives the task forward. Avoid aggressive polling that prevents completed VMs from becoming idle. Refresh completed runs on explicit user action rather than continuously waking them.

Show connection failures separately and retain useful cached output. Do not expose inactive `Resume`, `Approve`, or `Continue` controls that v1 cannot execute. Closing a run view detaches; forgetting a record must not orphan an active run or imply cancellation/deletion.

Use existing UI conventions, keyboard accessibility, clear loading/error states, and confirmation for cancellation/cleanup. A cloud badge plus a useful run pane is sufficient; no unrelated redesign.

## 10. Ordered implementation slices

For each slice: write focused tests, implement, run the relevant checks, review the diff, and checkpoint the working increment. Do not merge or release automatically. Preserve unrelated user changes.

### Slice 0 — Prove the risky platform capabilities

- Read the repository and establish baseline checks.
- Inspect installed boxd and agent help/version output rather than trusting remembered flags.
- With user-approved resources, prove supervised fake-agent execution survives the submitting connection closing.
- Verify Linux architecture/runtime, cloud authentication, fork isolation, deadlines, boot recovery, and restoration of idle policy without the laptop.
- Confirm a safe headless Claude mode with usable structured output and noninteractive permission behavior. Do not default to globally bypassing permissions.
- Record supported versions, setup requirements, and any blockers. Do not build the full UI before this proof succeeds.

During planning, the installed external CLI was `boxd 0.2.9`. Its command surface included `boxd machine exec`, `boxd machine fork`, `boxd machine cp`, and `boxd machine config set`. Older notes used top-level `boxd exec`/`boxd fork`, which this version rejected. Recheck current help; do not hardcode the old spellings or assume undocumented JSON schemas.

**Exit evidence:** one detached fake run completed and remained inspectable, plus verified credential/isolation and lifecycle behavior.

### Slice 1 — Contracts and durable submission identity

- Implement versioned request, receipt, snapshot, event, result, and error contracts.
- Add additive cloud-run persistence with backward-compatible hydration of existing stores.
- Implement immediate durable submission-intent writes and immutable manifest hashing.
- Test state separation, duplicate identity handling, old-store migration, and cursor/snapshot reconciliation.

**Exit evidence:** contract/store tests pass; existing local state is unchanged.

### Slice 2 — Runner with deterministic fake agent

- Implement persistent run storage, supervision, submit/inspect/events/cancel/result operations, and process ownership.
- Implement deadlines, cancellation of descendants, restart reconciliation, and protected runner state.
- Use a fake agent that emits controlled events, creates a file, spawns children, exits/fails, and can be interrupted at launch/publication checkpoints.
- Exercise real process and storage behavior on Linux; do not mock away the supervisor.

**Exit evidence:** duplicate submissions produce one execution; disconnect, cancel, deadline, and restart scenarios preserve truthful state.

### Slice 3 — boxd provisioning and transport

- Implement the backend boxd adapter, setup/probe path, private base selection, isolated fork, manifest upload, and durable receipt handling.
- Record VM IDs separately from display names and reconcile ambiguous create/submit outcomes.
- Verify the exact source checkout and required environment before execution.
- Handle missing CLI, missing authentication, quota, transport failure, incompatible runner versions, and failed setup with actionable errors.

**Exit evidence:** submit and inspect a fake cloud run through the actual desktop backend, close its connection, and recover it by run ID.

### Slice 4 — Claude, validation, and publication

- Replace the fake adapter in the production path with the verified headless Claude adapter.
- Capture provider session identity/events without deriving run success from prose.
- Run the captured validation commands under the same cloud deadline and restricted project identity.
- Implement result manifest, branch publication, partial-work preservation, and idempotent publication recovery.
- Retain the fake adapter for deterministic tests, not as a user-facing provider option.

**Exit evidence:** a small real task finishes and publishes while the desktop is absent; failed checks and publication errors remain distinguishable.

### Slice 5 — Cloud-run view and safe local import

- Add the submission flow, run listing/selection, progress/history, cancellation, errors, results, and local import.
- Reconcile automatically on app startup and reconnect without re-submission.
- Ensure local terminals, Git operations, and merge queue semantics remain unchanged.
- Test legacy persistence, delayed/out-of-order responses, missing event pages, and offline rendering.

**Exit evidence:** the full acceptance journey is available through Powerhouse without terminal-only manual repair.

### Slice 6 — Failure verification and operational handoff

- Run the matrix below, fix regressions, and document setup, supported versions, failure recovery, retention, and cleanup.
- Review credentials, privilege separation, command construction, untrusted logs/artifacts, and destructive operations.
- Record which tests were automated, which used real boxd resources, and which could not run. Include non-secret run/commit IDs for the real demonstration.
- Remove only implementation-owned temporary resources under the approved cleanup policy; preserve user environments and recoverable work.

**Exit evidence:** checks pass, the laptop-off demonstration succeeds, and remaining limitations are explicit. Stop here.

## 11. Verification and definition of done

### Current repository checks

The release workflow uses pnpm; both npm and pnpm lockfiles exist. Follow the established pnpm workflow and do not clean up unrelated lockfiles. At planning time there was no frontend test script; add the smallest suitable test setup for new behavior and document its focused/full commands.

Baseline/app checks, where supported on the development host:

```sh
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Add separate build/test commands for the standalone runner. Run its process/supervisor integration tests on Linux. A successful macOS Tauri build does not prove Linux runner behavior, and a Linux runner test does not prove the Mac app still works.

### Required verification matrix

| Scenario | Required outcome |
| --- | --- |
| Old `powerhouse.json` without cloud fields | Hydrates without losing repos, branches, chats, or merge history. |
| Duplicate submit, including concurrent requests | One agent execution; identical receipt identity; mismatched manifest rejected. |
| Lost create or submit acknowledgment | Reconciliation finds the existing resource/run; no blind duplicate launch. |
| Quit app after durable acceptance | Agent, checks, publication, and idle cleanup continue remotely. |
| Disconnect while streaming | Reconnect replays missed events in order without duplicates or state regression. |
| Laptop sleeps during CPU-only checks | Neither idle policy freezes active work; cloud deadline still applies. |
| Runner crash/VM reboot | Ownership is reconciled; ambiguous work becomes interrupted, never falsely completed or blindly rerun. |
| Cancel, including agent subprocesses | Cloud confirms processes stopped; partial work/history survives. |
| Cancel races with completion | One truthful final outcome; repeated cancel is harmless. |
| Agent asks for unavailable input/permission | Bounded, visible blockage; no silent indefinite wait or blanket approval bypass. |
| Deadline expires | All run processes stop remotely; outcome and partial results remain inspectable. |
| Validation fails or is not configured | Failure is explicit; absence of checks is not presented as passing validation. |
| Push fails or acknowledgment is lost | No false completion, no second agent execution, safe publication recovery. |
| Dirty/unpublished source or stale base checkout | Reject unsupported input or fetch exact requested SHA; never silently use different code. |
| Malformed events, oversized logs, or unsafe artifact paths | Safe bounded errors; no traversal, execution, credential leak, or unmarked log loss. |
| Agent attempts to read runner state/control credentials | OS-enforced separation prevents access; no reliance on prompt compliance. |
| Local import with unrelated local edits | New worktree at expected revision; existing edits are untouched. |
| Close cloud view / startup PTY cleanup | Cloud run stays alive; existing local cleanup behavior is preserved. |
| Completed run: release only after verified cache | VM removed only once result, all events and diff are cached and `ls-remote` shows the result SHA; a missing page or unverified remote keeps the VM and retries. |
| Lost acknowledgment on `machine new` | The machine is found by name and reused; never two machines for one run. |
| Lost acknowledgment on `snapshots save` | The park snapshot is found by name and the VM is then destroyed; never two saves or a destroyed VM without a ready snapshot. |
| Park (or discard) during a live run | Refused while the runner reports the run live; cancel first. |
| Machine ceiling reached | Submission refuses before creating anything; the record is `Not submitted` and holds no resources. |
| Snapshot version bump between form and create | Submission refuses a version drift before creating; a machine built from a newer version than recorded is removed and the run refused. |

### Decisive real-world acceptance test

1. Submit a small code task with a deterministic check through Powerhouse.
2. Wait for a durable cloud receipt; record the run ID and source SHA.
3. Quit Powerhouse and disconnect/sleep the laptop.
4. Allow enough time for agent work, validation, and publication to finish.
5. Reopen Powerhouse and reconnect.
6. Confirm the same run is `Ready for review`, with complete available history, checks, summary, and result revision.
7. Fetch its changes into a new local worktree and verify the expected modification and check outcome.
8. Verify there was exactly one agent execution and that the run's VM was released (`boxd machine get ph-<run8>` → not found) once the result was cached and verified.

If credentials or VM access prevent this test, report the milestone as **implemented but not cloud-verified**, not complete.

## 12. Deferred follow-on work — do not execute yet

After the first milestone, propose separately scoped increments for:

1. **Continue in cloud:** stable code checkpoint plus explicit handoff-document transfer. `.powerhouse/` is Git-excluded, so a branch push alone is insufficient. Transfer execution ownership deliberately to avoid two writers.
2. **Follow-up runs:** reuse the workspace/provider session where supported, but create a new run identity for each execution attempt.
3. **Selected dirty-state snapshots:** include staged, unstaged, and explicitly selected untracked content with secret filtering; never blindly copy a linked worktree's `.git` file.
4. **Durable approval/input flow:** persist requests and responses with explicit permission semantics.
5. **Cloud scheduling:** move provisioning, capacity waits, task dependencies, and cross-machine recovery off the desktop when those promises are required.
6. **Additional providers and richer remote workspace access:** add only against demonstrated needs and tested capabilities.

Deliver the narrow durable-run capability first. The defining achievement is reliable ownership transfer and recovery—not the number of providers, screens, or cloud machines supported.
