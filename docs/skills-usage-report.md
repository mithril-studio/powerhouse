# Skill usage audit and removal recommendations

## Decision summary

**Narrow the Powerhouse skill catalog; do not bulk-delete skills based on this sample.**

Existing telemetry does reveal historical skill reads and explicit invocations. In this audit:

- **13 distinct skills have 23 observed completed operational loads across 8 runs.**
- **39 of 52 currently installed skill names have no observed operational load.**
- One additional `memory` read was research about memory systems, not evidence of following the skill.
- Most loads are from Pi. Claude advertises many skills but rarely explicitly loads them in this sample.
- Two installed procedures directly mismatch Powerhouse's workflow: `merge` and `open-pr`.
- No skill is proven safe to delete globally: terminal/cloud coverage is incomplete and the window is only about a week.

**Recommended first removals from Powerhouse's default catalog:** `merge`, `open-pr`, the Vercel plugin skill family, and document/office skills (`docx`, `pdf`, `pptx`, `xlsx`, `google-workspace`). Preserve them elsewhere if those workflows are still used. Move other specialists to on-demand discovery. No skill files or settings were changed by this audit.

## Scope and evidence quality

Snapshot taken on **2026-09-29**, using SQLite's backup API against a read-only connection to `~/.powerhouse/telemetry.db`. Snapshot event timestamps span **2026-09-22 20:12:50 through 2026-09-29 09:20:18 UTC**. This is a historical snapshot, not a live dashboard.

The entire current audit conversation, run `75f01416-23f6-4c63-b72b-736c1eb7dee2`, is excluded, including its earlier telemetry analysis. Otherwise reading skills to prepare this report would manufacture evidence of usage.

| Included coverage | Runs | User turns | Projected tool calls |
|---|---:|---:|---:|
| Powerhouse ACP | 62 | 110 | 1,469 |
| Workflows ACP | 54 | 138 | 3,143 |
| Specter-ai ACP | 12 | 4 | 101 |
| ACP without a project label | 1 | 0 | 0 |
| **ACP total** | **129** | **252** | **4,713** |
| Uninstrumented terminal processes | 34 | Unknown | Unknown |
| Process-only merge queue | 2 | Not applicable | Not applicable |

Of the 129 ACP runs, 98 have tool activity; they represent 74 distinct chat IDs overall. A resumed run is not an independent task. There are 83,679 included raw events, of which 425 are marked replayed and one truncated. Recorded dropped-event and parse-error counters are zero; that does not establish complete harness or cloud coverage. No included run has a populated cost field.

### What counts as usage

1. **Catalog exposure:** a skill-name match in `available_commands_update`, deduplicated per run. Normalize `skill:NAME`, `$NAME`, and `anthropic-skills:NAME` to the installed name. Plain command-name matches are included but can be ambiguous (for example `memory` or `docs`). Exposure means the command was advertised, not that the entire skill entered model context.
2. **Operational load:** a completed read tool whose `rawInput.path` or `rawInput.file_path` points to `skills/NAME/SKILL.md`, or a completed native `Skill`/`Load skill` call with `rawInput.skill`. Partial file reads count as loads, not proof the entire document was read.
3. **Shell loads:** inspect shell commands mentioning `SKILL.md`, and verify the returned content. The only additional historical local skill read identified this way was the `memory` research inspection listed separately below.
4. **Deduplication:** fold `tool_call` and `tool_call_update` by `(run_id, toolCallId)` in sequence order. Arguments often arrive in updates, not the initial call. Exclude events marked `replayed`; count each completed call once.
5. **Not usage:** catalog listings, path searches, skill text quoted inside telemetry-query outputs, web research about skills, or an agent merely saying it used a skill. No explicit slash/dollar skill invocation was found at the start of the included user prompt text.

These are **observable loads**, not proof of application, quality improvement, or necessity. Implicit/system-injected instructions, inherited resumed context, and subagent or remote activity not individually surfaced as ACP tools can be missed. Historical skill versions were not captured as hashes. Current installation is not proof a skill was installed throughout the window.

## Observed operational usage

Counts below exclude the audit and the research-only read. For these observations, each skill was loaded at most once per run, and its run count equals its distinct chat count.

| Skill | Loads / runs | Powerhouse | Workflows | Specter-ai | Recommendation |
|---|---:|---:|---:|---:|---|
| memory | 6 | 3 | 2 | 1 | Keep; align versions and project memory contract |
| boxd-cli | 3 | 0 | 3 | 0 | Keep for cloud tasks; 2 native invocations + 1 file read |
| code-review-and-quality | 2 | 0 | 2 | 0 | Keep for review tasks |
| frontend-ui-engineering | 2 | 1 | 1 | 0 | Keep for UI tasks |
| test-driven-development | 2 | 1 | 1 | 0 | Keep for implementation tasks |
| bounded-waits | 1 | 0 | 1 | 0 | Keep for background jobs |
| caveman-explore | 1 | 0 | 1 | 0 | Keep for repository discovery |
| checkpoint-commits | 1 | 0 | 1 | 0 | Keep for longer implementations |
| debugging-and-error-recovery | 1 | 0 | 1 | 0 | Keep for debugging |
| fix-review | 1 | 0 | 1 | 0 | Keep conditional on CodeRabbit availability |
| git-workflow-and-versioning | 1 | 0 | 1 | 0 | Keep; project-specific policy takes precedence |
| incremental-implementation | 1 | 0 | 1 | 0 | Keep for multi-file implementation |
| security-and-hardening | 1 | 0 | 1 | 0 | Keep for security-sensitive tasks regardless of low frequency |
| **Total** | **23 loads** | **5** | **17** | **1** | **13 skills, 8 runs** |

**Concentration warning:** run `d8292efc` accounts for 12 of the 23 loads. This is not broad evidence that those 12 skills are independently effective.

### Harness differences matter more than a global ranking

| Harness | Included ACP runs | Runs with tools | Runs with operational skill loads | Operational loads |
|---|---:|---:|---:|---:|
| Pi | 12 | 7 | 6 | 21 |
| Claude ACP | 112 | 91 | 2 | 2 |
| Codex ACP | 5 | 0 | 0 | 0 |

Claude also has the one research-only `memory` read. Both Claude operational invocations were `boxd-cli`.

Before concluding that the other skills are irrelevant, investigate why Claude seldom loads them. This could reflect task mix, instructions, discovery behaviour, inherited context, or missing observability. The data does not distinguish those explanations. Do not interpret Codex's zero as rejection of skills: it has no tool activity in this cohort.

## Complete installed-name inventory

Inventory roots inspected on 2026-09-29:

- `~/.agents/skills`
- `~/.pi/agent/skills`
- `~/.claude/skills`, including nested `synced` skills and symlink targets

There are **84 `SKILL.md` paths representing 52 names** in these roots. This does not include every plugin cache, repository-local skill, remote machine, or built-in harness skill.

**Catalog runs** counts observed command-name exposure, not eligibility for every task. **Loads** counts operational loads across all three projects. A zero means **not observed**, never "useless".

Actions: **Keep** = retain for relevant tasks; **Conditional** = remove from always-advertised defaults but keep discoverable; **Remove profile** = recommended exclusion from Powerhouse's default coding profile, not global disk deletion.

| Installed name | Catalog runs | Loads | Action |
|---|---:|---:|---|
| app-design | 111 | 0 | Conditional: greenfield design; Next.js assumptions need adaptation |
| bounded-waits | 128 | 1 | Keep |
| boxd-cli | 128 | 3 | Keep for cloud tasks |
| boxd-migrate | 17 | 0 | Conditional |
| boxd-setup-deploy | 17 | 0 | Conditional |
| boxd-setup-fix | 17 | 0 | Conditional |
| boxd-setup-golden | 17 | 0 | Conditional |
| boxd-setup-hermes | 128 | 0 | Conditional; remove if Hermes work is no longer wanted |
| boxd-setup-preview | 17 | 0 | Conditional |
| built-in-browser | 62 | 0 | Conditional; do not remove browser testing capability |
| caveman-explore | 128 | 1 | Keep |
| checkpoint-commits | 128 | 1 | Keep |
| chrome-browser | 62 | 0 | Conditional |
| code-review-and-quality | 128 | 2 | Keep |
| code-simplification | 128 | 0 | Conditional |
| codebase-design | 128 | 0 | Conditional; preserve skill cross-references |
| computer-use | 62 | 0 | Conditional |
| context-engineering | 128 | 0 | Conditional; do not infer irrelevance from lack of loading |
| coordinator | 123 | 0 | Conditional: multi-agent work |
| debugging-and-error-recovery | 128 | 1 | Keep |
| decision-log | 111 | 0 | Conditional; inspect overlap with project memory |
| deep-research | 111 | 0 | Conditional |
| docs | 111 | 0 | Conditional; generic name makes exposure ambiguous |
| docx | 111 | 0 | Remove profile |
| domain-modeling | 128 | 0 | Conditional |
| doubt-driven-development | 128 | 0 | Conditional: high-stakes decisions |
| factory-compose | 128 | 0 | Conditional: backlog planning |
| find-skills | 128 | 0 | Conditional; retain a discovery path |
| fix-review | 128 | 1 | Keep when CodeRabbit is available |
| frontend-ui-engineering | 128 | 2 | Keep |
| git-workflow-and-versioning | 128 | 1 | Keep |
| google-workspace | 7 | 0 | Remove profile |
| import-memory | 111 | 0 | Conditional: migrations only |
| improve-codebase-architecture | 128 | 0 | Conditional |
| incremental-implementation | 128 | 1 | Keep |
| langfuse | 17 | 0 | Conditional: Langfuse integration/analysis only |
| lean-build | 128 | 0 | Conditional; preserve references to this entry point |
| memory | 128 | 6 | Keep; reconcile divergent versions |
| merge | 123 | 0 | Remove profile: conflicts with landing policy |
| open-pr | 123 | 0 | Remove profile: PR creation is human-owned here |
| pdf | 111 | 0 | Remove profile; enable for document tasks |
| performance-optimization | 128 | 0 | Conditional: profiling/performance work |
| pptx | 111 | 0 | Remove profile |
| rebase | 123 | 0 | Conditional; review policy before exposing |
| safe-refactor | 128 | 0 | Conditional; safety value is not frequency-dependent |
| security-and-hardening | 128 | 1 | Keep |
| sentry-cli | 128 | 0 | Conditional: Sentry tasks only |
| skill-creator | 116 | 0 | Conditional: authoring skills only |
| test-driven-development | 128 | 2 | Keep |
| workmux | 123 | 0 | Conditional: only when using workmux |
| worktree | 123 | 0 | Conditional: only when its worktree procedure applies |
| xlsx | 111 | 0 | Remove profile |

## What can be removed, and why?

### 1. Highest-confidence profile removals: incompatible procedures

- **`merge`:** the installed `~/.pi/agent/skills/merge/SKILL.md` (identical to the Claude copy) explicitly says not to fetch, defaults to local `main`, and invokes `workmux merge`. Powerhouse's `AGENTS.md` requires fetching, integrating `origin/test`, checking, and pushing to `test`. Remove this skill from Powerhouse's catalog or replace it with a project-aware procedure. This conflict is directly verified; it is not evidence the skill caused past errors, since no load was observed.
- **`open-pr`:** the installed procedure opens `gh pr create --web`. Powerhouse's checked-in rules leave the `test → main` PR to the human. Exclude it from this project's agent profile. Both `merge` and `open-pr` declare `disable-model-invocation: true`; their zero counts may be expected for manual-only commands, not evidence of failed automatic discovery.

### 2. Strong default-catalog removal candidates: unrelated families

- **Vercel plugin family:** 40 distinct `vercel:*` commands were advertised in 102 included runs; no explicit skill load was found. Powerhouse is a Tauri desktop app, not a Vercel deployment. Exclude this plugin family from the default Powerhouse coding profile; enable selected React/design guidance only when intentionally needed. This family is outside the 52-name inventory above.
- **Office/document skills:** `docx`, `pdf`, `pptx`, `xlsx`, `google-workspace` have no observed loads. Remove from the default coding profile; retain for document-oriented projects/tasks.
- **Personal workflow commands:** `gm`, `triage`, `my-tasks`, and `enrich` were each advertised in 111 runs. They are commands, not confirmed skill-file loads, and are excluded from the skill counts. They are additional candidates for a separate personal-assistant profile.

The Vercel catalog still appears in an event at **2026-09-29 09:11:19 UTC**, despite an earlier agent reporting it disabled. This could be a resumed session retaining its catalog; it does not prove the current settings failed. Verify a fresh session before changing settings again.

### 3. Keep specialists installed, but hide until needed

Move boxd provisioning/migration, Hermes, Langfuse, Sentry, architecture/design, research, factory planning, and workmux-specific procedures behind task/project selection. Their low usage is plausible for specialist workflows. For example, `boxd-cli` is used in Workflows even though no historical operational load appears in Powerhouse; deleting it globally based on Powerhouse-only usage would be a mistake.

The same caution applies to refactoring, security, and adversarial review: uncommon tasks can still require high-value safeguards. Preserve cross-skill references when narrowing the catalog.

### 4. Deduplicate distribution, not capabilities

The 84 paths include 32 names present in two roots. For **29 names**, the two `SKILL.md` files are byte-identical; `find-skills` is already a symlink. The remaining **3 names have divergent bodies**:

| Name | `~/.agents` bytes | `~/.claude` bytes | Action |
|---|---:|---:|---|
| boxd-cli | 26,584 | 39,300 | Review differences before choosing canonical version |
| boxd-setup-hermes | 5,063 | 5,187 | Review differences |
| memory | 11,199 | 6,687 | Align with the shared MCP memory/inbox contract |

Canonical files plus supported links/package distribution could eliminate stale copies. **Two files in different harness roots do not prove duplicate context injection.** Do not simply delete a harness's copy unless discovery still works, and compare referenced scripts/assets as well as `SKILL.md` before consolidating whole directories. Deleting files alone does not establish token savings.

### Global deletion verdict

**None is justified solely by this telemetry window.** If the owner confirms that a capability is unwanted everywhere, office skills, Hermes setup, or the Vercel plugin are reasonable uninstall candidates. Until then, profile exclusion is reversible and better supported by the evidence.

## Evidence ledger

Use `(run_id prefix, seq)` to find the exact event in the local database. Prefixes below are unique in the snapshot. Each listed output event includes the skill body or native launch acknowledgement; no private task transcript is copied into this report.

| Run prefix | Project | Skill | First call seq | Output seq | Classification |
|---|---|---|---:|---:|---|
| 0701d009 | powerhouse | memory | 11 | 13 | Operational read |
| 1c8d4ab2 | powerhouse | memory | 11 | 18 | Operational read |
| 1c8d4ab2 | powerhouse | frontend-ui-engineering | 12 | 17 | Operational read |
| 1c8d4ab2 | powerhouse | test-driven-development | 13 | 19 | Operational read |
| 8c7cf381 | powerhouse | memory | 25 | 27 | Operational read |
| 78d5c9da | specter-ai | memory | 11 | 16 | Operational read |
| c6c30ea0 | workflows | caveman-explore | 15 | 21 | Operational read |
| c6c30ea0 | workflows | memory | 16 | 22 | Operational read |
| c6c30ea0 | workflows | code-review-and-quality | 17 | 23 | Operational read |
| d8292efc | workflows | memory | 85 | 97 | Operational read |
| d8292efc | workflows | git-workflow-and-versioning | 86 | 101 | Operational read |
| d8292efc | workflows | test-driven-development | 87 | 99 | Operational read |
| d8292efc | workflows | security-and-hardening | 88 | 100 | Operational read |
| d8292efc | workflows | incremental-implementation | 89 | 102 | Operational read |
| d8292efc | workflows | checkpoint-commits | 90 | 98 | Operational read |
| d8292efc | workflows | debugging-and-error-recovery | 335 | 345 | Operational read |
| d8292efc | workflows | frontend-ui-engineering | 336 | 346 | Operational read |
| d8292efc | workflows | code-review-and-quality | 518 | 523 | Operational read |
| d8292efc | workflows | fix-review | 519 | 522 | Operational read |
| d8292efc | workflows | boxd-cli | 815 | 817 | Operational read |
| d8292efc | workflows | bounded-waits | 1035 | 1037 | Operational read |
| f9669341 | workflows | boxd-cli | 2562 | 2569 | Native invocation |
| 12ebe78e | workflows | boxd-cli | 824 | 829 | Native invocation |
| c897581c | powerhouse | memory | 121 | 130 | Research inspection; excluded from operational totals |

Example read-only evidence lookup:

```sh
sqlite3 -readonly ~/.powerhouse/telemetry.db \
  "SELECT run_id, seq, raw FROM events
   WHERE run_id LIKE 'd8292efc%' AND seq IN (85, 97);"
```

### Reproducing the extraction

1. Take a consistent SQLite backup using `sqlite3.Connection.backup`; do not copy only the main DB file while WAL writes are active.
2. Freeze the event cutoff at `2026-09-29 09:20:18 UTC` for this report and exclude run `75f01416-23f6-4c63-b72b-736c1eb7dee2`.
3. Select non-replayed `tool_call` and `tool_call_update` events, ordered by `(run_id, seq)`. Parse `params.update`, merge non-absent fields per `(run_id, toolCallId)`, including `rawInput`, `kind`, `name`, `title`, `status`, and `rawOutput`.
4. Select final `status == completed` calls with a read-kind input path ending in `/SKILL.md`, or native skill invocations with a `skill` argument. Verify output content; normalize the parent directory or explicit invocation name to the skill name.
5. Inspect remaining shell commands mentioning `SKILL.md`; exclude queries/listings/writes and research-only inspections from operational totals. Separately inspect user prompts for explicit invocations.
6. Join to `runs` for project, harness, and chat. Count calls, distinct runs, and distinct chats separately. Reconcile the result with the 23 operational rows plus one research row in the ledger.
7. Deduplicate catalog updates per run and normalized name. Compare with an inventory of `SKILL.md` paths under the three roots, following symlinks. Hash file contents to distinguish identical and divergent copies.

The temporary snapshot is not checked into git: it contains private conversational data. Re-running later can differ if the live database has been rebuilt, pruned, or the skill installation changed. The timestamp, exclusion, and event ledger are the audit trail, not a promise that mutable live run counters will stay identical.

## Follow-up measurement before permanent deletion

1. Create a narrow Powerhouse profile, preserving on-demand discovery and safety-relevant skills.
2. Start fresh Claude and Pi sessions; verify the advertised catalog and representative skill loads. Do not assume a settings change updates already-running sessions.
3. Record skill name/version, exposure, explicit load, harness, project, and task type. Capture optional user invocation separately from automatic selection.
4. Compare at least a few weeks of comparable task categories before and after: verified completion, user corrections/reopened tasks, startup context, and observed skill-load overhead. Do not claim causal benefit from raw usage counts.
5. Uninstall only owner-confirmed unwanted capabilities, after checking other projects, terminal/cloud use, and cross-skill dependencies. Keep a restorable source for removed skills.

**Bottom line:** telemetry already supports a useful usage audit. It supports removing catalog noise and conflicting procedures today, but not declaring 39 skills globally unnecessary.
