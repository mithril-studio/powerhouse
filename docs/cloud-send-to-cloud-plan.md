# Send to Cloud — one-click branch delegation plan

Date: 2026-09-22. Builds on the shipped boxd cloud-run stack (see
`boxd-cloud-agents.md`, `boxd-cloud-vm-lifecycle-plan.md`). Three features,
shipped as four slices, ordered so each is independently useful.

## Goals

1. **One-click "Send to cloud"** per branch: no form. Auto-checkpoint + push,
   auto-pick the brief (plan/handoff doc), submit with last-used settings.
   Most cloud runs execute plans written locally in normal mode; the plan
   document *is* the task.
2. **Branch-named VMs**: `ph-<branch-slug>` instead of `ph-<run8>`, so
   `boxd machine list` reads as "which branches are in the cloud".
3. **Per-project env vars**: defined in Powerhouse per repo, injected per run
   via the existing credentials channel. Never baked into snapshots; no key is
   visible to any VM except the one running that project.

Non-goals (unchanged from the brief): dirty-tree upload beyond the WIP
checkpoint commit, follow-up conversations on a run, multi-writer coordination
beyond the "in cloud" badge.

## Slice 1 — Branch-named VMs

Naming is the foundation of reconciliation ("a lost create acknowledgement is
reconciled by name"), so this lands first and alone.

- `task_vm_name` / `park_snapshot_name` (`commands.rs:85-92`) derive from the
  source branch, not the run id: `ph-<slug>` and `ph-<slug>-park`.
  - Slug: lowercase; any char outside `[a-z0-9]` → `-`; collapse repeats; trim
    `-`; cap at 32 chars. If truncation or sanitisation lost information,
    append `-<6-char hash of the full branch name>` to keep determinism.
  - Detached HEAD / no branch: fall back to `ph-<run8>` (current behaviour).
- The resolved names are already persisted (`CloudRunRecord.task_vm`,
  `SnapshotHandle.name`). Audit every reconciliation path
  (`do_lifecycle_tick`, `advance_after_terminal`, `do_park`, `do_restore`,
  `do_release`, inventory) to read names **from the record**, never recompute
  from the run id. Recomputation from branch is only done once, at submit.
- New invariant: **one live run per branch.** At submit, if another record
  with the same VM name still holds resources (`MachineState::holds_vm()` or a
  park snapshot exists), refuse with a message pointing at the existing run's
  Discard action. This also prevents park-snapshot name collisions and doubles
  as the two-writer guard.
- The `ph-` destructive-op guard in `transport.rs` is unchanged (prefix kept).
- The base snapshot `powerhouse-base` stays as the boot image — it names the
  disk image runs boot from, not any VM. Only per-run VM/park names change.

Verify: submit on branch `feat/foo-bar` → `boxd machine list` shows
`ph-feat-foo-bar`; park → snapshot `ph-feat-foo-bar-park`; kill the desktop
mid-provision, relaunch, lifecycle tick reconciles by the stored name; second
submit on the same branch while the first holds a VM is refused.

## Slice 2 — One-click "Send to cloud"

New Tauri command `cloud_quick_submit(repo_id, worktree)`; the existing modal
becomes the advanced/first-run path.

1. **Preflight** (reuses submit-time checks, run before any side effect):
   base snapshot ready, Claude + GitHub credentials in Keychain, org capacity
   free, no live run on this branch. Any failure returns a structured reason
   and the UI opens today's `CloudRunModal` instead — never a dead-end toast.
2. **Auto-checkpoint**: if the worktree is dirty, `git add -A` +
   `git commit -m "WIP: send to cloud"`. Then `git push origin <branch>`
   (`-u` when no upstream), using the user's normal git credentials — the
   Powerhouse PAT is only for the VM. `inspect_source` itself stays strict;
   quick-submit makes the source clean *before* inspecting, so the pull-by-SHA
   model is untouched.
3. **Brief selection**: newest `.powerhouse/handoff-*.md` or plan file under
   `.powerhouse/` (existing `cloud_latest_handoff`, 256 KiB cap). If none, a
   generated stub: `git log --oneline -10` + `git diff --stat origin/main...`.
   Task text is fixed: "Execute the work described in the brief
   (`.powerhouse/cloud-task.md`). It contains the plan and context."
4. **Submit** through the existing `do_submit` with the persisted last-used
   settings (`DEFAULT_CLOUD_SETTINGS` / `setCloudSettings`). No settings page.

UI:
- Branch row ☁ button becomes quick-submit; the modal moves to the row's
  context menu ("Run in cloud (advanced)…") and stays the Cloud-tab button.
- Staged progress in the run card, not a spinner: checkpointing → pushing →
  provisioning → accepted.
- Branch badge "in cloud" while the run's machine state holds resources;
  clears on release/discard.

Verify: dirty branch + existing plan doc → one click ends in `accepted` with
zero dialogs; WIP commit visible on origin; brief in the VM matches the plan
file; missing credentials → modal opens pre-filled; second click while running
→ refused with pointer to the live run.

## Slice 3 — Per-project env vars

- Repo settings gain an env list. **Names** live in repo config; **values** go
  to the macOS Keychain via the existing `cloud_set_secret` machinery, keyed
  per repo.
- `secrets::render_run_credentials` adds an `env: {NAME: value}` map to the
  per-run credentials file — the file that is `boxd machine cp`'d to the VM
  and consumed once by the runner. Values never enter the manifest,
  `~/.powerhouse/cloud-runs.json`, events, or logs (redact on render).
- Runner: export the map into the agent process environment and write
  `<workspace>/.env` (git-excluded, like `.powerhouse/`), so both the agent
  and any test/build commands it runs see the keys.
- Scope guarantee: injection is per run; VMs are destroyed or parked after,
  and the base snapshot never contains keys.

Verify: set `FOO_API_KEY` on repo A; a run for repo A sees it (`printenv` via
an agent command in the transcript); a run for repo B does not; the key
appears nowhere in `cloud-runs.json` or cached events.

## Slice 4 — Live run feed (polish, optional)

The desktop already polls `runner events` every 5 s and caches up to 4000
events per run. Render them as a scrolling log in the run card's expanded
view (tool calls, stage transitions, agent text), giving the "watch the boxd
agent on screen" view with zero new transport.

## Risks

- **Branch slug collisions** — hash suffix on lossy slugs keeps determinism;
  the one-live-run-per-branch gate catches the rest at submit time.
- **WIP commits on origin** — accepted by design; they are on feature
  branches and squashable. Documented in the runbook.
- **Push failures** (diverged remote, protected branch) — surface git's
  message verbatim in the preflight-failure path; never force-push.
- **Stale park snapshots blocking a branch** — the refusal message names the
  blocking run and its Discard action; lifecycle tick already retries
  releases.
