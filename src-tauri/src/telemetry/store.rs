// SQLite persistence. `events` is the append-only source of truth; `runs`'
// projected columns plus `turns`/`tool_calls` are projections that
// `rebuild()` re-derives from raw events through the same `ingest` path the
// live writer uses — replay must reproduce identical totals.
use super::projector::{parse_line, Delta, Direction, Projector};
use rusqlite::{params, Connection};

/// Raw lines are evidence, but a runaway tool result shouldn't balloon the
/// database; oversized lines are cut and flagged `truncated`.
const RAW_CAP: usize = 512 * 1024;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
  boot_id             TEXT NOT NULL,
  source              TEXT NOT NULL,           -- 'acp' | 'pty' | 'queue'
  coverage            TEXT NOT NULL,           -- 'instrumented' | 'uninstrumented' | 'process-only'
  chat_id             TEXT,
  provider_session_id TEXT,
  resumed             INTEGER NOT NULL DEFAULT 0,
  agent_command       TEXT,
  cwd                 TEXT,
  repo_id             TEXT,                    -- join key to queue outcomes
  source_sha          TEXT,                    -- worktree HEAD at spawn
  model               TEXT,                    -- last observed on the wire
  mode                TEXT,
  agent_name          TEXT,
  agent_version       TEXT,
  repo_label          TEXT,
  branch_label        TEXT,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,                 -- NULL = live, or unknown for interrupted runs
  exit_code           INTEGER,
  end_reason          TEXT,                    -- 'exit'|'killed'|'app-shutdown'|'interrupted'|NULL
  dropped_events      INTEGER NOT NULL DEFAULT 0,
  parse_errors        INTEGER NOT NULL DEFAULT 0,
  usage_events        INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER,                 -- NULL = unknown, never zero
  output_tokens       INTEGER,
  cached_tokens       INTEGER,
  cost_usd            REAL,
  turn_count          INTEGER NOT NULL DEFAULT 0,
  tool_call_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS runs_chat ON runs(chat_id, started_at);

CREATE TABLE IF NOT EXISTS events (
  run_id       TEXT    NOT NULL REFERENCES runs(run_id),
  seq          INTEGER NOT NULL,
  direction    TEXT    NOT NULL,               -- 'in' | 'out' | 'err' | 'sys'
  ingest_time  INTEGER NOT NULL,
  event_time   INTEGER,
  method       TEXT,
  update_kind  TEXT,
  rpc_id       TEXT,
  parse_status TEXT    NOT NULL,               -- 'ok' | 'invalid-json' | 'non-jsonrpc'
  replayed     INTEGER NOT NULL DEFAULT 0,
  truncated    INTEGER NOT NULL DEFAULT 0,
  raw          TEXT    NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS turns (
  run_id         TEXT    NOT NULL,
  turn_idx       INTEGER NOT NULL,
  prompt_seq     INTEGER NOT NULL,
  prompt_preview TEXT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  stop_reason    TEXT,
  PRIMARY KEY (run_id, turn_idx)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  run_id       TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  turn_idx     INTEGER,
  title        TEXT,
  kind         TEXT,
  status       TEXT,
  first_seq    INTEGER NOT NULL,
  last_seq     INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  PRIMARY KEY (run_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id      TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  title            TEXT NOT NULL,
  hypothesis       TEXT NOT NULL,
  target           TEXT NOT NULL,              -- the artifact being changed
  metric           TEXT NOT NULL,              -- key from METRICS
  repo_id          TEXT,                       -- optional cohort scope
  evidence_run_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of run ids
  min_samples      INTEGER NOT NULL DEFAULT 5,
  status           TEXT NOT NULL DEFAULT 'proposed', -- proposed|adopted|kept|reverted|retired
  adopted_at       INTEGER,
  decided_at       INTEGER,
  decision_note    TEXT,
  baseline_json    TEXT,                       -- frozen at adoption
  evaluation_json  TEXT                        -- last deterministic comparison
);
"#;

/// v1 → v2: context/attribution columns. Applied only when an existing
/// database self-reports version 1 (fresh databases are created at v2).
const MIGRATE_V1_V2: &str = r#"
ALTER TABLE runs ADD COLUMN repo_id TEXT;
ALTER TABLE runs ADD COLUMN source_sha TEXT;
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN mode TEXT;
"#;

pub fn open_db(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    init_schema(&conn)?;
    Ok(conn)
}

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;\nPRAGMA synchronous = NORMAL;\nPRAGMA foreign_keys = ON;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let version: i64 = conn
        .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if version == 1 {
        conn.execute_batch(MIGRATE_V1_V2).map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '2')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Startup hygiene: any run still open belongs to a previous app launch and
/// its true end is unknowable. Mark it interrupted; keep everything ingested
/// (`ended_at` stays NULL — the end time is genuinely unknown).
pub fn reconcile_interrupted(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "UPDATE runs SET end_reason = 'interrupted' WHERE ended_at IS NULL AND end_reason IS NULL",
        [],
    )
    .map_err(|e| e.to_string())
}

#[derive(Clone)]
pub struct RunStart {
    pub run_id: String,
    pub source: &'static str,
    pub coverage: &'static str,
    pub chat_id: Option<String>,
    pub agent_command: Option<String>,
    pub cwd: Option<String>,
    pub started_at: i64,
    pub repo_id: Option<String>,
    pub source_sha: Option<String>,
    pub repo_label: Option<String>,
    pub branch_label: Option<String>,
}

pub fn insert_run(conn: &Connection, spec: &RunStart, boot_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO runs
           (run_id, boot_id, source, coverage, chat_id, agent_command, cwd,
            started_at, repo_id, source_sha, repo_label, branch_label)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            spec.run_id,
            boot_id,
            spec.source,
            spec.coverage,
            spec.chat_id,
            spec.agent_command,
            spec.cwd,
            spec.started_at,
            spec.repo_id,
            spec.source_sha,
            spec.repo_label,
            spec.branch_label,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Idempotent: the exit poller, kill commands, and app shutdown can all race
/// to close a run — first close wins.
pub fn end_run(
    conn: &Connection,
    run_id: &str,
    ended_at: i64,
    exit_code: Option<i32>,
    reason: &str,
    dropped: u64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE runs SET ended_at = ?2, exit_code = ?3, end_reason = ?4,
                         dropped_events = MAX(dropped_events, ?5)
         WHERE run_id = ?1 AND ended_at IS NULL AND end_reason IS NULL",
        params![run_id, ended_at, exit_code, reason, dropped as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Default)]
pub struct Annotation {
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub repo_id: Option<String>,
    pub repo_label: Option<String>,
    pub branch_label: Option<String>,
    pub model: Option<String>,
}

pub fn annotate_run(conn: &Connection, run_id: &str, a: &Annotation) -> Result<(), String> {
    conn.execute(
        "UPDATE runs SET agent_name    = COALESCE(?2, agent_name),
                         agent_version = COALESCE(?3, agent_version),
                         repo_id       = COALESCE(?4, repo_id),
                         repo_label    = COALESCE(?5, repo_label),
                         branch_label  = COALESCE(?6, branch_label),
                         model         = COALESCE(model, ?7)
         WHERE run_id = ?1",
        params![
            run_id,
            a.agent_name,
            a.agent_version,
            a.repo_id,
            a.repo_label,
            a.branch_label,
            a.model,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_dropped(conn: &Connection, run_id: &str, dropped: u64) -> Result<(), String> {
    conn.execute(
        "UPDATE runs SET dropped_events = MAX(dropped_events, ?2) WHERE run_id = ?1",
        params![run_id, dropped as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Ingest one raw line: parse, fold through the run's projector, store the
/// event row, and apply the resulting projection deltas. `insert=false` is
/// the rebuild path — the event row already exists and only its derived
/// annotation columns are rewritten.
pub fn ingest_event(
    conn: &Connection,
    proj: &mut Projector,
    run_id: &str,
    seq: i64,
    direction: Direction,
    ingest_time: i64,
    raw: &str,
    insert: bool,
) -> Result<(), String> {
    let (raw, truncated) = cap_raw(raw);
    let parsed = parse_line(raw);
    let deltas = proj.feed(direction, seq, ingest_time, &parsed);
    let replayed = deltas.contains(&Delta::Replayed);
    let err = |e: rusqlite::Error| e.to_string();

    if insert {
        conn.execute(
            "INSERT OR IGNORE INTO events
               (run_id, seq, direction, ingest_time, event_time, method, update_kind,
                rpc_id, parse_status, replayed, truncated, raw)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                run_id,
                seq,
                direction.as_str(),
                ingest_time,
                parsed.event_time,
                parsed.method_label(),
                parsed.update_kind,
                parsed.rpc_id,
                parsed.parse_status,
                replayed as i64,
                truncated as i64,
                raw,
            ],
        )
        .map_err(err)?;
    } else {
        conn.execute(
            "UPDATE events SET event_time = ?3, method = ?4, update_kind = ?5, rpc_id = ?6,
                               parse_status = ?7, replayed = ?8
             WHERE run_id = ?1 AND seq = ?2",
            params![
                run_id,
                seq,
                parsed.event_time,
                parsed.method_label(),
                parsed.update_kind,
                parsed.rpc_id,
                parsed.parse_status,
                replayed as i64,
            ],
        )
        .map_err(err)?;
    }

    // Unparseable stdout is an evidence gap worth surfacing; stderr and
    // synthetic rows are expected to be non-JSON.
    if direction == Direction::In && parsed.parse_status != "ok" {
        conn.execute(
            "UPDATE runs SET parse_errors = parse_errors + 1 WHERE run_id = ?1",
            params![run_id],
        )
        .map_err(err)?;
    }

    if !replayed {
        for delta in &deltas {
            apply_delta(conn, run_id, delta)?;
        }
    }
    Ok(())
}

fn apply_delta(conn: &Connection, run_id: &str, delta: &Delta) -> Result<(), String> {
    let err = |e: rusqlite::Error| e.to_string();
    match delta {
        Delta::Session { session_id, resumed } => {
            conn.execute(
                "UPDATE runs SET provider_session_id = ?2, resumed = MAX(resumed, ?3)
                 WHERE run_id = ?1",
                params![run_id, session_id, *resumed as i64],
            )
            .map_err(err)?;
        }
        Delta::Agent { name, version } => {
            conn.execute(
                "UPDATE runs SET agent_name    = COALESCE(agent_name, ?2),
                                 agent_version = COALESCE(agent_version, ?3)
                 WHERE run_id = ?1",
                params![run_id, name, version],
            )
            .map_err(err)?;
        }
        Delta::TurnOpen { idx, prompt_seq, preview, at } => {
            conn.execute(
                "INSERT OR IGNORE INTO turns (run_id, turn_idx, prompt_seq, prompt_preview, started_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![run_id, idx, prompt_seq, preview, at],
            )
            .map_err(err)?;
            conn.execute(
                "UPDATE runs SET turn_count = turn_count + 1 WHERE run_id = ?1",
                params![run_id],
            )
            .map_err(err)?;
        }
        Delta::TurnClose { idx, stop_reason, at } => {
            conn.execute(
                "UPDATE turns SET ended_at = ?3, stop_reason = ?4
                 WHERE run_id = ?1 AND turn_idx = ?2 AND ended_at IS NULL",
                params![run_id, idx, at, stop_reason],
            )
            .map_err(err)?;
        }
        Delta::ToolUpsert { id, title, kind, status, turn_idx, seq, at } => {
            let inserted = conn
                .execute(
                    "INSERT OR IGNORE INTO tool_calls
                       (run_id, tool_call_id, turn_idx, title, kind, status,
                        first_seq, last_seq, started_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
                    params![run_id, id, turn_idx, title, kind, status, seq, at],
                )
                .map_err(err)?;
            if inserted > 0 {
                conn.execute(
                    "UPDATE runs SET tool_call_count = tool_call_count + 1 WHERE run_id = ?1",
                    params![run_id],
                )
                .map_err(err)?;
            } else {
                let terminal = matches!(status.as_deref(), Some("completed") | Some("failed"));
                conn.execute(
                    "UPDATE tool_calls SET title    = COALESCE(?3, title),
                                           kind     = COALESCE(?4, kind),
                                           status   = COALESCE(?5, status),
                                           last_seq = ?6,
                                           ended_at = CASE WHEN ?7 THEN ?8 ELSE ended_at END
                     WHERE run_id = ?1 AND tool_call_id = ?2",
                    params![run_id, id, title, kind, status, seq, terminal, at],
                )
                .map_err(err)?;
            }
        }
        Delta::Context { model, mode } => {
            // Wire observations beat annotations, and later observations beat
            // earlier ones (a mid-run model switch updates the run's context).
            conn.execute(
                "UPDATE runs SET model = CASE WHEN ?2 IS NOT NULL THEN ?2 ELSE model END,
                                 mode  = CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE mode END
                 WHERE run_id = ?1",
                params![run_id, model, mode],
            )
            .map_err(err)?;
        }
        Delta::Usage(u) => {
            // NULL means unknown: only fields with evidence move off NULL.
            let add_int = |col: &str, v: Option<i64>| -> Result<(), String> {
                if let Some(v) = v {
                    conn.execute(
                        &format!("UPDATE runs SET {col} = COALESCE({col}, 0) + ?2 WHERE run_id = ?1"),
                        params![run_id, v],
                    )
                    .map_err(|e| e.to_string())?;
                }
                Ok(())
            };
            add_int("input_tokens", u.input)?;
            add_int("output_tokens", u.output)?;
            add_int("cached_tokens", u.cached)?;
            if let Some(cost) = u.cost {
                conn.execute(
                    "UPDATE runs SET cost_usd = COALESCE(cost_usd, 0) + ?2 WHERE run_id = ?1",
                    params![run_id, cost],
                )
                .map_err(err)?;
            }
            conn.execute(
                "UPDATE runs SET usage_events = usage_events + 1 WHERE run_id = ?1",
                params![run_id],
            )
            .map_err(err)?;
        }
        Delta::Replayed => {}
    }
    Ok(())
}

fn cap_raw(raw: &str) -> (&str, bool) {
    let raw = raw.trim_end_matches(['\n', '\r']);
    if raw.len() <= RAW_CAP {
        return (raw, false);
    }
    let mut cut = RAW_CAP;
    while cut > 0 && !raw.is_char_boundary(cut) {
        cut -= 1;
    }
    (&raw[..cut], true)
}

#[derive(serde::Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RebuildReport {
    pub runs: u64,
    pub events: u64,
}

/// Wipe every projection and re-derive it by replaying raw events, in order,
/// through a fresh projector per run — the same `ingest_event` code path used
/// live. Capture-time facts (lifecycle, dropped counts, raw rows) stay.
pub fn rebuild(conn: &mut Connection) -> Result<RebuildReport, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        "DELETE FROM turns;
         DELETE FROM tool_calls;
         UPDATE runs SET provider_session_id = NULL, resumed = 0,
                         parse_errors = 0, usage_events = 0,
                         input_tokens = NULL, output_tokens = NULL,
                         cached_tokens = NULL, cost_usd = NULL,
                         turn_count = 0, tool_call_count = 0,
                         mode = NULL;",
    )
    .map_err(|e| e.to_string())?;

    let mut report = RebuildReport::default();
    // Batched keyset pagination: SQLite behavior is undefined when a table is
    // updated while a SELECT over it is still stepping, so each batch is
    // collected before its events are re-ingested (which UPDATEs `events`).
    let mut cursor: (String, i64) = (String::new(), 0);
    let mut current: Option<(String, Projector)> = None;
    loop {
        let batch: Vec<(String, i64, String, i64, String)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT run_id, seq, direction, ingest_time, raw FROM events
                     WHERE run_id > ?1 OR (run_id = ?1 AND seq > ?2)
                     ORDER BY run_id, seq LIMIT 500",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![cursor.0, cursor.1], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        if batch.is_empty() {
            break;
        }
        for (run_id, seq, direction, ingest_time, raw) in &batch {
            let is_new_run = current.as_ref().map(|(id, _)| id != run_id).unwrap_or(true);
            if is_new_run {
                report.runs += 1;
                current = Some((run_id.clone(), Projector::default()));
            }
            let proj = &mut current.as_mut().expect("just set").1;
            ingest_event(
                &tx,
                proj,
                run_id,
                *seq,
                Direction::parse(direction),
                *ingest_time,
                raw,
                false,
            )?;
            report.events += 1;
        }
        let (run_id, seq, ..) = batch.last().expect("non-empty batch");
        cursor = (run_id.clone(), *seq);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(report)
}

// --- metrics -----------------------------------------------------------
//
// Deterministic measurements for the proposal ledger. Code produces the
// numbers; humans (or later, an analyst agent) interpret them. Every metric
// returns its denominator so "insufficient evidence" is decidable, and a
// missing denominator yields value None, never a fabricated zero.

/// (key, higher_is_better) — the closed set of metrics a proposal can target.
pub const METRICS: [(&str, bool); 4] = [
    ("merge_rate", true),            // merged queue runs / terminal queue runs
    ("first_pass_merge_rate", true), // branches whose first attempt merged / branches attempted
    ("error_turn_rate", false),      // error|refusal turns / closed turns
    ("tool_failure_rate", false),    // failed tool calls / terminal tool calls
];

pub fn metric_higher_is_better(metric: &str) -> Option<bool> {
    METRICS.iter().find(|(k, _)| *k == metric).map(|(_, up)| *up)
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricSample {
    /// Denominator: how many observations the value rests on.
    pub n: i64,
    pub value: Option<f64>,
}

/// Computes `metric` over runs whose window column falls in `[from, to)`,
/// optionally scoped to one repo. Repo scoping is null-safe (`IS`-style):
/// passing None means "all repos".
pub fn compute_metric(
    conn: &Connection,
    metric: &str,
    repo_id: Option<&str>,
    from: i64,
    to: i64,
) -> Result<MetricSample, String> {
    let sql = match metric {
        "merge_rate" => {
            "SELECT COUNT(*), SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END)
             FROM runs
             WHERE source = 'queue' AND end_reason IS NOT NULL
               AND started_at >= ?2 AND started_at < ?3
               AND (?1 IS NULL OR repo_id = ?1)"
        }
        "first_pass_merge_rate" => {
            // A branch's first-ever terminal attempt, cohorted by when that
            // first attempt happened.
            "WITH firsts AS (
               SELECT COALESCE(repo_id, '') AS rk, branch_label, MIN(started_at) AS first_at
               FROM runs
               WHERE source = 'queue' AND end_reason IS NOT NULL AND branch_label IS NOT NULL
                 AND (?1 IS NULL OR repo_id = ?1)
               GROUP BY rk, branch_label
             )
             SELECT COUNT(*), SUM(CASE WHEN r.exit_code = 0 THEN 1 ELSE 0 END)
             FROM firsts f
             JOIN runs r ON r.source = 'queue'
               AND COALESCE(r.repo_id, '') = f.rk
               AND r.branch_label = f.branch_label
               AND r.started_at = f.first_at
             WHERE f.first_at >= ?2 AND f.first_at < ?3"
        }
        "error_turn_rate" => {
            "SELECT COUNT(*), SUM(CASE WHEN t.stop_reason IN ('error', 'refusal') THEN 1 ELSE 0 END)
             FROM turns t JOIN runs r ON r.run_id = t.run_id
             WHERE t.stop_reason IS NOT NULL
               AND t.started_at >= ?2 AND t.started_at < ?3
               AND (?1 IS NULL OR r.repo_id = ?1)"
        }
        "tool_failure_rate" => {
            "SELECT COUNT(*), SUM(CASE WHEN c.status = 'failed' THEN 1 ELSE 0 END)
             FROM tool_calls c JOIN runs r ON r.run_id = c.run_id
             WHERE c.status IN ('completed', 'failed')
               AND c.started_at >= ?2 AND c.started_at < ?3
               AND (?1 IS NULL OR r.repo_id = ?1)"
        }
        other => return Err(format!("unknown metric: {other}")),
    };
    let (n, hits): (i64, Option<i64>) = conn
        .query_row(sql, params![repo_id, from, to], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(MetricSample {
        n,
        value: if n > 0 {
            Some(hits.unwrap_or(0) as f64 / n as f64)
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        init_schema(&conn).expect("schema");
        conn
    }

    fn spec(run_id: &str) -> RunStart {
        RunStart {
            run_id: run_id.into(),
            source: "acp",
            coverage: "instrumented",
            chat_id: Some("chat-1".into()),
            agent_command: Some("claude-acp".into()),
            cwd: Some("/tmp".into()),
            started_at: 1_000,
            repo_id: Some("repo-1".into()),
            source_sha: None,
            repo_label: None,
            branch_label: None,
        }
    }

    #[test]
    fn fresh_database_installs_complete_telemetry_schema() {
        let conn = mem();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            tables,
            ["events", "meta", "proposals", "runs", "tool_calls", "turns"]
        );

        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .unwrap();
        let indexes: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(indexes, ["runs_chat", "runs_started"]);

        let version: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, "2");
    }

    /// A terminal queue run for metric tests.
    fn queue_run(conn: &Connection, run_id: &str, branch: &str, started_at: i64, merged: bool) {
        let spec = RunStart {
            run_id: run_id.into(),
            source: "queue",
            coverage: "process-only",
            chat_id: None,
            agent_command: None,
            cwd: None,
            started_at,
            repo_id: Some("repo-1".into()),
            source_sha: None,
            repo_label: Some("repo".into()),
            branch_label: Some(branch.into()),
        };
        insert_run(conn, &spec, "boot-1").unwrap();
        end_run(conn, run_id, started_at + 10, Some(if merged { 0 } else { 1 }), "exit", 0).unwrap();
    }

    const TRANSCRIPT: &[(&str, &str)] = &[
        ("out", r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#),
        ("in", r#"{"jsonrpc":"2.0","id":1,"result":{"agentInfo":{"name":"claude-agent","version":"1.2"}}}"#),
        ("out", r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{}}"#),
        ("in", r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess-1"}}"#),
        ("out", r#"{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"do the thing"}]}}"#),
        ("in", r#"npm WARN not json at all"#),
        ("in", r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Edit","kind":"edit","status":"in_progress"}}}"#),
        ("in", r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed"}}}"#),
        ("in", r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":40,"outputTokens":7,"costUsd":0.02}}}"#),
        ("err", "some stderr noise"),
    ];

    fn ingest_transcript(conn: &Connection, run_id: &str) {
        let mut proj = Projector::default();
        for (i, (dir, raw)) in TRANSCRIPT.iter().enumerate() {
            ingest_event(
                conn,
                &mut proj,
                run_id,
                i as i64 + 1,
                Direction::parse(dir),
                2_000 + i as i64,
                raw,
                true,
            )
            .expect("ingest");
        }
    }

    fn snapshot(conn: &Connection, run_id: &str) -> Vec<String> {
        let mut out = Vec::new();
        for sql in [
            "SELECT run_id, provider_session_id, resumed, agent_name, agent_version, parse_errors,
                    usage_events, input_tokens, output_tokens, cached_tokens, cost_usd,
                    turn_count, tool_call_count
             FROM runs WHERE run_id = ?1",
            "SELECT run_id, turn_idx, prompt_seq, prompt_preview, started_at, ended_at, stop_reason
             FROM turns WHERE run_id = ?1 ORDER BY turn_idx",
            "SELECT run_id, tool_call_id, turn_idx, title, kind, status, first_seq, last_seq,
                    started_at, ended_at
             FROM tool_calls WHERE run_id = ?1 ORDER BY tool_call_id",
            "SELECT seq, method, update_kind, parse_status, replayed FROM events
             WHERE run_id = ?1 ORDER BY seq",
        ] {
            let mut stmt = conn.prepare(sql).expect("prepare");
            let mut rows = stmt.query(params![run_id]).expect("query");
            while let Some(row) = rows.next().expect("row") {
                let mut line = String::new();
                for i in 0..row.as_ref().column_count() {
                    let v: rusqlite::types::Value = row.get(i).expect("col");
                    line.push_str(&format!("{v:?}|"));
                }
                out.push(line);
            }
        }
        out
    }

    #[test]
    fn ingests_a_transcript_into_projections() {
        let conn = mem();
        insert_run(&conn, &spec("r1"), "boot-1").unwrap();
        ingest_transcript(&conn, "r1");

        let (turns, tools, parse_errors, input, cost): (i64, i64, i64, Option<i64>, Option<f64>) = conn
            .query_row(
                "SELECT turn_count, tool_call_count, parse_errors, input_tokens, cost_usd
                 FROM runs WHERE run_id = 'r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!((turns, tools, parse_errors), (1, 1, 1));
        assert_eq!(input, Some(40));
        assert_eq!(cost, Some(0.02));

        let stop: Option<String> = conn
            .query_row("SELECT stop_reason FROM turns WHERE run_id='r1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stop.as_deref(), Some("end_turn"));

        let (status, ended): (Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT status, ended_at FROM tool_calls WHERE run_id='r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status.as_deref(), Some("completed"));
        assert!(ended.is_some());
    }

    #[test]
    fn unknown_usage_stays_null() {
        let conn = mem();
        insert_run(&conn, &spec("r1"), "boot-1").unwrap();
        let mut proj = Projector::default();
        ingest_event(
            &conn,
            &mut proj,
            "r1",
            1,
            Direction::Out,
            2_000,
            r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"prompt":[]}}"#,
            true,
        )
        .unwrap();
        ingest_event(
            &conn,
            &mut proj,
            "r1",
            2,
            Direction::In,
            2_001,
            r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}"#,
            true,
        )
        .unwrap();
        let (usage_events, input): (i64, Option<i64>) = conn
            .query_row(
                "SELECT usage_events, input_tokens FROM runs WHERE run_id='r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(usage_events, 0);
        assert_eq!(input, None, "unknown usage must stay NULL, never become 0");
    }

    #[test]
    fn rebuild_reproduces_identical_projections() {
        let mut conn = mem();
        insert_run(&conn, &spec("r1"), "boot-1").unwrap();
        ingest_transcript(&conn, "r1");
        // Second run with a replayed session/load history to exercise flags.
        insert_run(&conn, &spec("r2"), "boot-1").unwrap();
        let mut proj = Projector::default();
        for (i, (dir, raw)) in [
            ("out", r#"{"jsonrpc":"2.0","id":1,"method":"session/load","params":{"sessionId":"sess-1"}}"#),
            ("in", r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"old","status":"completed"}}}"#),
            ("in", r#"{"jsonrpc":"2.0","id":1,"result":{}}"#),
        ]
        .iter()
        .enumerate()
        {
            ingest_event(&conn, &mut proj, "r2", i as i64 + 1, Direction::parse(dir), 3_000 + i as i64, raw, true)
                .unwrap();
        }

        let before_r1 = snapshot(&conn, "r1");
        let before_r2 = snapshot(&conn, "r2");
        let report = rebuild(&mut conn).unwrap();
        assert_eq!(report, RebuildReport { runs: 2, events: 13 });
        assert_eq!(snapshot(&conn, "r1"), before_r1);
        assert_eq!(snapshot(&conn, "r2"), before_r2);

        // The replayed tool call still contributes nothing after rebuild.
        let (tools, resumed): (i64, i64) = conn
            .query_row(
                "SELECT tool_call_count, resumed FROM runs WHERE run_id='r2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(tools, 0);
        assert_eq!(resumed, 1);
    }

    #[test]
    fn end_run_is_idempotent() {
        let conn = mem();
        insert_run(&conn, &spec("r1"), "boot-1").unwrap();
        end_run(&conn, "r1", 5_000, Some(0), "exit", 2).unwrap();
        end_run(&conn, "r1", 9_999, Some(137), "killed", 0).unwrap();
        let (ended, code, reason): (i64, i32, String) = conn
            .query_row(
                "SELECT ended_at, exit_code, end_reason FROM runs WHERE run_id='r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((ended, code, reason.as_str()), (5_000, 0, "exit"));
    }

    #[test]
    fn reconcile_marks_stale_open_runs_interrupted() {
        let conn = mem();
        insert_run(&conn, &spec("stale"), "boot-0").unwrap();
        assert_eq!(reconcile_interrupted(&conn).unwrap(), 1);
        let (reason, ended): (String, Option<i64>) = conn
            .query_row(
                "SELECT end_reason, ended_at FROM runs WHERE run_id='stale'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(reason, "interrupted");
        assert_eq!(ended, None, "end time is genuinely unknown");
    }

    #[test]
    fn metrics_are_deterministic_with_honest_denominators() {
        let conn = mem();
        // b1: first attempt fails, retry merges. b2: first attempt merges.
        queue_run(&conn, "q1", "b1", 1_000, false);
        queue_run(&conn, "q2", "b1", 2_000, true);
        queue_run(&conn, "q3", "b2", 3_000, true);

        let merge = compute_metric(&conn, "merge_rate", Some("repo-1"), 0, 10_000).unwrap();
        assert_eq!(merge, MetricSample { n: 3, value: Some(2.0 / 3.0) });

        let first_pass =
            compute_metric(&conn, "first_pass_merge_rate", Some("repo-1"), 0, 10_000).unwrap();
        assert_eq!(first_pass, MetricSample { n: 2, value: Some(0.5) });

        // Empty cohorts have no value — never a fabricated zero.
        let empty = compute_metric(&conn, "merge_rate", Some("other-repo"), 0, 10_000).unwrap();
        assert_eq!(empty, MetricSample { n: 0, value: None });

        assert!(compute_metric(&conn, "nonsense", None, 0, 1).is_err());
    }

    #[test]
    fn error_turn_and_tool_failure_rates_count_only_terminal_rows() {
        let conn = mem();
        insert_run(&conn, &spec("r1"), "boot-1").unwrap();
        let mut proj = Projector::default();
        for (i, (dir, raw)) in [
            ("out", r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"a"}]}}"#),
            ("in", r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"ok","status":"in_progress"}}}"#),
            ("in", r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"ok","status":"completed"}}}"#),
            ("in", r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"bad","status":"failed"}}}"#),
            ("in", r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"open","status":"pending"}}}"#),
            ("in", r#"{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"boom"}}"#),
            ("out", r#"{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"b"}]}}"#),
            ("in", r#"{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}"#),
        ]
        .iter()
        .enumerate()
        {
            ingest_event(&conn, &mut proj, "r1", i as i64 + 1, Direction::parse(dir), 2_000 + i as i64, raw, true)
                .unwrap();
        }

        let errors = compute_metric(&conn, "error_turn_rate", None, 0, 10_000).unwrap();
        assert_eq!(errors, MetricSample { n: 2, value: Some(0.5) });

        // 'open' is still pending → excluded from the denominator.
        let tools = compute_metric(&conn, "tool_failure_rate", None, 0, 10_000).unwrap();
        assert_eq!(tools, MetricSample { n: 2, value: Some(0.5) });
    }

    #[test]
    fn v1_databases_migrate_to_v2() {
        let conn = Connection::open_in_memory().unwrap();
        // Fake a v1 database: v2 schema minus the new columns.
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE runs (
               run_id TEXT PRIMARY KEY, boot_id TEXT NOT NULL, source TEXT NOT NULL,
               coverage TEXT NOT NULL, chat_id TEXT, provider_session_id TEXT,
               resumed INTEGER NOT NULL DEFAULT 0, agent_command TEXT, cwd TEXT,
               agent_name TEXT, agent_version TEXT, repo_label TEXT, branch_label TEXT,
               started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER,
               end_reason TEXT, dropped_events INTEGER NOT NULL DEFAULT 0,
               parse_errors INTEGER NOT NULL DEFAULT 0, usage_events INTEGER NOT NULL DEFAULT 0,
               input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
               cost_usd REAL, turn_count INTEGER NOT NULL DEFAULT 0,
               tool_call_count INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO meta VALUES ('schema_version', '1');
             INSERT INTO runs (run_id, boot_id, source, coverage, started_at)
               VALUES ('old', 'b', 'acp', 'instrumented', 1);",
        )
        .unwrap();

        init_schema(&conn).unwrap();

        // New columns exist, old data survives, version is bumped.
        let (repo_id, model): (Option<String>, Option<String>) = conn
            .query_row("SELECT repo_id, model FROM runs WHERE run_id='old'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((repo_id, model), (None, None));
        let version: String = conn
            .query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, "2");
    }

    #[test]
    fn oversized_raw_lines_are_truncated_and_flagged() {
        let conn = mem();
        insert_run(&conn, &spec("r1"), "boot-1").unwrap();
        let big = format!("{{\"jsonrpc\":\"2.0\",\"pad\":\"{}\"}}", "x".repeat(600 * 1024));
        let mut proj = Projector::default();
        ingest_event(&conn, &mut proj, "r1", 1, Direction::In, 2_000, &big, true).unwrap();
        let (truncated, len, status): (i64, i64, String) = conn
            .query_row(
                "SELECT truncated, LENGTH(raw), parse_status FROM events WHERE run_id='r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(truncated, 1);
        assert!(len <= 512 * 1024);
        assert_eq!(status, "invalid-json");
    }

    #[test]
    fn rebuild_preserves_annotation_only_model_metadata() {
        let mut conn = mem();
        insert_run(&conn, &spec("r1"), "boot-1").unwrap();
        annotate_run(
            &conn,
            "r1",
            &Annotation { model: Some("claude-sonnet".into()), ..Annotation::default() },
        )
        .unwrap();

        rebuild(&mut conn).unwrap();

        let model: Option<String> = conn
            .query_row("SELECT model FROM runs WHERE run_id='r1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(model.as_deref(), Some("claude-sonnet"));
    }
}
