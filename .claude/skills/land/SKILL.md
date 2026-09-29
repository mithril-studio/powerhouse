---
name: land
description: Land finished work on the test branch with scripts/land.sh, without asking first. Use when the work in this worktree is done and committed, or when the user says "commit/push/merge to (origin) test", "land it", "ship it to test", or asks whether work is pushed or where it is (scripts/status.sh).
---

# Land on test

Landing on `test` is pre-approved in this repo (AGENTS.md). Do not ask "want me to land it?". Land it and report.

## When the work is done

1. Commit on your branch: small commits, one concern each, subjects written for the Merge tab.
2. From the repo root run `scripts/land.sh`. It fetches, rebases onto `origin/test`, runs the checks, pushes `HEAD:test`, and retries once if someone landed first. Don't run these steps by hand.
3. Reply with the `landed <sha> <subject>` lines it prints. That's the whole report.

## When it stops

| Exit | Meaning | Do |
|---|---|---|
| 1 | Dirty tree, or on `main` | Commit or discard, then run it again. Never land from `main`. |
| 2 | Rebase conflict (tree left unchanged) | If the conflict is mechanical (imports, lockfile, adjacent edits), `git rebase origin/test`, resolve, `git rebase --continue`, run it again. If it needs a product decision, stop and ask. |
| 3 | Checks failed (log tail shown) | Fix the cause, commit, run it again. If the failure is unrelated to your change and also fails on `origin/test`, report it instead. |
| 4 | Push rejected twice | Run it again once. If it still fails, report. |

Never force-push, never push `main`, never open a PR. The `test → main` release is the human's.

## "Is it pushed? Is it in the release?"

Run `scripts/status.sh`. It answers from git and tags: unlanded commits, on test → beta built → on main → released → installed, and the commits waiting on `test`. Don't answer from memory.
