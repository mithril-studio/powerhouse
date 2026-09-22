// Read-side Tauri commands. Each opens its own short-lived connection — WAL
// keeps readers concurrent with the writer thread — so queries never contend
// with ingestion.
use super::selfcheck::{self, CheckResult};
use super::store::{
    compute_metric, metric_higher_is_better, MetricSample, RebuildReport, METRICS,
};
use super::{now_ms, Annotation, Telemetry};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::BTreeMap;
use tauri::State;

fn open_read(telemetry: &Telemetry) -> Result<Connection, String> {
    let path = telemetry
        .db_path()
        .ok_or("telemetry database unavailable")?;
    Connection::open(path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: String,
    pub source: String,
    pub coverage: String,
    pub chat_id: Option<String>,
    pub provider_session_id: Option<String>,
    pub resumed: bool,
    pub agent_name: Option<String>,
    pub repo_label: Option<String>,
    pub branch_label: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub end_reason: Option<String>,
    pub dropped_events: i64,
    pub parse_errors: i64,
    pub usage_events: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cached_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub turn_count: i64,
    pub tool_call_count: i64,
    pub repo_id: Option<String>,
    pub source_sha: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
}

const RUN_COLUMNS: &str = "run_id, source, coverage, chat_id, provider_session_id, resumed,
    agent_name, repo_label, branch_label, started_at, ended_at, exit_code, end_reason,
    dropped_events, parse_errors, usage_events, input_tokens, output_tokens, cached_tokens,
    cost_usd, turn_count, tool_call_count, repo_id, source_sha, model, mode";

fn run_from_row(row: &Row) -> rusqlite::Result<RunSummary> {
    Ok(RunSummary {
        run_id: row.get(0)?,
        source: row.get(1)?,
        coverage: row.get(2)?,
        chat_id: row.get(3)?,
        provider_session_id: row.get(4)?,
        resumed: row.get::<_, i64>(5)? != 0,
        agent_name: row.get(6)?,
        repo_label: row.get(7)?,
        branch_label: row.get(8)?,
        started_at: row.get(9)?,
        ended_at: row.get(10)?,
        exit_code: row.get(11)?,
        end_reason: row.get(12)?,
        dropped_events: row.get(13)?,
        parse_errors: row.get(14)?,
        usage_events: row.get(15)?,
        input_tokens: row.get(16)?,
        output_tokens: row.get(17)?,
        cached_tokens: row.get(18)?,
        cost_usd: row.get(19)?,
        turn_count: row.get(20)?,
        tool_call_count: row.get(21)?,
        repo_id: row.get(22)?,
        source_sha: row.get(23)?,
        model: row.get(24)?,
        mode: row.get(25)?,
    })
}

#[tauri::command]
pub fn telemetry_list_runs(
    telemetry: State<Telemetry>,
    limit: u32,
    before: Option<i64>,
    source: Option<String>,
) -> Result<Vec<RunSummary>, String> {
    let conn = open_read(&telemetry)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {RUN_COLUMNS} FROM runs
             WHERE started_at < ?1 AND (?2 IS NULL OR source = ?2)
             ORDER BY started_at DESC LIMIT ?3",
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![before.unwrap_or(i64::MAX), source, limit.min(500)],
            run_from_row,
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRow {
    pub turn_idx: i64,
    pub prompt_seq: i64,
    pub prompt_preview: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub stop_reason: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRow {
    pub tool_call_id: String,
    pub turn_idx: Option<i64>,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: RunSummary,
    pub turns: Vec<TurnRow>,
    pub tool_calls: Vec<ToolCallRow>,
    pub event_count: i64,
}

#[tauri::command]
pub fn telemetry_run_detail(telemetry: State<Telemetry>, run_id: String) -> Result<RunDetail, String> {
    let conn = open_read(&telemetry)?;
    let run = conn
        .query_row(
            &format!("SELECT {RUN_COLUMNS} FROM runs WHERE run_id = ?1"),
            params![run_id],
            run_from_row,
        )
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT turn_idx, prompt_seq, prompt_preview, started_at, ended_at, stop_reason
             FROM turns WHERE run_id = ?1 ORDER BY turn_idx",
        )
        .map_err(|e| e.to_string())?;
    let turns = stmt
        .query_map(params![run_id], |row| {
            Ok(TurnRow {
                turn_idx: row.get(0)?,
                prompt_seq: row.get(1)?,
                prompt_preview: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                stop_reason: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT tool_call_id, turn_idx, title, kind, status, started_at, ended_at
             FROM tool_calls WHERE run_id = ?1 ORDER BY first_seq",
        )
        .map_err(|e| e.to_string())?;
    let tool_calls = stmt
        .query_map(params![run_id], |row| {
            Ok(ToolCallRow {
                tool_call_id: row.get(0)?,
                turn_idx: row.get(1)?,
                title: row.get(2)?,
                kind: row.get(3)?,
                status: row.get(4)?,
                started_at: row.get(5)?,
                ended_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let event_count = conn
        .query_row("SELECT COUNT(*) FROM events WHERE run_id = ?1", params![run_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    Ok(RunDetail { run, turns, tool_calls, event_count })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub seq: i64,
    pub direction: String,
    pub ingest_time: i64,
    pub method: Option<String>,
    pub update_kind: Option<String>,
    pub parse_status: String,
    pub replayed: bool,
    pub truncated: bool,
    pub raw_preview: String,
}

const RAW_PREVIEW_CAP: usize = 2_000;

#[tauri::command]
pub fn telemetry_run_events(
    telemetry: State<Telemetry>,
    run_id: String,
    offset: i64,
    limit: u32,
) -> Result<Vec<EventRow>, String> {
    let conn = open_read(&telemetry)?;
    let mut stmt = conn
        .prepare(
            "SELECT seq, direction, ingest_time, method, update_kind, parse_status,
                    replayed, truncated, SUBSTR(raw, 1, ?4) AS raw_preview
             FROM events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![run_id, offset, limit.min(500), RAW_PREVIEW_CAP as i64],
            |row| {
                Ok(EventRow {
                    seq: row.get(0)?,
                    direction: row.get(1)?,
                    ingest_time: row.get(2)?,
                    method: row.get(3)?,
                    update_kind: row.get(4)?,
                    parse_status: row.get(5)?,
                    replayed: row.get::<_, i64>(6)? != 0,
                    truncated: row.get::<_, i64>(7)? != 0,
                    raw_preview: row.get(8)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryStats {
    pub total_runs: i64,
    pub active_runs: i64,
    pub failed_runs: i64,
    pub interrupted_runs: i64,
    pub uninstrumented_runs: i64,
    pub total_turns: i64,
    pub total_tool_calls: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub instrumented_runs: i64,
    pub runs_with_usage: i64,
    pub dropped_events: i64,
    pub parse_errors: i64,
}

#[tauri::command]
pub fn telemetry_stats(telemetry: State<Telemetry>) -> Result<TelemetryStats, String> {
    let conn = open_read(&telemetry)?;
    conn.query_row(
        "SELECT COUNT(*),
                COUNT(*) FILTER (WHERE ended_at IS NULL AND end_reason IS NULL),
                COUNT(*) FILTER (WHERE exit_code IS NOT NULL AND exit_code != 0),
                COUNT(*) FILTER (WHERE end_reason = 'interrupted'),
                COUNT(*) FILTER (WHERE coverage = 'uninstrumented'),
                SUM(turn_count), SUM(tool_call_count),
                SUM(input_tokens), SUM(output_tokens), SUM(cost_usd),
                COUNT(*) FILTER (WHERE coverage = 'instrumented'),
                COUNT(*) FILTER (WHERE coverage = 'instrumented' AND usage_events > 0),
                SUM(dropped_events), SUM(parse_errors)
         FROM runs",
        [],
        |row| {
            Ok(TelemetryStats {
                total_runs: row.get(0)?,
                active_runs: row.get(1)?,
                failed_runs: row.get(2)?,
                interrupted_runs: row.get(3)?,
                uninstrumented_runs: row.get(4)?,
                total_turns: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                total_tool_calls: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                input_tokens: row.get(7)?,
                output_tokens: row.get(8)?,
                cost_usd: row.get(9)?,
                instrumented_runs: row.get(10)?,
                runs_with_usage: row.get(11)?,
                dropped_events: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
                parse_errors: row.get::<_, Option<i64>>(13)?.unwrap_or(0),
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn telemetry_rebuild(telemetry: State<Telemetry>) -> Result<RebuildReport, String> {
    telemetry.rebuild_blocking()
}

/// Live invariant battery — read-only, safe to run continuously while the
/// app is in use. Failures point at capture/projection bugs, not user error.
#[tauri::command]
pub fn telemetry_selfcheck(telemetry: State<Telemetry>) -> Result<Vec<CheckResult>, String> {
    let conn = open_read(&telemetry)?;
    Ok(selfcheck::run_checks(&conn))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn telemetry_annotate_run(
    telemetry: State<Telemetry>,
    chat_id: String,
    agent_name: Option<String>,
    agent_version: Option<String>,
    repo_id: Option<String>,
    repo_label: Option<String>,
    branch_label: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    telemetry.annotate_by_chat(
        &chat_id,
        Annotation { agent_name, agent_version, repo_id, repo_label, branch_label, model },
    );
    Ok(())
}

// --- milestone 2: outcome & context attribution ----------------------------

/// A "task" is a repo+branch: agent effort joined to its ground-truth queue
/// outcome. Only a merged branch counts as delivered — a failed or canceled
/// queue attempt never does.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub repo_key: String,
    pub repo_label: Option<String>,
    pub branch: String,
    pub agent_runs: i64,
    pub turns: i64,
    pub tool_calls: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub instrumented_runs: i64,
    pub runs_with_usage: i64,
    pub models: Option<String>,
    pub last_agent_at: Option<i64>,
    pub queue_attempts: i64,
    pub delivered: bool,
    pub first_pass_merged: Option<bool>,
    pub last_outcome: Option<String>,
    pub last_queue_at: Option<i64>,
}

fn queue_outcome(exit_code: Option<i64>, end_reason: Option<&str>) -> String {
    match (exit_code, end_reason) {
        (Some(0), _) => "merged".into(),
        (Some(_), _) => "failed".into(),
        _ => "canceled".into(),
    }
}

fn tasks_since(conn: &Connection, cutoff: i64) -> Result<Vec<TaskRow>, String> {
    let mut tasks: BTreeMap<(String, String), TaskRow> = BTreeMap::new();

    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(repo_id, ''), MAX(repo_label), branch_label,
                    COUNT(*), SUM(turn_count), SUM(tool_call_count),
                    SUM(input_tokens), SUM(output_tokens), SUM(cost_usd),
                    SUM(CASE WHEN coverage = 'instrumented' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN usage_events > 0 THEN 1 ELSE 0 END),
                    GROUP_CONCAT(DISTINCT model),
                    MAX(started_at)
             FROM runs
             WHERE source IN ('acp', 'pty') AND branch_label IS NOT NULL AND started_at >= ?1
             GROUP BY COALESCE(repo_id, ''), branch_label",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![cutoff], |row| {
            Ok(TaskRow {
                repo_key: row.get(0)?,
                repo_label: row.get(1)?,
                branch: row.get(2)?,
                agent_runs: row.get(3)?,
                turns: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                tool_calls: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                input_tokens: row.get(6)?,
                output_tokens: row.get(7)?,
                cost_usd: row.get(8)?,
                instrumented_runs: row.get(9)?,
                runs_with_usage: row.get(10)?,
                models: row.get(11)?,
                last_agent_at: row.get(12)?,
                queue_attempts: 0,
                delivered: false,
                first_pass_merged: None,
                last_outcome: None,
                last_queue_at: None,
            })
        })
        .map_err(|e| e.to_string())?;
    for task in rows {
        let task = task.map_err(|e| e.to_string())?;
        tasks.insert((task.repo_key.clone(), task.branch.clone()), task);
    }

    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(repo_id, ''), MAX(repo_label), branch_label, started_at,
                    exit_code, end_reason
             FROM runs
             WHERE source = 'queue' AND end_reason IS NOT NULL AND branch_label IS NOT NULL
               AND started_at >= ?1
             GROUP BY run_id
             ORDER BY started_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![cutoff], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (repo_key, repo_label, branch, started_at, exit_code, end_reason) =
            row.map_err(|e| e.to_string())?;
        let task = tasks
            .entry((repo_key.clone(), branch.clone()))
            .or_insert_with(|| TaskRow {
                repo_key,
                repo_label,
                branch,
                agent_runs: 0,
                turns: 0,
                tool_calls: 0,
                input_tokens: None,
                output_tokens: None,
                cost_usd: None,
                instrumented_runs: 0,
                runs_with_usage: 0,
                models: None,
                last_agent_at: None,
                queue_attempts: 0,
                delivered: false,
                first_pass_merged: None,
                last_outcome: None,
                last_queue_at: None,
            });
        let outcome = queue_outcome(exit_code, end_reason.as_deref());
        task.queue_attempts += 1;
        if task.first_pass_merged.is_none() {
            task.first_pass_merged = Some(outcome == "merged");
        }
        if outcome == "merged" {
            task.delivered = true;
        }
        task.last_outcome = Some(outcome);
        task.last_queue_at = Some(started_at);
    }

    let mut list: Vec<TaskRow> = tasks.into_values().collect();
    list.sort_by_key(|t| {
        std::cmp::Reverse(t.last_agent_at.max(t.last_queue_at).unwrap_or(0))
    });
    Ok(list)
}

#[tauri::command]
pub fn telemetry_tasks(telemetry: State<Telemetry>, window_days: u32) -> Result<Vec<TaskRow>, String> {
    let conn = open_read(&telemetry)?;
    let cutoff = now_ms() - i64::from(window_days) * 86_400_000;
    tasks_since(&conn, cutoff)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureItem {
    pub kind: String,
    pub repo_label: Option<String>,
    pub branch: Option<String>,
    pub detail: String,
    pub run_id: String,
    pub at: i64,
}

/// The bounded failure digest: what failed, under which configuration, at
/// what cost — with denominators and coverage, every item citing a run id.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestReport {
    pub window_days: u32,
    pub generated_at: i64,
    pub tasks_total: i64,
    pub tasks_delivered: i64,
    pub tasks_failed: i64,
    pub tasks_unattempted: i64,
    pub agent_runs: i64,
    pub interrupted_runs: i64,
    pub closed_turns: i64,
    pub error_turns: i64,
    pub tool_calls: i64,
    pub tool_failures: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub instrumented_runs: i64,
    pub runs_with_usage: i64,
    pub uninstrumented_runs: i64,
    pub dropped_events: i64,
    pub parse_errors: i64,
    pub failures: Vec<FailureItem>,
}

const FAILURE_DETAIL_CAP: usize = 240;
const FAILURE_ITEMS_CAP: usize = 8;

fn cap_detail(detail: String) -> String {
    if detail.len() <= FAILURE_DETAIL_CAP {
        return detail;
    }
    let mut cut = FAILURE_DETAIL_CAP;
    while cut > 0 && !detail.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &detail[..cut])
}

#[tauri::command]
pub fn telemetry_digest(telemetry: State<Telemetry>, window_days: u32) -> Result<DigestReport, String> {
    let conn = open_read(&telemetry)?;
    let now = now_ms();
    let cutoff = now - i64::from(window_days) * 86_400_000;
    let err = |e: rusqlite::Error| e.to_string();

    let tasks = tasks_since(&conn, cutoff)?;
    let tasks_total = tasks.len() as i64;
    let tasks_delivered = tasks.iter().filter(|t| t.delivered).count() as i64;
    let tasks_failed = tasks
        .iter()
        .filter(|t| !t.delivered && t.queue_attempts > 0)
        .count() as i64;
    let tasks_unattempted = tasks_total - tasks_delivered - tasks_failed;

    let (agent_runs, interrupted_runs, input_tokens, output_tokens, cost_usd,
         instrumented_runs, runs_with_usage, uninstrumented_runs, dropped_events, parse_errors):
        (i64, i64, Option<i64>, Option<i64>, Option<f64>, i64, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),
                    COUNT(*) FILTER (WHERE end_reason = 'interrupted'),
                    SUM(input_tokens), SUM(output_tokens), SUM(cost_usd),
                    COUNT(*) FILTER (WHERE coverage = 'instrumented'),
                    COUNT(*) FILTER (WHERE coverage = 'instrumented' AND usage_events > 0),
                    COUNT(*) FILTER (WHERE coverage = 'uninstrumented'),
                    COALESCE(SUM(dropped_events), 0), COALESCE(SUM(parse_errors), 0)
             FROM runs WHERE source IN ('acp', 'pty') AND started_at >= ?1",
            params![cutoff],
            |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?,
                    r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
            },
        )
        .map_err(err)?;

    let (closed_turns, error_turns): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),
                    COUNT(*) FILTER (WHERE stop_reason IN ('error', 'refusal'))
             FROM turns WHERE stop_reason IS NOT NULL AND started_at >= ?1",
            params![cutoff],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;

    let (tool_calls, tool_failures): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE status = 'failed')
             FROM tool_calls WHERE status IN ('completed', 'failed') AND started_at >= ?1",
            params![cutoff],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;

    let mut failures: Vec<FailureItem> = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT r.run_id, r.repo_label, r.branch_label, r.started_at,
                    COALESCE(json_extract(e.raw, '$.error'), 'checks failed')
             FROM runs r JOIN events e ON e.run_id = r.run_id AND e.seq = 1
             WHERE r.source = 'queue' AND r.exit_code IS NOT NULL AND r.exit_code != 0
               AND r.started_at >= ?1
             ORDER BY r.started_at DESC LIMIT ?2",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(params![cutoff, FAILURE_ITEMS_CAP as i64], |r| {
            Ok(FailureItem {
                kind: "queue-failure".into(),
                run_id: r.get(0)?,
                repo_label: r.get(1)?,
                branch: r.get(2)?,
                at: r.get(3)?,
                detail: r.get(4)?,
            })
        })
        .map_err(err)?;
    for item in rows {
        let mut item = item.map_err(err)?;
        item.detail = cap_detail(item.detail);
        failures.push(item);
    }

    let mut stmt = conn
        .prepare(
            "SELECT t.run_id, r.repo_label, r.branch_label, t.started_at,
                    t.stop_reason || COALESCE(': ' || t.prompt_preview, '')
             FROM turns t JOIN runs r ON r.run_id = t.run_id
             WHERE t.stop_reason IN ('error', 'refusal') AND t.started_at >= ?1
             ORDER BY t.started_at DESC LIMIT ?2",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map(params![cutoff, FAILURE_ITEMS_CAP as i64], |r| {
            Ok(FailureItem {
                kind: "error-turn".into(),
                run_id: r.get(0)?,
                repo_label: r.get(1)?,
                branch: r.get(2)?,
                at: r.get(3)?,
                detail: r.get(4)?,
            })
        })
        .map_err(err)?;
    for item in rows {
        let mut item = item.map_err(err)?;
        item.detail = cap_detail(item.detail);
        failures.push(item);
    }
    failures.sort_by_key(|f| std::cmp::Reverse(f.at));

    Ok(DigestReport {
        window_days,
        generated_at: now,
        tasks_total,
        tasks_delivered,
        tasks_failed,
        tasks_unattempted,
        agent_runs,
        interrupted_runs,
        closed_turns,
        error_turns,
        tool_calls,
        tool_failures,
        input_tokens,
        output_tokens,
        cost_usd,
        instrumented_runs,
        runs_with_usage,
        uninstrumented_runs,
        dropped_events,
        parse_errors,
        failures,
    })
}

// --- milestone 3: the proposal ledger ---------------------------------------
//
// A proposal is a reviewable improvement hypothesis. Code computes the
// baseline and evaluation samples deterministically; a human (or later, an
// analyst agent) interprets them and records the keep/revert decision. A
// verdict is a ledger decision, not proof — and thin cohorts must surface as
// insufficient evidence, never as a confident comparison.

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Evaluation {
    pub baseline: MetricSample,
    pub evaluation: MetricSample,
    pub verdict: String, // improved | regressed | unchanged | insufficient-evidence
    pub computed_at: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub proposal_id: String,
    pub created_at: i64,
    pub title: String,
    pub hypothesis: String,
    pub target: String,
    pub metric: String,
    pub repo_id: Option<String>,
    pub evidence_run_ids: Vec<String>,
    pub min_samples: i64,
    pub status: String,
    pub adopted_at: Option<i64>,
    pub decided_at: Option<i64>,
    pub decision_note: Option<String>,
    pub baseline: Option<MetricSample>,
    pub evaluation: Option<Evaluation>,
}

const PROPOSAL_COLUMNS: &str = "proposal_id, created_at, title, hypothesis, target, metric,
    repo_id, evidence_run_ids, min_samples, status, adopted_at, decided_at, decision_note,
    baseline_json, evaluation_json";

fn proposal_from_row(row: &Row) -> rusqlite::Result<Proposal> {
    let evidence: String = row.get(7)?;
    let baseline: Option<String> = row.get(13)?;
    let evaluation: Option<String> = row.get(14)?;
    Ok(Proposal {
        proposal_id: row.get(0)?,
        created_at: row.get(1)?,
        title: row.get(2)?,
        hypothesis: row.get(3)?,
        target: row.get(4)?,
        metric: row.get(5)?,
        repo_id: row.get(6)?,
        evidence_run_ids: serde_json::from_str(&evidence).unwrap_or_default(),
        min_samples: row.get(8)?,
        status: row.get(9)?,
        adopted_at: row.get(10)?,
        decided_at: row.get(11)?,
        decision_note: row.get(12)?,
        baseline: baseline.and_then(|json| serde_json::from_str(&json).ok()),
        evaluation: evaluation.and_then(|json| serde_json::from_str(&json).ok()),
    })
}

fn get_proposal(conn: &Connection, proposal_id: &str) -> Result<Proposal, String> {
    conn.query_row(
        &format!("SELECT {PROPOSAL_COLUMNS} FROM proposals WHERE proposal_id = ?1"),
        params![proposal_id],
        proposal_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("no proposal {proposal_id}"))
}

fn verdict(metric: &str, min_samples: i64, baseline: &MetricSample, evaluation: &MetricSample) -> String {
    if baseline.n < min_samples || evaluation.n < min_samples {
        return "insufficient-evidence".into();
    }
    let (Some(base), Some(eval)) = (baseline.value, evaluation.value) else {
        return "insufficient-evidence".into();
    };
    let higher_is_better = metric_higher_is_better(metric).unwrap_or(true);
    let delta = if higher_is_better { eval - base } else { base - eval };
    // One percentage point of movement separates signal from noise here;
    // anything finer is correlation-flavored wishful thinking at this scale.
    if delta > 0.01 {
        "improved".into()
    } else if delta < -0.01 {
        "regressed".into()
    } else {
        "unchanged".into()
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn telemetry_proposal_create(
    telemetry: State<Telemetry>,
    title: String,
    hypothesis: String,
    target: String,
    metric: String,
    repo_id: Option<String>,
    evidence_run_ids: Vec<String>,
    min_samples: u32,
) -> Result<Proposal, String> {
    if metric_higher_is_better(&metric).is_none() {
        let known: Vec<&str> = METRICS.iter().map(|(k, _)| *k).collect();
        return Err(format!("unknown metric {metric}; expected one of {known:?}"));
    }
    if title.trim().is_empty() || hypothesis.trim().is_empty() || target.trim().is_empty() {
        return Err("title, hypothesis, and target are required".into());
    }
    let proposal_id = uuid::Uuid::new_v4().to_string();
    let id = proposal_id.clone();
    telemetry.with_writer(move |conn| -> Result<Proposal, String> {
        conn.execute(
            "INSERT INTO proposals
               (proposal_id, created_at, title, hypothesis, target, metric, repo_id,
                evidence_run_ids, min_samples)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                now_ms(),
                title.trim(),
                hypothesis.trim(),
                target.trim(),
                metric,
                repo_id,
                serde_json::to_string(&evidence_run_ids).unwrap_or_else(|_| "[]".into()),
                i64::from(min_samples.max(1)),
            ],
        )
        .map_err(|e| e.to_string())?;
        get_proposal(conn, &id)
    })?
}

#[tauri::command]
pub fn telemetry_proposal_list(telemetry: State<Telemetry>) -> Result<Vec<Proposal>, String> {
    let conn = open_read(&telemetry)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {PROPOSAL_COLUMNS} FROM proposals ORDER BY created_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], proposal_from_row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Adoption freezes the baseline sample: everything observed before this
/// moment, in the proposal's scope.
#[tauri::command]
pub fn telemetry_proposal_adopt(
    telemetry: State<Telemetry>,
    proposal_id: String,
) -> Result<Proposal, String> {
    telemetry.with_writer(move |conn| -> Result<Proposal, String> {
        let proposal = get_proposal(conn, &proposal_id)?;
        if proposal.status != "proposed" {
            return Err(format!("proposal is {}, not proposed", proposal.status));
        }
        let adopted_at = now_ms();
        let baseline =
            compute_metric(conn, &proposal.metric, proposal.repo_id.as_deref(), 0, adopted_at)?;
        conn.execute(
            "UPDATE proposals SET status = 'adopted', adopted_at = ?2, baseline_json = ?3
             WHERE proposal_id = ?1",
            params![
                proposal_id,
                adopted_at,
                serde_json::to_string(&baseline).map_err(|e| e.to_string())?,
            ],
        )
        .map_err(|e| e.to_string())?;
        get_proposal(conn, &proposal_id)
    })?
}

/// Deterministic comparison of the frozen baseline against everything
/// observed since adoption. Note: before/after movement is correlation, not
/// proof — the verdict exists to inform the human decision, not to make it.
#[tauri::command]
pub fn telemetry_proposal_evaluate(
    telemetry: State<Telemetry>,
    proposal_id: String,
) -> Result<Proposal, String> {
    telemetry.with_writer(move |conn| -> Result<Proposal, String> {
        let proposal = get_proposal(conn, &proposal_id)?;
        let Some(adopted_at) = proposal.adopted_at else {
            return Err("proposal has not been adopted yet".into());
        };
        let Some(baseline) = proposal.baseline else {
            return Err("proposal has no frozen baseline".into());
        };
        let now = now_ms();
        let evaluation =
            compute_metric(conn, &proposal.metric, proposal.repo_id.as_deref(), adopted_at, now)?;
        let result = Evaluation {
            verdict: verdict(&proposal.metric, proposal.min_samples, &baseline, &evaluation),
            baseline,
            evaluation,
            computed_at: now,
        };
        conn.execute(
            "UPDATE proposals SET evaluation_json = ?2 WHERE proposal_id = ?1",
            params![proposal_id, serde_json::to_string(&result).map_err(|e| e.to_string())?],
        )
        .map_err(|e| e.to_string())?;
        get_proposal(conn, &proposal_id)
    })?
}

#[tauri::command]
pub fn telemetry_proposal_decide(
    telemetry: State<Telemetry>,
    proposal_id: String,
    decision: String,
    note: Option<String>,
) -> Result<Proposal, String> {
    if !matches!(decision.as_str(), "kept" | "reverted" | "retired") {
        return Err(format!("unknown decision {decision}"));
    }
    telemetry.with_writer(move |conn| -> Result<Proposal, String> {
        let proposal = get_proposal(conn, &proposal_id)?;
        let allowed = match decision.as_str() {
            "retired" => matches!(proposal.status.as_str(), "proposed" | "adopted"),
            _ => proposal.status == "adopted",
        };
        if !allowed {
            return Err(format!("cannot mark a {} proposal {decision}", proposal.status));
        }
        conn.execute(
            "UPDATE proposals SET status = ?2, decided_at = ?3, decision_note = ?4
             WHERE proposal_id = ?1",
            params![proposal_id, decision, now_ms(), note],
        )
        .map_err(|e| e.to_string())?;
        get_proposal(conn, &proposal_id)
    })?
}
