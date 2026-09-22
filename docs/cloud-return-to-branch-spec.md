# Return to branch — cloud results come home on their own

Date: 2026-09-22. Builds on the one-click send stack
(`cloud-send-to-cloud-plan.md`): branch-named VMs, `cloud_quick_submit`,
per-project env vars, the live feed, and the formless UI. This spec closes
the loop the brief deferred: today a finished run parks its result on
`powerhouse/cloud/<run_id>` and waits for a manual import; after this
feature the result returns to the branch and the chat that sent it, with
zero clicks in the happy path.

## Goal

One sentence: **a cloud run ends where it began.** You click ☁ on a branch
mid-conversation; minutes later the same chat shows what happened, and the
branch itself has the commits — no Cloud-tab spelunking, no review-worktree
detour unless something diverged.

Non-goals (unchanged): follow-up conversations *with the cloud agent* (the
run is one-shot; the returned summary continues in the local chat instead),
multi-writer coordination beyond the existing one-live-run-per-branch gate,
and any change to the runner or protocol — the desktop already has
everything it needs (result manifest, events, published branch).

## UX

1. **Send** — unchanged. The record additionally remembers *which chat* the
   send came from.
2. **Run finishes (completed & published)** — the desktop, on the sync tick
   it already runs:
   - fetches and verifies the result branch (existing machinery);
   - **fast-forwards the local source branch** to the result when that is
     safe (rules below), and pushes the source branch so origin matches;
   - posts a **result card into the originating chat**: outcome, agent
     summary, checks table, changed-files stat, and what integration did
     ("`feat/foo` fast-forwarded to `abc1234`" / "your branch moved —
     review needed"), with a button to open the diff;
   - the branch row's ☁ badge clears as the VM is released (existing).
3. **Run fails / blocks / cancels** — same card, different body: the state,
   the last error, the tail of the live feed, and a "Restore workspace"
   pointer (the park/restore lifecycle already preserves partial work). No
   integration is attempted.
4. **App was closed when the run ended** — on next launch the boot
   reconciliation (already syncs every non-terminal record) performs the
   same return. The card says it arrived late.

## Integration rules (the only genuinely new policy)

The result branch is always commits on top of `manifest.source.commit_sha`
(the runner publishes the tested tree; ancestry is verifiable locally after
fetch). "Return the code" means moving the *local* source branch — which
may be checked out in a worktree with its own state — so safety is strict:

fast-forward the local branch **iff all of**:
- the local branch still points at `source.commit_sha` (nothing happened
  locally since the send — the WIP checkpoint is that commit);
- its worktree is clean (`status --porcelain` empty);
- `result_sha` is a descendant of `source.commit_sha`
  (`merge-base --is-ancestor`).

Then: `git merge --ff-only <result_sha>` in that worktree, followed by
`git push origin <branch>` (never force). Origin, local branch, and chat
now agree.

Anything else — local commits, dirty tree, rewritten history — is
**Diverged**: no automatic writes, the chat card explains what moved and
offers the existing review-worktree import (`cloud/<run8>`) so the user
merges on their own terms. A deleted local branch or worktree is treated
as Diverged with "branch no longer exists locally" wording.

The run's remote output branch `powerhouse/cloud/<run_id>` is deleted after
a successful fast-forward (its commits are now on the source branch) and
kept in every other outcome.

## Design

### Record (desktop store only; no protocol change)

`CloudRunRecord` gains:

- `origin_chat_id: Option<String>` — set at submit from the branch's active
  chat; `None` for sends from the Cloud-tab button with no chat.
- `returned: Option<ReturnOutcome>` — `FastForwarded { sha }`,
  `Diverged { reason }`, `ReportedOnly` (failed/blocked runs), plus
  `return_error: Option<String>` for retryable failures (e.g. fetch died).

`QuickSubmitRequest` gains `chat_id: Option<String>`; the frontend passes
`branch.activeChatId`.

### Backend flow

New `do_return(mgr, run_id)` called from the same place the release gate
already runs (`advance_after_terminal`, after `remote_verified`): idempotent,
persists intent before each git operation like everything else in
`commands.rs`, records `returned`/`return_error`, and emits the normal
`cloud-run-update`. Terminal-but-not-completed runs set `ReportedOnly`
immediately. A `return_error` is retried by the lifecycle tick, mirroring
"release pending".

No new IPC surface: the frontend learns everything from the record update.

### Frontend flow

A store-level watcher (in `startCloudSync`, next to the existing
`cloud-run-update` listener) notices a record transitioning to
`returned != None && !chat_notified` and appends one **cloud-result item**
to the transcript of `origin_chat_id` (fallback: the branch's first chat;
no chat at all → Cloud-tab card only, which exists today).
`chat_notified` is store-frontend state keyed by run id so restarts don't
double-post; the transcript item itself carries the run id for dedupe.

The transcript renderer gains one item kind, `cloud-result`, rendered as a
card: outcome dot, agent summary (from `ResultManifest`), checks with
pass/fail, `diff --stat` line, integration sentence, and two actions —
"View diff" (existing cached diff) and, when Diverged, "Import for review"
(existing `cloud_import`).

## Slices

1. **Remember the chat** — `chat_id` through quick submit into the record.
   Trivial, unblocks the rest, ships alone.
2. **Auto-return the code** — `do_return` with the fast-forward rules,
   wired into the terminal path + lifecycle retry. Verifiable headless
   (this is where all the git edge cases live).
3. **The chat card** — transcript item + renderer + watcher. Pure frontend.
4. **Polish** — delete the output branch after fast-forward, "arrived
   late" wording after a cold boot, `ReportedOnly` cards for failed runs.

## Risks

- **Racing the user's checkout** — the fast-forward runs in a worktree the
  user may be typing in. Mitigation: the clean-tree + unmoved-HEAD check
  happens immediately before the ff in the same lock, and `--ff-only`
  cannot rewrite anything; worst case it fails → Diverged path.
- **Double-posting to chat** — restarts replay record updates. The run-id
  dedupe on the transcript item is the guard; the watcher is idempotent.
- **Chat/branch deleted mid-run** — every fallback ends at the Cloud-tab
  card, which is today's behaviour, so nothing is ever lost.
- **Push rejected on return** (protected branch, remote moved) — the ff
  stays local, the card reports the push failure verbatim, retry via tick.

## Verify

- Quick-submit from a chat, touch nothing: run completes → same chat shows
  the card, `git log` on the branch shows the cloud commits, origin
  matches, output branch gone, no dialogs anywhere.
- Commit locally while the run is in flight → card says Diverged, branch
  untouched, "Import for review" produces today's review worktree.
- `POWERHOUSE_CLOUD_E2E_SCRIPT=fail` → ReportedOnly card with the error and
  feed tail; no git writes.
- Quit the app before the run ends, relaunch → the same card arrives once.
