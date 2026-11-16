# Plan: every chat runs on its own boxd VM

Goal: a new chat creates a boxd VM, the agent runs there, and the chat pane is the ACP client for it. The
agent keeps working while the laptop is closed; reopening the app catches the chat up. Local chats stay
as an option. The old Cloud button, cloud workspaces, handoff, `server/` and `cloud/runner` go away.

Read first: `AGENTS.md` (branch and release rules), `src-tauri/src/acp.rs`, `src/lib/acpRegistry.ts`,
`src-tauri/src/cloud/transport.rs`.

## Decisions (agreed 2026-11-15)

| Topic | Decision |
|-------|----------|
| Granularity | One chat = one branch = one VM. "Several chats per branch" goes away. |
| Default | New chats run in the cloud. The new-chat picker offers **Local** as the alternative. |
| Survives laptop close | Required from the start: the agent runs detached on the VM under `ph-agentd`. |
| Permissions | Cloud chats run with permissions bypassed (the VM is the sandbox). You still chat live. |
| Cap | At most 5 chat VMs. Creating a 6th asks you to archive one. |
| Secrets | Keep the Keychain, `preflight()` and per-project env vars from `cloud/secrets.rs`. |
| VM setup | Conductor-style scripts in a committed `powerhouse.toml`, baked into a per-repo snapshot. |
| Deleted | Handoff, the cloud workspace flow, `server/`, `cloud/runner` (mine `systemd.rs` first). |

## What the spike measured (2026-11-15, throwaway `ph-spike` VMs, all destroyed)

- `boxd new`: under 1 s. The VM is x86_64 Ubuntu with systemd 255, user lingering on, and `claude`,
  node 24, `git`, `gh` and `tmux` already installed.
- `boxd snapshots save`: 2 s. `boxd new --from-snapshot`: 1 s, with a 177 MB `node_modules` intact and
  usable on the first `exec`.
- **Snapshots include memory.** A process running at save time keeps running in every machine
  restored from it. The build VM must have no agent or service running when it is snapshotted.
- **A process under a plain `boxd machine exec` dies when the client disconnects.** One started with
  `systemd-run --user` keeps running. So the detached supervisor is required, not optional.
- `boxd machine exec` streams stdin and stdout both ways with about 1 s first-byte latency. ACP
  `initialize` over `exec` against `npx -y @agentclientprotocol/claude-agent-acp` (v0.107.0) works. It
  reports `loadSession`, `resume`, `promptQueueing` and steering.
- The `npx` cold start is slow (tens of seconds). Install the ACP adapter globally in the snapshot and
  pin the version.
- `boxd env` already injects `CLAUDE_CODE_OAUTH_TOKEN` org-wide on this account. The Keychain upload
  stays the primary path; this is a fallback, not a dependency.
- boxd's stderr carries a "new version available" notice. Never merge stderr into the ACP stream.

## Architecture

```
Chat pane (ACP client, unchanged UI)
   │  JSON-RPC lines over stdin/stdout
acp.rs  spawns  boxd machine exec ph-c-<slug> -- node ~/ph-agentd.mjs attach --chat <id> -- <agent argv>
   │
VM: ph-agentd serve (systemd --user unit ph-agent-<id>, one per chat)
   ├─ owns the agent process (claude-agent-acp, cwd ~/repo)
   ├─ keeps every session/update in memory, numbered with _meta["ph/seq"]
   └─ unix socket ~/.ph/agents/<id>/sock; one attached client at a time
```

### `ph-agentd` (**built**: `agentd/ph-agentd.mjs`)

A single Node script with no dependencies instead of the Rust binary planned earlier. Node 24 is on
every boxd VM and the Claude adapter needs it anyway, so there is nothing to cross-compile and nothing
to add to CI. The app will embed the file and copy it to the VM with `boxd machine cp`. The full
contract is in the file header. In short:

- `attach` is the only call the app makes. It starts `serve` (via `systemd-run --user`) when none is
  running, then bridges stdin and stdout to the socket.
- Each `session/update` carries `_meta["ph/seq"]`. The app stores the last seq it rendered and
  reconnects with `session/resume` + `_meta["ph/fromSeq"]`. `ph-agentd` answers that call itself:
  it replays the missed updates, re-sends held permission requests, and returns the current modes and
  config options.
- `initialize` reaches the agent once; later clients get the cached result.
- Client request ids are remapped, and responses for a client that has gone are dropped.
- `_ph/turn` notifications carry turn state for prompts the current client did not send. Every resume
  ends with `{running: true}` or `{running: false, stopReason}`.
- **Gotchas found on real VMs:** systemd user units start with a bare environment, so `attach` passes
  its own through (`--setenv=NAME`, which keeps values off the command line). Global npm installs sit
  in nvm's bin, which the exec shell's PATH misses, so `serve` puts node's own directory first. And a
  client vanishing gives `ECONNRESET` on Linux, which readline re-emits and which would kill `serve`
  if unhandled.
- **Tests:** `pnpm test` runs `agentd/test/agentd.test.mjs` against a scripted fake agent, including
  one test through the real ACP SDK client. `node agentd/test/vm-e2e.mjs` runs the real adapter on a
  throwaway VM. It drops the connection mid-turn, lets the agent finish one tool call and start
  another while disconnected, reconnects, and checks that replay is gapless, the work completed, and
  the mode survived. About 1 minute.

### Builds (`powerhouse.toml`, committed at the repo root)

```toml
[vm]
size = "2x8G"          # boxd --vcpu
install = "scripts/vm-install.sh"   # system tools, once per build
setup   = "pnpm install"            # every new chat VM (fast: deps are already warm in the snapshot)
run     = "pnpm dev"                # optional Run button, previewed at https://ph-c-<slug>.boxd.sh
archive = ""                        # optional, before the VM is destroyed
```

- **Build** = fresh `ph-b-<repo>` VM → clone default branch to `~/repo` → copy `ph-agentd.mjs`, install
  the ACP adapter (`npm i -g @agentclientprotocol/claude-agent-acp@<pinned>`, about 12 s) → `install` → `setup` → stop anything running → `boxd snapshots save` as
  `ph-<repo>-b<n>` → destroy the build VM. Record the build in `~/.powerhouse/vm-builds.json`.
- Keep the last 3 successful builds per repo. "Activate" an older one to roll back.
- New builds trigger from Project settings (**Build VM image**), and automatically, in the background,
  when the lockfile or `powerhouse.toml` changes on the default branch.
- No `powerhouse.toml`: fall back to clone plus a detected install (`pnpm`/`npm`/`cargo`), and say so in
  the build log.
- Login-shell PATH gotcha (same as Conductor): `install` runs non-login, and chats run login. Installers
  that edit PATH must append to `~/.profile`.

### New cloud chat flow

1. Cap check: 5 `ph-c-*` VMs already exist → ask which one to archive.
2. Create branch `ph/<slug>` from the target branch.
3. `boxd new ph-c-<slug> --from-snapshot <active build>`.
4. Upload `~/.ph/env` (existing `secrets::workspace_env` and project env), then `git fetch`,
   `git checkout -b ph/<slug> origin/<target>`, then run `setup`.
5. `acp_spawn` with the `exec … ph-agentd.mjs attach` command. The session starts in bypass-permissions
   mode.

Target for steps 2–5: under 10 s to the first prompt.

### Workspace backend (needed because local stays an option)

- `Branch` gains `location: "cloud" | "local"` and `vm?: string`. `worktreePath` stays for local.
- Rust: `enum WorkspaceRef { Local(PathBuf), Vm { name, path } }`. `git.rs` file, diff and status
  commands run git through a small runner trait: local `Command`, or `boxd machine exec`. Cache results
  per branch for a few seconds, because each remote call costs about 1 s.
- **Terminal:** `pty_spawn` runs `boxd machine exec --tty ph-c-<slug> -- bash -lc 'cd ~/repo && exec bash -l'`.
- **Merge queue:** before enqueueing, the VM pushes `ph/<slug>`. The queue then fetches and merges
  `origin/ph/<slug>` in the local repo exactly as today.

### Lifecycle

- **Auto-suspend risk:** boxd suspends on idle *network*, but an agent running a long silent build has
  no traffic. Create chat VMs with auto-suspend off, and have the app pause or hibernate them itself:
  pause when the chat has been idle for 15 min, hibernate after 2 h. Opening the chat wakes the VM.
- Archive chat → `archive` script → `boxd machine rm -y`. Merging via the queue offers to archive.
- Keep the `ph-` guard in `transport.rs`. On first launch, list leftover `ph-<branch>` VMs from the old
  cloud workspaces and offer to delete them.

## Slices (each one: feature branch → PR into `test` → beta → verify)

0. **Done:** the spike above.
1. **Done:** `ph-agentd` and its tests (see above).
2. **Done:** builds. `src-tauri/src/vm/builds.rs` and `config.rs`, plus Project settings → Cloud VM. A real
   build of a small repo takes about 22 s. The build puts node's real bin directory on `~/.profile`'s PATH,
   because global npm tools are otherwise missing from login shells. This repo's `powerhouse.toml` installs
   Rust and the Tauri libraries and warms the cargo build.
3. **Done:** cloud chats. `vm/chats.rs`, plus the Cloud/Local switch in New branch (Cloud by default).
   A chat VM is ready about 5 s after restore. Cloud branches keep a local worktree for now, so the Files,
   Diff and terminal tabs and the merge queue keep working on local state until slices 4 and 5 make them
   follow the VM. Chats re-attach on mount, reconnect with backoff when the link drops (a dropped turn is
   not a failure), and start in bypass-permissions mode. One chat per cloud branch. Known gap: builds and
   VM creation run over a single `exec`, so closing the laptop mid-build fails the build.
4–5. **Done, as one slice:** the local worktree mirrors the VM (`src-tauri/src/vm/sync.rs`). Instead of
   reading every file over `exec`, the VM snapshots its working tree when a turn ends (new files included,
   ignored files not, branch and index untouched) and bundles it with any unpushed commits; `boxd machine
   cp` brings the bundle to the Mac, which fetches it into a local-only `refs/ph/wip/<branch>`. Nothing goes
   to GitHub (the repo may be public). The local
   worktree then takes the VM's HEAD as its tip and the snapshot as its working tree, so Files, Changes and
   Diff work unchanged. The worktree is a read-only mirror: syncing discards local edits there. Changes →
   ↻ pulls a fresh snapshot. **Merge** first commits everything left on the VM (message: the chat's title
   if renamed, else its first prompt line, else the branch name), pushes the branch, resets the local branch
   to it, then runs the normal queue. The Shell tab opens `bash -l` in `~/repo` on the VM; the Agent CLI tab
   is unavailable on cloud branches. Deleting the branch also deletes its local mirror ref. Diff follows the VM at
   the end of each turn, not live mid-turn.
6. **Done:** removed handoff (Rust watcher, `/handoff` command seeding, button, store state), the cloud
   workspace flow (`claude -p` turns, polling, result cards, banner, recap, "bring back local", the Cloud
   button and its readiness check), `server/`, the `cloud/` runner crates, `scripts/cloud-base-setup.sh`,
   and their docs. About 14k lines. Kept and moved: Settings → Cloud tokens and project env vars
   (`src-tauri/src/vm/settings.rs`), the boxd transport, secrets and VM git helpers (`src-tauri/src/cloud/`),
   the Machines tab. "Also write `.env`" now applies to cloud chat VMs. Saved chats lose their old cloud
   result cards and recaps when loaded.
7. **Done:** lifecycle. Measured on real VMs first: an idle VM with boxd auto-suspend goes to `standby`
   with its memory kept (a running process is frozen, not killed), any `exec` wakes it in about a second,
   an attached `exec` connection keeps it awake, and outbound traffic every 30 s keeps it running.
   Chat VMs are now created with a 10-minute auto-suspend. `ph-agentd` makes a small outbound request
   every minute while a turn runs, so a silent build is never suspended mid-turn. An off-screen cloud
   chat with no turn running lets go of its VM after 10 minutes (parked), so the VM can suspend; opening
   the chat reattaches. Waking skips `machine start` for standby VMs. A merged cloud branch has its VM and
   mirror ref deleted after the queue reports the merge; the chat keeps its transcript. Every new chat VM
   gets the current `ph-agentd`, whatever image it came from. No one-time cleanup of old cloud workspace
   VMs: the Machines tab lists and deletes any stray `ph-` machine.

## Open questions

- v1 cloud chats are Claude only (decided 2026-11-15). pi and other agents can follow later.

## Security rules (2026-11-16)

- Cloud agents run without permission prompts, so a VM only ever gets a GitHub token from Settings → Cloud
  (Keychain `github_token[:owner[/repo]]`), meant to be fine-grained and limited to the repos Powerhouse may
  push to. There is no fallback to the GitHub sign-in: without a token, builds and chat VMs refuse to start.
- The agent's uncommitted work never leaves boxd and this Mac: the mirror travels VM → Mac as a git bundle.
  The only push to GitHub is the branch itself, at Merge.
