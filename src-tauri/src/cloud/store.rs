//! Desktop-side durable record of submitted cloud runs. This is a cache and a
//! receipt log: the VM runner owns the truth. Writes are explicit and atomic
//! (write, fsync, rename) so a launch receipt never depends on a debounce.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use powerhouse_cloud_protocol::{
    Receipt, ResultManifest, RunEvent, RunManifest, RunSnapshot, RunState,
};

pub const EVENT_CACHE_CAP: usize = 4000;

/// Desktop-only lifecycle around the remote run state.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Record written; no remote side effect confirmed yet.
    Submitting,
    /// A fork/create was issued; identity may or may not exist remotely.
    Provisioning,
    /// Manifest transferred and `submit` was sent; acknowledgement pending.
    SubmissionUnknown,
    /// Durable receipt received. The laptop is no longer needed.
    Accepted,
    /// Submission definitively failed before acceptance.
    SubmitFailed,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct VmRef {
    pub name: String,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct CloudRunRecord {
    pub run_id: String,
    pub repo_id: String,
    pub repo_path: String,
    pub repo_name: String,
    #[serde(default)]
    pub source_branch: Option<String>,
    pub manifest: RunManifest,
    pub manifest_digest: String,
    pub created_at_ms: u64,
    pub phase: Phase,
    #[serde(default)]
    pub phase_detail: Option<String>,
    #[serde(default)]
    pub base_vm: Option<VmRef>,
    #[serde(default)]
    pub task_vm: Option<VmRef>,
    #[serde(default)]
    pub receipt: Option<Receipt>,
    #[serde(default)]
    pub snapshot: Option<RunSnapshot>,
    #[serde(default)]
    pub result: Option<ResultManifest>,
    #[serde(default)]
    pub events: Vec<RunEvent>,
    /// Highest event seq durably cached here.
    #[serde(default)]
    pub event_cursor: u64,
    #[serde(default)]
    pub last_sync_ms: Option<u64>,
    #[serde(default)]
    pub last_sync_error: Option<String>,
    /// Idle policy of the base, re-applied to the task VM after the run ends.
    #[serde(default)]
    pub idle_policy: Option<(u64, u64)>,
    #[serde(default)]
    pub idle_policy_restored: bool,
    #[serde(default)]
    pub imported_worktree: Option<String>,
}

impl CloudRunRecord {
    /// Merge a fresh snapshot, refusing regressions from stale responses.
    pub fn merge_snapshot(&mut self, next: RunSnapshot) -> bool {
        if let Some(prev) = &self.snapshot {
            if next.state.rank() < prev.state.rank() {
                return false;
            }
            if prev.state.is_terminal() && next.state != prev.state {
                return false;
            }
            if next.updated_at_ms < prev.updated_at_ms && next.state == prev.state {
                return false;
            }
        }
        self.snapshot = Some(next);
        true
    }

    /// Merge an event page: dedupe by seq, keep order, advance the cursor only
    /// over a contiguous prefix so a missing page is fetched again.
    pub fn merge_events(&mut self, page: Vec<RunEvent>) -> usize {
        let mut added = 0;
        for ev in page {
            if self.events.iter().any(|e| e.seq == ev.seq) {
                continue;
            }
            self.events.push(ev);
            added += 1;
        }
        self.events.sort_by_key(|e| e.seq);
        self.events.dedup_by_key(|e| e.seq);
        if self.events.len() > EVENT_CACHE_CAP {
            let cut = self.events.len() - EVENT_CACHE_CAP;
            self.events.drain(..cut);
        }
        // Contiguity from the previous cursor.
        let mut cursor = self.event_cursor;
        for e in &self.events {
            if e.seq == cursor + 1 {
                cursor = e.seq;
            } else if e.seq > cursor + 1 {
                break;
            }
        }
        self.event_cursor = cursor;
        added
    }

    pub fn state(&self) -> Option<RunState> {
        self.snapshot.as_ref().map(|s| s.state).or_else(|| self.receipt.as_ref().map(|r| r.state))
    }

    pub fn is_active(&self) -> bool {
        match self.phase {
            Phase::Accepted => self.state().map(|s| s.is_live()).unwrap_or(true),
            Phase::SubmitFailed => false,
            _ => true,
        }
    }
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct FileShape {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    runs: BTreeMap<String, CloudRunRecord>,
}

pub struct CloudStore {
    path: PathBuf,
    runs: BTreeMap<String, CloudRunRecord>,
}

impl CloudStore {
    pub fn default_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join(".powerhouse")
            .join("cloud-runs.json")
    }

    pub fn open(path: PathBuf) -> Self {
        let runs = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<FileShape>(&b).ok())
            .map(|f| f.runs)
            .unwrap_or_default();
        Self { path, runs }
    }

    pub fn list(&self) -> Vec<CloudRunRecord> {
        let mut v: Vec<_> = self.runs.values().cloned().collect();
        v.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
        v
    }

    pub fn get(&self, run_id: &str) -> Option<&CloudRunRecord> {
        self.runs.get(run_id)
    }

    /// Insert/replace and write through. Returns after the bytes are durable.
    pub fn put(&mut self, record: CloudRunRecord) -> Result<(), String> {
        self.runs.insert(record.run_id.clone(), record);
        self.flush()
    }

    pub fn remove(&mut self, run_id: &str) -> Result<Option<CloudRunRecord>, String> {
        let r = self.runs.remove(run_id);
        self.flush()?;
        Ok(r)
    }

    fn flush(&self) -> Result<(), String> {
        let shape = FileShape { version: 1, runs: self.runs.clone() };
        let bytes = serde_json::to_vec_pretty(&shape).map_err(|e| e.to_string())?;
        write_atomic(&self.path, &bytes).map_err(|e| format!("could not persist cloud runs: {e}"))
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".cloud-runs.{}.tmp", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    if let Ok(d) = std::fs::File::open(parent) {
        let _ = d.sync_all();
    }
    Ok(())
}

#[cfg(test)]
pub mod tests_support {
    use super::*;
    use powerhouse_cloud_protocol::*;

    pub fn record_with_vm(run_id: &str, vm: &str) -> CloudRunRecord {
        let id = run_id.to_string();
        CloudRunRecord {
            run_id: id.clone(),
            repo_id: "r".into(),
            repo_path: "/tmp/r".into(),
            repo_name: "r".into(),
            source_branch: None,
            manifest: RunManifest {
                protocol_version: PROTOCOL_VERSION,
                run_id: id.clone(),
                task: TaskSpec { text: "t".into(), acceptance_criteria: vec![] },
                source: SourceSpec { repo_name: "r".into(), remote_url: "https://x/y.git".into(), commit_sha: "a".repeat(40), source_branch: None },
                output_branch: RunManifest::expected_output_branch(&id),
                workspace: WorkspaceSpec { base_vm_id: "b".into(), base_vm_name: "b".into() },
                agent: AgentSpec { provider: AgentProvider::Fake, model: None, permission_mode: "dontAsk".into(), allowed_tools: vec![], max_turns: None, max_budget_usd: None, fake_script: None },
                checks: vec![],
                deadline_seconds: 600,
                created_at_ms: 1,
                predecessor_run_id: None,
            },
            manifest_digest: "d".into(),
            created_at_ms: 1,
            phase: Phase::Submitting,
            phase_detail: None,
            base_vm: None,
            task_vm: Some(VmRef { name: vm.into(), id: None }),
            receipt: None,
            snapshot: None,
            result: None,
            events: vec![],
            event_cursor: 0,
            last_sync_ms: None,
            last_sync_error: None,
            idle_policy: None,
            idle_policy_restored: false,
            imported_worktree: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use powerhouse_cloud_protocol::*;

    fn record() -> CloudRunRecord {
        let id = "11111111-2222-4333-8444-555555555555".to_string();
        CloudRunRecord {
            run_id: id.clone(),
            repo_id: "r".into(),
            repo_path: "/tmp/r".into(),
            repo_name: "r".into(),
            source_branch: None,
            manifest: RunManifest {
                protocol_version: PROTOCOL_VERSION,
                run_id: id.clone(),
                task: TaskSpec { text: "t".into(), acceptance_criteria: vec![] },
                source: SourceSpec { repo_name: "r".into(), remote_url: "https://x/y.git".into(), commit_sha: "a".repeat(40), source_branch: None },
                output_branch: RunManifest::expected_output_branch(&id),
                workspace: WorkspaceSpec { base_vm_id: "b".into(), base_vm_name: "b".into() },
                agent: AgentSpec { provider: AgentProvider::Fake, model: None, permission_mode: "dontAsk".into(), allowed_tools: vec![], max_turns: None, max_budget_usd: None, fake_script: None },
                checks: vec![],
                deadline_seconds: 600,
                created_at_ms: 1,
                predecessor_run_id: None,
            },
            manifest_digest: "d".into(),
            created_at_ms: 1,
            phase: Phase::Accepted,
            phase_detail: None,
            base_vm: None,
            task_vm: None,
            receipt: None,
            snapshot: None,
            result: None,
            events: vec![],
            event_cursor: 0,
            last_sync_ms: None,
            last_sync_error: None,
            idle_policy: None,
            idle_policy_restored: false,
            imported_worktree: None,
        }
    }

    fn snap(state: RunState, updated: u64) -> RunSnapshot {
        RunSnapshot {
            run_id: "x".into(), manifest_digest: "d".into(), state, stage: None, last_event_seq: 0,
            accepted_at_ms: 0, updated_at_ms: updated, started_at_ms: None, finished_at_ms: None,
            error: None, cancel_requested: false, result_available: false, unit_active: None,
        }
    }

    fn ev(seq: u64) -> RunEvent {
        RunEvent { seq, ts_ms: seq, kind: "k".into(), payload: serde_json::Value::Null }
    }

    #[test]
    fn stale_snapshots_never_regress() {
        let mut r = record();
        assert!(r.merge_snapshot(snap(RunState::Running, 10)));
        assert!(!r.merge_snapshot(snap(RunState::Preparing, 11)));
        assert!(r.merge_snapshot(snap(RunState::Completed, 12)));
        assert!(!r.merge_snapshot(snap(RunState::Running, 13)));
        assert!(!r.merge_snapshot(snap(RunState::Cancelled, 14)));
        assert_eq!(r.state(), Some(RunState::Completed));
        assert!(!r.is_active());
    }

    #[test]
    fn events_dedupe_and_cursor_is_contiguous() {
        let mut r = record();
        r.merge_events(vec![ev(1), ev(2), ev(4)]);
        assert_eq!(r.event_cursor, 2);
        r.merge_events(vec![ev(2), ev(3)]);
        assert_eq!(r.event_cursor, 4);
        assert_eq!(r.events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
    }

    #[test]
    fn store_round_trips_and_tolerates_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cloud-runs.json");
        let mut s = CloudStore::open(path.clone());
        assert!(s.list().is_empty());
        s.put(record()).unwrap();
        let again = CloudStore::open(path);
        assert_eq!(again.list().len(), 1);
        assert_eq!(again.list()[0].phase, Phase::Accepted);
    }
}
