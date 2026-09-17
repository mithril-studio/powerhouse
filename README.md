# Powerhouse

A Conductor-style Mac app: manage repos and parallel git-worktree branches from
a sidebar, and talk to coding agents (e.g. `claude`) in real PTY terminals.

Tauri 2 + Rust (`portable-pty`, git via `/usr/bin/git`) · React + TypeScript +
Vite + Tailwind v4 · xterm.js · Zustand.

## Run

```sh
pnpm install
pnpm tauri dev
```

## How it works

- **Sidebar → Projects "+"** adds a git repo (native folder picker, validated
  with `git rev-parse`).
- **Repo "+" or ⌘D** creates a branch as a git worktree under
  `~/.powerhouse/worktrees/<repo>/<branch>`, opens it, and starts a chat.
- **⌘T** opens another chat on the current branch. Each chat is a real
  `zsh -il` PTY with the agent command (default `claude`, stored in settings)
  typed in automatically; when the agent exits you drop back to a live shell.
- Tab switches keep every xterm mounted (hidden, never re-fit while hidden),
  so long-running TUIs survive switching away and back.
- The tree (repos → branches → chats) persists via `tauri-plugin-store`;
  terminals are runtime-only. After a restart, chats show a **Start** button —
  no agent-launch storm on boot.
- Closing a chat kills its PTY; deleting a branch removes its worktree
  (`git worktree remove --force`, confirm dialog); quitting the app kills all
  sessions. `pty_kill_all` also runs on boot for dev-reload hygiene.

## Layout

- `src-tauri/src/pty.rs` — PTY sessions: spawn/write/resize/kill, reader
  thread emits `pty-out-{id}` / `pty-exit-{id}` events.
- `src-tauri/src/git.rs` — repo validation, worktree create/remove
  (shell-out to git with arg vectors, never shell strings).
- `src/lib/terminalRegistry.ts` — xterm instances, outside React.
- `src/store/appStore.ts` + `store/persist.ts` — Zustand tree, debounced
  persistence to `powerhouse.json`.
