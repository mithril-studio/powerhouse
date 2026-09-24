//! Desktop-side durable record of submitted cloud runs. This is a cache and a
//! receipt log: the VM runner owns the truth about the run, boxd owns the
//! truth about machines and snapshots. Writes are explicit and atomic (write,
//! fsync, rename) so a launch receipt never depends on a debounce.

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
    /// A machine create was issued; identity may or may not exist remotely.
    Provisioning,
    /// Manifest transferred and `submit` was sent; acknowledgement pending.
    SubmissionUnknown,
    /// Durable receipt received. The laptop is no longer needed.
    Accepted,
    /// Submission definitively failed before acceptance.
    SubmitFailed,
}

/// What boxd resources a run holds. Independent of the run state; see
/// docs/boxd-cloud-vm-lifecycle-plan.md. The intended state is persisted
/// *before* the boxd call that realises it, so a lost acknowledgement is
/// reconciled by name (`ph-<run8>`, `ph-<run8>-park`).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MachineState {
    /// `machine new --from-snapshot` issued; VM not yet confirmed running.
    Provisioning,
    /// Run is live on the VM (idle timers 0/0).
    Active,
    /// Run reached a terminal state; VM kept for inspection, park timer running.
    Holding,
    /// VM snapshotted and destroyed; workspace recoverable from `park_snapshot`.
    Parked,
    /// New VM being created from the park snapshot.
    Restoring,
    /// VM and any park snapshot removed. Nothing is held.
    Released,
    /// Record predates lifecycle tracking (or names a machine Powerhouse does
    /// not own). Powerhouse never touches its resources; clean up by hand.
    #[default]
    Unmanaged,
}

impl MachineState {
    pub fn holds_vm(self) -> bool {
        matches!(self, MachineState::Provisioning | MachineState::Active | MachineState::Holding | MachineState::Restoring)
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct VmRef {
    pub name: String,
    #[serde(default)]
    pub id: Option<String>,
}

/// A park snapshot Powerhouse saved for a run.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SnapshotHandle {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub size: Option<String>,
}

/// The run's diff is cached to disk next to the store once the run ends, so
/// the VM can be released.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DiffMeta {
    pub bytes: u64,
    pub truncated: bool,
}

/// How a finished run's result came home to the local branch. Set once, on the
/// sync that returns it; drives the chat result card. See
/// docs/cloud-return-to-branch-spec.md.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReturnOutcome {
    /// The local source branch was fast-forwarded to `sha` and pushed; the
    /// remote output branch was deleted.
    FastForwarded { sha: String },
    /// The branch could not be moved safely; `reason` explains what happened.
    /// The output branch is kept for the review-worktree import.
    Diverged { reason: String },
    /// A failed/blocked/cancelled run: reported to chat only, no integration.
    ReportedOnly,
}

/// A chat's Claude Code session that travelled with the run. While `returned`
/// is `None` the cloud owns the conversation and the chat stays locked.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionHandoff {
    pub session_id: String,
    /// The worktree the session belongs to on this machine.
    pub cwd: String,
    #[serde(default)]
    pub returned: Option<SessionReturn>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionReturn {
    /// The continued session was written back; the chat resumes `session_id`.
    Restored { session_id: String, files: usize },
    /// Nothing came back (the agent never ran, or the VM is gone); the local
    /// session is as it was when the chat was sent.
    Unchanged { reason: String },
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
    #[serde(default)]
    pub imported_worktree: Option<String>,
    // --- machine lifecycle -------------------------------------------------
    #[serde(default)]
    pub machine: MachineState,
    /// When `machine` last changed; drives the hold timer.
    #[serde(default)]
    pub machine_changed_ms: u64,
    /// Set (as intent) before `snapshots save`; cleared after the snapshot is removed.
    #[serde(default)]
    pub park_snapshot: Option<SnapshotHandle>,
    /// True once `machine remove` was confirmed (or the name was gone).
    #[serde(default)]
    pub vm_released: bool,
    #[serde(default)]
    pub diff_cached: Option<DiffMeta>,
    /// `git ls-remote` showed the result revision on the output branch.
    #[serde(default)]
    pub remote_verified: bool,
    /// Last lifecycle problem (park/release/restore), shown on the card.
    #[serde(default)]
    pub machine_error: Option<String>,
    // --- return to branch --------------------------------------------------
    /// Which chat the send came from; the result card returns here. `None` for
    /// Cloud-tab sends with no chat.
    #[serde(default)]
    pub origin_chat_id: Option<String>,
    /// How the finished result came home. `None` until a terminal run is
    /// returned; set exactly once thereafter.
    #[serde(default)]
    pub returned: Option<ReturnOutcome>,
    /// Retryable failure from the return attempt (fetch died, push rejected),
    /// retried by the lifecycle tick like "release pending".
    #[serde(default)]
    pub return_error: Option<String>,
    // --- session handoff ---------------------------------------------------
    /// Set when the send carried the chat itself (protocol 4).
    #[serde(default)]
    pub session: Option<SessionHandoff>,
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

    /// True while boxd still holds something for this run (VM or snapshot).
    pub fn holds_resources(&self) -> bool {
        match self.machine {
            MachineState::Unmanaged => false,
            MachineState::Parked => true,
            _ => !self.vm_released || self.park_snapshot.is_some(),
        }
    }

    pub fn set_machine(&mut self, next: MachineState, now_ms: u64) {
        if self.machine != next {
            self.machine = next;
            self.machine_changed_ms = now_ms;
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

    /// Per-run artifact cache (diff.patch) next to the store file:
    /// `<store>/../cloud-runs/<run id>/`.
    pub fn cache_dir(&self, run_id: &str) -> PathBuf {
        let stem = self.path.file_stem().and_then(|s| s.to_str()).unwrap_or("cloud-runs").to_string();
        self.path.parent().unwrap_or(Path::new(".")).join(stem).join(run_id)
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
        let _ = std::fs::remove_dir_all(self.cache_dir(run_id));
        Ok(r)
    }

    fn flush(&self) -> Result<(), String> {
        let shape = FileShape { version: 2, runs: self.runs.clone() };
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
                workspace: WorkspaceSpec::from_snapshot("ph-test-base", Some("v1".into())),
                agent: Some(AgentSpec { provider: AgentProvider::Fake, model: None, permission_mode: "dontAsk".into(), allowed_tools: vec![], max_turns: None, max_budget_usd: None, fake_script: None }),
                script: None,
                checks: vec![],
                context: ContextSpec::default(),
                deadline_seconds: 600,
                created_at_ms: 1,
                predecessor_run_id: None,
                session: None,
            },
            manifest_digest: "d".into(),
            created_at_ms: 1,
            phase: Phase::Submitting,
            phase_detail: None,
            task_vm: Some(VmRef { name: vm.into(), id: None }),
            receipt: None,
            snapshot: None,
            result: None,
            events: vec![],
            event_cursor: 0,
            last_sync_ms: None,
            last_sync_error: None,
            imported_worktree: None,
            machine: MachineState::Active,
            machine_changed_ms: 1,
            park_snapshot: None,
            vm_released: false,
            diff_cached: None,
            remote_verified: false,
            machine_error: None,
            origin_chat_id: None,
            returned: None,
            return_error: None,
            session: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> CloudRunRecord {
        let mut r = tests_support::record_with_vm("11111111-2222-4333-8444-555555555555", "ph-11111111");
        r.phase = Phase::Accepted;
        r.task_vm = None;
        r.machine = MachineState::Unmanaged;
        r
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
        assert!(again.cache_dir("abc").ends_with("cloud-runs/abc"));
    }

    #[test]
    fn records_from_the_fork_era_load_as_unmanaged() {
        // A record written by the base-VM/fork model: extra fields, no machine state.
        let legacy = serde_json::json!({
            "version": 1,
            "runs": {
                "49c6291e-290c-49e5-a2d0-4e17f8f8dba9": {
                    "run_id": "49c6291e-290c-49e5-a2d0-4e17f8f8dba9",
                    "repo_id": "r", "repo_path": "/tmp/r", "repo_name": "r",
                    "manifest": {
                        "protocol_version": 1, "run_id": "49c6291e-290c-49e5-a2d0-4e17f8f8dba9",
                        "task": {"text": "t", "acceptance_criteria": []},
                        "source": {"repo_name": "r", "remote_url": "https://x/y.git", "commit_sha": "a", "source_branch": "main"},
                        "output_branch": "powerhouse/cloud/49c6291e-290c-49e5-a2d0-4e17f8f8dba9",
                        "workspace": {"base_vm_id": "5a94", "base_vm_name": "powerhouse-cloud-base"},
                        "agent": {"provider": "claude", "permission_mode": "acceptEdits", "allowed_tools": []},
                        "deadline_seconds": 900, "created_at_ms": 1
                    },
                    "manifest_digest": "d", "created_at_ms": 1, "phase": "accepted",
                    "base_vm": {"name": "powerhouse-cloud-base", "id": "5a94"},
                    "task_vm": {"name": "powerhouse-main", "id": "9801"},
                    "idle_policy": [300, 900], "idle_policy_restored": true
                }
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cloud-runs.json");
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let s = CloudStore::open(path);
        let r = &s.list()[0];
        assert_eq!(r.machine, MachineState::Unmanaged);
        assert!(!r.holds_resources());
        assert_eq!(r.task_vm.as_ref().unwrap().name, "powerhouse-main");
        assert!(r.manifest.workspace.base_snapshot.is_none());
        assert_eq!(r.manifest.workspace.base_vm_name, "powerhouse-cloud-base");
    }

    #[test]
    fn resource_accounting_follows_machine_state() {
        let mut r = record();
        r.machine = MachineState::Active;
        assert!(r.holds_resources());
        r.vm_released = true;
        assert!(!r.holds_resources());
        r.park_snapshot = Some(SnapshotHandle { name: "ph-1-park".into(), version: None, size: None });
        assert!(r.holds_resources());
        r.machine = MachineState::Released;
        assert!(r.holds_resources(), "a lingering park snapshot still counts");
        r.park_snapshot = None;
        assert!(!r.holds_resources());
        r.machine = MachineState::Parked;
        assert!(r.holds_resources());
    }
}
