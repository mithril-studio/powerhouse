# Powerhouse

A Conductor-style Mac app: manage repos and parallel git-worktree branches from
a sidebar, and talk to Claude, Codex, and Pi through one shared chat UI.

Powerhouse is an [Agent Client Protocol](https://agentclientprotocol.com/) client.
Each agent keeps its own runtime, authentication, tools, and model behavior; ACP
turns their output into structured events that Powerhouse renders consistently.
The existing xterm/PTY experience remains available from every chat as a fallback.

Tauri 2 + Rust (stdio ACP subprocesses, `portable-pty`, git via `/usr/bin/git`) ·
React + TypeScript + Vite + Tailwind v4 · xterm.js · Zustand.

## Run

```sh
pnpm install
pnpm tauri dev
```

The built-in profiles launch these ACP servers:

| Agent | ACP command |
| --- | --- |
| Claude | `npx -y @agentclientprotocol/claude-agent-acp` |
| Codex | `npx -y @agentclientprotocol/codex-acp` |
| Pi | `npx -y pi-acp` |

Authenticate with the agent's own CLI as usual. If an ACP adapter is unavailable
or a workflow needs direct CLI access, press **⌘⇧P** and choose **Open terminal**.

## How it works

- **Sidebar → Projects "+"** adds a git repo (native folder picker, validated
  with `git rev-parse`).
- **Repo "+" or ⌘D** creates a branch as a git worktree under
  `~/.powerhouse/worktrees/<repo>/<branch>`, opens it, and starts a chat.
- **⌘T** opens another chat on the current branch. Claude, Codex, and Pi default
  to ACP; legacy/custom profiles default to a PTY.
- The ACP pane renders messages, reasoning, plans, tool calls, diffs, and permission
  requests in one Pi-inspired terminal UI. Press **⌘⇧P** (or type `/`) to choose
  agent-provided commands and skills, modes, model/config options, or the terminal
  fallback. Unsupported controls simply do not appear.
- Structured ACP transcripts and session IDs persist. Restored chats can resume
  when the backend supports it.
- **Open terminal** switches only that chat to its agent's real CLI. Tab switches keep
  every xterm mounted, so long-running TUIs survive switching away and back.
- The tree (repos → branches → chats) persists via `tauri-plugin-store`;
  subprocesses are runtime-only. After a restart, chats wait for **Resume** or
  **Start fresh** — no agent-launch storm on boot.
- Closing a chat kills its ACP/PTY process; deleting a branch removes its worktree
  (`git worktree remove --force`, confirm dialog); quitting the app kills all
  sessions. `pty_kill_all` also runs on boot for dev-reload hygiene.

## Layout

- `src-tauri/src/pty.rs` — PTY sessions: spawn/write/resize/kill, reader
  thread emits `pty-out-{id}` / `pty-exit-{id}` events.
- `src-tauri/src/acp.rs` — safe stdio ACP subprocess lifecycle and event bridge.
- `src-tauri/src/git.rs` — repo validation, worktree create/remove
  (shell-out to git with arg vectors, never shell strings).
- `src/lib/acpRegistry.ts` + `acpTranscript.ts` — typed ACP connection lifecycle
  and structured event normalization.
- `src/components/AcpChatPane.tsx` — shared agent-independent chat experience.
- `src/lib/terminalRegistry.ts` — xterm instances, outside React.
- `src/store/appStore.ts` + `store/persist.ts` — Zustand tree, debounced
  persistence to `powerhouse.json`.
