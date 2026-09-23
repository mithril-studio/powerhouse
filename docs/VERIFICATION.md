# Telemetry verification checklist

Two layers: the automated gate (run it before every merge) and the manual
smoke checks (run after changes to capture, storage, or the queue — they
exercise the acceptance criteria a machine can't).

## Automated gate

```sh
./scripts/verify.sh        # or: pnpm verify
```

Covers: Rust unit tests (projector fixtures, store round-trips,
rebuild-equals-incremental, run-close idempotency, orphan reconciliation,
v1→v2 migration, metric determinism), TypeScript typecheck + unit tests
(unknown-renders-as-"—", coverage badges, digest markdown), the production
build, and — when a live `~/.powerhouse/telemetry.db` exists — SQLite
`integrity_check` plus schema version.

## Live checks during manual testing

Manual testing doubles as a soak test — two watchers run while you use the app:

- **In-app health strip** (Telemetry page, above the tabs): a battery of nine
  invariant checks re-runs automatically on every captured event batch —
  database integrity, schema version, orphan events, sequence continuity,
  projection-counter consistency, usage honesty (unknown never becomes 0),
  stale-open-run reconciliation, and a **shadow replay** that re-feeds recent
  runs' raw events through the projector and confirms stored projections
  match. Green = all invariants hold; any drift turns the strip red with the
  offending run ids. Keep the Telemetry page open (or revisit it after each
  step below) — checks run on open and on every update while it's open.
- **Terminal heartbeat**: `./scripts/watch-telemetry.sh` in a separate
  terminal shows events flowing in live (counts, last-event age, evidence
  gaps, the last 8 events) plus a periodic integrity check.

## Manual smoke — milestone 1 (capture & evidence)

Start the app with `pnpm tauri dev`, then:

- [ ] **Live run.** Open a Claude (ACP) chat, send a prompt. Telemetry → Runs
      shows the run with a pulsing dot; when the reply finishes, the turn has
      a stop reason and tool calls show durations.
- [ ] **Markdown.** Ask the agent for "a 3-column markdown table and a bullet
      list". The reply shows a bordered table and real bullets, not pipes and
      dashes. Fenced code keeps its indentation.
- [ ] **Images.** In a Claude chat, paste a screenshot (⌃⇧⌘4 then ⌘V), drop a
      PNG from Finder, and use **+**. Each shows a thumbnail chip; send with
      "what is this?" and the agent describes the image. The chip persists
      across a restart as a labelled placeholder. A `.txt` drop is refused with
      a transcript note.
- [ ] **Crash retention.** Kill the app mid-turn (`kill -9` the process).
      Relaunch → the run shows an `interrupted` badge and its Evidence tab
      still contains every event up to the kill.
- [ ] **Resume without double-counting.** Resume that chat. A *new* run row
      appears with a `resumed` badge and the same provider session id. Stats
      totals (turns/tools/tokens) do **not** jump from replayed history —
      replayed events show `replayed` in the Evidence view.
- [ ] **Uninstrumented is not zero.** Open a terminal (PTY) chat → its run
      shows `uninstrumented` and tokens render "—", never 0.
- [ ] **Rebuild is lossless.** Note the stat tiles, click "Rebuild
      projections", confirm identical numbers after.
- [ ] **DB spot-check (optional).**
      `sqlite3 ~/.powerhouse/telemetry.db "SELECT seq,direction,method,update_kind FROM events ORDER BY rowid DESC LIMIT 20;"`
      shows both `out` (your prompts) and `in` (agent) rows.

## Manual smoke — milestone 2 (outcomes & context)

- [ ] **Context captured.** In a run's detail pane: model, mode, and source
      SHA are populated for an ACP run (— only where genuinely unknown).
- [ ] **Task join.** Work on a branch in a chat, then enqueue that branch in
      the merge queue. Telemetry → Tasks shows one row joining the agent
      effort to the queue outcome.
- [ ] **Delivery truth.** A failed queue entry shows the task red
      ("failed (n attempts)") — it must never count as delivered. Only after
      a merge does it turn green; retries show "merged (n attempts)" rather
      than first-pass.
- [ ] **Digest cites evidence.** "Copy digest" produces markdown with
      denominators ("2/4 instrumented runs reported usage"), "—" for unknown
      cost, and run ids on every failure item.

## Manual smoke — milestone 3 (proposal ledger)

- [ ] **Lifecycle.** Create a proposal (pick a metric), Adopt it (baseline
      freezes with its n), Evaluate → on a thin database the verdict is
      `insufficient-evidence` — this is correct behavior, not a bug.
- [ ] **Decision is human.** Keep/Revert buttons record the decision + note;
      the verdict alone never changes status.
- [ ] **Bad input rejected.** Creating a proposal with an empty title fails
      with a clear error; a second Adopt on the same proposal fails.

## When to run what

| Change | Gate | Manual sections |
|---|---|---|
| Frontend-only (views, formatting) | `pnpm verify` | — |
| Projector / store / writer | `pnpm verify` | M1 |
| Spawn sites (acp/pty/queue) or annotate | `pnpm verify` | M1 + M2 |
| Metrics or proposals | `pnpm verify` | M3 |
| Schema change | `pnpm verify` | all, on a copy of a real DB |
