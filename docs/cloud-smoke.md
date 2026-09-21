# Cloud Smoke Summary

Powerhouse is a Conductor-style Mac desktop app for managing git repositories
and running coding agents (e.g. `claude`) in real PTY terminals.

- Lets you add repos to a sidebar and spin up parallel branches as git
  worktrees, each opening its own terminal chat session.
- Built with Tauri 2 + Rust for the backend (PTY handling via `portable-pty`,
  git operations shelling out to `/usr/bin/git`).
- Frontend is React + TypeScript + Vite + Tailwind v4, using xterm.js for
  terminals and Zustand for state, persisted via `tauri-plugin-store`.

Source layout:
- `src-tauri/src/pty.rs` — PTY session lifecycle (spawn/write/resize/kill).
- `src-tauri/src/git.rs` — repo validation and worktree create/remove.
- `src/lib/terminalRegistry.ts` — xterm instance management.
- `src/store/appStore.ts` / `store/persist.ts` — app state and persistence.
