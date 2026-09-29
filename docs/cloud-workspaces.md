# Cloud workspaces

The **Cloud** button continues the active chat and its branch on a boxd VM. One click; no settings per run.

## What happens

1. The chat's local agent is closed, so two agents never edit one branch.
2. Uncommitted work is committed (`WIP: send to cloud`) and the branch is pushed.
3. VM `ph-<branch-slug>` is created, or reused and started. Fresh boxd machines already have
   `claude`, `node`, `git` and `gh`; no snapshot is involved.
4. `~/.ph/env` gets the Claude token, a GitHub token and the repo's env vars (outside the repo, so the
   agent can never commit them). `~/repo` is cloned or fetched and reset to the pushed branch.
5. The chat becomes a prompt (`## User` / `## Assistant` turns, tools left out) and `claude -p` starts
   detached with the chat's model and `--dangerously-skip-permissions` (the VM is the sandbox).
6. Powerhouse reads `~/.ph/turn-<n>.jsonl` from a byte offset every 2.5 s and renders it in the same chat.
7. When `turn-<n>.exit` appears: the clone is inspected (HEAD, unpushed commits, dirty files), the branch
   is fetched and fast-forwarded locally when the worktree is clean, and a result card is posted.

Follow-up messages go to the cloud agent (`claude -p --resume <session>`). **Bring back local** pulls,
deletes the VM, and hands the chat back to the local agent, which gets a recap of the cloud turns with
its next prompt. Deleting the branch deletes its VM too.

## Where things live

| What | Where |
|------|-------|
| Workspace records | `~/.powerhouse/cloud-workspaces.json` |
| Backend | `src-tauri/src/cloud/` (`workspace.rs` pure + tested, `commands.rs` flow) |
| Frontend | `src/lib/cloud.ts` (IPC, poll loop, actions), `src/lib/cloudStream.ts` (stream-json → transcript) |
| Credentials | Settings → Cloud (Keychain). GitHub falls back to the GitHub connection. |
| Per-repo env vars | Repo workflow settings |

The `cloud/` runner crates and `scripts/cloud-base-setup.sh` belong to the workflow coordinator
(`server/`), not to cloud workspaces.

## Testing

`cargo test cloud` covers the pure parts and the flow against a fake boxd.
`PH_CLOUD_E2E=1 cargo test cloud_mechanics_on_a_real_vm -- --ignored` runs detach, polling, exit and
stop on a real throwaway VM with a fake agent.

## Not in v1

Other agents than Claude over ACP, images in cloud prompts, carrying local Claude session files, VM
snapshots, validation pipelines, shared memory on the VM (`routableMemory` exists for it).
