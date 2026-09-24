# Agentic memory for Powerhouse — research and recommendation

Date: 2026-09-23. Status: research, no decision recorded yet.

Goal: give the coding agents Powerhouse launches (Claude Code, Codex, Pi over ACP, locally and on boxd VMs) a shared, persistent memory that measurably makes them better, backed by an open-source system, rendered and editable on the existing Memory page.

## 1. What the evidence says helps coding agents

The benchmark literature is consistent about the shape of memory that pays off. Summary of the strongest results:

| Finding | Source | Effect |
|---|---|---|
| Distilled success + failure items, retrieved by task similarity | ReasoningBank (arXiv 2509.25140) | SWE-bench Verified +3.4 to +4.6pp, up to 16% fewer steps; failures included beats success-only |
| Subtask-level memory beats whole-trajectory memory | arXiv 2602.21611 | +4.7pp Pass@1 on SWE-bench Verified |
| Short summaries of prior related tasks (~200 tokens) beat full trajectories (~25k tokens) | SWE Context Bench (arXiv 2602.08316) | 26.3% to 34.3% resolve; >60% runtime reduction on hard tasks. Unguided retrieval: no gain, +27% cost |
| Learned procedural skill bank | CODESKILL (arXiv 2605.25430) | +9.7% pass rate over no-skill |
| Add-all memory vs curated add+delete | arXiv 2505.16067 | 13% accuracy with 2,400 records vs 39% with 248 |
| Context files (AGENTS.md / CLAUDE.md) | arXiv 2602.11988, 2607.27250, 2601.20404 | No correctness gain, >20% cost if generic; -28% runtime when they encode non-default practices |
| Agents cannot detect stale memories | STALE (arXiv 2605.06527) | Needs explicit age and supersession |

What works: failure-avoidance entries (gotchas), subtask-level procedures, non-derivable repo conventions, explicit user corrections, decisions with rationale. Retrieval keyed on task structure and files touched, not on everything.

What hurts: repo overviews and architecture narratives, raw transcript recall, add-all writes, writes from unverified sessions, unconditional injection, memory outranking checked-in code and docs, memories without timestamp, scope, or provenance.

Every vendor converged on the same product shape: file-based, human-readable, per-repo, small, reviewable, subordinate to checked-in docs. Claude Code auto-memory (user / feedback / project / reference types, 200-line index), Codex memories (off by default, code wins on conflict), Cursor and Augment (propose then approve), Devin Knowledge (every item carries a retrieval trigger).

Implication for Powerhouse: the store matters less than the write discipline and the retrieval gate. The existing `.mem/` JSONL convention in this repo already matches the evidence well (failure + resolution, convention, decision, evidence.files for retrieval, supersession, append-only for git merges). Whatever we adopt should keep those properties.

## 2. Landscape of open-source systems (verified 2026-09-23)

| System | License | Storage / deps | Interface | Fits the Powerhouse constraints? |
|---|---|---|---|---|
| Basic Memory | AGPL-3.0 | Markdown is source of truth, SQLite index derived, optional local FastEmbed; no LLM needed to write | MCP stdio/HTTP, `bm` CLI, first-party Claude Code + Codex hooks, Pi package | Yes. Only system where files are canonical, git-syncable, Obsidian-editable, and all three agents have integrations |
| Hindsight | MIT | Postgres (embedded pg0 ok), LLM required for every write | REST, per-bank MCP, Claude Code / Codex / Pi integrations | Partial. Best retrieval science, but server state, not files; laptop and VMs must reach one server |
| agentmemory | Apache-2.0 | SQLite, keyless BM25 mode, LLM optional | 54 MCP tools, Claude Code / Codex / Pi wiring | Partial. TypeScript, young and fast-moving, server state |
| Cognee | Apache-2.0 | SQLite + LanceDB + Kuzu embedded; LLM for extraction | MCP, Claude Code + Codex plugins | Partial. Graph, not files; no Pi |
| claude-mem | Apache-2.0 | SQLite + Chroma, hosted observer by default | Claude Code hooks, MCP search | No. Claude-only, drifting commercial |
| mem0 | Apache-2.0 | Qdrant + Postgres, LLM per write | SDK, REST, plugins | No. Hosted-platform shape, not git-friendly |
| Graphiti / Zep | Apache-2.0 | Neo4j or FalkorDB, LLM + embeddings | Python, MCP | No. Graph DB requirement, Zep CE retired |
| Letta | Apache-2.0 | MemFS: markdown + git, but only for Letta agents | Its own harness | No as a layer, but its MemFS pattern is worth copying |
| Supermemory, Memori, MemOS, OpenViking, MemPalace | mixed | server or hosted | various | No. Hosted or heavy, or wrong agents |
| LangMem, A-MEM | MIT | library only | Python | No. Research or LangGraph-only |
| Roll our own on the Claude auto-memory convention | n/a | Markdown dir, small Rust MCP server in Tauri | MCP + FTS5 | Yes, zero deps, but no community and no search or graph without building it |

Complement worth noting: deja-vu (MIT, Go, no LLM) indexes raw session logs of 34 agents and syncs over SSH. Useful for "what did the agent do last Tuesday" recall, not curated memory.

## 3. How memory reaches the agents under ACP

Powerhouse sends `mcpServers: []` on every session/new, session/load and session/resume in `src/lib/acpRegistry.ts`. That array is the uniform injection seam.

Schema (ACP protocol v1, which the app and adapters speak): http entries are `{ type: "http", name, url, headers }`. Stdio entries are untagged, `{ name, command, args, env }`. Sending `type: "stdio"` makes claude-agent-acp silently drop the server.

| Channel | Claude Code (claude-agent-acp 0.81) | Codex (codex-acp 1.13) | Pi (`npx pi-acp`, the adapter Powerhouse uses) |
|---|---|---|---|
| ACP mcpServers http | Yes (probe bug fixed 2026-09-23) | Yes, with open bugs: servers replace config.toml ones (PR 507), session/new does not await MCP startup (PR 517), upstream Codex may hang on per-thread config (issue 45361) | Accepted but not wired to Pi. The georgeharker fork plus pi-mcp-adapter does wire it |
| Context file | CLAUDE.md hierarchy | AGENTS.md | AGENTS.md, `.pi/APPEND_SYSTEM.md` |
| Per-session system prompt append | `_meta.systemPrompt.append` | `developer_instructions` via `CODEX_CONFIG` env per process | fork only |
| Filesystem hooks with context injection | Yes, settings.json and plugin hooks run under ACP | Yes, hooks.json, app-server supported | Extensions (`session_start`, `before_agent_start`) |
| Native memory to switch off | auto-memory, on by default; disable with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` via `_meta.claudeCode.options.env` | memories, off by default | none |

The only channel all three agents share reliably today is the prompt itself. Recall must therefore be host-side: Powerhouse builds the brief and prepends it to the first prompt. Capture can be host-side too, since the app already receives every session/update.

## 4. Recommendation

Adopt Basic Memory as the store and MCP surface, wrapped by a Powerhouse memory layer that enforces the write discipline the evidence demands.

Why Basic Memory over the alternatives: markdown files are canonical so the Memory page can render and edit them directly, the index rebuilds from files so only the notes folder needs to sync to VMs, no LLM is needed to write, and Claude Code, Codex and Pi all have first-party integrations. Hindsight has better retrieval but forces a shared server and an LLM per write, which breaks the offline laptop plus ephemeral VM model.

Risks to accept or mitigate:

- AGPL-3.0. Run it as a separate process over MCP, never link or bundle it into the Tauri binary, and get a license read before shipping an installer that pulls it in. Powerhouse ships through the updater, so distribution counts.
- Python plus uv runtime that the desktop app must bootstrap, and a FastMCP 4 prerelease pin at the moment.
- About 30 MCP tools. Allowlist a handful per agent to keep context cost down.
- Pi. The adapter Powerhouse uses does not wire MCP servers. Either switch to the georgeharker fork with pi-mcp-adapter, or ship a tiny Pi extension that reads the same brief.
- No local REST API. The Memory page talks streamable-HTTP MCP to one app-supervised process, or reads the markdown folder directly and uses MCP only for search and graph.

## 5. Proposed shape of the Powerhouse memory layer

Taxonomy, derived from the evidence and mapped onto Basic Memory folders with a fixed note template:

| Type | Content | Why |
|---|---|---|
| gotcha | failure, cause, fix, tied to file, tool or command | strongest evidence, targets repeated-mistake rate |
| procedure | subtask-level how-to, at most ten lines | AWM, CODESKILL, subtask-memory gains |
| convention | non-default repo rule the agent cannot infer from code | the only context-file content with measurable effect |
| correction | explicit user correction or confirmed approach | highest-signal write trigger |
| decision | choice plus reason, not derivable from git | prevents relitigating |
| pointer | where external information lives | cheap, low-risk |

Excluded on purpose: architecture summaries, episodic logs, generic facts.

Read path: Powerhouse builds a brief at session start from `recent_activity` plus `build_context` scoped to the repo, capped at roughly 200 lines, filtered by the files and directories the task names. Gotchas and procedures re-surface on tool errors. The brief is marked as reference data, not instructions, and code wins on conflict.

Write path: agent writes through `write_note` during the run. Powerhouse writes a deterministic checkpoint note at turn end from the session/update stream (cwd, files touched, commands, final summary), skipping short or inconclusive sessions. Proposed entries land in an inbox; the Memory page shows them for approve, edit or discard before they become active.

Scoping: per repo by default, committed inside the repo so it travels to the VM in the checkout. User preferences go to a global project. Branch-specific entries carry the commit they were pinned to.

Hygiene: `modified` timestamp and provenance on every note, supersede instead of delete, a periodic consolidation pass that merges duplicates and flags entries older than a threshold.

Measurement: the telemetry proposals feature already tracks first-pass merge rate, error turn rate and tool failure rate per repo. Run memory as a proposal against those metrics, and add a repeated-mistake counter (same gotcha recorded twice) and retrieval precision (was an injected memory referenced in the run).

Migration: convert the existing `.mem/domains/*.jsonl` records into Basic Memory notes under `gotcha/` and `convention/`. The field mapping is one to one.

## 6. Open questions before implementation

1. Is AGPL acceptable for a distributed desktop app that installs Basic Memory as a separate process? Needs a legal read.
2. Pi: switch adapter, or ship an extension?
3. Bootstrap strategy for Python and uv on a fresh machine and inside the boxd snapshot VM.
4. Human review gate on every write, or only on writes that did not come from a user correction?

## Sources

Evidence: ReasoningBank https://arxiv.org/abs/2509.25140; subtask memory https://arxiv.org/abs/2602.21611; CODESKILL https://arxiv.org/abs/2605.25430; SWE Context Bench https://arxiv.org/html/2602.08316v3; experience-following https://arxiv.org/abs/2505.16067; Evaluating AGENTS.md https://arxiv.org/abs/2602.11988; two-agent ablation https://arxiv.org/html/2607.27250; STALE https://arxiv.org/pdf/2605.06527; Claude Code memory docs https://code.claude.com/docs/en/memory; Codex memories https://developers.openai.com/codex/memories; Augment memory review https://www.augmentcode.com/blog/how-we-built-memory-review; Devin knowledge https://docs.devin.ai/product-guides/knowledge.

Systems: Basic Memory https://github.com/basicmachines-co/basic-memory and https://docs.basicmemory.com/raw/integrations/harness-capture.md; Hindsight https://github.com/vectorize-io/hindsight; agentmemory https://github.com/rohitg00/agentmemory; Cognee https://github.com/topoteretes/cognee; claude-mem https://github.com/thedotmack/claude-mem; mem0 https://github.com/mem0ai/mem0; Graphiti https://github.com/getzep/graphiti; Letta MemFS https://docs.letta.com/letta-code/memfs; deja-vu https://github.com/vshulcz/deja-vu.

Integration: ACP session setup https://agentclientprotocol.com/protocol/session-setup; claude-agent-acp https://github.com/agentclientprotocol/claude-agent-acp (hooks under ACP, issue 144); codex-acp https://github.com/agentclientprotocol/codex-acp (PRs 507, 517); Codex issue https://github.com/openai/codex/issues/45361; pi-acp https://github.com/svkozak/pi-acp and fork https://github.com/georgeharker/pi-acp; pi-mcp-adapter https://github.com/nicobailon/pi-mcp-adapter; Basic Memory Pi plan https://github.com/basicmachines-co/basic-memory/blob/main/docs/PI_MEMORY_PLAN.md.
