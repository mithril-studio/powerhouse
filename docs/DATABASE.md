# Database architecture

Powerhouse stores lightweight agent telemetry in
`~/.powerhouse/telemetry.db`. The database is initialized during Tauri startup
and uses SQLite WAL mode so the background capture writer and UI reads can run
concurrently.

## Telemetry schema

| Table | Role |
|---|---|
| `meta` | Schema version and database metadata |
| `runs` | One lifecycle record per ACP, PTY, or merge-queue process |
| `events` | Append-only raw protocol evidence, ordered by `(run_id, seq)` |
| `turns` | Rebuildable turn projection derived from events |
| `tool_calls` | Rebuildable tool-call projection derived from events |
| `proposals` | Human-controlled improvement experiments and evaluations |

`events` is the source of truth. Derived run counters, turns, and tool calls
can be rebuilt deterministically through the same projector used for live
ingestion. Lifecycle and annotation fields on `runs` are retained because they
come from process supervision rather than the event stream.

Schema changes are versioned in `meta.schema_version` and migrated when the
database opens. The schema contract is covered by Rust tests; the broader
integrity and projection invariants are checked by `pnpm verify` and by the
Telemetry screen's health checks.

See [VERIFICATION.md](./VERIFICATION.md) for automated and manual database
checks.
