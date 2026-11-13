# Task board implementation and verification

Implemented on `feature/ateam-task-board`, 2026-11-13. This covers all six delivery increments in [the ATeam task-board plan](ateam-task-board-plan.md).

## Delivered

- Versioned task persistence, pre-migration tree backup, serialized saves and explicit launch-boundary flushes. Backlog tasks allocate no worktree. Branch adoption is idempotent; archive retains files and transcripts.
- Shared ACP session ownership outside React, background start independent of navigation, concurrent permission queues, stale-response guards, explicit turn outcomes, and recovery without blindly resending the first prompt.
- Recoverable UUID-owned task worktrees, collision-safe task branch names, process/permission guards on worktree removal, and branch/task reference cleanup.
- Five-column board, all-project/project scope, search, unread activity, composer, editable details, agent selection, return to backlog, review/navigation, checks and merge, archive/restore, and a Mission Control activity grid. Existing chat/terminal instances remain mounted and hidden surfaces are inert.
- Merge completion evidence retains the tested source SHA and merge SHA. Queue history eviction does not lose the task's completion. Git facts refresh while viewing the board; subsequent working-copy changes return merged work to Review.
- Read-only paginated GitHub issue intake through Rust/keychain auth, issue/PR filtering, cached stale-data display on failures, and deduplicated issue-to-task creation.
- Existing cloud-run linking, observed-state and offline display, shared cloud detail/log UI, cancellation, result import, and duplicate branch-row protection on repeated imports. No second cloud scheduler or runner.

The board intentionally uses activity excerpts in Mission Control. It does not create a second terminal controller. Structured free-text question tooling, Lead-agent orchestration, scheduled loops, and phone access remain the later extensions identified in the plan.

## Automated verification

Latest bug-fix verification: 105 TypeScript tests passed across 23 files, with type checking and the production frontend build passing. The native implementation was unchanged in this fix pass; its preceding verification passed 78 Rust tests with 1 existing ignored test, the native build and SQLite integrity checks.

Run:

```sh
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

The existing target directory contained cached absolute build paths from a previous repository location. Verification used `CARGO_TARGET_DIR=/tmp/powerhouse-task-board-target`; this avoids deleting the user's existing build cache. The native bundle also built successfully using this target directory.

Regression coverage includes simultaneous starts, multiple permissions, duplicate/stale answers, resume fallback, late events after session replacement, failed/canceled turns, background launch without navigation, launch failure retaining its workspace, idempotent branch/issue adoption, stale issue cache and pagination, sibling-session failure, completed-merge invalidation, merge-history eviction, cloud outcome projection, hidden workspace isolation, serialized persistence, Git worktree recovery and GitHub remote validation.

CodeRabbit review was attempted, but the installed CLI required authentication. Direct code review and the automated checks were used instead.

## Native and service acceptance

An isolated native test bundle was built and launched with a disposable repository and a deterministic ACP fixture. Its test database was created in the isolated directory. Desktop automation repeatedly returned `cgWindowNotFound`, including when attempting to bring Finder forward, so interactive UI acceptance could not be completed. This is not recorded as a passed native smoke test.

Still run interactively before release:

- Start two local ACP tasks in the background while keeping another chat/draft selected.
- Observe a permission in Needs You, allow/deny the exact request, and confirm another pending request remains visible.
- Cancel while a draft is present; confirm no follow-up is accidentally submitted.
- Switch between Board, Mission Control, Settings and workspace; confirm sessions and drafts survive and shortcuts target the visible surface.
- Inspect a committed change, run configured checks, merge it, and confirm Done contains merge evidence. Modify the task afterward and confirm Review returns after the Git refresh.
- Quit during preparation/work; reopen, inspect the interruption, and resume without duplicate worktrees or automatic initial-prompt submission.
- Check a real authenticated GitHub repository and live cloud run. Unit tests and the existing cloud suite do not establish live provider/account connectivity.

The GitHub intake cache is retained for the current app session. A restart refetches it; task records and issue identities persist. Local execution does not survive quitting Powerhouse. Native CLI/PTY sessions expose limited activity status, while the complete background workflow uses ACP.

## Isolated native smoke builds

Debug builds recognize `POWERHOUSE_TEST_DATA_DIR` for test telemetry, transcripts, cloud-run state, task worktrees and merge-check worktrees. With it set, startup skips global handoff-command installation and GitHub account reconciliation. Use a distinct Tauri identifier as well to isolate `powerhouse.json`. Release builds ignore this override. This is test isolation, not a user-facing storage preference.

## Review fixes

The four implementation findings from the independent review are addressed:

- Stop during a pending persistence save prevents prompt dispatch. After dispatch, Stop sends protocol cancellation, and stale completion/cancellation callbacks cannot affect a newer turn.
- Deleting the primary chat clears task ownership and resolves its running marker. Restart checks whether the chat actually exists, including recovery of previously persisted dangling references.
- Retry checks uses the same activity and clean-worktree admission checks as initial checks, rechecks activity after Git returns, and preserves the original failure until the new entry is admitted.
- Cloud task details renders only the linked run. Both project and task imports update the task's local workspace linkage, and repeat imports preserve subsequent local work.

Nine regression tests cover these cases. CodeRabbit was retried during the fix pass and still required authentication. Interactive native and live-provider acceptance remain outstanding as described above.
