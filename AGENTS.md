# AGENTS.md — Powerhouse

Shared context for all coding agents working in this repo. Read this before making changes.

## What Powerhouse is

A **Tauri (Rust + React/Vite) macOS desktop app**. There is no web server to "deploy" — shipping means
publishing a new signed app version that users receive via the **auto-updater**.

- Updater endpoint: `https://github.com/mithril-studio/powerhouse-releases/releases/latest/download/latest.json`
- `/releases/latest/` **excludes pre-releases**, so anything marked pre-release is never served to users.

## Branch & release flow (do not bypass)

```
feature branch → PR → test → signed beta pre-release auto-builds → install & verify
                           → PR test → main → push v* tag → ships to all users
```

- **`main` is production and is branch-protected.** No direct pushes (enforced for admins too). Every change
  reaches `main` through a PR. Do not attempt to `git push origin main` — it will be rejected.
- **`test` is the staging branch.** Merge feature work here first. Every push to `test` triggers
  `.github/workflows/beta.yml`, which builds a **signed + notarized** beta and publishes it as a GitHub
  **pre-release** on the `mithril-studio/powerhouse` repo (never shipped to users).
- **Promote by**: verify the installed beta actually contains the intended work, then open a PR from `test`
  into `main`, merge, and push a `v<version>` tag (matching `src-tauri/tauri.conf.json` `version`) to fire
  `.github/workflows/release.yml`, which builds/signs/notarizes and publishes to `powerhouse-releases`.

Why this exists: a production release once went out missing work that was assumed to be included. The beta
gate is the mandatory place to catch that — a real installed build, not just a green CI check.

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
