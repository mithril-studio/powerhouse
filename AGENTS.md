# AGENTS.md — Powerhouse

Shared context for all coding agents working in this repo. Read this before making changes.

## What Powerhouse is

A **Tauri (Rust + React/Vite) macOS desktop app**. There is no web server to "deploy" — shipping means
publishing a new signed app version that users receive via the **auto-updater**.

- Updater endpoint: `https://github.com/mithril-studio/powerhouse-releases/releases/latest/download/latest.json`
- `/releases/latest/` **excludes pre-releases**, so anything marked pre-release is never served to users.

## Branch & release flow (do not bypass)

```
worktree branch → agent pushes to test → test server + signed beta pre-release auto-build
                                       → ship workflow (once per feature) → PR test → main → push v* tag → ships
```

- **`main` is production and is branch-protected.** No direct pushes (enforced for admins too). Every change
  reaches `main` through a PR from `test`. Do not attempt to `git push origin main` — it will be rejected.
- **`test` is the integration branch.** Agents push their finished work here themselves (rules below). It is
  deliberately unprotected. Every push triggers `.github/workflows/beta.yml`, which builds a **signed +
  notarized** beta and publishes it as a GitHub **pre-release** on `mithril-studio/powerhouse` (never shipped
  to users); the test server also deploys from it.
- **Ship by**: when a feature is complete, run the ship workflow against `test` (lint, tests, build, run the
  app, AI review of the diff against `main`). Green → verify the installed beta contains the intended work,
  open a PR from `test` into `main`, merge, and push a `v<version>` tag (matching `src-tauri/tauri.conf.json`
  `version`) to fire `.github/workflows/release.yml`, which builds/signs/notarizes and publishes to
  `powerhouse-releases`.

Why this exists: a production release once went out missing work that was assumed to be included. The beta
gate is the mandatory place to catch that — a real installed build, not just a green CI check.

## The Merge tab: what is on `test`

The Merge tab in the right sidebar lists **every commit on `origin/test` that is not yet on `origin/main`**,
newest first, with author and time (`git_target_commits` in `src-tauri/src/git.rs`; fetches first, refreshes
each minute while open). That list is the session overview and, at ship time, the answer to "what is in this
release". Write commit subjects for that list: one line, imperative, says what changed.

Below the list, **Merge** lands the selected worktree branch on the target with the merge queue. With no
workflow steps configured it only checks that the merge is clean, then fast-forwards and pushes — a one-click
alternative to pushing by hand. Steps can be configured under **Edit workflow** but are not the gate; the
ship workflow is.

**Target branch.** Each project stores one target branch: new worktrees are cut from it, diffs are shown
against it, the Merge tab lists it, and the queue lands on it. `origin/test` is chosen automatically when a
project is added if it exists (`detect_target_branch`); otherwise the remote default. Change it in **Edit
workflow → Target branch**. For this repo it is `test`.

## Rules for agents working in a worktree

Each agent works in its own worktree on its own branch and lands its own work on `test`.

- Commit on your branch when the work is done and the local checks pass (`pnpm build`, `pnpm test`,
  `cargo test` in `src-tauri` when Rust changed). Small commits, one concern each, clear subjects.
- Land it yourself, always the same way:

  ```sh
  git fetch origin
  git rebase origin/test          # or merge, if the branch is shared
  pnpm build && pnpm test         # re-check on top of the current test tip
  git push origin HEAD:test
  ```

  A rejected (non-fast-forward) push means someone landed first: fetch, rebase, re-check, push again.
- Never force-push `test`. Never push `main`. Never open a PR — the `test → main` PR is the human's.
- Say what you landed: the commit subjects and the short SHAs, so it can be matched to the Merge tab list.
- If your push broke the test server, fixing it is your next task, ahead of anything else.

## Ship workflow (once per feature)

Run before the `test → main` PR, never per commit. It cuts a throwaway worktree from `origin/test` and runs,
in order: install, lint, tests, build, launch the app for a smoke check, and an AI review of the whole diff
against `main`. It runs on the shared workflow runner below. Status: the runner and step validation exist;
the "run a workflow against a branch in a throwaway worktree" wrapper and the AI-review step type are the
next two pieces.

## Workflow runner

`src-tauri/src/workflow.rs` is the shared step executor: the merge queue uses it today and on-demand
workflows will. It has no Tauri dependency and is fully unit-tested. Contracts (ported from
kunchenguid/no-mistakes and pinned by tests — keep them when changing the runner):

- Every step runs as the leader of its own process group; cancel terminates the whole tree, not just the
  shell. Survivors get SIGTERM, then SIGKILL after a grace period; leftovers are reaped even after a clean
  exit, so a test runner's workers or a dev server cannot leak across runs.
- A grandchild holding the step's stdout pipe cannot wedge the step.
- First failing step fails the run and skips the rest; a cancelled run reports canceled, never failed.
- Observers see state changes and log chunks on one thread, in order. Per-step logs are capped at 256 KiB
  on UTF-8 boundaries.

Step lists are validated before anything runs (`src/lib/workflowSteps.ts`): every step needs a command,
names are unique, at most 16 steps. The merge workflow modal refuses to save an invalid list.

## Agent context files

`AGENTS.md` is the single source of shared agent context for this repo. `CLAUDE.md` exists only because
Claude Code reads that name; it is a one-line import (`@AGENTS.md`). Edit this file, never `CLAUDE.md`.

## Release-tooling gotchas

- **Never trust the embedded `.assets` field** from `gh release view` / `GET /releases/tags/*` — it is
  eventually-consistent and intermittently returns `[]` for a release that has assets. To check assets
  authoritatively, use `GET /repos/{owner}/{repo}/releases/{id}/assets` and require `state == "uploaded"`.
- Beta tags are `beta-v<version>-<shortsha>` (intentionally not matching `v*`, so they never trip the
  production release workflow). Production tags are `v<version>`.
- Signing/notarization runs on `macos-latest` using repo secrets (Apple cert + notary API key + Tauri
  updater key). `scripts/release.sh` (production) and `scripts/beta.sh` (staging) share these steps.

## Build & verify locally

- `pnpm install` — install frontend deps
- `pnpm build` — typecheck + Vite build
- `pnpm test` — run vitest
- `pnpm verify` / `./scripts/verify.sh` — project verification
- `pnpm tauri build` — full app build (signing requires the CI secrets)
