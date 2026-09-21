# Cloud runs: snapshot-based VM lifecycle

Plan, 2026-09-21. Supersedes the base-VM/fork model and the "never destroy a VM" retention rule in `boxd-cloud-agents.md` sections 4 and 7. Everything else in that brief (durable run identity, in-VM runner, credentials, publication, import) stays as built.

## Goal

No Powerhouse machine may hold a boxd slot while it is idle. The org has 20 slots; templates and finished task VMs must live as snapshots, which are cheaper to host and boot in seconds.

Target flow per run:

```text
base snapshot ──new──▶ task VM ──run──▶ publish ──▶ desktop verifies ──▶ destroy VM
                                          │
                        waiting on a response > 1 h ──▶ snapshot VM + destroy VM ("park")
                                          │
                        response arrives ──▶ new VM from park snapshot ──▶ continue ──▶ destroy VM + park snapshot
```

## Lifecycle model

Two independent state machines. The runner's run state (`accepted … completed | failed | blocked | cancelled | interrupted`) is unchanged. The desktop adds a **machine state** on each `CloudRunRecord`:

| Machine state | Meaning | boxd resources held |
| --- | --- | --- |
| `provisioning` | `machine new --from-snapshot` issued, VM not yet running | 1 VM slot |
| `active` | run is live on the VM (idle timers 0/0) | 1 VM slot |
| `holding` | run reached a terminal state; VM kept for inspection, park timer running | 1 VM slot |
| `parked` | VM snapshotted and destroyed; workspace recoverable | 1 snapshot |
| `restoring` | new VM being created from the park snapshot | 1 VM slot + 1 snapshot |
| `released` | VM and any park snapshot removed | none |

Transitions the desktop owns:

- `completed` and published, remote ref verified, result + events + diff cached → **release immediately**. The branch on the remote and the local cache are the record; the VM has nothing left to give.
- `failed`, `blocked`, `cancelled`, `interrupted` → `holding`. Partial work only exists in the VM workspace, so keep it reachable.
- `holding` for 1 h → **park**: `boxd snapshots save <vm> ph-<run8>-park`, confirm `ready`, then `boxd machine remove <vm> --confirm`.
- User acts on a held or parked run (Discard, Forget, Fetch changes on a failed-but-published run) → **release**: remove VM if present, remove park snapshot if present.
- User asks to inspect or continue a parked run → **restore**: `machine new ph-<run8> --from-snapshot ph-<run8>-park --isolated --auto-suspend-timeout 0 --auto-hibernate-timeout 0`, then back to `holding` with a fresh 1 h timer. Continuation itself (a follow-up run in the restored workspace) is the deferred "follow-up runs" increment; this plan only makes it cheap.

Invariants:

- Never remove a VM whose runner reports a live run. Cancel first and confirm `cancelled`.
- Never remove a VM before the result manifest, event pages, and `diff.patch` are in the local cache and, for published runs, `git ls-remote` shows the recorded result SHA on the output branch.
- Never remove a park snapshot while the run's machine state is `parked` or `restoring`.
- Persist the intended machine state and resource names **before** each boxd call, same as submission today. A lost ack is reconciled by name: `machine get ph-<run8>` and `snapshots list` are the source of truth.
- Timers run in the desktop sync loop. With the app closed, a `holding` VM stays up until the app reopens. Acceptable now; the always-on Powerhouse instance takes over this loop later without a model change.

## Base snapshot

Replace `powerhouse-cloud-base` (a stopped VM holding a slot) with a versioned snapshot.

`scripts/cloud-base-setup.sh` gains a `--publish-snapshot <name>` mode:

1. `boxd machine new ph-base-build --isolated` from scratch.
2. Run the existing setup steps (runner build, `install`, Claude staging, `--reset-store`).
3. Sweep: stop all `powerhouse-run-*` units, verify the runner store is empty and no reserved run ids exist, clear shell history and `/tmp`.
4. `boxd snapshots save ph-base-build <name>`; read back `snapshots list --json` and print the resulting version.
5. `boxd machine remove ph-base-build --confirm`.

Snapshots capture memory, so the runner's boot reconcile must treat a restore the same as a fork (it already logs `fork detected` and re-initialises). Re-saving a name bumps its version; the manifest records `base_snapshot: {name, version}` and submission pins that version. Powerhouse settings hold the current base snapshot name; the Run in cloud form shows name, version, and size from `snapshots list`.

Verify during slice 1, on real boxd: whether `--from-snapshot` accepts a pinned version and in what syntax, boot time from snapshot, that `--isolated` and the idle-timeout flags are honoured on a snapshot-created machine, and that a snapshot saved from a running machine restores with systemd healthy.

## Submission changes

- `do_submit`: drop `machine_get(base)`, `machine_start(base)`, and `fork`. Create `ph-<run8>` from the base snapshot with idle timers 0/0 and `--isolated`. Deterministic per-run name keeps lost-ack reuse working; the per-branch "already has an active run" check goes away because each run owns its machine.
- Capacity gate before creating: count machines from `machine list`; refuse with an actionable error when the count is at or above a configurable ceiling (default 18 of 20, leaving room for non-Powerhouse machines).
- Manifest: `base_vm_id`/`base_vm_name` become `base_snapshot`. Old records deserialise with the new field absent.
- `idle_policy` / `idle_policy_restored` are removed; nothing is restored because nothing survives.
- `cloud_probe_base` becomes `cloud_list_snapshots`. The runner probe still runs on the fresh task VM before the manifest is uploaded.

## Transport additions

Add to the `BoxdTransport` trait and the fake used in tests:

| Op | CLI |
| --- | --- |
| `machine_list` | `boxd machine list --json` |
| `machine_new_from_snapshot(name, snapshot, isolated, 0, 0)` | `boxd machine new … --from-snapshot … --json` |
| `machine_remove(vm)` | `boxd machine remove <vm> --confirm --json` |
| `snapshots_list` | `boxd snapshots list --json` |
| `snapshot_save(vm, name)` | `boxd snapshots save <vm> <name> --json` |
| `snapshot_remove(name)` | `boxd snapshots remove <name> --confirm --json` (check exact flag) |

All destructive ops take a name that must start with `ph-`. The transport refuses anything else so a bug cannot delete an unrelated machine.

## Desktop view

- Run card shows the machine state next to the run state: "VM active", "VM held, parks in 42 min", "Parked (snapshot 8.8 GB)", "Released".
- Actions: **Discard workspace** on held/parked non-completed runs (releases), **Restore** on parked runs, **Cancel** unchanged, **Fetch changes** unchanged and releases after a successful import when the run is completed.
- Forget refuses while a VM or park snapshot exists, and offers Discard first.
- A Cloud tab footer lists Powerhouse-owned machines and snapshots with total counts against the 20-slot ceiling.

## Slices

1. **Transport + platform proof.** Add the ops, the `ph-` guard, and fake-transport coverage. On real boxd: save a snapshot of the current base, create a machine from it, probe the runner, remove it. Record boot time and the version-pinning syntax.
2. **Base snapshot.** Setup script `--publish-snapshot`, settings field, `cloud_list_snapshots`, form update. Publish `powerhouse-base` v1 and destroy `powerhouse-cloud-base`.
3. **Per-run VM from snapshot.** Submit path, manifest field, capacity gate, record migration. Fake-transport tests: persistence before each side effect, lost-ack reuse by name, ceiling refusal, completed-run release gate.
4. **Release on completion.** `do_sync` releases after the cache-and-verify gate; Fetch changes releases; live-run guard. Real e2e: completed run ends with zero Powerhouse machines. Destroy `powerhouse-main` by hand once its result is imported.
5. **Hold, park, restore.** Machine-state field, 1 h timer in the sync loop, park and restore commands, Discard/Restore UI. Real e2e: fail a run on purpose, wait for park, restore, inspect the workspace, discard.
6. **Docs and verification.** Rewrite brief sections 4 and 7 and the runbook's retention and idle-policy sections. Extend the verification matrix with: release only after verified cache, lost ack on `machine new`, lost ack on `snapshots save`, park during a live run refused, ceiling reached, snapshot version bump between submit and create.

Stop after slice 6. Follow-up runs on a restored workspace and the always-on lifecycle owner are separate increments.

## Risks

- **Snapshot cost accumulates.** Each park snapshot is roughly the base size (8–9 GB today). Release paths must remove them, and the Cloud tab must show what exists.
- **Snapshot of a running machine.** `snapshots save` requires a running VM. Park only from `holding` with no live unit; the executor is already stopped in every terminal state.
- **Version drift.** If the base snapshot is re-saved between form open and submit, the manifest pins the version the user saw. Refuse if that version no longer exists.
- **Desktop-only timers.** Until the always-on instance exists, a closed laptop leaves held VMs up. State this in the runbook.
