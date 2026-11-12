# ATeam task workflow for Powerhouse

Planning baseline: 2026-11-12. Powerhouse commit `10abad63e8276258b3c222c7a96091241a3bbc75` (`feature/readable-agent-chat`), with navigation/UI edits still in progress. Recheck those files before implementation. Implementation of increments 1–6 is now on `feature/ateam-task-board`. See [implementation and verification](task-board-verification.md) for delivered behavior and remaining live-test limits. The design below records the intended architecture.

Build a task workspace around Powerhouse's existing worktrees, chats, permissions, diffs, and merge queue. The useful outcome is that Joost can start several tasks, leave agents working, handle the ones needing him, and review and land finished work from one board.

The first release should deliver that entire loop locally. GitHub issue intake and Mission Control follow it. The Lead assistant, scheduled loops, and remote coordination are separate extensions.

## Reference and scope

The installed ATeam app is version **0.1.92**; its board and new-task composer were inspected directly. Its current Workflows project showed five columns, GitHub issues in Backlog, task search, Mission Control layouts, and cleanup. The composer offers an optional title, a prompt, an agent, an execution location, and separate background/open launch gestures. No task was created or agent started during inspection.

The source reference is [clawnify/ateam at f73fb86](https://github.com/clawnify/ateam/tree/f73fb86c5091ce7609009ab853f9aa94114a4655), cloned for read-only analysis to `/tmp/powerhouse-ateam-reference-20261112`. The upstream checkout and installed release are distinct baselines; advanced behavior below was established from source, not exercised live.

ATeam's [license](https://github.com/clawnify/ateam/blob/f73fb86c5091ce7609009ab853f9aa94114a4655/LICENSE) specifies GPL-3.0-or-later or a commercial license. The proposed approach is to implement the workflow within Powerhouse's own architecture. Any direct source reuse needs an explicit licensing decision before it is incorporated.

### What makes ATeam's board work

- **A task owns an isolated workspace.** Its persisted model associates one task with one branch/worktree and multiple agent sessions. GitHub backlog issues can exist before a task/worktree is created.
- **Activity drives placement.** Working events move work into In Progress; permissions and questions surface Needs You; a finished agent turn reaches Review; merge evidence supplies Done. A finished turn is not proof that the work shipped.
- **Attention remains visible.** Pending questions and proposals hold the card in Needs You even when other events arrive. Answers identify the specific question and reject stale responses.
- **Starting work does not steal focus.** The composer can start a task in the background or open it immediately. Each board column orders tasks by recent activity.
- **The card opens the work.** A task leads to its sessions, changes, questions, and merge controls. Mission Control is another view of those same tasks.
- **Recovery and cleanup are distinct.** Session recovery, archiving, and deleting a worktree are separate operations. Offline remote tasks keep their last-known cards.

Relevant upstream source:

| Responsibility | Source |
| --- | --- |
| Task, session, question, PR and archive fields | [schema.ts](https://github.com/clawnify/ateam/blob/f73fb86c5091ce7609009ab853f9aa94114a4655/packages/db/src/schema.ts#L16) |
| Event-to-status mapping and hook processing | [engine.ts](https://github.com/clawnify/ateam/blob/f73fb86c5091ce7609009ab853f9aa94114a4655/packages/server/src/engine.ts#L215) |
| Keep pending decisions visible | [repo.ts](https://github.com/clawnify/ateam/blob/f73fb86c5091ce7609009ab853f9aa94114a4655/packages/db/src/repo.ts#L31) |
| Worktree/task creation and session launch | [sessions.ts](https://github.com/clawnify/ateam/blob/f73fb86c5091ce7609009ab853f9aa94114a4655/packages/server/src/sessions.ts#L135) |
| Columns, composer integration, board and task panel | [App.tsx](https://github.com/clawnify/ateam/blob/f73fb86c5091ce7609009ab853f9aa94114a4655/apps/desktop/src/renderer/src/App.tsx#L180), Board begins at line 3346 |
| Question validation and answer delivery | [questions.ts](https://github.com/clawnify/ateam/blob/f73fb86c5091ce7609009ab853f9aa94114a4655/packages/server/src/questions.ts#L132) |
| Agent-facing board tools | [board-mcp.ts](https://github.com/clawnify/ateam/blob/f73fb86c5091ce7609009ab853f9aa94114a4655/packages/server/src/hooks/board-mcp.ts) |
| Deduplicated issue-to-task conversion | [issue-tasks.ts](https://github.com/clawnify/ateam/blob/f73fb86c5091ce7609009ab853f9aa94114a4655/packages/server/src/issue-tasks.ts) |

## Powerhouse integration decisions

Powerhouse already supplies the expensive execution primitives. Preserve them and introduce task ownership and shared session state.

| Existing capability | Integration |
| --- | --- |
| `Branch` → `Chat[]`, worktree paths | Link a task to an existing branch; do not duplicate chats or transcripts in tasks. |
| `createBranch`, `createChat`, Rust Git commands | Separate workspace allocation, chat creation, launch, and navigation so background tasks actually run. |
| `acpRegistry` and `useAcpSession` | Move session ownership and live snapshots out of component-local state. Keep ACP as the main agent transport. |
| `AgentControls` | Keep capability-driven agent controls; do not add provider-specific UI branches. |
| `RightSidebar`, `DiffView`, `QueuePane` | Open the linked workspace for review and reuse its existing checks/landing flow. |
| Tauri store persistence | Add versioned task records and migration to the existing store; introduce no task database in the first release. |
| Telemetry Tasks | Keep these derived analytics rows separate from editable product tasks. Link IDs for diagnostics when useful. |
| Cloud runner and `cloud.ts` | Later associate cloud run IDs with tasks and project their observed status. Keep existing submission/reconciliation machinery. |

The current `ChatStatus` (`idle/running/exited`) describes process availability, not whether the agent is working or waiting. `useAcpSession` currently owns `busy` and a permission resolver in React state. Its auto-start effect also requires `active`, while `createChat` selects the new branch. Merely rendering cards over these fields would produce misleading statuses and background tasks that never start.

Current navigation is the simplified project workspace plus Settings. Older `docs/workflows-plan.md` describes navigation that no longer matches this baseline. Add Board as a primary workspace surface; do not restore old navigation or mix this work into the DBOS workflow plan.

### Task model

Add `src/features/tasks/types.ts`, a small task store slice in `appStore.ts`, and pure selectors/transitions in `taskState.ts`.

Persist a `Task` with:

- `id`, `repoId`, `title`, `description`, `createdAt`, `updatedAt`.
- `branchId: string | null` and `primaryChatId: string | null`. A backlog task has no workspace until Start; an existing branch can be attached without moving files. Enforce one task per branch in the first release.
- `source` as a local origin or a GitHub repository/issue identity; the latter arrives with issue intake.
- `archivedAt`, `lastActivityAt`, `lastSeenActivityId`, and a bounded latest activity summary.
- `launch` with a stable attempt ID, stage (`not_started`, `preparing`, `ready`, `interrupted`, `failed`), allocated branch/chat IDs, and a recoverable error.
- A last turn outcome and explicit completion evidence, such as the queue entry and merged commit, or a user completion record for non-code work.

The displayed column is a **projection**, not a freely writable field. Derive it from task lifecycle, the latest session snapshots, unresolved attention items, and current merge evidence. Keep task identity independent of title and branch name. Renaming a task must not rename its branch.

Keep runtime snapshots separate: `chatId`, connection/attempt generation, transport capability, working/idle/error state, current turn ID, pending permission IDs, and last activity. Promise resolvers, connections, and terminals never go into persisted state. Durable history can say a permission was interrupted; it must not recreate a live approval after restart.

For multiple chats, aggregate across all chats attached to the branch: any unresolved permission wins over another chat working; one idle chat cannot move a task to Review while another is busy. Plain shells do not count as working agents.

### Column rules

Evaluate these rules in order, excluding archived tasks from the normal board:

| Column | Rule and available action |
| --- | --- |
| Needs You | Any live permission/question, unreconciled launch, unexpected interruption, or failed check requiring action. Show the reason and the exact session or check. |
| In Progress | Any agent turn is starting/running/canceling, or the task is queued/validating/merging. Display a precise badge such as Preparing, Running checks, or Canceling. |
| Done | Completion evidence is current and there is no newer work or unresolved attention. Show Merged or Completed, as appropriate. |
| Review | An agent turn ended normally, work awaits human inspection, or an existing branch has been attached for review. |
| Backlog | The task has not started, or was explicitly returned here while idle. |

Store distinct turn outcomes: normal completion, cancellation, error, and interrupted. Do not use the `onBusyChange(false)` callback alone as a success signal: it also runs when `session/prompt` fails. Preserve the returned ACP stop reason and normalize it explicitly. A requested cancellation becomes Stopped with Resume/Retry available, not a success badge.

Done cannot be inferred from silence, a closed terminal, a clean diff, or a model saying it is finished. A new prompt reopens a completed task. Associate queue completion with the run/revision it validated; a sticky `Branch.merged` boolean must not mark later work Done. Failed or canceled checks do not count as delivery. Manual completion is a named action for non-code work and does not increment merged-code telemetry.

Do not add unrestricted drag-and-drop status changes. Start, Stop, Resolve, Return to backlog, Complete, and Archive have defined semantics. A later drag interaction can invoke those same actions where valid.

### Shared session ownership

Introduce `src/lib/agentSessionService.ts` over `acpRegistry.ts`. Its narrow API should expose start/resume, send, cancel, resolve permission, close, snapshot, and subscribe. The service owns one controller per chat; React hooks subscribe to it. Opening the same chat in a board inspector and the workspace must not create two owners or two subprocesses.

Initially move the existing lifecycle behavior intact: transcript updates and replay, session IDs, advertised controls, diagnostics, permission cancellation, handoff watches, and telemetry annotation. Then add the board's event projection. Preserve the per-connection TextDecoder and the distinction between session/load replay and session/resume.

Use attempt generations to reject stale callbacks after stop/restart. Permission resolutions must match the active chat, connection generation, and request ID, and settle once. Board and chat resolve the same pending request. Multiple requests should be queued or individually indexed; a second request must not silently replace the first.

PTY/custom agents initially show only verified process facts and an explicit limited-status badge. Do not scrape terminal output to guess business status. Keep native CLI as the existing separate companion conversation. Provider hook adapters can be added later if parity becomes necessary.

### Creation and persistence

`createTask` saves a backlog record. `startTask` performs an explicit sequence: persist a launch intent → allocate or recover the worktree → persist its IDs → create the chosen agent chat → start it → submit its first prompt. Navigation is a separate final choice: Start in background or Start and open.

Allocate worktree names from a readable slug plus a task-ID suffix. The current Rust allocator uses repository basename and branch slug, so clones with identical names need a stable repository suffix for new task workspaces. Keep existing paths intact and validate Git refs using argument vectors.

Refactor persistence to serialize writes and expose an awaited flush for launch boundaries; its current 300 ms debounce is insufficient as an admission receipt. Record enough identity to find a worktree if the process dies after Git succeeds but before the next save. Retries reuse the same intent and existing allocation. Never delete a partially prepared workspace merely because agent startup failed.

Do not promise exactly-once prompt execution after a crash. If a prompt may have reached the agent before its acknowledgement was saved, surface an uncertain/interrupted launch and let the user resume and inspect the existing session. Do not silently resend the initial prompt. A first prompt must not run again just because resume fell back to a new session.

Migration is additive and idempotent. Back up the previous tree before writing a new schema version. Retain repositories, branches, sessions, settings, queues, and workflow drafts. Offer Attach existing branch and bulk adoption with deterministic task IDs; leave legacy branches usable until adopted. Never create worktrees during hydration.

### Board experience

Add a Board entry near the primary project navigation, with current-project and all-project scopes, search, column counts, and New task. Cards show title, project, agent, current reason, recent activity, unread indicator, and a compact changes/checks summary when available. Sort within each column by meaningful activity, with a stable ID tie-breaker.

Opening a card selects its linked task/workspace. The first implementation can use the current full workspace with Back to board; a split inspector is a follow-up if space permits. Keep chats and terminals mounted across navigation. Hidden surfaces must be inert and keyboard shortcuts must act only on the visible view.

Needs You must expose the existing ACP permission options and the affected tool directly, or open that exact permission in its chat. Read/unread is separate from resolved/unresolved: opening a card never grants permission. Free-text questions that lack a structured event remain visible in the final reply under Review; do not label every ended turn as a question. Structured question cards can follow through an explicit tool integration.

Archiving hides the card and retains its workspace and history. Active work or unresolved permissions prevent archive in the first release. Cleanup is a separate user action with dirty/untracked-file and active-session checks before the existing destructive removal flow. Deleting a task must not leave a dangling branch reference, and removing a branch must update its task.

## Delivery sequence

### 1. Task records and adoption

Files: new `src/features/tasks/{types,taskState}.ts`; `src/store/{appStore,persist}.ts`; related tests.

Deliver task CRUD, versioned hydration, serialized persistence/flush, archive, branch attachment, and the pure status projection contract. Write the transition tests before connecting live sessions.

Acceptance: old persisted data opens unchanged; repeated migration/adoption creates no duplicates; backlog survives restart without a worktree; deleting or detaching a branch has defined behavior; completion evidence never masks newer work.

### 2. Shared sessions and background launch

Files: new `src/lib/agentSessionService.ts` and `src/features/tasks/taskActions.ts`; `src/hooks/useAcpSession.ts`; `src/lib/{acpRegistry,actions}.ts`; `src-tauri/src/git.rs` and IPC if allocation changes require it.

Extract session ownership, publish meaningful status events, and implement recoverable task launch. Preserve existing chat behavior before wiring the board. Make background start independent of `active` and selection. Keep launch double-click protection in the service, not only a disabled button.

Acceptance: two tasks start while the first remains selected; each prompt reaches its intended worktree once during normal operation; a failed agent start retains its workspace; a permission in one session is not hidden by another; restarting or switching views cannot duplicate a process. Crash tests at each launch boundary recover or present an explicit uncertain state.

### 3. Board, composer and Needs You

Files: new `src/features/tasks/{TaskBoardPage,TaskCard,TaskComposer,TaskAttention}.tsx`; `src/App.tsx`; `src/components/Sidebar.tsx`; `src/hooks/useShortcuts.ts`; existing ACP permission components.

Deliver the five columns, scoped search, prompt-first creation, background/open actions, counts, unread/activity, task navigation, and shared permission resolution. Use Powerhouse's existing visual language and design tokens.

Acceptance: start three tasks, continue viewing one, observe another request permission, resolve that request from the board, and return to the same chat/draft. Verify keyboard navigation, narrow-window scrolling, focus, and hidden-surface shortcuts. A second click or stale answer must never authorize a later request.

### 4. Review, landing and recovery

Files: task state/actions; `src/lib/queueSync.ts`; `src/store/appStore.ts`; existing `RightSidebar`, `DiffView`, queue UI, and cleanup actions. Extend queue result metadata if needed to identify the exact validated source revision.

Wire Review to existing changes and checks. Expose the existing enqueue action with its configured push behavior visible. Move to Done only on current completion evidence. Implement archive/restore and restart reconciliation. Local sessions require explicit resume after an app restart; the board must show interruption instead of restoring a false Running state.

Acceptance: a failed check surfaces Needs You; a successful merge yields Done with commit evidence; a new prompt reopens the task; archive preserves files; cleanup refuses unsafe silent deletion; quit/reopen produces no launch storm or stale actionable permissions. Existing ACP replay, composer Stop behavior, queue, cloud, and telemetry checks still pass.

**First-release stop condition:** create → background work → permission handling → review → validated landing → restart recovery works for multiple local ACP tasks. This is a complete useful system before adding more orchestration.

### 5. GitHub issue intake

Extend `src-tauri/src/github.rs` using the existing authenticated Rust/keychain boundary. Add repository resolution, paginated issue reads, error/freshness state, and task-source matching. Display issue-only backlog entries without allocating worktrees. Starting one creates or returns its unique task, keyed by normalized repository identity and issue number.

Acceptance: repeated refresh/start does not duplicate tasks; cached issues remain visibly stale on network/auth failure; PRs returned by issue endpoints are excluded; linking or completing a task does not silently close an issue, post a comment, or create a PR. Issue/PR writes are separate explicit actions. Later PR-merge observation can supplement local merge-queue evidence.

### 6. Mission Control and existing cloud runs

Build a grid from the same task selectors and session snapshots. Start with activity excerpts, attention cards, and explicit open controls; add live terminal surfaces only after measuring rendering and input ownership. Avoid mounting a second writable terminal for the same session.

Link the existing cloud-run identity to a task. Map preparing/running/validating/publishing to In Progress, blocked/failed/interrupted to Needs You, and completed to Review. Render stale/offline state with its last confirmed timestamp. Reuse cloud import, cancellation and reconciliation; do not submit replacement jobs on a failed poll. Cloud completion is not proof of merge.

Acceptance: board and grid agree; hidden tiles do not consume input; offline cards remain visible; reopening Powerhouse reconciles the original cloud run; importing a result preserves task/run lineage and does not duplicate the task.

## Later extensions

After the first-release loop proves useful, add structured agent questions and proposals through a capability-tested board tool bridge. `acpRegistry.ts` currently passes empty `mcpServers` arrays, so tool exposure and adapter support require explicit integration. Start with task lookup and questions; reject stale responses and persist an auditable proposal outcome. Agent-proposed work should open a prefilled composer for the user's decision.

A Lead assistant can then summarize tasks, navigate to work, and propose new work using those same APIs. Inter-agent messaging, autonomous task creation, automatic merging, scheduling, phone access, and ATeam's remote daemon are outside the initial scope. Recurring automation belongs with Powerhouse's existing cloud/workflow design once its server-side orchestration is implemented.

## Verification and handoff

Run focused unit/component tests for each increment, then the repository's `pnpm verify` gate before merging implementation. Use temporary Git repositories for worktree-allocation, interrupted-creation, same-name-clone, and cleanup tests. Mock ACP at the protocol boundary for permission races, cancellation/error outcomes, stale callbacks, multi-chat aggregation, and prompt-admission recovery.

Run a native-app smoke test with the supported installed ACP agents: start in the background, switch views, resolve a permission, stop with an unsent draft, resume, inspect a diff, and run configured merge checks. Exercise local crash recovery separately from remote continuation. Local processes currently die with Powerhouse; closing the app is not a background execution guarantee.

No application tests were run for this planning-only change. Implementation should begin with increments 1 and 2, since the board UI depends on reliable task identity and session state. Recheck the ongoing navigation edits first and keep this work additive.
