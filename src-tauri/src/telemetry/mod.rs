// Lightweight telemetry: a durable, append-only record of agent runs and
// their raw ACP traffic in ~/.powerhouse/telemetry.db, with rebuildable
// projections (runs/turns/tool_calls) and honest completeness metadata.
// Capture sits at the process boundary (acp.rs / pty.rs / queue.rs), so a
// renderer crash loses nothing and an app crash keeps everything ingested.
pub mod commands;
mod projector;
mod selfcheck;
mod store;
mod writer;

pub use projector::Direction;
pub use store::Annotation;
use store::RunStart;
use writer::Msg;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

/// Bounded so a chatty agent can never balloon memory; overflow is counted
/// per run as `dropped_events` instead of blocking the reader thread.
const CHANNEL_CAP: usize = 4096;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Best-effort HEAD of the run's working directory — the source revision the
/// agent started from. None (unknown) when the cwd isn't a git checkout.
pub fn head_sha(cwd: &str) -> Option<String> {
    crate::git::git(std::path::Path::new(cwd), &["rev-parse", "HEAD"]).ok()
}

struct RunCounters {
    seq: AtomicI64,
    dropped: AtomicU64,
    /// `acp_write` receives stream chunks, not whole lines; complete lines
    /// are cut here before recording.
    out_buf: Mutex<String>,
}

#[derive(Default)]
struct Inner {
    live: HashMap<String, Arc<RunCounters>>, // run_id → counters
    by_chat: HashMap<String, String>,        // chat_id → run_id
}

pub struct RunSpec {
    pub source: &'static str,
    pub coverage: &'static str,
    pub chat_id: Option<String>,
    pub agent_command: Option<String>,
    pub cwd: Option<String>,
    pub repo_id: Option<String>,
    pub source_sha: Option<String>,
    pub repo_label: Option<String>,
    pub branch_label: Option<String>,
}

pub struct Telemetry {
    tx: SyncSender<Msg>,
    inner: Mutex<Inner>,
    db_path: Option<PathBuf>,
}

impl Telemetry {
    pub fn init(app: AppHandle) -> Telemetry {
        let boot_id = uuid::Uuid::new_v4().to_string();
        let db_path = dirs::home_dir().map(|h| h.join(".powerhouse").join("telemetry.db"));
        let conn = db_path.as_ref().and_then(|path| {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match store::open_db(path) {
                Ok(conn) => {
                    if let Err(e) = store::reconcile_interrupted(&conn) {
                        eprintln!("[telemetry] orphan reconciliation failed: {e}");
                    }
                    // Self-checks compare runs' boot ids against the current
                    // launch to detect unreconciled leftovers.
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO meta(key, value) VALUES('boot_id', ?1)",
                        rusqlite::params![boot_id],
                    );
                    Some(conn)
                }
                Err(e) => {
                    eprintln!("[telemetry] disabled, could not open {}: {e}", path.display());
                    None
                }
            }
        });
        let db_available = conn.is_some();
        let (tx, rx) = sync_channel(CHANNEL_CAP);
        writer::spawn(app, rx, conn, boot_id);
        Telemetry {
            tx,
            inner: Mutex::new(Inner::default()),
            db_path: db_path.filter(|_| db_available),
        }
    }

    pub fn db_path(&self) -> Option<&PathBuf> {
        self.db_path.as_ref()
    }

    fn send_control(&self, msg: Msg) {
        // Lifecycle messages are rare and must not be lost (events reference
        // their run row), so unlike per-event sends this may block briefly.
        if self.tx.send(msg).is_err() {
            eprintln!("[telemetry] writer thread gone; control message lost");
        }
    }

    pub fn run_start(&self, spec: RunSpec) -> String {
        let run_id = uuid::Uuid::new_v4().to_string();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.live.insert(
                run_id.clone(),
                Arc::new(RunCounters {
                    seq: AtomicI64::new(0),
                    dropped: AtomicU64::new(0),
                    out_buf: Mutex::new(String::new()),
                }),
            );
            if let Some(chat_id) = &spec.chat_id {
                inner.by_chat.insert(chat_id.clone(), run_id.clone());
            }
        }
        self.send_control(Msg::RunStart(Box::new(RunStart {
            run_id: run_id.clone(),
            source: spec.source,
            coverage: spec.coverage,
            chat_id: spec.chat_id,
            agent_command: spec.agent_command,
            cwd: spec.cwd,
            started_at: now_ms(),
            repo_id: spec.repo_id,
            source_sha: spec.source_sha,
            repo_label: spec.repo_label,
            branch_label: spec.branch_label,
        })));
        run_id
    }

    /// A cheap capture handle for reader threads; safe to use from any thread
    /// and never blocks (overflow is counted, not waited out).
    pub fn tap(&self, run_id: &str, direction: Direction) -> Tap {
        let counters = {
            let inner = self.inner.lock().unwrap();
            inner.live.get(run_id).cloned()
        }
        .unwrap_or_else(|| {
            Arc::new(RunCounters {
                seq: AtomicI64::new(0),
                dropped: AtomicU64::new(0),
                out_buf: Mutex::new(String::new()),
            })
        });
        Tap { tx: self.tx.clone(), run_id: run_id.to_string(), counters, direction }
    }

    /// Buffers client→agent stream chunks and records each completed line.
    pub fn record_out_chunk(&self, chat_id: &str, chunk: &str) {
        let Some((run_id, counters)) = self.lookup(chat_id) else { return };
        let mut lines = Vec::new();
        {
            let mut buf = counters.out_buf.lock().unwrap();
            buf.push_str(chunk);
            while let Some(pos) = buf.find('\n') {
                lines.push(buf[..pos].to_string());
                buf.drain(..=pos);
            }
        }
        let tap = Tap { tx: self.tx.clone(), run_id, counters, direction: Direction::Out };
        for line in lines {
            tap.record_line(&line);
        }
    }

    pub fn run_end(&self, run_id: &str, exit_code: Option<i32>, reason: &'static str) {
        let counters = {
            let mut inner = self.inner.lock().unwrap();
            inner.by_chat.retain(|_, rid| rid != run_id);
            inner.live.remove(run_id)
        };
        let Some(counters) = counters else {
            return;
        };
        // A trailing partial line is still evidence of what was sent.
        let leftover = std::mem::take(&mut *counters.out_buf.lock().unwrap());
        if !leftover.trim().is_empty() {
            let tap = Tap {
                tx: self.tx.clone(),
                run_id: run_id.to_string(),
                counters: counters.clone(),
                direction: Direction::Out,
            };
            tap.record_line(&leftover);
        }
        let dropped = counters.dropped.load(Ordering::Relaxed);
        self.send_control(Msg::RunEnd {
            run_id: run_id.to_string(),
            ended_at: now_ms(),
            exit_code,
            reason,
            dropped,
        });
    }

    pub fn run_end_by_chat(&self, chat_id: &str, exit_code: Option<i32>, reason: &'static str) {
        let run_id = {
            let inner = self.inner.lock().unwrap();
            inner.by_chat.get(chat_id).cloned()
        };
        if let Some(run_id) = run_id {
            self.run_end(&run_id, exit_code, reason);
        }
    }

    /// App-exit hygiene: close every run still live.
    pub fn end_all(&self, reason: &'static str) {
        let run_ids: Vec<String> = {
            let inner = self.inner.lock().unwrap();
            inner.live.keys().cloned().collect()
        };
        for run_id in run_ids {
            self.run_end(&run_id, None, reason);
        }
    }

    /// Flushes every previously queued message and stops the writer thread.
    pub fn shutdown(&self) -> Result<(), String> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.tx
            .send(Msg::Shutdown(reply_tx))
            .map_err(|_| "telemetry writer thread unavailable".to_string())?;
        reply_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "telemetry shutdown timed out".to_string())?
    }

    /// Cosmetic labels from the renderer; losing this loses labels, never evidence.
    pub fn annotate_by_chat(&self, chat_id: &str, annotation: Annotation) {
        let run_id = {
            let inner = self.inner.lock().unwrap();
            inner.by_chat.get(chat_id).cloned()
        };
        if let Some(run_id) = run_id {
            self.send_control(Msg::Annotate { run_id, annotation: Box::new(annotation) });
        }
    }

    /// Runs a low-frequency write on the writer thread and returns its result.
    /// Fails fast (dropped closure → disconnected reply) when storage is
    /// unavailable instead of hanging.
    pub fn with_writer<R: Send + 'static>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> R + Send + 'static,
    ) -> Result<R, String> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.send_control(Msg::Write(Box::new(move |conn| {
            let _ = reply_tx.send(f(conn));
        })));
        reply_rx
            .recv_timeout(std::time::Duration::from_secs(15))
            .map_err(|_| "telemetry database unavailable".to_string())
    }

    /// Records a run whose whole lifecycle is already known (queue entries),
    /// with a synthetic `sys` event carrying the raw evidence.
    pub fn record_completed_run(
        &self,
        spec: RunSpec,
        started_at: i64,
        ended_at: i64,
        exit_code: Option<i32>,
        reason: &'static str,
        sys_raw: String,
    ) {
        self.send_control(Msg::CompletedRun {
            spec: Box::new(RunStart {
                run_id: uuid::Uuid::new_v4().to_string(),
                source: spec.source,
                coverage: spec.coverage,
                chat_id: spec.chat_id,
                agent_command: spec.agent_command,
                cwd: spec.cwd,
                started_at,
                repo_id: spec.repo_id,
                source_sha: spec.source_sha,
                repo_label: spec.repo_label,
                branch_label: spec.branch_label,
            }),
            ended_at,
            exit_code,
            reason,
            sys_raw,
        });
    }

    fn lookup(&self, chat_id: &str) -> Option<(String, Arc<RunCounters>)> {
        let inner = self.inner.lock().unwrap();
        let run_id = inner.by_chat.get(chat_id)?;
        let counters = inner.live.get(run_id)?;
        Some((run_id.clone(), counters.clone()))
    }

    fn rebuild_blocking(&self) -> Result<store::RebuildReport, String> {
        let inner = self.inner.lock().unwrap();
        if !inner.live.is_empty() {
            return Err("cannot rebuild projections while runs are active".into());
        }
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.tx
            .send(Msg::Rebuild(reply_tx))
            .map_err(|_| "telemetry writer thread unavailable".to_string())?;
        // Keep run_start behind the rebuild request in the writer queue.
        drop(inner);
        reply_rx
            .recv_timeout(std::time::Duration::from_secs(60))
            .map_err(|_| "telemetry rebuild timed out".to_string())?
    }
}

pub struct Tap {
    tx: SyncSender<Msg>,
    run_id: String,
    counters: Arc<RunCounters>,
    direction: Direction,
}

impl Tap {
    pub fn record_line(&self, line: &str) {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() {
            return;
        }
        let seq = self.counters.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let msg = Msg::Event {
            run_id: self.run_id.clone(),
            seq,
            direction: self.direction,
            ingest_time: now_ms(),
            raw: trimmed.to_string(),
            dropped_so_far: self.counters.dropped.load(Ordering::Relaxed),
        };
        if self.tx.try_send(msg).is_err() {
            self.counters.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{sync_channel, TryRecvError};

    fn test_telemetry() -> (Telemetry, std::sync::mpsc::Receiver<Msg>) {
        let (tx, rx) = sync_channel(8);
        (
            Telemetry {
                tx,
                inner: Mutex::new(Inner::default()),
                db_path: None,
            },
            rx,
        )
    }

    fn spec(chat_id: &str) -> RunSpec {
        RunSpec {
            source: "acp",
            coverage: "instrumented",
            chat_id: Some(chat_id.into()),
            agent_command: None,
            cwd: None,
            repo_id: None,
            source_sha: None,
            repo_label: None,
            branch_label: None,
        }
    }

    #[test]
    fn rebuild_is_rejected_while_a_run_is_live() {
        let (telemetry, rx) = test_telemetry();
        telemetry.run_start(spec("chat-1"));
        let worker = std::thread::spawn(move || {
            while let Ok(msg) = rx.recv() {
                if let Msg::Rebuild(reply) = msg {
                    let _ = reply.send(Ok(store::RebuildReport::default()));
                    break;
                }
            }
        });

        assert_eq!(
            telemetry.rebuild_blocking().unwrap_err(),
            "cannot rebuild projections while runs are active"
        );
        drop(telemetry);
        worker.join().unwrap();
    }

    #[test]
    fn first_run_close_wins() {
        let (telemetry, rx) = test_telemetry();
        let run_id = telemetry.run_start(spec("chat-1"));
        assert!(matches!(rx.recv().unwrap(), Msg::RunStart(_)));

        telemetry.run_end(&run_id, None, "killed");
        telemetry.run_end(&run_id, Some(0), "exit");

        assert!(matches!(rx.recv().unwrap(), Msg::RunEnd { reason: "killed", .. }));
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn shutdown_waits_for_writer_acknowledgement() {
        let (telemetry, rx) = test_telemetry();
        let worker = std::thread::spawn(move || {
            if let Msg::Shutdown(reply) = rx.recv().unwrap() {
                let _ = reply.send(Ok(()));
            }
        });

        telemetry.shutdown().unwrap();
        worker.join().unwrap();
    }
}
