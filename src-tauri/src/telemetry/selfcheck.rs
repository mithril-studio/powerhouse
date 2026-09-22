// Live invariant checks against the real database. These run continuously
// while the Telemetry page is open, so manual testing doubles as a soak test:
// every event batch re-verifies that capture, projection, and honesty rules
// still hold. Read-only — checking must never mutate the evidence.
use super::projector::{parse_line, Delta, Direction, Projector};
use rusqlite::{params, Connection};

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub id: &'static str,
    pub label: &'static str,
    pub status: &'static str, // 'pass' | 'fail' | 'info'
    pub detail: String,
}

fn pass(id: &'static str, label: &'static str, detail: String) -> CheckResult {
    CheckResult { id, label, status: "pass", detail }
}
fn fail(id: &'static str, label: &'static str, detail: String) -> CheckResult {
    CheckResult { id, label, status: "fail", detail }
}

/// How many recent instrumented runs the shadow replay re-verifies per tick.
const REPLAY_SAMPLE: usize = 10;

pub fn run_checks(conn: &Connection) -> Vec<CheckResult> {
    let mut results = Vec::new();
    results.push(check_integrity(conn));
    results.push(check_schema(conn));
    results.push(check_orphan_events(conn));
    results.push(check_seq_continuity(conn));
    results.push(check_projection_counts(conn));
    results.push(check_usage_honesty(conn));
    results.push(check_stale_open_runs(conn));
    results.push(check_replay_determinism(conn));
    results.push(check_freshness(conn));
    results
}

fn check_integrity(conn: &Connection) -> CheckResult {
    const ID: &str = "integrity";
    const LABEL: &str = "database integrity";
    match conn.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)) {
        Ok(result) if result == "ok" => pass(ID, LABEL, "quick_check ok".into()),
        Ok(result) => fail(ID, LABEL, result),
        Err(e) => fail(ID, LABEL, e.to_string()),
    }
}

fn check_schema(conn: &Connection) -> CheckResult {
    const ID: &str = "schema";
    const LABEL: &str = "schema version";
    match conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| {
        r.get::<_, String>(0)
    }) {
        Ok(version) if version == "2" => pass(ID, LABEL, "v2".into()),
        Ok(version) => fail(ID, LABEL, format!("expected v2, found v{version}")),
        Err(e) => fail(ID, LABEL, e.to_string()),
    }
}

/// Every event must belong to a run row — a violation means RunStart messages
/// are being lost ahead of their events.
fn check_orphan_events(conn: &Connection) -> CheckResult {
    const ID: &str = "orphan_events";
    const LABEL: &str = "events belong to runs";
    match conn.query_row(
        "SELECT COUNT(*) FROM events e LEFT JOIN runs r ON r.run_id = e.run_id
         WHERE r.run_id IS NULL",
        [],
        |r| r.get::<_, i64>(0),
    ) {
        Ok(0) => pass(ID, LABEL, "no orphans".into()),
        Ok(n) => fail(ID, LABEL, format!("{n} events reference missing runs")),
        Err(e) => fail(ID, LABEL, e.to_string()),
    }
}

/// Per-run sequence numbers may have holes only when drops were counted:
/// max(seq) can never exceed stored events + acknowledged drops.
fn check_seq_continuity(conn: &Connection) -> CheckResult {
    const ID: &str = "seq_continuity";
    const LABEL: &str = "event sequence continuity";
    let query = "SELECT r.run_id FROM runs r
                 JOIN (SELECT run_id, MAX(seq) AS max_seq, COUNT(*) AS n FROM events GROUP BY run_id) e
                   ON e.run_id = r.run_id
                 WHERE e.max_seq > e.n + r.dropped_events LIMIT 3";
    match collect_ids(conn, query) {
        Ok(ids) if ids.is_empty() => pass(ID, LABEL, "no unexplained gaps".into()),
        Ok(ids) => fail(ID, LABEL, format!("unexplained seq gaps in runs {}", ids.join(", "))),
        Err(e) => fail(ID, LABEL, e),
    }
}

/// The counters on `runs` must agree with the projection tables they summarize.
fn check_projection_counts(conn: &Connection) -> CheckResult {
    const ID: &str = "projection_counts";
    const LABEL: &str = "projection counters consistent";
    let query = "SELECT run_id FROM runs r
                 WHERE turn_count != (SELECT COUNT(*) FROM turns t WHERE t.run_id = r.run_id)
                    OR tool_call_count != (SELECT COUNT(*) FROM tool_calls c WHERE c.run_id = r.run_id)
                 LIMIT 3";
    match collect_ids(conn, query) {
        Ok(ids) if ids.is_empty() => pass(ID, LABEL, "counters match tables".into()),
        Ok(ids) => fail(ID, LABEL, format!("counter drift in runs {}", ids.join(", "))),
        Err(e) => fail(ID, LABEL, e),
    }
}

/// Unknown must stay unknown: uninstrumented runs can carry no usage, and a
/// run claiming usage evidence must actually hold at least one usage value.
fn check_usage_honesty(conn: &Connection) -> CheckResult {
    const ID: &str = "usage_honesty";
    const LABEL: &str = "unknown usage stays unknown";
    let query = "SELECT run_id FROM runs
                 WHERE (coverage = 'uninstrumented'
                        AND (usage_events > 0 OR input_tokens IS NOT NULL
                             OR output_tokens IS NOT NULL OR cost_usd IS NOT NULL))
                    OR (usage_events > 0 AND input_tokens IS NULL AND output_tokens IS NULL
                        AND cached_tokens IS NULL AND cost_usd IS NULL)
                 LIMIT 3";
    match collect_ids(conn, query) {
        Ok(ids) if ids.is_empty() => pass(ID, LABEL, "no fabricated or empty usage".into()),
        Ok(ids) => fail(ID, LABEL, format!("usage honesty violated in runs {}", ids.join(", "))),
        Err(e) => fail(ID, LABEL, e),
    }
}

/// Runs left open by an earlier app launch must have been reconciled to
/// `interrupted` at startup — a stale open run means reconciliation failed.
fn check_stale_open_runs(conn: &Connection) -> CheckResult {
    const ID: &str = "stale_open_runs";
    const LABEL: &str = "no stale open runs";
    let boot: Result<String, _> =
        conn.query_row("SELECT value FROM meta WHERE key = 'boot_id'", [], |r| r.get(0));
    let Ok(boot) = boot else {
        return fail(ID, LABEL, "boot_id missing from meta".into());
    };
    let query_result = conn
        .prepare(
            "SELECT run_id FROM runs
             WHERE ended_at IS NULL AND end_reason IS NULL AND boot_id != ?1 LIMIT 3",
        )
        .and_then(|mut stmt| {
            stmt.query_map(params![boot], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        });
    match query_result {
        Ok(ids) if ids.is_empty() => pass(ID, LABEL, "all open runs belong to this launch".into()),
        Ok(ids) => fail(ID, LABEL, format!("unreconciled runs from earlier launches: {}", ids.join(", "))),
        Err(e) => fail(ID, LABEL, e.to_string()),
    }
}

#[derive(Default, PartialEq, Debug)]
struct Shadow {
    turns: i64,
    tools: i64,
    usage_events: i64,
    parse_errors: i64,
    input: Option<i64>,
    output: Option<i64>,
}

/// The live version of the rebuild guarantee: re-feed a run's raw events
/// through a fresh projector in memory and compare against the stored
/// projections. Any drift means incremental ingest and replay disagree.
fn check_replay_determinism(conn: &Connection) -> CheckResult {
    const ID: &str = "replay_determinism";
    const LABEL: &str = "stored projections match raw replay";
    let sample = match collect_ids(
        conn,
        &format!(
            "SELECT run_id FROM runs WHERE coverage = 'instrumented'
             ORDER BY started_at DESC LIMIT {REPLAY_SAMPLE}"
        ),
    ) {
        Ok(ids) => ids,
        Err(e) => return fail(ID, LABEL, e),
    };
    if sample.is_empty() {
        return pass(ID, LABEL, "no instrumented runs yet".into());
    }
    for run_id in &sample {
        let shadow = match shadow_replay(conn, run_id) {
            Ok(s) => s,
            Err(e) => return fail(ID, LABEL, format!("replay of {run_id} failed: {e}")),
        };
        let stored = conn.query_row(
            "SELECT turn_count, tool_call_count, usage_events, parse_errors,
                    input_tokens, output_tokens
             FROM runs WHERE run_id = ?1",
            params![run_id],
            |r| {
                Ok(Shadow {
                    turns: r.get(0)?,
                    tools: r.get(1)?,
                    usage_events: r.get(2)?,
                    parse_errors: r.get(3)?,
                    input: r.get(4)?,
                    output: r.get(5)?,
                })
            },
        );
        match stored {
            Ok(stored) if stored == shadow => {}
            Ok(stored) => {
                return fail(
                    ID,
                    LABEL,
                    format!("run {run_id}: stored {stored:?} != replay {shadow:?}"),
                )
            }
            Err(e) => return fail(ID, LABEL, e.to_string()),
        }
    }
    pass(ID, LABEL, format!("{} recent runs replayed identically", sample.len()))
}

fn shadow_replay(conn: &Connection, run_id: &str) -> Result<Shadow, String> {
    let mut stmt = conn
        .prepare("SELECT seq, direction, ingest_time, raw FROM events WHERE run_id = ?1 ORDER BY seq")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![run_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut proj = Projector::default();
    let mut shadow = Shadow::default();
    let mut tool_ids = std::collections::HashSet::new();
    for row in rows {
        let (seq, direction, ingest_time, raw) = row.map_err(|e| e.to_string())?;
        let direction = Direction::parse(&direction);
        let parsed = parse_line(&raw);
        if direction == Direction::In && parsed.parse_status != "ok" {
            shadow.parse_errors += 1;
        }
        let deltas = proj.feed(direction, seq, ingest_time, &parsed);
        if deltas.contains(&Delta::Replayed) {
            continue;
        }
        for delta in deltas {
            match delta {
                Delta::TurnOpen { .. } => shadow.turns += 1,
                Delta::ToolUpsert { id, .. } => {
                    if tool_ids.insert(id) {
                        shadow.tools += 1;
                    }
                }
                Delta::Usage(usage) => {
                    shadow.usage_events += 1;
                    if let Some(v) = usage.input {
                        shadow.input = Some(shadow.input.unwrap_or(0) + v);
                    }
                    if let Some(v) = usage.output {
                        shadow.output = Some(shadow.output.unwrap_or(0) + v);
                    }
                }
                _ => {}
            }
        }
    }
    Ok(shadow)
}

/// Not an invariant — a heartbeat so a human can see capture is alive.
fn check_freshness(conn: &Connection) -> CheckResult {
    const ID: &str = "freshness";
    const LABEL: &str = "capture activity";
    let last: Option<i64> = conn
        .query_row("SELECT MAX(ingest_time) FROM events", [], |r| r.get(0))
        .unwrap_or(None);
    let open: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM runs WHERE ended_at IS NULL AND end_reason IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let detail = match last {
        Some(ts) => {
            let age_s = (super::now_ms() - ts).max(0) / 1000;
            format!("{open} open runs, last event {age_s}s ago")
        }
        None => format!("{open} open runs, no events captured yet"),
    };
    CheckResult { id: ID, label: LABEL, status: "info", detail }
}

fn collect_ids(conn: &Connection, query: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::store::{self, RunStart};
    use super::*;

    fn healthy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::init_schema(&conn).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('boot_id', 'boot-now')",
            [],
        )
        .unwrap();
        let spec = RunStart {
            run_id: "r1".into(),
            source: "acp",
            coverage: "instrumented",
            chat_id: Some("c1".into()),
            agent_command: None,
            cwd: None,
            started_at: 1_000,
            repo_id: None,
            source_sha: None,
            repo_label: None,
            branch_label: None,
        };
        store::insert_run(&conn, &spec, "boot-now").unwrap();
        let mut proj = Projector::default();
        for (i, (dir, raw)) in [
            ("out", r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"hi"}]}}"#),
            ("in", r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","status":"completed"}}}"#),
            ("in", r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn","usage":{"inputTokens":10,"outputTokens":2}}}"#),
        ]
        .iter()
        .enumerate()
        {
            store::ingest_event(&conn, &mut proj, "r1", i as i64 + 1, Direction::parse(dir), 2_000 + i as i64, raw, true)
                .unwrap();
        }
        store::end_run(&conn, "r1", 3_000, Some(0), "exit", 0).unwrap();
        conn
    }

    fn failing_ids(results: &[CheckResult]) -> Vec<&'static str> {
        results.iter().filter(|c| c.status == "fail").map(|c| c.id).collect()
    }

    #[test]
    fn healthy_database_passes_every_check() {
        let conn = healthy_db();
        let results = run_checks(&conn);
        assert_eq!(failing_ids(&results), Vec::<&str>::new(), "{results:?}");
        assert_eq!(results.len(), 9);
    }

    #[test]
    fn tampered_projection_counter_is_caught_twice() {
        let conn = healthy_db();
        conn.execute("UPDATE runs SET turn_count = 99 WHERE run_id = 'r1'", []).unwrap();
        let failing = failing_ids(&run_checks(&conn));
        assert!(failing.contains(&"projection_counts"), "{failing:?}");
        assert!(failing.contains(&"replay_determinism"), "{failing:?}");
    }

    #[test]
    fn fabricated_usage_on_uninstrumented_run_is_caught() {
        let conn = healthy_db();
        conn.execute(
            "UPDATE runs SET coverage = 'uninstrumented', input_tokens = 5 WHERE run_id = 'r1'",
            [],
        )
        .unwrap();
        assert!(failing_ids(&run_checks(&conn)).contains(&"usage_honesty"));
    }

    #[test]
    fn stale_open_run_from_previous_boot_is_caught() {
        let conn = healthy_db();
        let spec = RunStart {
            run_id: "stale".into(),
            source: "acp",
            coverage: "instrumented",
            chat_id: None,
            agent_command: None,
            cwd: None,
            started_at: 500,
            repo_id: None,
            source_sha: None,
            repo_label: None,
            branch_label: None,
        };
        store::insert_run(&conn, &spec, "boot-old").unwrap();
        assert!(failing_ids(&run_checks(&conn)).contains(&"stale_open_runs"));
        // After reconciliation (what startup does) the check passes again.
        store::reconcile_interrupted(&conn).unwrap();
        assert!(!failing_ids(&run_checks(&conn)).contains(&"stale_open_runs"));
    }

    #[test]
    fn unexplained_seq_gap_is_caught_but_counted_drops_are_fine() {
        let conn = healthy_db();
        // Simulate a dropped event: seq jumps without a counted drop.
        let mut proj = Projector::default();
        store::ingest_event(&conn, &mut proj, "r1", 9, Direction::In, 5_000, "{}", true).unwrap();
        assert!(failing_ids(&run_checks(&conn)).contains(&"seq_continuity"));
        // Acknowledge the drops → the gap is explained.
        store::set_dropped(&conn, "r1", 5).unwrap();
        assert!(!failing_ids(&run_checks(&conn)).contains(&"seq_continuity"));
    }
}
