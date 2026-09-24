# Cloud session handoff: the chat goes to the cloud and comes back

The **Cloud** button in the chat tab bar sends the branch *and the active chat* to a cloud VM. The same
Claude Code conversation continues there, unattended. When the run ends, the branch comes home as before
(`docs/cloud-return-to-branch-spec.md`), and so does the conversation: the chat reconnects and shows the
local turns followed by the cloud turns in one transcript.

## What travels

A Claude Code session is a set of files keyed by session id and working directory. The desktop packs them
into a `SessionBundle` (JSON, text only, capped at 64 MiB). The layout is defined once, in
`cloud/protocol/src/session_files.rs`, and used by both sides.

| Bundle root | Desktop | VM |
|---|---|---|
| `project/<id>.jsonl`, `project/<id>/…` | `~/.claude/projects/<slug(worktree)>/` | `<run>/home/.claude/projects/<slug(workspace)>/` |
| `todos/<id>*` | `~/.claude/todos/` | `<run>/home/.claude/todos/` |
| `powerhouse/…` | `<worktree>/.powerhouse/` | `<workspace>/.powerhouse/` |

On each hop, every occurrence of the sender's working directory is rewritten to the receiver's, matching
whole path components only (`SessionBundle::rebase`). That keeps old tool calls pointing at real files and
lets Claude Code find the session through its per-directory slug.

## Flow

1. **Click.** `prepareChatHandoff` (`src/lib/quickSubmit.ts`) applies only to Claude chats over ACP that
   have a session. It cancels any turn in flight, waits for the turn to settle, and closes the agent
   (`detachAcp`), so the transcript on disk is final. The chat's model goes along as the run's model.
2. **Quick submit** (`do_quick_submit`) checkpoints and pushes the branch as before, then packs the session
   (`cloud/session.rs::pack`). With no transcript on disk (a chat that never ran), the send is brief-only,
   exactly as before.
3. **Submit.** The manifest uses **protocol 4** and pins the bundle's size and SHA-256 (`SessionSpec`). The
   bundle is uploaded next to the manifest and passed to `runner submit --session`. The runner verifies
   the pin and keeps the bundle in root-only storage.
   - If the base snapshot's runner does not advertise `session_protocol_version: 4`, the desktop rebuilds
     the manifest as a plain v2 run and the chat stays local. The run card says why.
4. **Run.** `prepare_workspace` installs the bundle into the agent's HOME, then the agent runs
   `claude --print --resume <id>` with a resume prompt (`build_resume_prompt`). Its task line is
   `SESSION_TASK_TEXT`, "continue the work from this conversation".
5. **Capture.** After the agent stops, whatever the verdict, the runner packs the session again, addressed
   back to the desktop worktree, and stores it as `results/<run>/session.json`.
6. **Return.** Once the run is terminal, `bring_session_home` runs `runner session <run> --out …`,
   downloads the bundle (`boxd machine cp vm:… local`), verifies the digest, and writes it back
   (`cloud/session.rs::restore`).
   - The previous transcript is kept as `<id>.jsonl.pre-cloud`.
   - `.powerhouse/` docs are only added, never overwritten.
   - The chat comes back before the branch return, so the result card lands in the continued chat.
7. **Reconnect.** The frontend sees `session.returned = restored`, sets `replayOnResume` on the chat
   (`applyReturnedSession`), and the chat restarts with `session/load` so the whole history replays.
   Cloud result cards survive the replay.

## Invariants

- **One owner at a time.** While a run holds the session (`runHoldingChat`), the composer is replaced by
  the in-cloud panel. Nothing can write the local transcript until the session is back.
- **The VM stays until the chat is home.** `release_gate` refuses while `session.returned` is empty.
  - Held runs retry each lifecycle tick.
  - A run that is parked or released before the chat comes back unlocks the chat unchanged.
- **Nothing is lost locally.** Sending never modifies the local transcript. A run that never continued
  the chat (cancelled early, interrupted, runner error) ends as `Unchanged` and the local session is
  exactly as it was.
  - "Continue here instead" (`cloud_keep_session_local`) unlocks a finished run by hand. It is refused
    while the agent may still be working.

## Limits

- Only Claude chats over ACP travel. PTY chats and other agents send the branch only.
- MCP servers and tools that exist only on the laptop are not available in the cloud; the resume prompt
  says so.
- Deploying this needs a base snapshot built from this runner. Until then, sends fall back to brief-only.
  Publish it with:

  ```sh
  scripts/cloud-base-setup.sh --publish-snapshot powerhouse-base
  ```
