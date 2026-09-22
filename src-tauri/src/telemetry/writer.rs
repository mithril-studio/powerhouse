// The single writer: one thread owns the sole write connection and drains the
// bounded channel in batched transactions. The release profile is
// panic="abort", so nothing here may unwrap on an I/O or SQL path — failures
// are logged and counted, and agent execution is never blocked or taken down
// by telemetry.
use super::projector::{Direction, Projector};
use super::store::{self, Annotation, RebuildReport, RunStart};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const BATCH_MAX: usize = 256;
const EMIT_DEBOUNCE: Duration = Duration::from_millis(500);

pub enum Msg {
    RunStart(Box<RunStart>),
    Event {
        run_id: String,
        seq: i64,
        direction: Direction,
        ingest_time: i64,
        raw: String,
        dropped_so_far: u64,
    },
    RunEnd {
        run_id: String,
        ended_at: i64,
        exit_code: Option<i32>,
        reason: &'static str,
        dropped: u64,
    },
    /// A run whose whole lifecycle is known at record time (queue entries).
    CompletedRun {
        spec: Box<RunStart>,
        ended_at: i64,
        exit_code: Option<i32>,
        reason: &'static str,
        sys_raw: String,
    },
    Annotate {
        run_id: String,
        annotation: Box<Annotation>,
    },
    /// Low-frequency writes (the proposal ledger) routed through the writer
    /// so the single-writer invariant holds. The closure sends its own reply.
    Write(Box<dyn FnOnce(&Connection) + Send>),
    Rebuild(Sender<Result<RebuildReport, String>>),
    Shutdown(Sender<Result<(), String>>),
}

pub fn spawn(app: AppHandle, rx: Receiver<Msg>, conn: Option<Connection>, boot_id: String) {
    std::thread::spawn(move || {
        let Some(mut conn) = conn else {
            // Storage is unavailable: drain so producers never block, and
            // answer rebuild requests with the failure instead of hanging.
            while let Ok(msg) = rx.recv() {
                match msg {
                    Msg::Rebuild(reply) => {
                        let _ = reply.send(Err("telemetry database unavailable".into()));
                    }
                    Msg::Shutdown(reply) => {
                        let _ = reply.send(Err("telemetry database unavailable".into()));
                        break;
                    }
                    _ => {}
                }
            }
            return;
        };

        let mut projectors: HashMap<String, Projector> = HashMap::new();
        let mut last_emit: HashMap<String, Instant> = HashMap::new();
        let mut write_failures: u64 = 0;

        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            while batch.len() < BATCH_MAX {
                match rx.try_recv() {
                    Ok(msg) => batch.push(msg),
                    Err(_) => break,
                }
            }

            let mut touched: Vec<(String, bool)> = Vec::new(); // (run_id, force emit)
            let mut shutdown_replies = Vec::new();
            if let Err(e) = conn.execute_batch("BEGIN") {
                let error = e.to_string();
                log_failure(&mut write_failures, &error);
                for msg in batch {
                    if let Msg::Shutdown(reply) = msg {
                        let _ = reply.send(Err(error.clone()));
                    }
                }
                continue;
            }
            for msg in batch {
                if let Msg::Shutdown(reply) = msg {
                    shutdown_replies.push(reply);
                    continue;
                }
                let result = apply(&conn, &mut projectors, &mut touched, msg, &boot_id);
                match result {
                    Ok(Some(reply)) => {
                        // Rebuild needs the transaction closed and exclusive
                        // access; the batch boundary provides both.
                        let _ = conn.execute_batch("COMMIT");
                        projectors.clear();
                        let _ = reply.send(store::rebuild(&mut conn));
                        let _ = conn.execute_batch("BEGIN");
                    }
                    Ok(None) => {}
                    Err(e) => log_failure(&mut write_failures, &e),
                }
            }
            let commit_error = conn.execute_batch("COMMIT").err().map(|e| e.to_string());
            if let Some(error) = &commit_error {
                log_failure(&mut write_failures, error);
                let _ = conn.execute_batch("ROLLBACK");
            }

            if !shutdown_replies.is_empty() {
                for reply in shutdown_replies {
                    let result = commit_error.clone().map_or(Ok(()), Err);
                    let _ = reply.send(result);
                }
                return;
            }

            let now = Instant::now();
            for (run_id, force) in touched {
                let due = last_emit
                    .get(&run_id)
                    .map(|t| now.duration_since(*t) >= EMIT_DEBOUNCE)
                    .unwrap_or(true);
                if force || due {
                    last_emit.insert(run_id.clone(), now);
                    let _ = app.emit("telemetry-updated", run_id);
                }
            }
        }
    });
}

/// Applies one message inside the open transaction. Returns the reply channel
/// when the message was a rebuild request (handled by the caller).
fn apply(
    conn: &Connection,
    projectors: &mut HashMap<String, Projector>,
    touched: &mut Vec<(String, bool)>,
    msg: Msg,
    boot_id: &str,
) -> Result<Option<Sender<Result<RebuildReport, String>>>, String> {
    match msg {
        Msg::RunStart(spec) => {
            store::insert_run(conn, &spec, boot_id)?;
            projectors.insert(spec.run_id.clone(), Projector::default());
            touched.push((spec.run_id.clone(), true));
        }
        Msg::Event { run_id, seq, direction, ingest_time, raw, dropped_so_far } => {
            let proj = projectors.entry(run_id.clone()).or_default();
            store::ingest_event(conn, proj, &run_id, seq, direction, ingest_time, &raw, true)?;
            if dropped_so_far > 0 {
                store::set_dropped(conn, &run_id, dropped_so_far)?;
            }
            touched.push((run_id, false));
        }
        Msg::RunEnd { run_id, ended_at, exit_code, reason, dropped } => {
            store::end_run(conn, &run_id, ended_at, exit_code, reason, dropped)?;
            projectors.remove(&run_id);
            touched.push((run_id, true));
        }
        Msg::CompletedRun { spec, ended_at, exit_code, reason, sys_raw } => {
            store::insert_run(conn, &spec, boot_id)?;
            let mut proj = Projector::default();
            store::ingest_event(conn, &mut proj, &spec.run_id, 1, Direction::Sys, ended_at, &sys_raw, true)?;
            store::end_run(conn, &spec.run_id, ended_at, exit_code, reason, 0)?;
            touched.push((spec.run_id.clone(), true));
        }
        Msg::Annotate { run_id, annotation } => {
            store::annotate_run(conn, &run_id, &annotation)?;
            touched.push((run_id, false));
        }
        Msg::Write(f) => f(conn),
        Msg::Rebuild(reply) => return Ok(Some(reply)),
        Msg::Shutdown(_) => unreachable!("shutdown is handled at the batch boundary"),
    }
    Ok(None)
}

fn log_failure(count: &mut u64, error: &str) {
    *count += 1;
    eprintln!("[telemetry] write failure #{count}: {error}");
}
