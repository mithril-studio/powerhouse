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
acp.rs  spawns  boxd machine exec ph-c-<slug> -- ph-agentd attach --chat <id> --from <seq>
   │
VM: ph-agentd (systemd --user unit, one per chat)
   ├─ owns the agent process: claude-agent-acp, cwd ~/repo
   ├─ appends every agent→client message to ~/.ph/<chat>/log.jsonl with a sequence number
   └─ unix socket ~/.ph/<chat>/sock; `attach` replays from <seq>, then streams live
```

### `ph-agentd` (new, small Rust binary, `agentd/`)

- `ph-agentd serve --chat <id> -- <agent argv>`: started with `systemd-run --user --unit=ph-agent-<id>`.
  Spawns the agent, logs its output, accepts one attached client at a time on the socket.
- `ph-agentd attach --chat <id> --from <seq>`: what `exec` runs. It bridges stdin and stdout to the
  socket. If no `serve` is running for the chat, it starts one, so the first attach and every reconnect
  are the same call.
- **`initialize` is cached.** The first response is stored. A reattaching client's `initialize` is
  answered from the cache, not forwarded, so the agent sees exactly one handshake.
- **Replay** covers notifications and responses after `<seq>`. The frontend stores the last `seq`
  it rendered per chat (next to `acpTranscript`) and dedupes on it.
- **Agent→client requests while detached** (permission requests, should bypass mode miss one) are held
  until a client attaches. They are not auto-answered.
- Build: cross-compile `x86_64-unknown-linux-musl` in CI, ship it as a release asset next to the app,
  and the app uploads it with `boxd machine cp` during a snapshot build.

### Builds (`powerhouse.toml`, committed at the repo root)

```toml
[vm]
size = "2x8G"          # boxd --vcpu
install = "scripts/vm-install.sh"   # system tools, once per build
setup   = "pnpm install"            # every new chat VM (fast: deps are already warm in the snapshot)
run     = "pnpm dev"                # optional Run button, previewed at https://ph-c-<slug>.boxd.sh
archive = ""                        # optional, before the VM is destroyed
```

- **Build** = fresh `ph-b-<repo>` VM → clone default branch to `~/repo` → upload `ph-agentd`, install
  the ACP adapter → `install` → `setup` → stop anything running → `boxd snapshots save` as
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
5. `acp_spawn` with the `exec … ph-agentd attach` command. The session starts in bypass-permissions
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
1. **`ph-agentd`:** the binary, CI cross-compile, and an integration test on a throwaway VM:
   start it, attach, kill the client mid-turn, reattach, and check that replay has no gaps.
2. **Builds:** `powerhouse.toml` parsing, the build flow, build history in Project settings.
3. **Cloud chats:** the new-chat flow, the `acp_spawn` command for VMs, reconnect on app start and
   wake, the cap. Done when a chat survives quitting the app mid-turn and shows the full turn on reopen.
4. **Workspace backend:** Files, Changes, Diff and terminal for VM branches.
5. **Merge queue** via push and fetch.
6. **Delete** handoff (`handoff.rs`, `handoff.ts`, `/handoff` seeding, `pendingHandoff`), the cloud
   workspace flow (`cloud/commands.rs` start/send/poll/pull, `cloud.ts`, `cloudStream.ts`,
   `CloudBanner`, `CloudResultCard`, `Chat.cloudRecap`, the TabBar buttons), `server/`, `cloud/`,
   `scripts/cloud-base-setup.sh`, `docs/cloud-workspaces.md` and `docs/cloud-env-plan.md`.
7. **Lifecycle:** idle pause and hibernate, archive on merge, cleanup of old VMs.

## Open questions

- Does `session/load` on a *live* claude-agent-acp session replay correctly mid-turn? If so, replay
  could lean on it instead of the log. Test this in slice 1; the log stays the agent-agnostic default.
- Non-Claude ACP agents (pi) on VMs: install them in the snapshot too, or limit v1 cloud to Claude?
