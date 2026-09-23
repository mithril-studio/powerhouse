//! SQLite-backed durable run store. State changes and their events commit in
//! one transaction; event sequences are monotonic per run.

use powerhouse_cloud_protocol::{
    validate_run_id, EventPage, Receipt, ResultManifest, RunError, RunEvent, RunManifest,
    RunSnapshot, RunState, MAX_EVENT_PAGE, MAX_EVENT_PAYLOAD_BYTES,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::Path;

use crate::util::{now_ms, truncate_utf8};

pub struct Store {
    conn: Connection,
}

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Conflict(String),
    NotFound(String),
    Invalid(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Sqlite(e) => write!(f, "store: {e}"),
            StoreError::Conflict(m) | StoreError::NotFound(m) | StoreError::Invalid(m) => {
                f.write_str(m)
            }
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Row-level view used by the executor and reconcile.
#[derive(Clone, Debug)]
pub struct RunRow {
    pub run_id: String,
    pub manifest_digest: String,
    pub manifest: RunManifest,
    pub state: RunState,
    pub stage: Option<String>,
    pub accepted_at_ms: u64,
    pub updated_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub error: Option<RunError>,
    pub cancel_requested: bool,
    pub launch_attempted_at_ms: Option<u64>,
    pub unit_name: Option<String>,
    #[allow(dead_code)]
    pub owner_token: Option<String>,
    pub last_event_seq: u64,
    pub result: Option<ResultManifest>,
}

impl RunRow {
    pub fn snapshot(&self, unit_active: Option<bool>) -> RunSnapshot {
        RunSnapshot {
            run_id: self.run_id.clone(),
            manifest_digest: self.manifest_digest.clone(),
            state: self.state,
            stage: self.stage.clone(),
            last_event_seq: self.last_event_seq,
            accepted_at_ms: self.accepted_at_ms,
            updated_at_ms: self.updated_at_ms,
            started_at_ms: self.started_at_ms,
            finished_at_ms: self.finished_at_ms,
            error: self.error.clone(),
            cancel_requested: self.cancel_requested,
            result_available: self.result.is_some(),
            unit_active,
        }
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  manifest_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  state TEXT NOT NULL,
  stage TEXT,
  accepted_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  error_stage TEXT,
  error_message TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  launch_attempted_at_ms INTEGER,
  unit_name TEXT,
  owner_token TEXT,
  owner_pid INTEGER,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  result_json TEXT
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
"#;

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| StoreError::Invalid(e.to_string()))?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    /// Idempotent accept: identical digest returns the existing run; a
    /// different manifest under the same id is a conflict.
    pub fn submit(&mut self, manifest: &RunManifest) -> Result<Receipt> {
        manifest.validate().map_err(StoreError::Invalid)?;
        let digest = manifest.digest();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, String, u64, u64)> = tx
            .query_row(
                "SELECT manifest_digest, state, last_event_seq, accepted_at_ms FROM runs WHERE run_id = ?1",
                params![manifest.run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)? as u64)),
            )
            .optional()?;
        if let Some((d, state, seq, accepted)) = existing {
            if d != digest {
                return Err(StoreError::Conflict(format!(
                    "run {} already exists with a different manifest (digest {d})",
                    manifest.run_id
                )));
            }
            tx.commit()?;
            return Ok(Receipt {
                run_id: manifest.run_id.clone(),
                manifest_digest: digest,
                state: RunState::parse(&state).unwrap_or(RunState::Interrupted),
                event_cursor: seq,
                accepted_at_ms: accepted,
                duplicate: true,
            });
        }
        let now = now_ms();
        let json = serde_json::to_string(manifest).map_err(|e| StoreError::Invalid(e.to_string()))?;
        tx.execute(
            "INSERT INTO runs (run_id, manifest_digest, manifest_json, state, accepted_at_ms, updated_at_ms, last_event_seq)
             VALUES (?1, ?2, ?3, 'accepted', ?4, ?4, 0)",
            params![manifest.run_id, digest, json, now as i64],
        )?;
        let seq = append_event_tx(
            &tx,
            &manifest.run_id,
            "run.accepted",
            &serde_json::json!({ "manifest_digest": digest }),
        )?;
        tx.commit()?;
        Ok(Receipt {
            run_id: manifest.run_id.clone(),
            manifest_digest: digest,
            state: RunState::Accepted,
            event_cursor: seq,
            accepted_at_ms: now,
            duplicate: false,
        })
    }

    pub fn get(&self, run_id: &str) -> Result<RunRow> {
        validate_run_id(run_id).map_err(StoreError::Invalid)?;
        self.conn
            .query_row(
                "SELECT run_id, manifest_digest, manifest_json, state, stage, accepted_at_ms, updated_at_ms,
                        started_at_ms, finished_at_ms, error_stage, error_message, cancel_requested,
                        launch_attempted_at_ms, unit_name, owner_token, last_event_seq, result_json
                 FROM runs WHERE run_id = ?1",
                params![run_id],
                row_to_run,
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("unknown run {run_id}")))
    }

    pub fn list(&self) -> Result<Vec<RunRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT run_id, manifest_digest, manifest_json, state, stage, accepted_at_ms, updated_at_ms,
                    started_at_ms, finished_at_ms, error_stage, error_message, cancel_requested,
                    launch_attempted_at_ms, unit_name, owner_token, last_event_seq, result_json
             FROM runs ORDER BY accepted_at_ms DESC",
        )?;
        let rows = stmt.query_map([], row_to_run)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn events(&self, run_id: &str, after: u64, limit: u64) -> Result<EventPage> {
        validate_run_id(run_id).map_err(StoreError::Invalid)?;
        let last: u64 = self
            .conn
            .query_row(
                "SELECT last_event_seq FROM runs WHERE run_id = ?1",
                params![run_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(format!("unknown run {run_id}")))? as u64;
        let limit = limit.clamp(1, MAX_EVENT_PAGE);
        let mut stmt = self.conn.prepare(
            "SELECT seq, ts_ms, kind, payload FROM events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let events = stmt
            .query_map(params![run_id, after as i64, (limit + 1) as i64], |r| {
                let payload: String = r.get(3)?;
                Ok(RunEvent {
                    seq: r.get::<_, i64>(0)? as u64,
                    ts_ms: r.get::<_, i64>(1)? as u64,
                    kind: r.get(2)?,
                    payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let has_more = events.len() as u64 > limit;
        let events: Vec<RunEvent> = events.into_iter().take(limit as usize).collect();
        let next_after = events.last().map(|e| e.seq).unwrap_or(after);
        Ok(EventPage {
            run_id: run_id.to_string(),
            events,
            next_after,
            has_more,
            last_event_seq: last,
        })
    }

    /// Append an event without changing state.
    pub fn append_event(&mut self, run_id: &str, kind: &str, payload: &serde_json::Value) -> Result<u64> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let seq = append_event_tx(&tx, run_id, kind, payload)?;
        tx.commit()?;
        Ok(seq)
    }

    /// Append several events in one transaction (agent output is bursty).
    pub fn append_events(&mut self, run_id: &str, events: &[(String, serde_json::Value)]) -> Result<u64> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut last = 0;
        for (kind, payload) in events {
            last = append_event_tx(&tx, run_id, kind, payload)?;
        }
        tx.commit()?;
        Ok(last)
    }

    /// Claim execution ownership. Succeeds only once, only from `accepted`.
    pub fn claim(&mut self, run_id: &str, owner_token: &str, pid: u32) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_ms() as i64;
        let n = tx.execute(
            "UPDATE runs SET state = 'preparing', stage = 'preparing', owner_token = ?2, owner_pid = ?3,
                    started_at_ms = ?4, updated_at_ms = ?4
             WHERE run_id = ?1 AND state = 'accepted' AND owner_token IS NULL",
            params![run_id, owner_token, pid as i64, now],
        )?;
        if n == 1 {
            append_event_tx(
                &tx,
                run_id,
                "run.claimed",
                &serde_json::json!({ "owner_token": owner_token, "pid": pid, "state": "preparing" }),
            )?;
        } else {
            append_event_tx(
                &tx,
                run_id,
                "run.duplicate_executor_refused",
                &serde_json::json!({ "pid": pid }),
            )?;
        }
        tx.commit()?;
        Ok(n == 1)
    }

    pub fn record_launch_attempt(&mut self, run_id: &str, unit: &str) -> Result<()> {
        let now = now_ms() as i64;
        self.conn.execute(
            "UPDATE runs SET launch_attempted_at_ms = ?2, unit_name = ?3, updated_at_ms = ?2 WHERE run_id = ?1",
            params![run_id, now, unit],
        )?;
        Ok(())
    }

    /// Live → live transition guarded by owner token.
    pub fn set_stage(&mut self, run_id: &str, owner: &str, state: RunState, stage: &str) -> Result<()> {
        if state.is_terminal() {
            return Err(StoreError::Invalid("use finish() for terminal states".into()));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_ms() as i64;
        let n = tx.execute(
            "UPDATE runs SET state = ?3, stage = ?4, updated_at_ms = ?5
             WHERE run_id = ?1 AND owner_token = ?2 AND state IN ('accepted','preparing','running','validating','publishing')",
            params![run_id, owner, state.as_str(), stage, now],
        )?;
        if n != 1 {
            return Err(StoreError::Conflict(format!(
                "run {run_id} is not live or owned by another executor"
            )));
        }
        append_event_tx(
            &tx,
            run_id,
            "run.stage",
            &serde_json::json!({ "state": state.as_str(), "stage": stage }),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Terminal transition. Only the first terminal write wins; later attempts
    /// are reported as `Ok(false)` so a cancel racing completion stays truthful.
    pub fn finish(
        &mut self,
        run_id: &str,
        state: RunState,
        error: Option<RunError>,
        result: Option<&ResultManifest>,
    ) -> Result<bool> {
        if !state.is_terminal() {
            return Err(StoreError::Invalid("finish() needs a terminal state".into()));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_ms() as i64;
        let result_json = match result {
            Some(r) => Some(serde_json::to_string(r).map_err(|e| StoreError::Invalid(e.to_string()))?),
            None => None,
        };
        let n = tx.execute(
            "UPDATE runs SET state = ?2, stage = ?2, finished_at_ms = ?3, updated_at_ms = ?3,
                    error_stage = ?4, error_message = ?5,
                    result_json = COALESCE(?6, result_json)
             WHERE run_id = ?1 AND state IN ('accepted','preparing','running','validating','publishing')",
            params![
                run_id,
                state.as_str(),
                now,
                error.as_ref().map(|e| e.stage.clone()),
                error.as_ref().map(|e| e.message.clone()),
                result_json,
            ],
        )?;
        if n == 1 {
            append_event_tx(
                &tx,
                run_id,
                "run.finished",
                &serde_json::json!({ "state": state.as_str(), "error": error }),
            )?;
        }
        tx.commit()?;
        Ok(n == 1)
    }

    /// Attach/refresh a result manifest without changing state (used for
    /// partial results before the terminal write).
    pub fn set_result(&mut self, run_id: &str, result: &ResultManifest) -> Result<()> {
        let json = serde_json::to_string(result).map_err(|e| StoreError::Invalid(e.to_string()))?;
        self.conn.execute(
            "UPDATE runs SET result_json = ?2, updated_at_ms = ?3 WHERE run_id = ?1",
            params![run_id, json, now_ms() as i64],
        )?;
        Ok(())
    }

    pub fn request_cancel(&mut self, run_id: &str) -> Result<RunRow> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let n = tx.execute(
            "UPDATE runs SET cancel_requested = 1, updated_at_ms = ?2 WHERE run_id = ?1 AND cancel_requested = 0",
            params![run_id, now_ms() as i64],
        )?;
        if n == 1 {
            append_event_tx(&tx, run_id, "run.cancel_requested", &serde_json::Value::Null)?;
        }
        tx.commit()?;
        self.get(run_id)
    }

    pub fn cancel_requested(&self, run_id: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT cancel_requested FROM runs WHERE run_id = ?1",
                params![run_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map(|v| v != 0)
            .unwrap_or(false))
    }
}

fn append_event_tx(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
    kind: &str,
    payload: &serde_json::Value,
) -> Result<u64> {
    let mut payload_str = serde_json::to_string(payload).unwrap_or_else(|_| "null".into());
    if payload_str.len() > MAX_EVENT_PAYLOAD_BYTES {
        let (cut, _) = truncate_utf8(&payload_str, MAX_EVENT_PAYLOAD_BYTES - 128);
        payload_str = serde_json::json!({ "truncated": true, "head": cut }).to_string();
    }
    let n = tx.execute(
        "UPDATE runs SET last_event_seq = last_event_seq + 1 WHERE run_id = ?1",
        params![run_id],
    )?;
    if n != 1 {
        return Err(StoreError::NotFound(format!("unknown run {run_id}")));
    }
    let seq: i64 = tx.query_row(
        "SELECT last_event_seq FROM runs WHERE run_id = ?1",
        params![run_id],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO events (run_id, seq, ts_ms, kind, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![run_id, seq, now_ms() as i64, kind, payload_str],
    )?;
    Ok(seq as u64)
}

fn row_to_run(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    let manifest_json: String = r.get(2)?;
    let manifest: RunManifest = serde_json::from_str(&manifest_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let state: String = r.get(3)?;
    let error_stage: Option<String> = r.get(9)?;
    let error_message: Option<String> = r.get(10)?;
    let result_json: Option<String> = r.get(16)?;
    Ok(RunRow {
        run_id: r.get(0)?,
        manifest_digest: r.get(1)?,
        manifest,
        state: RunState::parse(&state).unwrap_or(RunState::Interrupted),
        stage: r.get(4)?,
        accepted_at_ms: r.get::<_, i64>(5)? as u64,
        updated_at_ms: r.get::<_, i64>(6)? as u64,
        started_at_ms: r.get::<_, Option<i64>>(7)?.map(|v| v as u64),
        finished_at_ms: r.get::<_, Option<i64>>(8)?.map(|v| v as u64),
        error: match (error_stage, error_message) {
            (Some(stage), Some(message)) => Some(RunError { stage, message }),
            _ => None,
        },
        cancel_requested: r.get::<_, i64>(11)? != 0,
        launch_attempted_at_ms: r.get::<_, Option<i64>>(12)?.map(|v| v as u64),
        unit_name: r.get(13)?,
        owner_token: r.get(14)?,
        last_event_seq: r.get::<_, i64>(15)? as u64,
        result: result_json.and_then(|j| serde_json::from_str(&j).ok()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use powerhouse_cloud_protocol::*;

    pub fn manifest(id: &str) -> RunManifest {
        RunManifest {
            protocol_version: PROTOCOL_VERSION,
            run_id: id.to_string(),
            task: TaskSpec { text: "do it".into(), acceptance_criteria: vec![] },
            source: SourceSpec {
                repo_name: "r".into(),
                remote_url: "https://example.com/o/r.git".into(),
                commit_sha: "a".repeat(40),
                source_branch: None,
            },
            output_branch: RunManifest::expected_output_branch(id),
            workspace: WorkspaceSpec::from_snapshot("base", Some("v1".into())),
            agent: Some(AgentSpec {
                provider: AgentProvider::Fake,
                model: None,
                permission_mode: "dontAsk".into(),
                allowed_tools: vec![],
                max_turns: None,
                max_budget_usd: None,
                fake_script: Some("complete".into()),
            }),
            script: None,
            checks: vec![],
            context: ContextSpec::default(),
            deadline_seconds: 300,
            created_at_ms: 1,
            predecessor_run_id: None,
        }
    }

    const ID: &str = "11111111-2222-4333-8444-555555555555";

    #[test]
    fn submit_is_idempotent_and_rejects_digest_mismatch() {
        let mut s = Store::open_in_memory().unwrap();
        let m = manifest(ID);
        let r1 = s.submit(&m).unwrap();
        assert!(!r1.duplicate);
        assert_eq!(r1.state, RunState::Accepted);
        let r2 = s.submit(&m).unwrap();
        assert!(r2.duplicate);
        assert_eq!(r1.manifest_digest, r2.manifest_digest);
        assert_eq!(r1.event_cursor, r2.event_cursor);
        let mut other = manifest(ID);
        other.task.text = "different".into();
        assert!(matches!(s.submit(&other), Err(StoreError::Conflict(_))));
        // Exactly one accepted event exists.
        let page = s.events(ID, 0, 100).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].kind, "run.accepted");
    }

    #[test]
    fn claim_succeeds_once() {
        let mut s = Store::open_in_memory().unwrap();
        s.submit(&manifest(ID)).unwrap();
        assert!(s.claim(ID, "tok-a", 1).unwrap());
        assert!(!s.claim(ID, "tok-b", 2).unwrap());
        let row = s.get(ID).unwrap();
        assert_eq!(row.state, RunState::Preparing);
        assert_eq!(row.owner_token.as_deref(), Some("tok-a"));
        let page = s.events(ID, 0, 100).unwrap();
        assert!(page.events.iter().any(|e| e.kind == "run.duplicate_executor_refused"));
    }

    #[test]
    fn stage_requires_owner_and_terminal_wins_once() {
        let mut s = Store::open_in_memory().unwrap();
        s.submit(&manifest(ID)).unwrap();
        s.claim(ID, "tok", 1).unwrap();
        assert!(s.set_stage(ID, "other", RunState::Running, "agent").is_err());
        s.set_stage(ID, "tok", RunState::Running, "agent").unwrap();
        assert!(s.finish(ID, RunState::Completed, None, None).unwrap());
        // A late cancel must not regress the terminal outcome.
        assert!(!s.finish(ID, RunState::Cancelled, None, None).unwrap());
        assert_eq!(s.get(ID).unwrap().state, RunState::Completed);
        assert!(s.set_stage(ID, "tok", RunState::Running, "agent").is_err());
    }

    #[test]
    fn events_page_in_order_with_cursor() {
        let mut s = Store::open_in_memory().unwrap();
        s.submit(&manifest(ID)).unwrap();
        for i in 0..7 {
            s.append_event(ID, "x", &serde_json::json!({ "i": i })).unwrap();
        }
        let p1 = s.events(ID, 0, 3).unwrap();
        assert_eq!(p1.events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert!(p1.has_more);
        let p2 = s.events(ID, p1.next_after, 3).unwrap();
        assert_eq!(p2.events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![4, 5, 6]);
        let p3 = s.events(ID, p2.next_after, 3).unwrap();
        assert_eq!(p3.events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![7, 8]);
        assert!(!p3.has_more);
        assert_eq!(p3.last_event_seq, 8);
        // Replaying an old cursor returns the same page again (dedupe is the
        // client's job by seq).
        let again = s.events(ID, 0, 3).unwrap();
        assert_eq!(again.events, p1.events);
    }

    #[test]
    fn oversized_payload_is_truncated_not_lost() {
        let mut s = Store::open_in_memory().unwrap();
        s.submit(&manifest(ID)).unwrap();
        let big = "z".repeat(MAX_EVENT_PAYLOAD_BYTES * 2);
        s.append_event(ID, "agent.raw", &serde_json::json!({ "text": big })).unwrap();
        let page = s.events(ID, 1, 10).unwrap();
        assert_eq!(page.events[0].payload["truncated"], true);
    }

    #[test]
    fn cancel_request_is_recorded_once() {
        let mut s = Store::open_in_memory().unwrap();
        s.submit(&manifest(ID)).unwrap();
        s.request_cancel(ID).unwrap();
        s.request_cancel(ID).unwrap();
        assert!(s.cancel_requested(ID).unwrap());
        let n = s
            .events(ID, 0, 100)
            .unwrap()
            .events
            .iter()
            .filter(|e| e.kind == "run.cancel_requested")
            .count();
        assert_eq!(n, 1);
    }

    #[test]
    fn unknown_and_invalid_ids() {
        let s = Store::open_in_memory().unwrap();
        assert!(matches!(s.get("../x"), Err(StoreError::Invalid(_))));
        assert!(matches!(s.get(ID), Err(StoreError::NotFound(_))));
    }
}
