# AGENTS.md — Powerhouse

Shared context for all coding agents working in this repo. Read this before making changes.

## What Powerhouse is

A **Tauri (Rust + React/Vite) macOS desktop app**. There is no web server to "deploy" — shipping means
publishing a new signed app version that users receive via the **auto-updater**.

- Updater endpoint: `https://github.com/mithril-studio/powerhouse-releases/releases/latest/download/latest.json`
- `/releases/latest/` **excludes pre-releases**, so anything marked pre-release is never served to users.

## Branch & release flow (do not bypass)

```
worktree branch → Powerhouse merge queue → test → signed beta pre-release auto-builds → install & verify
                                                → PR test → main → push v* tag → ships to all users
```

- **`main` is production and is branch-protected.** No direct pushes (enforced for admins too). Every change
  reaches `main` through a PR. Do not attempt to `git push origin main` — it will be rejected.
- **`test` is the staging branch and the merge queue's target.** Feature work lands here only through the
  Powerhouse merge queue (below), never by hand and never via PR. Every push to `test` triggers
  `.github/workflows/beta.yml`, which builds a **signed + notarized** beta and publishes it as a GitHub
  **pre-release** on the `mithril-studio/powerhouse` repo (never shipped to users). `test` is not
  branch-protected on purpose: the queue fast-forwards and pushes it.
- **Promote by**: verify the installed beta actually contains the intended work, then open a PR from `test`
  into `main`, merge, and push a `v<version>` tag (matching `src-tauri/tauri.conf.json` `version`) to fire
  `.github/workflows/release.yml`, which builds/signs/notarizes and publishes to `powerhouse-releases`.

Why this exists: a production release once went out missing work that was assumed to be included. The beta
gate is the mandatory place to catch that — a real installed build, not just a green CI check.

## Landing work on `test`: the merge queue

Powerhouse's own merge queue (Merge tab in the right sidebar, engine in `src-tauri/src/queue.rs`) is the
only path from a worktree branch to `test`. One worker per repo, so integration is serial and every landed
commit was tested against the `test` tip it landed on.

What happens when a branch is enqueued (⇧ on the branch row, or **Merge** in the Merge tab):

1. A throwaway worktree is cut from `origin/test`; the branch is merged into it with a merge commit.
2. The repo's workflow steps (**Edit workflow** in the Merge tab: e.g. `pnpm build`, `pnpm test`) run there
   in order. First failure fails the entry and skips the rest; the step log stays on the card.
3. All green → `test` is fast-forwarded to the tested merge commit and pushed. The worktree is removed on
   every exit path, including cancel and crash.
4. A red entry blocks only that branch. Re-enqueue after fixing.

**Target branch.** Each project stores one target branch: new worktrees are cut from it, diffs are shown
against it, and the queue lands on it. When a project is added, `origin/test` is chosen automatically if it
exists (`detect_target_branch` in `src-tauri/src/git.rs`); otherwise the remote default. Change it in
**Edit workflow → Target branch**. For this repo it must be `test`.

**Promotion `test` → `main`** stays a GitHub PR, batched, after the beta gate. Nothing else touches `main`.

## Rules for agents working in a worktree

Each agent works in its own worktree on its own branch. The agent's job ends at a clean commit on that
branch; landing is the human's click.

- Commit on your branch when the work is done and the local checks pass (`pnpm build`, `pnpm test`,
  `cargo test` in `src-tauri` when Rust changed).
- Do **not** merge, rebase, or push. Do not touch `origin/test` or `origin/main`. Do not open PRs.
- One concern per branch; open a second worktree for a second concern. The queue is serial, so big
  branches are the ones that get sent back.
- When ready, say **"ready for queue"** and stop.
- If the queue reports a merge conflict, rebase onto `origin/test`, resolve, rerun the checks, and say
  "ready for queue" again. That is the only time an agent rebases.
- Keep workflow steps fast; they run once per landed branch.

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
