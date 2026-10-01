# Plan: project env vars and keys for cloud workspaces

Goal: getting keys and env vars into a cloud workspace takes one click per project, and a missing key
shows before you click Cloud, not after.

Read first: `docs/cloud-workspaces.md` (how a workspace runs) and `AGENTS.md` (branch and land rules).

## Where things stand

- **Injection already works.** Before every turn, `src-tauri/src/cloud/commands.rs` (`env_vars`, then
  `upload(.., "env", ..)`) writes `~/.ph/env` on the VM. `RUN_SCRIPT` in `cloud/workspace.rs` sources it
  with `set -a`, so the agent and everything it runs see the variables.
- **Keys:** `CLAUDE_CODE_OAUTH_TOKEN` comes from Keychain `Powerhouse/claude_oauth_token`. `GH_TOKEN`
  comes from Keychain `github_token[:owner[/repo]]`, or else the GitHub connection
  (`secrets::workspace_env`). Both are set in Settings → Cloud (`SettingsPage.tsx`, `CloudSection`).
- **Project env vars:** names live in `repo.cloudEnvNames` (persisted store) and values in Keychain
  `project_env:<repoId>:<NAME>` (`secrets::project_env_values`). The editor is
  `src/components/RepoEnvEditor.tsx`, hidden in the Merge tab → Edit workflow modal
  (`WorkflowModal.tsx`, "Cloud env vars").
- **Problems:** the editor is hard to find, every value is typed by hand, tools that only read a `.env`
  file get nothing, and a missing key only fails after the click.

## Scope

Build, in this order, one commit each, and land each with `scripts/land.sh`:

1. Project settings page
2. Import from `.env`
3. Readiness on the Cloud button
4. Opt-in `.env` file on the VM

Out of scope: values per branch, env shared across projects, a Keychain migration, and any change to
how the Claude or GitHub token is stored.

---

## 1. Project settings page

**What:** a per-project page holding what is scattered today: target branch, merge workflow steps,
push-on-merge, and cloud env vars.

- Add `projectSettingsRepoId: string | null` plus `openProjectSettings(repoId)` and
  `closeProjectSettings()` to `appStore.ts`. Mirror `settingsOpen`, and keep the overlays mutually
  exclusive the way settings/telemetry/memory are (there is a test for this in `appStore.test.ts`,
  "page navigation overlays").
- New `src/components/ProjectSettingsPage.tsx`, laid out like `SettingsPage.tsx` (same shell and
  classes). Sections:
  - **General:** target branch and push-on-merge, moved from `WorkflowModal.tsx`.
  - **Merge workflow:** the step list editor, moved from `WorkflowModal.tsx`. Keep validation via
    `src/lib/workflowSteps.ts` and still refuse to save an invalid list.
  - **Cloud env vars:** `RepoEnvEditor`, plus the import button from step 2.
- Entry points:
  - Repo context menu in `RepoItem.tsx`: a "Project settings" row above Hide.
  - Merge tab: "Edit workflow" in `QueuePane.tsx` opens the new page instead of the modal.
- Delete `WorkflowModal.tsx` and its `App.tsx` mount and `App.test.tsx` mock once everything has moved.
  Remove `workflowModalRepoId`, `openWorkflowModal` and `closeWorkflowModal` from the store.
- Escape closes the page, as `SettingsPage` does.

**Done when:** everything the modal did works from the page, the modal is gone, and `pnpm build` and
`pnpm test` pass.

## 2. Import from `.env`

**What:** one button reads the local `.env` and stores each value in the Keychain. No retyping, and
re-importing updates the values.

- **Backend,** new command `cloud_import_env_file(repo_id, worktree_path, file)` in
  `cloud/commands.rs`:
  - `file` defaults to `.env`. Allow only a plain filename matching `^\.env(\.[A-Za-z0-9_-]+)?$`, so
    no paths.
  - Read `<worktree_path>/<file>` and refuse over 256 KiB.
  - Parse with a small pure function `parse_dotenv(text) -> Vec<(String, String)>` in
    `cloud/secrets.rs`:
    - skip blank lines and `#` comments;
    - accept an optional `export ` prefix;
    - `KEY=value`, with the key validated by `is_env_var_name`;
    - strip matching surrounding `'…'` or `"…"`;
    - in double quotes, unescape `\n` and `\"`;
    - strip ` #comment` from unquoted values;
    - last duplicate wins;
    - skip invalid lines and count them.
  - Refuse to import `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`. Report them as skipped: they come from
    Settings → Cloud and must not be shadowed.
  - Store each value with `secrets.set(project_env_slot(..))`.
  - Return `{ imported: Vec<String>, skipped: Vec<String> }`. Names only, never values.
- **Frontend:**
  - Add `cloudImportEnvFile` in `src/lib/cloud.ts`.
  - In `RepoEnvEditor`, an "Import from .env" button uses the selected branch's worktree, or else the
    repo path. It merges the imported names into `repo.cloudEnvNames` (`setRepoEnvNames`) and
    refreshes the status.
  - Show "Imported 7 · skipped 1 (GH_TOKEN: set in Settings)".
  - The file picker is only a filename field with `.env` as the default, no dialog.
- **Tests** (Rust):
  - `parse_dotenv` covers quotes, `export`, comments, duplicates and invalid keys.
  - The command against a temp dir and `MemoryStore` stores values, rejects `../x` and oversized
    files, and skips the reserved names.
- Never log or return values.

**Done when:** importing this repo's own `.env`, if any, fills the editor with every key marked "set",
and a second import is idempotent.

## 3. Readiness on the Cloud button

**What:** know before clicking that a key or env value is missing.

- New command `cloud_readiness(repo_id, worktree_path, env_names) -> { ready: bool, missing: Vec<String> }`.
  It reuses the checks in `begin()` (`cloud/commands.rs`) without side effects: Claude token present,
  GitHub token resolvable for the `https_remote(origin)`, and every configured env name has a value.
  Factor the shared checks into one `preflight()` function that both `begin()` and `cloud_readiness`
  call.
- `TabBar.tsx`: fetch readiness when the selected branch changes and when the Settings or project
  settings page closes. Not ready: the Cloud button stays clickable but shows a small warning dot, and
  its title lists what is missing ("Claude key missing, set it in Settings → Cloud"). Clicking still
  runs `sendChatToCloud`, which reports the same error in the chat.
- Settings → Cloud: add "Get token", which opens the bottom shell and types `claude setup-token`
  (same trick as `openCloudShell` in `src/lib/cloud.ts`, using the selected branch's shell id), with a
  note to paste the printed token into the field.

**Done when:** with the Claude token cleared, the button shows the warning and reason. After pasting,
the warning is gone without a restart.

## 4. Opt-in `.env` file on the VM

**What:** for tools that read a file rather than the environment.

- `Repo` gets `cloudWriteEnvFile?: boolean` (persisted; default off). Add a checkbox in the page's
  Cloud env section: "Also write `.env` in the repo on the VM (only if git ignores it)."
- Pass it through `StartRequest` and `send` (a new `write_env_file: bool` argument next to
  `env_names`). Store it on `CloudWorkspace` so polls and follow-ups keep it.
- Backend: after the env upload, when enabled, run a VM script that:
  1. `cd ~/repo && git check-ignore -q .env`. If not ignored, fail the turn start with
     "`.env` is not gitignored in this repo; not writing it (the agent could commit it)."
  2. Writes the project env vars as `NAME=value` lines to `~/repo/.env` with mode 600. Upload via
     `upload()` to `~/.ph/dotenv`, then `cp`, so values never appear in argv.
  - Only project vars go in the file, never `CLAUDE_CODE_OAUTH_TOKEN` or `GH_TOKEN`.
  - Add a pure `render_dotenv(vars)` in `secrets.rs` and refuse values containing newlines.
- **Tests:** `render_dotenv` escaping and refusal. Extend the ignored real-VM test
  (`cloud_mechanics_on_a_real_vm`) to write `.env` into the octocat clone after adding `.env` to
  `.git/info/exclude`, and assert that `git status --porcelain` stays empty.

**Done when:** with the checkbox on, the VM clone has a `.env` that git ignores, and a repo that
doesn't ignore `.env` gets the refusal message.

---

## Checks for every step

- `pnpm build`, `pnpm test`, and `cargo test` in `src-tauri` pass.
- For steps 2 and 4: `PH_CLOUD_E2E=1 cargo test cloud_mechanics_on_a_real_vm -- --ignored` passes. It
  creates and deletes its own `ph-e2e-*` VM.
- Update `docs/cloud-workspaces.md`: the "Where things live" table (the project settings page, the
  import) and the injection description.
- Land with `scripts/land.sh`, then paste the `landed <sha> <subject>` lines.

## Guardrails

- Secret values never go into logs, telemetry, IPC responses, argv, or the persisted store. They go
  only to the Keychain and to `~/.ph/env` or `~/repo/.env` on the VM.
- Never write a `.env` that git would track.
- Don't touch `cloud/` (the runner) or `server/`: they belong to the workflow coordinator.
