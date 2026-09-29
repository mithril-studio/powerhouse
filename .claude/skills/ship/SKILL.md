---
name: ship
description: Release what is on test to users. Checks the release, reviews the diff, opens the test → main PR, and after the human merges it tags v<version> and verifies the published release. Only when the user runs /ship.
disable-model-invocation: true
---

# Ship test → users

Arguments: `$ARGUMENTS` (empty = start a release; `tag` = the PR is merged, publish it; `watch` = follow a running release)

The human decides when to release, installs the beta, and merges the PR. You run the scripts, review the diff, and report. Never push `main`, never force-push, never merge the PR yourself.

## 1. Check

Run `scripts/ship.sh check`. It runs `verify.sh` in a throwaway worktree, which takes a few minutes. Use `--fast` only for a quick re-check after fixing a version or beta problem.

For each `NOT READY` reason:
- **Version not bumped:** run `scripts/bump.sh patch` (or `minor` if the release adds a feature a user would call new), then `scripts/land.sh`, then check again once the Beta workflow has built the new tip.
- **No beta on the test tip:** the Beta workflow is still building or failed. Check with `gh run list --workflow beta.yml -L 3`. Wait for it with a background command, not a sleep loop.
- **verify.sh failed:** stop and report. A broken `test` is fixed by landing a fix, not by releasing around it.

## 2. Review

When the check says `READY`, review `git diff origin/main...origin/test`. It's the whole release. Report briefly:
- Anything that looks unfinished, debug-only, or risky for existing users (migrations, settings formats, deleted behaviour).
- Commits whose subject doesn't match their diff.
- What the human should try in the installed beta: 3–6 concrete checks derived from the user-visible commits.

## 3. Open the PR, then wait for "go"

Show the review and the beta checklist, and ask the human whether to open the release PR. On yes: `scripts/ship.sh open`, and give them the URL. They merge it on GitHub.

## 4. Publish (`/ship tag`)

After the human says the PR is merged: `scripts/ship.sh tag`. It tags `v<version>` on `main`, pushes the tag, follows `release.yml`, checks the assets through the reliable per-release endpoint, and waits until the updater serves the new version. Run it as a background command; it takes as long as the release build.

Report the version, the release run, and whether the updater serves it. On failure, report the step and run `gh run view <id> --log-failed` for the release build.
