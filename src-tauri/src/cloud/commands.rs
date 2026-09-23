//! Tauri commands for cloud runs. Provisioning, transfer, submission and the
//! machine lifecycle (release, hold, park, restore) happen here on a blocking
//! thread; the UI observes progress through `cloud-run-update` events and
//! explicit `cloud_sync` / `cloud_lifecycle_tick` calls. Nothing in this
//! module is reached by PTY cleanup or app shutdown.
//!
//! Lifecycle rules (docs/boxd-cloud-vm-lifecycle-plan.md): every run owns one
//! VM named for its source branch (`ph-<branch-slug>`, or `ph-<run8>` on a
//! detached HEAD) created from the base snapshot; a completed, published,
//! fully cached and remotely verified run releases its VM at once; any other
//! terminal state holds the VM for `hold_secs()`, then parks it as snapshot
//! `<vm>-park` and destroys the VM. The intended state is persisted before
//! each boxd call so a lost acknowledgement is reconciled by name — always
//! the name stored on the record, never one recomputed after submit.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use powerhouse_cloud_protocol::{
    AgentProvider, AgentSpec, CheckSpec, ContextSpec, EventPage, ProbeInfo, Receipt, Response,
    ResultManifest, RunManifest, RunSnapshot, RunState, RunnerError, SourceSpec, TaskSpec,
    WorkspaceSpec, MAX_BRIEF_BYTES, PROTOCOL_VERSION,
};
use tauri::{AppHandle, Emitter, Manager, State};

use super::secrets::{self, SecretStore};
use super::store::{CloudRunRecord, CloudStore, DiffMeta, MachineState, Phase, ReturnOutcome, SnapshotHandle, VmRef};
use super::transport::{ensure_owned, Boxd, BoxdCli, MachineInfo, SnapshotInfo, TransportError, OWNED_PREFIX};
use crate::git::git;

pub const RUNNER_BIN: &str = "/usr/local/bin/powerhouse-runner";
const UPDATE_EVENT: &str = "cloud-run-update";
const VM_READY_TIMEOUT: Duration = Duration::from_secs(180);
const SNAPSHOT_READY_TIMEOUT: Duration = Duration::from_secs(600);
/// Machines in the org (any owner) at or above which Powerhouse refuses to
/// create another; leaves room for non-Powerhouse machines in the 20-slot org.
pub const DEFAULT_MACHINE_CEILING: usize = 18;
pub const ORG_MACHINE_SLOTS: usize = 20;
const DEFAULT_HOLD_SECS: u64 = 3600;

/// How long a non-completed terminal run keeps its VM before parking.
/// `POWERHOUSE_CLOUD_HOLD_SECS` shortens it for end-to-end tests.
pub fn hold_secs() -> u64 {
    std::env::var("POWERHOUSE_CLOUD_HOLD_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_HOLD_SECS)
}

pub struct CloudManager {
    pub store: Mutex<CloudStore>,
    pub boxd: Arc<dyn Boxd>,
    pub secrets: Arc<dyn SecretStore>,
    /// Serialises lifecycle mutations (tick vs. user actions vs. sync).
    lifecycle: Mutex<()>,
}

impl Default for CloudManager {
    fn default() -> Self {
        Self {
            store: Mutex::new(CloudStore::open(CloudStore::default_path())),
            boxd: Arc::new(BoxdCli::default()),
            secrets: Arc::new(secrets::Keychain),
            lifecycle: Mutex::new(()),
        }
    }
}

impl CloudManager {
    #[allow(dead_code)]
    pub fn with(store: CloudStore, boxd: Arc<dyn Boxd>, secrets: Arc<dyn SecretStore>) -> Self {
        Self { store: Mutex::new(store), boxd, secrets, lifecycle: Mutex::new(()) }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn short(run_id: &str) -> String {
    run_id.chars().take(8).collect()
}

/// Every run owns one machine, named for the branch it runs: `ph-<slug>`, so
/// `boxd machine list` reads as "which branches are in the cloud". Detached
/// HEAD (no branch) falls back to `ph-<run8>`. Deterministic so a lost create
/// acknowledgement is reconciled by name instead of creating twice. The name
/// is computed once, at submit; every later step reads it from the record.
pub fn task_vm_name(source_branch: Option<&str>, run_id: &str) -> String {
    match source_branch.map(branch_slug).filter(|s| !s.is_empty()) {
        Some(slug) => format!("{OWNED_PREFIX}{slug}"),
        None => format!("{OWNED_PREFIX}{}", short(run_id)),
    }
}

/// Park snapshot for a run's VM, `<vm>-park`. Re-saving bumps its version.
pub fn park_snapshot_name(vm_name: &str) -> String {
    format!("{vm_name}-park")
}

const SLUG_MAX: usize = 32;

/// Lowercased, `[a-z0-9]` kept, every other char `-`, runs of `-` collapsed,
/// ends trimmed, capped at [`SLUG_MAX`]. When case folding, collapsing,
/// trimming or truncation could make two branches collide, a 6-hex-char hash
/// of the full branch name is appended to keep the name deterministic and
/// distinct. Plain per-char substitution (`feat/foo` → `feat-foo`) gets no
/// suffix; the one-live-run-per-branch gate at submit catches the rest.
fn branch_slug(branch: &str) -> String {
    let lower = branch.to_lowercase();
    let mapped: String = lower.chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '-' }).collect();
    let mut cleaned = String::with_capacity(mapped.len());
    for c in mapped.chars() {
        if c == '-' && (cleaned.is_empty() || cleaned.ends_with('-')) {
            continue;
        }
        cleaned.push(c);
    }
    let cleaned = cleaned.trim_end_matches('-').to_string();
    let mut lossy = lower != branch || cleaned != mapped;
    let mut slug = cleaned;
    if slug.len() > SLUG_MAX {
        slug.truncate(SLUG_MAX);
        slug = slug.trim_end_matches('-').to_string();
        lossy = true;
    }
    if slug.is_empty() {
        return hash6(branch);
    }
    if lossy {
        format!("{slug}-{}", hash6(branch))
    } else {
        slug
    }
}

/// First 6 hex chars of the FNV-1a 64-bit hash. Stable across releases: park
/// snapshots and lost-acknowledgement reconciliation depend on recomputing
/// the same name for the same branch forever.
fn hash6(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")[..6].to_string()
}

/// Parse boxd's idle values ("300s", "off") into seconds.
pub fn parse_idle(v: Option<&str>) -> u64 {
    match v {
        Some("off") | None => 0,
        Some(s) => s.trim_end_matches('s').parse().unwrap_or(0),
    }
}

/// `machine get` reports `source: "snapshot/<name>:<n>"` for snapshot-created
/// machines. Returns `(name, "vN")` when present.
pub fn source_snapshot_version(source: Option<&str>) -> Option<(String, String)> {
    let rest = source?.strip_prefix("snapshot/")?;
    let (name, n) = rest.rsplit_once(':')?;
    n.parse::<u64>().ok().map(|n| (name.to_string(), format!("v{n}")))
}

fn strip_credentials(url: &str) -> String {
    if let Some((scheme, rest)) = url.split_once("://") {
        if let Some((_, host)) = rest.split_once('@') {
            return format!("{scheme}://{host}");
        }
    }
    url.to_string()
}

// --- runner protocol over exec -------------------------------------------------

fn runner_call<T: serde::de::DeserializeOwned>(
    boxd: &dyn Boxd,
    vm: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<T, String> {
    let mut argv: Vec<String> = vec!["sudo".into(), "-n".into(), RUNNER_BIN.into()];
    argv.extend(args.iter().map(|s| s.to_string()));
    let out = boxd.exec(vm, &argv, timeout).map_err(|e| e.to_string())?;
    let json = super::transport::extract_json(&out.output).ok_or_else(|| {
        if out.output.contains("No such file") || out.output.contains("not found") {
            format!("the Powerhouse runner is not installed on {vm}. Publish a new base snapshot with scripts/cloud-base-setup.sh --publish-snapshot.")
        } else {
            format!("runner returned no JSON (exit {}): {}", out.exit_code, out.output.trim().chars().take(400).collect::<String>())
        }
    })?;
    let resp: Response<T> = serde_json::from_value(json).map_err(|e| format!("runner response did not match protocol {PROTOCOL_VERSION}: {e}"))?;
    resp.into_result().map_err(|e: RunnerError| format!("{} ({})", e.message, e.code))
}

// --- source -------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize)]
pub struct SourceInfo {
    pub sha: String,
    pub branch: Option<String>,
    pub remote_url: Option<String>,
    pub dirty: bool,
    pub on_remote: bool,
    pub problems: Vec<String>,
}

pub fn inspect_source(worktree: &Path) -> Result<SourceInfo, String> {
    let sha = git(worktree, &["rev-parse", "HEAD"])?;
    let branch = git(worktree, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|s| !s.is_empty());
    let remote_url = git(worktree, &["remote", "get-url", "origin"]).ok().map(|u| strip_credentials(&u));
    let dirty = !git(worktree, &["status", "--porcelain"])?.trim().is_empty();
    let mut problems = vec![];
    if dirty {
        problems.push("The worktree has uncommitted changes. Commit or stash them first; cloud runs use committed code only.".into());
    }
    let mut on_remote = false;
    match &remote_url {
        None => problems.push("The repository has no `origin` remote; the cloud VM needs a remote to fetch from.".into()),
        Some(_) => {
            let _ = git(worktree, &["fetch", "--quiet", "origin"]);
            let containing = git(worktree, &["branch", "-r", "--contains", &sha]).unwrap_or_default();
            on_remote = !containing.trim().is_empty();
            if !on_remote {
                problems.push(format!("Commit {} is not on origin yet. Push it first.", short(&sha)));
            }
        }
    }
    Ok(SourceInfo { sha, branch, remote_url, dirty, on_remote, problems })
}

// --- submission ---------------------------------------------------------------

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRequest {
    pub repo_id: String,
    pub repo_path: String,
    pub repo_name: String,
    /// Directory whose HEAD is the source revision (a worktree or the repo).
    pub source_path: String,
    pub task: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    /// Name of the base snapshot to create the task VM from.
    pub base_snapshot: String,
    /// Version the user saw in the form (`v3`). Submission refuses if the
    /// snapshot has been re-saved since.
    #[serde(default)]
    pub base_snapshot_version: Option<String>,
    /// Org-wide machine count at or above which submission refuses.
    #[serde(default)]
    pub machine_ceiling: Option<usize>,
    #[serde(default)]
    pub checks: Vec<CheckSpec>,
    pub deadline_seconds: u64,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
    #[serde(default)]
    pub model: Option<String>,
    /// "claude" (default) or "fake" (tests only).
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub fake_script: Option<String>,
    /// Plan/context markdown rendered by Powerhouse (handoff doc, notes).
    #[serde(default)]
    pub brief: String,
    /// Per-project env var names; values come from the Keychain per repo and
    /// travel only in the per-run credentials file.
    #[serde(default)]
    pub env_names: Vec<String>,
    /// Chat the send came from; the finished result returns here. `None` for
    /// Cloud-tab sends with no active chat.
    #[serde(default)]
    pub chat_id: Option<String>,
}

fn default_permission_mode() -> String {
    "dontAsk".into()
}
fn default_provider() -> String {
    "claude".into()
}

fn persist(mgr: &CloudManager, app: Option<&AppHandle>, record: &CloudRunRecord) -> Result<(), String> {
    mgr.store.lock().unwrap().put(record.clone())?;
    if let Some(app) = app {
        let _ = app.emit(UPDATE_EVENT, record);
    }
    Ok(())
}

fn load(mgr: &CloudManager, run_id: &str) -> Result<CloudRunRecord, String> {
    mgr.store.lock().unwrap().get(run_id).cloned().ok_or_else(|| format!("unknown cloud run {run_id}"))
}

fn wait_running(boxd: &dyn Boxd, vm: &str) -> Result<MachineInfo, String> {
    let start = Instant::now();
    loop {
        let info = boxd.machine_get(vm).map_err(|e| e.to_string())?;
        match info.status.as_str() {
            "running" | "standby" => return Ok(info),
            "stopped" | "hibernated" => {
                boxd.machine_start(vm).map_err(|e| e.to_string())?;
            }
            _ => {}
        }
        if start.elapsed() > VM_READY_TIMEOUT {
            return Err(format!(
                "{vm} did not become ready within {}s (last status: {}). Retry later; the machine is reconciled by name.",
                VM_READY_TIMEOUT.as_secs(),
                info.status
            ));
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

/// Look a snapshot up by name; only `ready` snapshots can be used.
fn find_snapshot(boxd: &dyn Boxd, name: &str) -> Result<SnapshotInfo, String> {
    let rows = boxd.snapshots_list().map_err(|e| e.to_string())?;
    let row = rows
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("base snapshot `{name}` not found in your boxd org. Publish one with scripts/cloud-base-setup.sh --publish-snapshot {name}."))?;
    if !row.is_ready() {
        return Err(format!("base snapshot `{name}` is `{}`, not ready", row.status));
    }
    Ok(row)
}

fn wait_snapshot_ready(boxd: &dyn Boxd, name: &str) -> Result<SnapshotInfo, String> {
    let start = Instant::now();
    loop {
        let rows = boxd.snapshots_list().map_err(|e| e.to_string())?;
        if let Some(row) = rows.into_iter().find(|s| s.name == name) {
            if row.is_ready() {
                return Ok(row);
            }
        }
        if start.elapsed() > SNAPSHOT_READY_TIMEOUT {
            return Err(format!("snapshot {name} did not become ready within {}s", SNAPSHOT_READY_TIMEOUT.as_secs()));
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

/// Refuse when the org is at or above the machine ceiling.
fn ensure_capacity(boxd: &dyn Boxd, ceiling: usize) -> Result<(), String> {
    let count = boxd.machine_list().map_err(|e| e.to_string())?.len();
    if count >= ceiling {
        return Err(format!(
            "your boxd org has {count} machines and Powerhouse's ceiling is {ceiling} (org limit {ORG_MACHINE_SLOTS}). Discard or park finished runs in the Cloud tab, remove other machines, or raise the ceiling in the run form."
        ));
    }
    Ok(())
}

/// The record (if any) that still holds this VM name's resources — the reason
/// a branch counts as "in the cloud".
fn holding_run(mgr: &CloudManager, vm_name: &str) -> Option<CloudRunRecord> {
    mgr.store
        .lock()
        .unwrap()
        .list()
        .into_iter()
        .find(|r| r.task_vm.as_ref().is_some_and(|v| v.name == vm_name) && r.holds_resources())
}

fn branch_conflict_message(branch: Option<&str>, existing: &CloudRunRecord) -> String {
    format!(
        "branch {} is already in the cloud: run {} still holds {}. Discard that run's workspace in the Cloud tab (or wait for it to finish) before sending this branch again.",
        branch.unwrap_or("(detached)"),
        short(&existing.run_id),
        if existing.machine == MachineState::Parked { "a parked snapshot" } else { "its VM" },
    )
}

/// Create (or find) a machine by name from a snapshot. A timeout or unclear
/// error from `machine new` is followed by a lookup: absence of an
/// acknowledgement is not absence of a machine.
fn ensure_machine_from_snapshot(boxd: &dyn Boxd, name: &str, snapshot: &str, ceiling: Option<usize>) -> Result<MachineInfo, String> {
    match boxd.machine_get(name) {
        Ok(existing) => return Ok(existing),
        Err(TransportError::NotFound(_)) => {}
        Err(e) => return Err(e.to_string()),
    }
    if let Some(ceiling) = ceiling {
        ensure_capacity(boxd, ceiling)?;
    }
    match boxd.machine_new_from_snapshot(name, snapshot, true, 0, 0) {
        Ok(info) => Ok(info),
        Err(TransportError::NotOwned(n)) => Err(TransportError::NotOwned(n).to_string()),
        Err(first) => {
            std::thread::sleep(Duration::from_secs(2));
            match boxd.machine_get(name) {
                Ok(info) => Ok(info),
                Err(_) => Err(first.to_string()),
            }
        }
    }
}

pub fn build_manifest(req: &SubmitRequest, run_id: &str, source: &SourceInfo, base: &SnapshotInfo) -> Result<RunManifest, String> {
    let provider = match req.provider.as_str() {
        "claude" => AgentProvider::Claude,
        "fake" => AgentProvider::Fake,
        other => return Err(format!("unknown provider {other}")),
    };
    let manifest = RunManifest {
        protocol_version: PROTOCOL_VERSION,
        run_id: run_id.to_string(),
        task: TaskSpec { text: req.task.trim().to_string(), acceptance_criteria: req.acceptance_criteria.clone() },
        source: SourceSpec {
            repo_name: req.repo_name.clone(),
            remote_url: source.remote_url.clone().ok_or("no remote")?,
            commit_sha: source.sha.clone(),
            source_branch: source.branch.clone(),
        },
        output_branch: RunManifest::expected_output_branch(run_id),
        workspace: WorkspaceSpec::from_snapshot(&base.name, base.version.clone()),
        agent: Some(AgentSpec {
            provider,
            model: req.model.clone().filter(|m| !m.trim().is_empty()),
            permission_mode: req.permission_mode.clone(),
            allowed_tools: req.allowed_tools.clone(),
            max_turns: req.max_turns,
            max_budget_usd: req.max_budget_usd,
            fake_script: req.fake_script.clone(),
        }),
        script: None,
        checks: req.checks.iter().filter(|c| !c.command.trim().is_empty()).cloned().collect(),
        context: ContextSpec { brief_markdown: req.brief.chars().take(MAX_BRIEF_BYTES).collect() },
        deadline_seconds: req.deadline_seconds,
        created_at_ms: now_ms(),
        predecessor_run_id: None,
    };
    manifest.validate()?;
    Ok(manifest)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}

fn shred_local(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(path) {
            use std::io::Write;
            let _ = f.write_all(&vec![0u8; meta.len() as usize]);
            let _ = f.sync_all();
        }
        let _ = std::fs::remove_file(path);
    }
}

fn manifest_temp_path(run_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".powerhouse")
        .join("cloud-tmp")
        .join(format!("{run_id}.json"))
}

/// The whole submission. Every step persists before its remote side effect.
pub fn do_submit(mgr: &CloudManager, app: Option<&AppHandle>, req: SubmitRequest) -> Result<CloudRunRecord, String> {
    let boxd = mgr.boxd.clone();
    let source = inspect_source(Path::new(&req.source_path))?;
    if !source.problems.is_empty() {
        return Err(source.problems.join("\n"));
    }
    let base_name = req.base_snapshot.trim().to_string();
    if base_name.is_empty() {
        return Err("choose a base snapshot first".into());
    }
    let base = find_snapshot(boxd.as_ref(), &base_name)?;
    if let Some(pinned) = req.base_snapshot_version.as_deref().filter(|v| !v.is_empty()) {
        if base.version.as_deref() != Some(pinned) {
            return Err(format!(
                "base snapshot `{base_name}` is now {} but the form was opened at {pinned}. Reopen the form to run from the current version.",
                base.version.as_deref().unwrap_or("an unknown version")
            ));
        }
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let manifest = build_manifest(&req, &run_id, &source, &base)?;
    let digest = manifest.digest();
    // Credentials are Powerhouse's own, per run, and must exist before any
    // machine is touched. Git publication needs a token only for HTTPS remotes.
    let need_claude = manifest.agent.as_ref().is_some_and(|a| a.provider == AgentProvider::Claude);
    let git_remote = manifest.source.remote_url.starts_with("https://").then_some(manifest.source.remote_url.as_str());
    let project_env = secrets::project_env_values(mgr.secrets.as_ref(), &req.repo_id, &req.env_names)?;
    let credentials_text = secrets::render_run_credentials(mgr.secrets.as_ref(), need_claude, git_remote, &project_env)?;
    let vm_name = task_vm_name(source.branch.as_deref(), &run_id);
    let ceiling = Some(req.machine_ceiling.unwrap_or(DEFAULT_MACHINE_CEILING));
    // One live run per branch: the VM name is the branch's cloud identity, so
    // a second run would collide with the first's VM or park snapshot. This
    // doubles as the two-writer guard for the branch's output.
    if let Some(existing) = holding_run(mgr, &vm_name) {
        return Err(branch_conflict_message(source.branch.as_deref(), &existing));
    }

    let mut record = CloudRunRecord {
        run_id: run_id.clone(),
        repo_id: req.repo_id.clone(),
        repo_path: req.repo_path.clone(),
        repo_name: req.repo_name.clone(),
        source_branch: source.branch.clone(),
        manifest: manifest.clone(),
        manifest_digest: digest.clone(),
        created_at_ms: now_ms(),
        phase: Phase::Submitting,
        phase_detail: Some("Recording submission".into()),
        task_vm: Some(VmRef { name: vm_name.clone(), id: None }),
        receipt: None,
        snapshot: None,
        result: None,
        events: vec![],
        event_cursor: 0,
        last_sync_ms: None,
        last_sync_error: None,
        imported_worktree: None,
        machine: MachineState::Provisioning,
        machine_changed_ms: now_ms(),
        park_snapshot: None,
        vm_released: false,
        diff_cached: None,
        remote_verified: false,
        machine_error: None,
        origin_chat_id: req.chat_id.clone(),
        returned: None,
        return_error: None,
    };
    // Durable intent (run id, machine name, snapshot version) before the
    // first remote side effect.
    persist(mgr, app, &record)?;

    let result = (|| -> Result<(), String> {
        record.phase = Phase::Provisioning;
        record.phase_detail = Some(format!(
            "Preparing cloud environment: creating {vm_name} from snapshot {} {}",
            base.name,
            base.version.as_deref().unwrap_or("")
        ));
        persist(mgr, app, &record)?;
        let vm = ensure_machine_from_snapshot(boxd.as_ref(), &vm_name, &base.name, ceiling)?;
        record.task_vm = Some(VmRef { name: vm_name.clone(), id: vm.id.clone() });
        record.phase_detail = Some(format!("Waiting for {vm_name} to boot"));
        persist(mgr, app, &record)?;
        let info = wait_running(boxd.as_ref(), &vm_name)?;
        record.task_vm = Some(VmRef { name: vm_name.clone(), id: info.id.clone().or(vm.id.clone()) });

        // boxd always builds from the latest version; refuse a machine built
        // from a different version than the one the manifest records.
        if let (Some((_, built)), Some(pinned)) = (source_snapshot_version(info.source.as_deref()), base.version.as_deref()) {
            if built != pinned {
                return Err(format!(
                    "{vm_name} was built from snapshot {} {built}, but this run recorded {pinned}. The base was re-saved during submission; retry.",
                    base.name
                ));
            }
        }
        if let Some(iso) = info.isolated.as_deref() {
            if iso != "yes" {
                return Err(format!("{vm_name} is not isolated (`{iso}`); refusing to run on a machine that can reach the org network"));
            }
        }
        // Idle timers watch network only; the run must not be frozen mid-check.
        if parse_idle(info.auto_suspend.as_deref()) != 0 {
            boxd.config_set(&vm_name, "auto-suspend.timeout", "0").map_err(|e| e.to_string())?;
        }
        if parse_idle(info.auto_hibernate.as_deref()) != 0 {
            boxd.config_set(&vm_name, "auto-hibernate.timeout", "0").map_err(|e| e.to_string())?;
        }
        let verify = boxd.machine_get(&vm_name).map_err(|e| e.to_string())?;
        if parse_idle(verify.auto_suspend.as_deref()) != 0 || parse_idle(verify.auto_hibernate.as_deref()) != 0 {
            return Err(format!("could not disable idle policies on {vm_name}; refusing to run unattended"));
        }
        record.set_machine(MachineState::Active, now_ms());
        record.phase_detail = Some("Checking the runner on the task VM".into());
        persist(mgr, app, &record)?;
        let probe: ProbeInfo = runner_call(boxd.as_ref(), &vm_name, &["probe"], Duration::from_secs(60))?;
        if probe.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "runner in snapshot {} speaks protocol {} but this Powerhouse needs {PROTOCOL_VERSION}; publish a new base snapshot",
                base.name, probe.protocol_version
            ));
        }
        if !probe.agent_user_ready || !probe.store_ready {
            return Err(format!("runner on {vm_name} is not installed correctly (agent user or store missing); publish a new base snapshot"));
        }
        if !probe.ambient_secret_names.is_empty() {
            record.phase_detail = Some(format!(
                "Warning: the task VM's exec sessions carry ambient secrets ({}); the run itself never receives them. Remove them from boxd to keep the machine clean.",
                probe.ambient_secret_names.join(", ")
            ));
            persist(mgr, app, &record)?;
        }

        // Transfer the manifest by file, then finalize with a digest check.
        let tmp = manifest_temp_path(&run_id);
        std::fs::create_dir_all(tmp.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, serde_json::to_vec(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let remote = format!("/home/boxd/powerhouse-{run_id}.json");
        let remote_creds = format!("/home/boxd/powerhouse-{run_id}.creds");
        record.phase_detail = Some("Uploading the run request".into());
        persist(mgr, app, &record)?;
        boxd.cp_to(&tmp, &vm_name, &remote).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
        // Per-run credentials travel next to the manifest and are taken into
        // root-only custody by `submit`; the local copy is shredded right away.
        let has_credentials = !credentials_text.trim().is_empty();
        if has_credentials {
            let creds_tmp = manifest_temp_path(&format!("{run_id}.creds"));
            write_private(&creds_tmp, credentials_text.as_bytes())?;
            let cp_result = boxd.cp_to(&creds_tmp, &vm_name, &remote_creds).map_err(|e| e.to_string());
            shred_local(&creds_tmp);
            cp_result?;
        }

        record.phase = Phase::SubmissionUnknown;
        record.phase_detail = Some("Submitting to the runner".into());
        persist(mgr, app, &record)?;
        let mut submit_args: Vec<&str> = vec!["submit", "--manifest", &remote, "--expect-digest", &digest];
        if has_credentials {
            submit_args.extend(["--credentials", remote_creds.as_str()]);
        }
        let receipt: Receipt = match runner_call(boxd.as_ref(), &vm_name, &submit_args, Duration::from_secs(90)) {
            Ok(r) => r,
            Err(first) => {
                // Absence of a response is not absence of a run.
                match runner_call::<RunSnapshot>(boxd.as_ref(), &vm_name, &["inspect", &run_id], Duration::from_secs(60)) {
                    Ok(snap) => Receipt {
                        run_id: run_id.clone(),
                        manifest_digest: snap.manifest_digest.clone(),
                        state: snap.state,
                        event_cursor: snap.last_event_seq,
                        accepted_at_ms: snap.accepted_at_ms,
                        duplicate: true,
                    },
                    Err(_) => return Err(first),
                }
            }
        };
        if receipt.manifest_digest != digest {
            return Err(format!("runner accepted a different manifest (digest {}) under this run id", receipt.manifest_digest));
        }
        record.receipt = Some(receipt);
        record.phase = Phase::Accepted;
        record.phase_detail = None;
        persist(mgr, app, &record)?;
        Ok(())
    })();

    match result {
        Ok(()) => Ok(record),
        Err(e) => {
            if record.phase == Phase::SubmissionUnknown {
                // The runner may own the run; keep the machine and let sync decide.
                record.phase_detail = Some(e.clone());
                let _ = persist(mgr, app, &record);
            } else if record.phase != Phase::Accepted {
                record.phase = Phase::SubmitFailed;
                record.phase_detail = Some(e.clone());
                let _ = persist(mgr, app, &record);
                // Nothing of value is on a machine that never accepted a run.
                if let Err(re) = release_vm(mgr, app, &mut record) {
                    record.machine_error = Some(re);
                    let _ = persist(mgr, app, &record);
                }
            }
            Err(e)
        }
    }
}

// --- one-click submission -------------------------------------------------------

/// Fixed task text for quick submissions: the brief *is* the task.
pub const QUICK_TASK_TEXT: &str =
    "Execute the work described in the brief (`.powerhouse/cloud-task.md`). It contains the plan and context.";
const QUICK_EVENT: &str = "cloud-quick-submit";

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickSubmitRequest {
    pub repo_id: String,
    pub repo_path: String,
    pub repo_name: String,
    /// Worktree whose branch is sent to the cloud.
    pub source_path: String,
    /// Last-used settings, persisted by the UI.
    pub base_snapshot: String,
    #[serde(default)]
    pub machine_ceiling: Option<usize>,
    #[serde(default)]
    pub checks: Vec<CheckSpec>,
    pub deadline_seconds: u64,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub max_turns: Option<u32>,
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub fake_script: Option<String>,
    #[serde(default)]
    pub env_names: Vec<String>,
    /// Chat the send came from (`branch.activeChatId`); the result returns here.
    #[serde(default)]
    pub chat_id: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QuickSubmitOutcome {
    /// The run was accepted; the record carries the rest of the story.
    Accepted { record: Box<CloudRunRecord> },
    /// Something needs the user; the UI opens the advanced form with the
    /// reason instead of a dead-end toast. `stage` names where it stopped.
    NeedsAttention { stage: String, reason: String },
}

fn emit_quick_stage(app: Option<&AppHandle>, repo_id: &str, branch: &str, stage: &str) {
    if let Some(app) = app {
        let _ = app.emit(QUICK_EVENT, serde_json::json!({ "repoId": repo_id, "branch": branch, "stage": stage }));
    }
}

/// One-click "Send to cloud": preflight every submit-time refusal before any
/// side effect, checkpoint a dirty worktree as a WIP commit, push the branch,
/// pick the newest plan document as the brief (or generate a stub), then run
/// the normal submission with the caller's last-used settings.
pub fn do_quick_submit(mgr: &CloudManager, app: Option<&AppHandle>, req: QuickSubmitRequest) -> Result<QuickSubmitOutcome, String> {
    let worktree = PathBuf::from(&req.source_path);
    let attention = |stage: &str, reason: String| Ok(QuickSubmitOutcome::NeedsAttention { stage: stage.into(), reason });

    // Preflight, in the order the failures are cheapest to detect. Nothing
    // here mutates the worktree, the store, or boxd.
    let Some(branch) = git(&worktree, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|b| !b.is_empty()) else {
        return attention("preflight", "The worktree is on a detached HEAD; check out a branch first, or use the advanced form.".into());
    };
    let remote_url = match git(&worktree, &["remote", "get-url", "origin"]) {
        Ok(u) => strip_credentials(&u),
        Err(_) => return attention("preflight", "The repository has no `origin` remote; the cloud VM needs a remote to fetch from.".into()),
    };
    let need_claude = req.provider != "fake";
    let git_remote = remote_url.starts_with("https://").then_some(remote_url.as_str());
    let project_env = match secrets::project_env_values(mgr.secrets.as_ref(), &req.repo_id, &req.env_names) {
        Ok(env) => env,
        Err(e) => return attention("preflight", e),
    };
    if let Err(e) = secrets::render_run_credentials(mgr.secrets.as_ref(), need_claude, git_remote, &project_env) {
        return attention("preflight", e);
    }
    let base = match find_snapshot(mgr.boxd.as_ref(), req.base_snapshot.trim()) {
        Ok(b) => b,
        Err(e) => return attention("preflight", e),
    };
    if let Err(e) = ensure_capacity(mgr.boxd.as_ref(), req.machine_ceiling.unwrap_or(DEFAULT_MACHINE_CEILING)) {
        return attention("preflight", e);
    }
    // The run id plays no part in a branch-derived name; "" keeps that honest.
    if let Some(existing) = holding_run(mgr, &task_vm_name(Some(&branch), "")) {
        return attention("preflight", branch_conflict_message(Some(&branch), &existing));
    }

    // Checkpoint: make the source clean so the strict `inspect_source` in
    // `do_submit` passes; `.powerhouse/` stays excluded from the commit.
    crate::handoff::ensure_powerhouse_dir(&worktree);
    emit_quick_stage(app, &req.repo_id, &branch, "checkpointing");
    let dirty = match git(&worktree, &["status", "--porcelain"]) {
        Ok(s) => !s.trim().is_empty(),
        Err(e) => return attention("checkpoint", e),
    };
    if dirty {
        if let Err(e) = git(&worktree, &["add", "-A"]).and_then(|_| git(&worktree, &["commit", "-m", "WIP: send to cloud"])) {
            return attention("checkpoint", format!("could not checkpoint the dirty worktree: {e}"));
        }
    }
    // Push with the user's own git credentials; the Powerhouse token is only
    // for the VM. Never force; git's own message explains a refusal.
    emit_quick_stage(app, &req.repo_id, &branch, "pushing");
    let has_upstream = git(&worktree, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
    let push_args: Vec<&str> = if has_upstream { vec!["push", "origin", &branch] } else { vec!["push", "-u", "origin", &branch] };
    if let Err(e) = git(&worktree, &push_args) {
        return attention("push", format!("git push failed: {}", super::redact_stderr(&e)));
    }

    let brief = match latest_brief_doc(&req.source_path) {
        Some(doc) => doc.content,
        None => stub_brief(&worktree),
    };

    emit_quick_stage(app, &req.repo_id, &branch, "submitting");
    let submit = SubmitRequest {
        repo_id: req.repo_id.clone(),
        repo_path: req.repo_path,
        repo_name: req.repo_name,
        source_path: req.source_path,
        task: QUICK_TASK_TEXT.into(),
        acceptance_criteria: vec![],
        base_snapshot: base.name.clone(),
        base_snapshot_version: base.version.clone(),
        machine_ceiling: req.machine_ceiling,
        checks: req.checks,
        deadline_seconds: req.deadline_seconds,
        permission_mode: req.permission_mode,
        allowed_tools: req.allowed_tools,
        max_turns: req.max_turns,
        max_budget_usd: req.max_budget_usd,
        model: req.model,
        provider: req.provider,
        fake_script: req.fake_script,
        brief,
        env_names: req.env_names,
        chat_id: req.chat_id,
    };
    match do_submit(mgr, app, submit) {
        Ok(record) => Ok(QuickSubmitOutcome::Accepted { record: Box::new(record) }),
        Err(e) => attention("submit", e),
    }
}

/// No plan document under `.powerhouse/`: a generated snapshot of the branch
/// so the agent still has context beyond the fixed task line.
fn stub_brief(worktree: &Path) -> String {
    let log = git(worktree, &["log", "--oneline", "-10"]).unwrap_or_default();
    let stat = git(worktree, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .and_then(|h| git(worktree, &["diff", "--stat", &format!("{h}...")]).ok())
        .or_else(|| git(worktree, &["diff", "--stat", "origin/main..."]).ok())
        .unwrap_or_default();
    format!(
        "# Branch snapshot (auto-generated)\n\nNo plan document was found under `.powerhouse/`; \
         this is the branch's recent history.\n\n## Recent commits\n\n```\n{log}\n```\n\n## Diff stat against the default branch\n\n```\n{stat}\n```\n"
    )
}

// --- machine lifecycle ----------------------------------------------------------

/// Remove a run's VM if it still exists. Persists the `Released` intent first
/// and `vm_released` after confirmation. Never called for unmanaged records.
fn release_vm(mgr: &CloudManager, app: Option<&AppHandle>, record: &mut CloudRunRecord) -> Result<(), String> {
    if record.machine == MachineState::Unmanaged {
        return Err("this run's machine is not managed by Powerhouse; clean it up by hand".into());
    }
    let Some(vm) = record.task_vm.clone() else {
        record.vm_released = true;
        record.set_machine(MachineState::Released, now_ms());
        return persist(mgr, app, record);
    };
    ensure_owned(&vm.name).map_err(|e| e.to_string())?;
    if !record.vm_released {
        if record.machine != MachineState::Parked {
            record.set_machine(MachineState::Released, now_ms());
        }
        persist(mgr, app, record)?;
        match mgr.boxd.machine_get(&vm.name) {
            Ok(_) => mgr.boxd.machine_remove(&vm.name).map_err(|e| e.to_string())?,
            Err(TransportError::NotFound(_)) => {}
            Err(e) => return Err(e.to_string()),
        }
        record.vm_released = true;
        record.machine_error = None;
        persist(mgr, app, record)?;
    }
    Ok(())
}

/// Remove a run's park snapshot if one is recorded.
fn release_park_snapshot(mgr: &CloudManager, app: Option<&AppHandle>, record: &mut CloudRunRecord) -> Result<(), String> {
    let Some(park) = record.park_snapshot.clone() else { return Ok(()) };
    ensure_owned(&park.name).map_err(|e| e.to_string())?;
    match mgr.boxd.snapshot_remove(&park.name) {
        Ok(()) | Err(TransportError::NotFound(_)) => {}
        Err(e) => return Err(e.to_string()),
    }
    record.park_snapshot = None;
    persist(mgr, app, record)
}

/// Ask the runner whether the run is live on its VM. `Ok(true)` means a unit
/// is (or may be) active; errors mean we could not confirm either way.
fn runner_reports_live(boxd: &dyn Boxd, vm: &str, run_id: &str) -> Result<bool, String> {
    let snap: RunSnapshot = runner_call(boxd, vm, &["inspect", run_id], Duration::from_secs(60))?;
    Ok(snap.state.is_live() || snap.unit_active == Some(true))
}

/// What still blocks releasing a completed run's VM, if anything.
pub fn release_gate(record: &CloudRunRecord) -> Result<(), String> {
    let Some(res) = record.result.as_ref() else { return Err("result not cached yet".into()) };
    if !res.published || res.result_sha.is_none() {
        return Err("result is not published".into());
    }
    let high_water = record.snapshot.as_ref().map(|s| s.last_event_seq).unwrap_or(0);
    if record.event_cursor < high_water {
        return Err(format!("events cached up to {} of {high_water}", record.event_cursor));
    }
    if record.diff_cached.is_none() {
        return Err("diff not cached yet".into());
    }
    if !record.remote_verified {
        return Err("remote branch not verified yet".into());
    }
    Ok(())
}

fn https_auth_env_for(mgr: &CloudManager, remote: &str) -> Vec<(String, String)> {
    if !remote.starts_with("https://") {
        return vec![];
    }
    match secrets::render_run_credentials(mgr.secrets.as_ref(), false, Some(remote), &[]) {
        Ok(text) => text
            .lines()
            .find_map(|l| l.strip_prefix("GIT_PUBLISH_TOKEN=").map(|t| t.to_string()))
            .map(|t| https_auth_env(&t))
            .unwrap_or_default(),
        Err(_) => vec![],
    }
}

/// `git ls-remote` must show the recorded result revision on the output branch.
fn verify_remote_ref(mgr: &CloudManager, record: &CloudRunRecord) -> Result<(), String> {
    let sha = record
        .result
        .as_ref()
        .and_then(|r| r.result_sha.clone())
        .ok_or("no result revision to verify")?;
    let branch = record.manifest.output_branch.clone();
    let repo = Path::new(&record.repo_path);
    let env = https_auth_env_for(mgr, &record.manifest.source.remote_url);
    let out = git_with_env(repo, &["ls-remote", "origin", &format!("refs/heads/{branch}")], &env)?;
    let remote_sha = out.split_whitespace().next().unwrap_or("");
    if remote_sha != sha {
        return Err(format!(
            "remote branch {branch} is at {} but the run recorded {}",
            if remote_sha.is_empty() { "<missing>".to_string() } else { short(remote_sha) },
            short(&sha)
        ));
    }
    Ok(())
}

fn diff_cache_path(mgr: &CloudManager, run_id: &str) -> PathBuf {
    mgr.store.lock().unwrap().cache_dir(run_id).join("diff.patch")
}

/// Copy the run's diff from the VM into the local cache (once).
fn cache_diff(mgr: &CloudManager, record: &mut CloudRunRecord) -> Result<(), String> {
    if record.diff_cached.is_some() {
        return Ok(());
    }
    let vm = record.task_vm.clone().ok_or("no task VM")?;
    let v: serde_json::Value = runner_call(mgr.boxd.as_ref(), &vm.name, &["diff", &record.run_id], Duration::from_secs(90))?;
    let patch = v.get("patch").and_then(|p| p.as_str()).unwrap_or("");
    let path = diff_cache_path(mgr, &record.run_id);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, patch.as_bytes()).map_err(|e| e.to_string())?;
    record.diff_cached = Some(DiffMeta {
        bytes: v.get("bytes").and_then(|b| b.as_u64()).unwrap_or(patch.len() as u64),
        truncated: v.get("truncated").and_then(|t| t.as_bool()).unwrap_or(false),
    });
    Ok(())
}

/// Completed and published: release as soon as the local cache and the
/// remote are verified. Other terminal states: hold (parked later by the tick).
fn advance_after_terminal(mgr: &CloudManager, app: Option<&AppHandle>, record: &mut CloudRunRecord) -> Result<(), String> {
    if record.phase != Phase::Accepted || !matches!(record.machine, MachineState::Active | MachineState::Provisioning) {
        return Ok(());
    }
    let Some(state) = record.state().filter(|s| s.is_terminal()) else { return Ok(()) };
    let published = record.result.as_ref().map(|r| r.published && r.result_sha.is_some()).unwrap_or(false);
    if state == RunState::Completed && published {
        if let Err(e) = cache_diff(mgr, record) {
            record.machine_error = Some(format!("release pending: diff: {e}"));
            return persist(mgr, app, record);
        }
        if !record.remote_verified {
            match verify_remote_ref(mgr, record) {
                Ok(()) => record.remote_verified = true,
                Err(e) => {
                    record.machine_error = Some(format!("release pending: {e}"));
                    return persist(mgr, app, record);
                }
            }
        }
        // The remote is confirmed: bring the result home to the branch. Its own
        // failures live in `return_error` and never block the VM release.
        let _ = do_return(mgr, app, record);
        match release_gate(record) {
            Ok(()) => {
                let vm = record.task_vm.as_ref().map(|v| v.name.clone()).ok_or("no task VM")?;
                if runner_reports_live(mgr.boxd.as_ref(), &vm, &record.run_id)? {
                    return Err("runner still reports the run live; not releasing".into());
                }
                release_vm(mgr, app, record)
            }
            Err(why) => {
                record.machine_error = Some(format!("release pending: {why}"));
                persist(mgr, app, record)
            }
        }
    } else {
        // Partial work only exists in the workspace: hold, then park.
        let _ = cache_diff(mgr, record);
        // Report the outcome to chat; no integration for a non-completed run.
        let _ = do_return(mgr, app, record);
        record.set_machine(MachineState::Holding, now_ms());
        record.machine_error = None;
        persist(mgr, app, record)
    }
}

/// The local worktree that has `branch` checked out, if any. Parses
/// `git worktree list --porcelain` from the repo (the main checkout is a
/// worktree too).
fn worktree_for_branch(repo: &Path, branch: &str) -> Option<PathBuf> {
    let out = git(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let want = format!("refs/heads/{branch}");
    let mut current: Option<PathBuf> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            current = Some(PathBuf::from(p.trim()));
        } else if let Some(b) = line.strip_prefix("branch ") {
            if b.trim() == want {
                return current;
            }
        }
    }
    None
}

/// Bring a finished run's result home to the branch that sent it. Idempotent:
/// does nothing once `returned` is set. Never touches the VM. Retryable
/// failures (fetch died, push rejected) are recorded in `return_error` and left
/// for the lifecycle tick, mirroring "release pending". The integration rules
/// (fast-forward only a clean, unmoved branch; everything else is Diverged) are
/// in docs/cloud-return-to-branch-spec.md.
fn do_return(mgr: &CloudManager, app: Option<&AppHandle>, record: &mut CloudRunRecord) -> Result<(), String> {
    if record.returned.is_some() {
        return Ok(());
    }
    let Some(state) = record.state().filter(|s| s.is_terminal()) else { return Ok(()) };
    let published = record.result.as_ref().map(|r| r.published && r.result_sha.is_some()).unwrap_or(false);

    // Anything but a completed & published run has no code to integrate.
    if state != RunState::Completed || !published {
        record.returned = Some(ReturnOutcome::ReportedOnly);
        record.return_error = None;
        return persist(mgr, app, record);
    }
    // The fast-forward path needs the remote confirmed first; otherwise a
    // not-yet-pushed branch would look like a divergence. Wait (retried).
    if !record.remote_verified {
        return Ok(());
    }
    let result_sha = record.result.as_ref().and_then(|r| r.result_sha.clone()).ok_or("no result revision")?;
    let source_sha = record.manifest.source.commit_sha.clone();
    let output_branch = record.manifest.output_branch.clone();

    let diverge = |record: &mut CloudRunRecord, reason: String| {
        record.returned = Some(ReturnOutcome::Diverged { reason });
        record.return_error = None;
        persist(mgr, app, record)
    };

    // A run with no source branch (detached HEAD) has nothing to move.
    let Some(branch) = record.source_branch.clone() else {
        return diverge(record, "the run was sent from a detached HEAD; import it for review to merge it yourself.".into());
    };

    let repo = Path::new(&record.repo_path).to_path_buf();
    // Make the result revision local so the ff-only merge can resolve it. The
    // output branch is Powerhouse's own, fetched with its token.
    let auth_env = https_auth_env_for(mgr, &record.manifest.source.remote_url);
    let refspec = format!("+refs/heads/{output_branch}:refs/remotes/origin/{output_branch}");
    if let Err(e) = git_with_env(&repo, &["fetch", "--quiet", "origin", &refspec], &auth_env) {
        record.return_error = Some(format!("return pending: fetch: {e}"));
        return persist(mgr, app, record);
    }

    let Some(worktree) = worktree_for_branch(&repo, &branch) else {
        return diverge(record, format!("branch {branch} is no longer checked out locally; import the result for review to merge it yourself."));
    };

    let head = match git(&worktree, &["rev-parse", "HEAD"]) {
        Ok(h) => h,
        Err(e) => {
            record.return_error = Some(format!("return pending: {e}"));
            return persist(mgr, app, record);
        }
    };
    // Already at the result (a retry after a push failure, or the user pulled
    // it themselves): only the push and cleanup remain.
    if head != result_sha {
        if head != source_sha {
            return diverge(record, format!("your branch moved since the run started (now {}); import the result for review to merge it yourself.", short(&head)));
        }
        let dirty = git(&worktree, &["status", "--porcelain"]).map(|s| !s.trim().is_empty()).unwrap_or(true);
        if dirty {
            return diverge(record, "the branch has uncommitted changes; import the result for review to merge it yourself.".into());
        }
        if git(&worktree, &["merge-base", "--is-ancestor", &source_sha, &result_sha]).is_err() {
            return diverge(record, "the cloud result is not a fast-forward of your branch; import it for review to merge it yourself.".into());
        }
        if let Err(e) = git(&worktree, &["merge", "--ff-only", &result_sha]) {
            return diverge(record, format!("could not fast-forward the branch ({}); import the result for review to merge it yourself.", super::redact_stderr(&e)));
        }
    }
    // Push the moved branch with the user's own credentials (the token is only
    // for Powerhouse's own branches). Never force; a rejection keeps the local
    // fast-forward and is retried by the tick.
    if let Err(e) = git(&worktree, &["push", "origin", &branch]) {
        record.return_error = Some(format!("return pending: push: {}", super::redact_stderr(&e)));
        return persist(mgr, app, record);
    }

    record.returned = Some(ReturnOutcome::FastForwarded { sha: result_sha });
    record.return_error = None;
    persist(mgr, app, record)?;
    // The output branch's commits now live on the source branch; delete it
    // (best effort — the return already succeeded).
    let _ = git_with_env(&repo, &["push", "origin", "--delete", &output_branch], &auth_env);
    Ok(())
}

/// Snapshot a held VM and destroy it. Refuses while the runner reports a live run.
pub fn do_park(mgr: &CloudManager, app: Option<&AppHandle>, run_id: &str) -> Result<CloudRunRecord, String> {
    let _guard = mgr.lifecycle.lock().unwrap();
    let mut record = load(mgr, run_id)?;
    if record.machine != MachineState::Holding {
        return Err(format!("run is {:?}, only held runs can be parked", record.machine));
    }
    let vm = record.task_vm.clone().ok_or("no task VM")?;
    ensure_owned(&vm.name).map_err(|e| e.to_string())?;
    if record.state().map(|s| s.is_live()).unwrap_or(true) || runner_reports_live(mgr.boxd.as_ref(), &vm.name, run_id)? {
        return Err("the run is still live on the VM; cancel it and wait for `cancelled` before parking".into());
    }
    let name = park_snapshot_name(&vm.name);
    let result = (|| -> Result<(), String> {
        // Intent first: a lost `save` acknowledgement is found by name.
        if record.park_snapshot.is_none() {
            record.park_snapshot = Some(SnapshotHandle { name: name.clone(), version: None, size: None });
            persist(mgr, app, &record)?;
        }
        let saved = match mgr.boxd.snapshot_save(&vm.name, &name) {
            Ok(info) => info,
            Err(e) => match wait_snapshot_ready(mgr.boxd.as_ref(), &name) {
                Ok(info) => info,
                Err(_) => return Err(e.to_string()),
            },
        };
        let ready = if saved.is_ready() { saved } else { wait_snapshot_ready(mgr.boxd.as_ref(), &name)? };
        record.park_snapshot = Some(SnapshotHandle { name: name.clone(), version: ready.version.clone(), size: ready.size.clone() });
        record.set_machine(MachineState::Parked, now_ms());
        record.vm_released = false;
        persist(mgr, app, &record)?;
        mgr.boxd.machine_remove(&vm.name).map_err(|e| e.to_string())?;
        record.vm_released = true;
        record.machine_error = None;
        persist(mgr, app, &record)
    })();
    if let Err(e) = result {
        record.machine_error = Some(format!("park: {e}"));
        persist(mgr, app, &record)?;
        return Err(e);
    }
    Ok(record)
}

/// Bring a parked run's workspace back on a fresh VM (held again, timer reset).
pub fn do_restore(mgr: &CloudManager, app: Option<&AppHandle>, run_id: &str) -> Result<CloudRunRecord, String> {
    let _guard = mgr.lifecycle.lock().unwrap();
    let mut record = load(mgr, run_id)?;
    if record.machine != MachineState::Parked {
        return Err(format!("run is {:?}, only parked runs can be restored", record.machine));
    }
    let park = record.park_snapshot.clone().ok_or("no park snapshot recorded")?;
    let vm = record.task_vm.clone().ok_or("no task VM name")?;
    record.set_machine(MachineState::Restoring, now_ms());
    record.machine_error = None;
    persist(mgr, app, &record)?;
    let result = (|| -> Result<(), String> {
        let created = ensure_machine_from_snapshot(mgr.boxd.as_ref(), &vm.name, &park.name, Some(DEFAULT_MACHINE_CEILING))?;
        record.task_vm = Some(VmRef { name: vm.name.clone(), id: created.id.clone() });
        record.vm_released = false;
        persist(mgr, app, &record)?;
        let info = wait_running(mgr.boxd.as_ref(), &vm.name)?;
        record.task_vm = Some(VmRef { name: vm.name.clone(), id: info.id.or(created.id) });
        record.set_machine(MachineState::Holding, now_ms());
        persist(mgr, app, &record)
    })();
    if let Err(e) = result {
        record.machine_error = Some(format!("restore: {e}"));
        // Back to parked: the snapshot is intact; a half-created VM is found by name next time.
        record.set_machine(MachineState::Parked, now_ms());
        persist(mgr, app, &record)?;
        return Err(e);
    }
    Ok(record)
}

/// Discard: remove the VM (if any) and the park snapshot (if any).
pub fn do_release(mgr: &CloudManager, app: Option<&AppHandle>, run_id: &str) -> Result<CloudRunRecord, String> {
    let _guard = mgr.lifecycle.lock().unwrap();
    let mut record = load(mgr, run_id)?;
    if record.machine == MachineState::Unmanaged {
        return Err("this run's machine is not managed by Powerhouse; remove it by hand with `boxd machine remove`".into());
    }
    if record.machine.holds_vm() && !record.vm_released {
        if record.is_active() && record.phase == Phase::Accepted {
            return Err("the run is still active; cancel it first".into());
        }
        if let Some(vm) = record.task_vm.as_ref() {
            if record.phase == Phase::Accepted && runner_reports_live(mgr.boxd.as_ref(), &vm.name, run_id)? {
                return Err("the runner still reports this run live; cancel it and wait for `cancelled`".into());
            }
        }
    }
    let result = (|| -> Result<(), String> {
        release_vm(mgr, app, &mut record)?;
        release_park_snapshot(mgr, app, &mut record)?;
        record.set_machine(MachineState::Released, now_ms());
        record.machine_error = None;
        persist(mgr, app, &record)
    })();
    if let Err(e) = result {
        record.machine_error = Some(format!("discard: {e}"));
        persist(mgr, app, &record)?;
        return Err(e);
    }
    Ok(record)
}

/// Periodic lifecycle work across all records: park due holds, retry pending
/// releases, reconcile lost acknowledgements. Per-record errors are recorded
/// on the card, never propagated. Returns a description of what happened.
pub fn do_lifecycle_tick(mgr: &CloudManager, app: Option<&AppHandle>) -> Result<Vec<String>, String> {
    let records = mgr.store.lock().unwrap().list();
    let mut actions = vec![];
    let now = now_ms();
    let hold_ms = hold_secs() * 1000;
    for rec in records {
        let id = rec.run_id.clone();
        let note = |s: &str| format!("{}: {s}", short(&id));
        // Return the result to the branch/chat if a terminal run still needs it
        // (a push that was rejected, or the app was closed when it finished).
        // Idempotent and independent of the VM lifecycle below.
        if rec.phase == Phase::Accepted
            && rec.machine != MachineState::Unmanaged
            && rec.returned.is_none()
            && rec.state().map(|s| s.is_terminal()).unwrap_or(false)
        {
            let _guard = mgr.lifecycle.lock().unwrap();
            if let Ok(mut r) = load(mgr, &id) {
                if r.returned.is_none() {
                    let _ = do_return(mgr, app, &mut r);
                    match &r.returned {
                        Some(ReturnOutcome::FastForwarded { sha }) => actions.push(note(&format!("returned: fast-forwarded to {}", short(sha)))),
                        Some(ReturnOutcome::Diverged { .. }) => actions.push(note("returned: diverged, review needed")),
                        Some(ReturnOutcome::ReportedOnly) => actions.push(note("returned: reported to chat")),
                        None => {}
                    }
                }
            }
        }
        match rec.machine {
            MachineState::Unmanaged | MachineState::Restoring => {}
            MachineState::Provisioning | MachineState::Active => {
                if rec.phase == Phase::SubmitFailed && !rec.vm_released {
                    let _guard = mgr.lifecycle.lock().unwrap();
                    let mut r = rec.clone();
                    match release_vm(mgr, app, &mut r) {
                        Ok(()) => actions.push(note("released after failed submission")),
                        Err(e) => {
                            r.machine_error = Some(e);
                            let _ = persist(mgr, app, &r);
                        }
                    }
                } else if rec.phase == Phase::Accepted && rec.state().map(|s| s.is_terminal()).unwrap_or(false) {
                    if let Ok(r) = do_sync(mgr, app, &rec.run_id, false) {
                        if r.machine != rec.machine {
                            actions.push(note(&format!("now {:?}", r.machine)));
                        }
                    }
                }
            }
            MachineState::Holding => {
                if now.saturating_sub(rec.machine_changed_ms) >= hold_ms {
                    match do_park(mgr, app, &rec.run_id) {
                        Ok(_) => actions.push(note("parked")),
                        Err(e) => actions.push(note(&format!("park failed: {e}"))),
                    }
                }
            }
            MachineState::Parked | MachineState::Released => {
                let _guard = mgr.lifecycle.lock().unwrap();
                let mut r = rec.clone();
                if !r.vm_released {
                    match release_vm(mgr, app, &mut r) {
                        Ok(()) => actions.push(note("removed VM after lost acknowledgement")),
                        Err(e) => {
                            r.machine_error = Some(e);
                            let _ = persist(mgr, app, &r);
                        }
                    }
                }
                if r.machine == MachineState::Released && r.park_snapshot.is_some() {
                    match release_park_snapshot(mgr, app, &mut r) {
                        Ok(()) => actions.push(note("removed park snapshot")),
                        Err(e) => {
                            r.machine_error = Some(e);
                            let _ = persist(mgr, app, &r);
                        }
                    }
                }
            }
        }
    }
    Ok(actions)
}

// --- sync ---------------------------------------------------------------------

/// Pull authoritative state for one record. Never re-submits. Parked and
/// released runs are served from the local cache (there is no VM to ask).
pub fn do_sync(mgr: &CloudManager, app: Option<&AppHandle>, run_id: &str, force_events: bool) -> Result<CloudRunRecord, String> {
    let boxd = mgr.boxd.clone();
    let mut record = load(mgr, run_id)?;
    let Some(vm) = record.task_vm.clone() else {
        // Never reached a VM: the submission cannot have happened.
        if record.phase != Phase::SubmitFailed {
            record.phase = Phase::SubmitFailed;
            record.phase_detail = Some("Submission was interrupted before a cloud environment existed.".into());
            record.machine = MachineState::Released;
            record.vm_released = true;
            persist(mgr, app, &record)?;
        }
        return Ok(record);
    };
    if matches!(record.machine, MachineState::Parked | MachineState::Released) || (record.machine != MachineState::Unmanaged && record.vm_released) {
        record.last_sync_ms = Some(now_ms());
        persist(mgr, app, &record)?;
        return Ok(record);
    }
    let sync_result = (|| -> Result<(), String> {
        let snap: RunSnapshot = match runner_call(boxd.as_ref(), &vm.name, &["inspect", run_id], Duration::from_secs(60)) {
            Ok(s) => s,
            Err(e) if e.contains("(not_found)") => {
                if record.phase != Phase::Accepted {
                    record.phase = Phase::SubmitFailed;
                    record.phase_detail = Some("The runner has no record of this run; the submission never completed.".into());
                    return Ok(());
                }
                return Err(e);
            }
            Err(e) => return Err(e),
        };
        if record.phase != Phase::Accepted {
            record.phase = Phase::Accepted;
            record.phase_detail = None;
            record.receipt.get_or_insert(Receipt {
                run_id: run_id.to_string(),
                manifest_digest: snap.manifest_digest.clone(),
                state: snap.state,
                event_cursor: 0,
                accepted_at_ms: snap.accepted_at_ms,
                duplicate: true,
            });
        }
        let result_available = snap.result_available;
        let terminal = snap.state.is_terminal();
        let high_water = snap.last_event_seq;
        record.merge_snapshot(snap);
        // Bounded event catch-up; missing pages are retried next sync.
        let mut pages = 0;
        while (force_events || record.event_cursor < high_water) && pages < 5 {
            let after = record.event_cursor.to_string();
            let page: EventPage = runner_call(boxd.as_ref(), &vm.name, &["events", run_id, "--after", &after, "--limit", "200"], Duration::from_secs(60))?;
            let more = page.has_more;
            record.merge_events(page.events);
            pages += 1;
            if !more {
                break;
            }
        }
        if terminal && result_available && record.result.is_none() {
            let res: ResultManifest = runner_call(boxd.as_ref(), &vm.name, &["result", run_id], Duration::from_secs(60))?;
            record.result = Some(res);
        }
        Ok(())
    })();
    record.last_sync_ms = Some(now_ms());
    record.last_sync_error = sync_result.as_ref().err().cloned();
    persist(mgr, app, &record)?;
    if sync_result.is_ok() {
        let _guard = mgr.lifecycle.lock().unwrap();
        let outcome = if record.phase == Phase::SubmitFailed && record.machine.holds_vm() && !record.vm_released {
            release_vm(mgr, app, &mut record)
        } else {
            advance_after_terminal(mgr, app, &mut record)
        };
        if let Err(e) = outcome {
            record.machine_error = Some(e);
            persist(mgr, app, &record)?;
        }
    }
    Ok(record)
}

pub fn do_cancel(mgr: &CloudManager, app: Option<&AppHandle>, run_id: &str) -> Result<CloudRunRecord, String> {
    let boxd = mgr.boxd.clone();
    let record = load(mgr, run_id)?;
    let vm = record.task_vm.clone().ok_or("this run never reached a cloud VM; nothing to cancel")?;
    if record.vm_released {
        return Err("this run's VM is gone; nothing to cancel".into());
    }
    let _snap: RunSnapshot = runner_call(boxd.as_ref(), &vm.name, &["cancel", run_id], Duration::from_secs(60))?;
    do_sync(mgr, app, run_id, false)
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ImportResult {
    pub worktree_path: String,
    pub branch: String,
    pub result_sha: String,
}

/// Fetch the published branch, verify it is the recorded revision, and create
/// a fresh local worktree for review. Never touches existing worktrees. A
/// completed run whose VM is still up is released after a successful import.
pub fn do_import(mgr: &CloudManager, app: Option<&AppHandle>, run_id: &str) -> Result<ImportResult, String> {
    let mut record = load(mgr, run_id)?;
    let result = record.result.clone().ok_or("this run has no result yet")?;
    if !result.published {
        return Err(result.publish_error.unwrap_or_else(|| "the result was not published".into()));
    }
    let result_sha = result.result_sha.clone().ok_or("result has no revision")?;
    let repo = Path::new(&record.repo_path);
    let branch = record.manifest.output_branch.clone();
    let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    // Fetch with Powerhouse's own token for HTTPS remotes (header in the
    // environment only), so import works even without a local git helper.
    let auth_env = https_auth_env_for(mgr, &record.manifest.source.remote_url);
    git_with_env(repo, &["fetch", "--quiet", "origin", &refspec], &auth_env)?;
    let remote_sha = git(repo, &["rev-parse", &format!("refs/remotes/origin/{branch}")])?;
    if remote_sha != result_sha {
        return Err(format!(
            "remote branch {branch} is at {} but the run recorded {}. Not importing a different revision.",
            short(&remote_sha),
            short(&result_sha)
        ));
    }
    let local_branch = format!("cloud/{}", short(run_id));
    let path = crate::git::git_create_worktree(record.repo_path.clone(), local_branch.clone(), result_sha.clone())?;
    let head = git(Path::new(&path), &["rev-parse", "HEAD"])?;
    if head != result_sha {
        return Err(format!("new worktree is at {} instead of {}", short(&head), short(&result_sha)));
    }
    record.imported_worktree = Some(path.clone());
    record.remote_verified = true;
    persist(mgr, app, &record)?;
    // The fetch just verified the remote; a completed run has nothing left on
    // its VM once the local cache is complete.
    if record.state() == Some(RunState::Completed) && record.machine.holds_vm() && !record.vm_released {
        let _guard = mgr.lifecycle.lock().unwrap();
        if record.machine == MachineState::Holding {
            record.set_machine(MachineState::Active, now_ms());
        }
        if let Err(e) = advance_after_terminal(mgr, app, &mut record) {
            record.machine_error = Some(e);
            let _ = persist(mgr, app, &record);
        }
    }
    Ok(ImportResult { worktree_path: path, branch: local_branch, result_sha })
}

fn https_auth_env(token: &str) -> Vec<(String, String)> {
    use base64::Engine;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    vec![
        ("GIT_CONFIG_COUNT".into(), "1".into()),
        ("GIT_CONFIG_KEY_0".into(), "http.extraHeader".into()),
        ("GIT_CONFIG_VALUE_0".into(), format!("Authorization: Basic {basic}")),
    ]
}

fn git_with_env(cwd: &Path, args: &[&str], env: &[(String, String)]) -> Result<String, String> {
    let mut cmd = std::process::Command::new(crate::git::GIT);
    cmd.current_dir(cwd).args(args).env("GIT_TERMINAL_PROMPT", "0");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(super::super::cloud::redact_stderr(&String::from_utf8_lossy(&out.stderr)))
    }
}

// --- inventory ------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize)]
pub struct Inventory {
    /// Machines Powerhouse owns (`ph-…`) plus legacy `powerhouse-…` ones.
    pub machines: Vec<MachineInfo>,
    /// Powerhouse snapshots: the base plus any `ph-…` park snapshots.
    pub snapshots: Vec<SnapshotInfo>,
    pub total_machines: usize,
    pub ceiling: usize,
    pub org_slots: usize,
}

pub fn inventory(boxd: &dyn Boxd, base_snapshot: Option<&str>, ceiling: usize) -> Result<Inventory, String> {
    let all = boxd.machine_list().map_err(|e| e.to_string())?;
    let total_machines = all.len();
    let machines = all
        .into_iter()
        .filter(|m| m.name.starts_with(OWNED_PREFIX) || m.name.starts_with("powerhouse-"))
        .collect();
    let snapshots = boxd
        .snapshots_list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| s.name.starts_with(OWNED_PREFIX) || Some(s.name.as_str()) == base_snapshot)
        .collect();
    Ok(Inventory { machines, snapshots, total_machines, ceiling, org_slots: ORG_MACHINE_SLOTS })
}

// --- tauri surface ------------------------------------------------------------

#[tauri::command]
pub fn cloud_list_runs(state: State<CloudManager>) -> Result<Vec<CloudRunRecord>, String> {
    Ok(state.store.lock().unwrap().list())
}

#[tauri::command]
pub async fn cloud_inspect_source(source_path: String) -> Result<SourceInfo, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_source(Path::new(&source_path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_list_snapshots(app: AppHandle) -> Result<Vec<SnapshotInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        mgr.boxd.snapshots_list().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_inventory(app: AppHandle, base_snapshot: Option<String>, ceiling: Option<usize>) -> Result<Inventory, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        inventory(mgr.boxd.as_ref(), base_snapshot.as_deref(), ceiling.unwrap_or(DEFAULT_MACHINE_CEILING))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_submit(app: AppHandle, request: SubmitRequest) -> Result<CloudRunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        do_submit(&mgr, Some(&app), request)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_quick_submit(app: AppHandle, request: QuickSubmitRequest) -> Result<QuickSubmitOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        do_quick_submit(&mgr, Some(&app), request)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_sync(app: AppHandle, run_id: String, force_events: Option<bool>) -> Result<CloudRunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        do_sync(&mgr, Some(&app), &run_id, force_events.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_cancel(app: AppHandle, run_id: String) -> Result<CloudRunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        do_cancel(&mgr, Some(&app), &run_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Discard workspace: remove the run's VM and park snapshot.
#[tauri::command]
pub async fn cloud_release(app: AppHandle, run_id: String) -> Result<CloudRunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        do_release(&mgr, Some(&app), &run_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_restore(app: AppHandle, run_id: String) -> Result<CloudRunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        do_restore(&mgr, Some(&app), &run_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_lifecycle_tick(app: AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        do_lifecycle_tick(&mgr, Some(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The run's diff: from the local cache once the run ended, else live from the VM.
#[tauri::command]
pub async fn cloud_diff(app: AppHandle, run_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        let mut record = load(&mgr, &run_id)?;
        if let Some(meta) = record.diff_cached.clone() {
            let patch = std::fs::read_to_string(diff_cache_path(&mgr, &run_id)).map_err(|e| format!("cached diff unreadable: {e}"))?;
            return Ok(serde_json::json!({ "patch": patch, "truncated": meta.truncated, "bytes": meta.bytes }));
        }
        if record.machine != MachineState::Unmanaged && (record.vm_released || !record.machine.holds_vm()) {
            return Err("the diff was not cached before the VM was released".into());
        }
        cache_diff(&mgr, &mut record)?;
        persist(&mgr, Some(&app), &record)?;
        let meta = record.diff_cached.clone().unwrap();
        let patch = std::fs::read_to_string(diff_cache_path(&mgr, &run_id)).map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "patch": patch, "truncated": meta.truncated, "bytes": meta.bytes }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_import(app: AppHandle, run_id: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        do_import(&mgr, Some(&app), &run_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Status for the remote a run would use, so the form can show which Keychain
/// entry (`github_token`, `github_token:<owner>`, `github_token:<owner>/<repo>`)
/// applies.
#[tauri::command]
pub fn cloud_secret_status(state: State<CloudManager>, remote_url: Option<String>) -> Result<secrets::SecretStatus, String> {
    secrets::status_for(state.secrets.as_ref(), remote_url.as_deref())
}

/// `name` is `claude_oauth_token`, `github_token`, or a scoped
/// `github_token:<owner>[/<repo>]` slot. An empty value clears the entry.
#[tauri::command]
pub fn cloud_set_secret(state: State<CloudManager>, name: String, value: String, remote_url: Option<String>) -> Result<secrets::SecretStatus, String> {
    if !secrets::KNOWN.contains(&name.as_str()) && !secrets::is_github_slot(&name) && !secrets::is_project_env_slot(&name) {
        return Err(format!("unknown secret {name}"));
    }
    if name.len() > 200 || name.chars().any(|c| c.is_whitespace()) {
        return Err("invalid secret name".into());
    }
    if value.trim().is_empty() {
        state.secrets.clear(&name)?;
    } else {
        state.secrets.set(&name, value.trim())?;
    }
    secrets::status_for(state.secrets.as_ref(), remote_url.as_deref())
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct EnvVarStatus {
    pub name: String,
    /// Whether a non-empty value is stored for this repo (values never leave
    /// the Keychain through this command).
    pub set: bool,
}

/// Which of a repo's configured env names have a stored value.
#[tauri::command]
pub fn cloud_project_env_status(state: State<CloudManager>, repo_id: String, names: Vec<String>) -> Result<Vec<EnvVarStatus>, String> {
    names
        .into_iter()
        .map(|name| {
            if !secrets::is_env_var_name(&name) {
                return Err(format!("`{name}` is not a valid environment variable name"));
            }
            let set = state
                .secrets
                .get(&secrets::project_env_slot(&repo_id, &name))?
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            Ok(EnvVarStatus { name, set })
        })
        .collect()
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct HandoffDoc {
    pub path: String,
    pub content: String,
}

/// Newest plan document under `.powerhouse/` in the source directory:
/// `handoff-*.md` (the artifact Powerhouse already produces) or anything with
/// `plan` in the name. Newest by modification time, name as the tie-break;
/// content capped at the brief limit.
fn latest_brief_doc(source_path: &str) -> Option<HandoffDoc> {
    let dir = Path::new(source_path).join(".powerhouse");
    let candidates: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.ends_with(".md") && (n.starts_with("handoff-") || n.contains("plan")))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    let path = candidates.into_iter().max_by_key(|p| {
        let mtime = std::fs::metadata(p).and_then(|m| m.modified()).ok();
        (mtime, p.file_name().map(|n| n.to_os_string()))
    })?;
    let bytes = std::fs::read(&path).ok()?;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_BRIEF_BYTES)]).to_string();
    Some(HandoffDoc { path: path.to_string_lossy().to_string(), content: text })
}

/// The document `latest_brief_doc` would pick, for the form's brief prefill.
#[tauri::command]
pub fn cloud_latest_handoff(source_path: String) -> Result<Option<HandoffDoc>, String> {
    Ok(latest_brief_doc(&source_path))
}

/// Drop the local record. Refuses while the run may still be active (unless
/// forced) and always while boxd still holds a VM or snapshot for it:
/// discard first, so nothing is orphaned.
#[tauri::command]
pub fn cloud_forget(state: State<CloudManager>, run_id: String, force: Option<bool>) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    if let Some(r) = store.get(&run_id) {
        if r.holds_resources() {
            return Err("this run still holds a cloud VM or snapshot. Discard its workspace first so nothing is left behind in boxd.".into());
        }
        if r.is_active() && !force.unwrap_or(false) {
            return Err("this run may still be active in the cloud. Cancel it or wait for it to finish; forgetting it here would not stop it.".into());
        }
    }
    store.remove(&run_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Scripted transport: records calls and answers from tables.
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<String>>,
        machines: Mutex<HashMap<String, MachineInfo>>,
        snapshots: Mutex<HashMap<String, SnapshotInfo>>,
        exec: Mutex<Vec<(String, Result<String, TransportError>)>>, // (arg substring, output)
        /// Answer `submit` with a receipt echoing the digest on the command line.
        echo_submit: bool,
        /// `machine new` times out but the machine appears anyway (lost ack).
        create_timeout_but_exists: bool,
        /// `snapshots save` times out but the snapshot appears anyway (lost ack).
        save_timeout_but_exists: bool,
        /// The base is re-saved right when a machine is created (version drift).
        bump_base_on_create: bool,
    }

    impl Fake {
        fn machine(&self, name: &str, status: &str) {
            self.machines.lock().unwrap().insert(
                name.into(),
                MachineInfo { name: name.into(), id: Some(format!("id-{name}")), status: status.into(), isolated: Some("yes".into()), auto_suspend: Some("off".into()), auto_hibernate: Some("off".into()), source: None },
            );
        }
        fn snapshot(&self, name: &str, version: &str) {
            self.snapshots.lock().unwrap().insert(
                name.into(),
                SnapshotInfo { name: name.into(), version: Some(version.into()), status: "ready".into(), size: Some("8.7G".into()), id: None },
            );
        }
        fn on_exec(&self, needle: &str, out: Result<String, TransportError>) {
            self.exec.lock().unwrap().push((needle.into(), out));
        }
        fn clear_exec(&self, needle: &str) {
            self.exec.lock().unwrap().retain(|(n, _)| n != needle);
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
        fn count(&self, prefix: &str) -> usize {
            self.calls().iter().filter(|c| c.starts_with(prefix)).count()
        }
        fn insert_from_snapshot(&self, name: &str, snapshot: &str) -> MachineInfo {
            let version = self.snapshots.lock().unwrap().get(snapshot).and_then(|s| s.version.clone()).unwrap_or("v1".into());
            let m = MachineInfo { name: name.into(), id: Some(format!("id-{name}")), status: "running".into(), isolated: Some("yes".into()), auto_suspend: Some("off".into()), auto_hibernate: Some("off".into()), source: Some(format!("snapshot/{snapshot}:{}", version.trim_start_matches('v'))) };
            self.machines.lock().unwrap().insert(name.into(), m.clone());
            m
        }
    }

    impl Boxd for Fake {
        fn auth(&self) -> super::super::transport::TResult<serde_json::Value> {
            Ok(serde_json::json!({}))
        }
        fn machine_list(&self) -> super::super::transport::TResult<Vec<MachineInfo>> {
            self.calls.lock().unwrap().push("list".into());
            Ok(self.machines.lock().unwrap().values().cloned().collect())
        }
        fn machine_get(&self, vm: &str) -> super::super::transport::TResult<MachineInfo> {
            self.calls.lock().unwrap().push(format!("get {vm}"));
            self.machines.lock().unwrap().get(vm).cloned().ok_or(TransportError::NotFound(vm.into()))
        }
        fn machine_start(&self, vm: &str) -> super::super::transport::TResult<()> {
            self.calls.lock().unwrap().push(format!("start {vm}"));
            Ok(())
        }
        fn machine_new_from_snapshot(&self, name: &str, snapshot: &str, isolated: bool, s: u64, h: u64) -> super::super::transport::TResult<MachineInfo> {
            ensure_owned(name)?;
            self.calls.lock().unwrap().push(format!("new {name} from {snapshot} iso={isolated} {s}/{h}"));
            if !self.snapshots.lock().unwrap().contains_key(snapshot) {
                return Err(TransportError::NotFound(format!("snapshot {snapshot}")));
            }
            if self.bump_base_on_create {
                self.snapshot(snapshot, "v2");
            }
            let mut m = self.insert_from_snapshot(name, snapshot);
            if self.create_timeout_but_exists {
                return Err(TransportError::Timeout("machine new".into()));
            }
            m.status = "starting".into();
            Ok(m)
        }
        fn machine_remove(&self, vm: &str) -> super::super::transport::TResult<()> {
            ensure_owned(vm)?;
            self.calls.lock().unwrap().push(format!("remove {vm}"));
            self.machines.lock().unwrap().remove(vm).map(|_| ()).ok_or(TransportError::NotFound(vm.into()))
        }
        fn config_set(&self, vm: &str, key: &str, value: &str) -> super::super::transport::TResult<()> {
            self.calls.lock().unwrap().push(format!("config {vm} {key}={value}"));
            Ok(())
        }
        fn cp_to(&self, _local: &Path, vm: &str, remote: &str) -> super::super::transport::TResult<()> {
            self.calls.lock().unwrap().push(format!("cp {vm} {remote}"));
            Ok(())
        }
        fn exec(&self, vm: &str, argv: &[String], _t: Duration) -> super::super::transport::TResult<super::super::transport::ExecOutput> {
            let joined = argv.join(" ");
            self.calls.lock().unwrap().push(format!("exec {vm} {joined}"));
            if !self.machines.lock().unwrap().contains_key(vm) {
                return Err(TransportError::NotFound(vm.into()));
            }
            if self.echo_submit {
                if let Some(i) = argv.iter().position(|a| a == "--expect-digest") {
                    let digest = argv[i + 1].clone();
                    let run_id = argv[argv.iter().position(|a| a == "--manifest").unwrap() + 1].trim_start_matches("/home/boxd/powerhouse-").trim_end_matches(".json").to_string();
                    return Ok(super::super::transport::ExecOutput { output: serde_json::json!({"ok": {"run_id": run_id, "manifest_digest": digest, "state": "accepted", "event_cursor": 1, "accepted_at_ms": 5, "duplicate": false}}).to_string(), exit_code: 0 });
                }
            }
            let table = self.exec.lock().unwrap();
            for (needle, out) in table.iter() {
                if joined.contains(needle.as_str()) {
                    return out.clone().map(|o| super::super::transport::ExecOutput { output: o, exit_code: 0 });
                }
            }
            Err(TransportError::Other(format!("unscripted exec: {joined}")))
        }
        fn snapshots_list(&self) -> super::super::transport::TResult<Vec<SnapshotInfo>> {
            self.calls.lock().unwrap().push("snaplist".into());
            Ok(self.snapshots.lock().unwrap().values().cloned().collect())
        }
        fn snapshot_save(&self, vm: &str, name: &str) -> super::super::transport::TResult<SnapshotInfo> {
            self.calls.lock().unwrap().push(format!("snapsave {vm} {name}"));
            if !self.machines.lock().unwrap().contains_key(vm) {
                return Err(TransportError::NotFound(vm.into()));
            }
            let mut snaps = self.snapshots.lock().unwrap();
            let next = snaps.get(name).and_then(|s| s.version.as_deref()).and_then(|v| v.trim_start_matches('v').parse::<u64>().ok()).unwrap_or(0) + 1;
            let info = SnapshotInfo { name: name.into(), version: Some(format!("v{next}")), status: "ready".into(), size: Some("8.8G".into()), id: Some("snap_x".into()) };
            snaps.insert(name.into(), info.clone());
            if self.save_timeout_but_exists {
                return Err(TransportError::Timeout("snapshots save".into()));
            }
            Ok(info)
        }
        fn snapshot_remove(&self, name: &str) -> super::super::transport::TResult<()> {
            ensure_owned(name)?;
            self.calls.lock().unwrap().push(format!("snaprm {name}"));
            self.snapshots.lock().unwrap().remove(name).map(|_| ()).ok_or(TransportError::NotFound(name.into()))
        }
    }

    fn probe_json() -> String {
        serde_json::json!({"ok": {"protocol_version": PROTOCOL_VERSION, "runner_version": "0.1.0", "agents": ["claude","fake"], "os": "Linux", "arch": "x86_64", "systemd": true, "cgroup_v2": true, "agent_user_ready": true, "store_ready": true, "claude_version": null, "git_version": "git", "ambient_secret_names": [], "pending_credentials": 0}}).to_string()
    }

    fn snap_json(run_id: &str, state: &str, updated: u64, seq: u64, unit_active: bool) -> String {
        serde_json::json!({"ok": {"run_id": run_id, "manifest_digest": "d", "state": state, "stage": null, "last_event_seq": seq, "accepted_at_ms": 1, "updated_at_ms": updated, "cancel_requested": false, "result_available": state != "running" && state != "accepted", "unit_active": unit_active}}).to_string()
    }

    fn snapshot_of(run_id: &str, state: &str) -> RunSnapshot {
        serde_json::from_str::<Response<RunSnapshot>>(&snap_json(run_id, state, 1, 1, false)).unwrap().into_result().unwrap()
    }

    fn events_json(run_id: &str, seqs: &[u64]) -> String {
        let events: Vec<_> = seqs.iter().map(|s| serde_json::json!({"seq": s, "ts_ms": s, "kind": "run.stage", "payload": null})).collect();
        serde_json::json!({"ok": {"run_id": run_id, "events": events, "next_after": seqs.last().copied().unwrap_or(0), "has_more": false, "last_event_seq": seqs.last().copied().unwrap_or(0)}}).to_string()
    }

    fn result_json(run_id: &str, sha: Option<&str>, published: bool) -> String {
        serde_json::json!({"ok": {"run_id": run_id, "source_sha": "a", "result_sha": sha, "output_branch": format!("powerhouse/cloud/{run_id}"), "published": published, "checks_configured": false, "checks": [], "tree_changed_after_checks": false, "changed_files": [], "diff_bytes": 0, "diff_truncated": false, "partial_work_preserved": true}}).to_string()
    }

    fn diff_json() -> String {
        serde_json::json!({"ok": {"patch": "diff --git a/x b/x\n", "truncated": false, "bytes": 20}}).to_string()
    }

    fn mem_secrets(claude: bool, github: bool) -> Arc<secrets::MemoryStore> {
        let m = secrets::MemoryStore::default();
        if claude { m.set(secrets::CLAUDE_OAUTH, "sk-ant-oat-test").unwrap(); }
        if github { m.set(secrets::GITHUB_TOKEN, "github_pat_test").unwrap(); }
        Arc::new(m)
    }

    /// Bare remote + work clone. `https_origin` swaps the origin URL for a
    /// credential-free https one after the push (the fetch then fails quietly).
    fn temp_repo_with(https_origin: bool) -> (tempfile::TempDir, String, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.git");
        let work = dir.path().join("work");
        std::process::Command::new("git").args(["init", "-q", "--bare"]).arg(&remote).output().unwrap();
        std::process::Command::new("git").args(["init", "-q", "-b", "main"]).arg(&work).output().unwrap();
        std::fs::write(work.join("a.txt"), "a").unwrap();
        for args in [vec!["add", "."], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]] {
            std::process::Command::new("git").arg("-C").arg(&work).args(&args).output().unwrap();
        }
        std::process::Command::new("git").arg("-C").arg(&work).args(["remote", "add", "origin"]).arg(&remote).output().unwrap();
        std::process::Command::new("git").arg("-C").arg(&work).args(["push", "-q", "origin", "main"]).output().unwrap();
        if https_origin {
            let remote_url = format!("https://example.invalid/{}", remote.file_name().unwrap().to_string_lossy());
            std::process::Command::new("git").arg("-C").arg(&work).args(["remote", "set-url", "origin", &remote_url]).output().unwrap();
        }
        (dir, work.to_string_lossy().to_string(), remote)
    }

    fn temp_repo() -> (tempfile::TempDir, String) {
        let (d, w, _) = temp_repo_with(true);
        (d, w)
    }

    fn head_sha(work: &str) -> String {
        git(Path::new(work), &["rev-parse", "HEAD"]).unwrap()
    }

    /// Publish `powerhouse/cloud/<run_id>` at HEAD on the bare remote.
    fn publish_branch(work: &str, run_id: &str) {
        let branch = format!("HEAD:refs/heads/powerhouse/cloud/{run_id}");
        let out = std::process::Command::new("git").arg("-C").arg(work).args(["push", "-q", "origin", &branch]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    fn request(source: &str, base: &str) -> SubmitRequest {
        SubmitRequest {
            repo_id: "repo".into(), repo_path: source.into(), repo_name: "work".into(), source_path: source.into(),
            task: "do the thing".into(), acceptance_criteria: vec![], base_snapshot: base.into(), base_snapshot_version: None,
            machine_ceiling: None, checks: vec![],
            deadline_seconds: 900, permission_mode: "dontAsk".into(), allowed_tools: vec![], max_turns: None,
            max_budget_usd: None, model: None, provider: "fake".into(), fake_script: Some("complete".into()),
            brief: "# Plan\n1. add file".into(), env_names: vec![], chat_id: None,
        }
    }

    fn manager(fake: Arc<Fake>, dir: &Path) -> CloudManager {
        CloudManager::with(CloudStore::open(dir.join("cloud-runs.json")), fake, mem_secrets(true, true))
    }

    fn base_fake() -> Arc<Fake> {
        let fake = Arc::new(Fake::default());
        fake.snapshot("ph-test-base", "v1");
        fake
    }

    /// An accepted record on VM `ph-<run8>` whose repo is a real local clone.
    fn accepted_record(work: &str, run_id: &str) -> CloudRunRecord {
        let mut rec = super::super::store::tests_support::record_with_vm(run_id, &task_vm_name(None, run_id));
        rec.phase = Phase::Accepted;
        rec.repo_path = work.to_string();
        rec.manifest.source.remote_url = "file-remote".into();
        rec
    }

    fn git_commit(work: &str, msg: &str) -> String {
        for args in [vec!["add", "-A"], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg]] {
            std::process::Command::new("git").arg("-C").arg(work).args(&args).output().unwrap();
        }
        head_sha(work)
    }

    /// A completed, published run whose result branch is on the remote: `main`
    /// is back at the source commit locally, the result is one commit ahead.
    /// The record is on VM `ph-main` for source branch `main`.
    fn completed_return_setup(work: &str, run_id: &str, fake: &Fake) -> (String, String, CloudRunRecord) {
        let source_sha = head_sha(work);
        std::fs::write(Path::new(work).join("cloud.txt"), "from cloud").unwrap();
        let result_sha = git_commit(work, "cloud work");
        publish_branch(work, run_id);
        std::process::Command::new("git").arg("-C").arg(work).args(["reset", "--hard", &source_sha]).output().unwrap();
        let vm = task_vm_name(Some("main"), run_id);
        fake.machine(&vm, "running");
        let mut rec = accepted_record(work, run_id);
        rec.task_vm = Some(VmRef { name: vm, id: None });
        rec.source_branch = Some("main".into());
        rec.manifest.source.commit_sha = source_sha.clone();
        rec.manifest.source.source_branch = Some("main".into());
        (source_sha, result_sha, rec)
    }

    fn branch_missing(remote: &Path, run_id: &str) -> bool {
        git(remote, &["rev-parse", "--verify", "-q", &format!("refs/heads/powerhouse/cloud/{run_id}")]).is_err()
    }

    // --- submission -------------------------------------------------------------

    #[test]
    fn dirty_or_unpushed_source_is_rejected_before_any_cloud_call() {
        let (dir, work) = temp_repo();
        std::fs::write(Path::new(&work).join("b.txt"), "dirty").unwrap();
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let err = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap_err();
        assert!(err.contains("uncommitted"), "{err}");
        assert!(fake.calls().is_empty());
        assert!(mgr.store.lock().unwrap().list().is_empty());
    }

    #[test]
    fn missing_base_snapshot_is_refused_before_any_record() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake::default());
        let mgr = manager(fake.clone(), dir.path());
        let err = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert_eq!(fake.calls(), vec!["snaplist"]);
        assert!(mgr.store.lock().unwrap().list().is_empty());
    }

    #[test]
    fn snapshot_version_drift_between_form_and_submit_is_refused() {
        let (dir, work) = temp_repo();
        let fake = base_fake();
        fake.snapshot("ph-test-base", "v2");
        let mgr = manager(fake.clone(), dir.path());
        let mut req = request(&work, "ph-test-base");
        req.base_snapshot_version = Some("v1".into());
        let err = do_submit(&mgr, None, req).unwrap_err();
        assert!(err.contains("now v2") && err.contains("v1"), "{err}");
        assert!(!fake.calls().iter().any(|c| c.starts_with("new ")));
        assert!(mgr.store.lock().unwrap().list().is_empty());
    }

    #[test]
    fn successful_submission_persists_before_each_side_effect_and_ends_accepted() {
        let (dir, work) = temp_repo();
        let fake = base_fake();
        fake.on_exec("probe", Ok(probe_json()));
        fake.on_exec("submit", Ok(serde_json::json!({"ok": {"run_id": "REPLACED", "manifest_digest": "REPLACED", "state": "accepted", "event_cursor": 1, "accepted_at_ms": 5, "duplicate": false}}).to_string()));
        let mgr = manager(fake.clone(), dir.path());
        // The digest cannot be known ahead of time here; the mismatch proves the
        // path up to and including `submit` was taken.
        let err = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap_err();
        assert!(err.contains("different manifest"), "{err}");
        let calls = fake.calls();
        let rec = &mgr.store.lock().unwrap().list()[0];
        let vm = rec.task_vm.as_ref().unwrap().name.clone();
        assert_eq!(vm, "ph-main", "the VM is named for the source branch");
        assert!(calls.iter().any(|c| c.starts_with(&format!("get {vm}"))), "lookup by name before create: {calls:?}");
        assert!(calls.iter().any(|c| c.starts_with(&format!("new {vm} from ph-test-base iso=true 0/0"))), "{calls:?}");
        assert!(calls.iter().any(|c| c.contains("probe")));
        assert!(calls.iter().any(|c| c.starts_with(&format!("cp {vm}"))), "{calls:?}");
        // A rejected receipt is not a lost one: the runner may hold the run,
        // so the VM stays and sync decides.
        assert_eq!(rec.phase, Phase::SubmissionUnknown);
        assert_eq!(rec.machine, MachineState::Active);
        assert!(!rec.vm_released);
        assert_eq!(rec.manifest.workspace.base_snapshot.as_ref().unwrap().version.as_deref(), Some("v1"));
    }

    #[test]
    fn accepted_receipt_with_matching_digest() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake { echo_submit: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v3");
        fake.on_exec("probe", Ok(probe_json()));
        let mgr = manager(fake.clone(), dir.path());
        let mut req = request(&work, "ph-test-base");
        req.base_snapshot_version = Some("v3".into());
        let rec = do_submit(&mgr, None, req).unwrap();
        assert_eq!(rec.phase, Phase::Accepted);
        assert_eq!(rec.machine, MachineState::Active);
        let vm = rec.task_vm.as_ref().unwrap().name.clone();
        assert_eq!(vm, "ph-main");
        assert_eq!(rec.manifest.context.brief_markdown, "# Plan\n1. add file");
        assert_eq!(rec.manifest.workspace.base_snapshot.as_ref().unwrap().name, "ph-test-base");
        assert_eq!(rec.manifest.workspace.base_snapshot.as_ref().unwrap().version.as_deref(), Some("v3"));
        let calls = fake.calls();
        assert!(calls.iter().any(|c| c.starts_with(&format!("cp {vm} /home/boxd/powerhouse-")) && c.ends_with(".creds")), "{calls:?}");
        assert!(calls.iter().any(|c| c.contains("--credentials /home/boxd/powerhouse-")), "{calls:?}");
        assert!(!calls.iter().any(|c| c.starts_with("config ")), "timers were already 0/0 on the snapshot-created machine: {calls:?}");
        assert_eq!(rec.receipt.as_ref().unwrap().manifest_digest, rec.manifest_digest);
        assert_eq!(rec.manifest.output_branch, format!("powerhouse/cloud/{}", rec.run_id));
        let reloaded = CloudStore::open(dir.path().join("cloud-runs.json"));
        assert_eq!(reloaded.list()[0].phase, Phase::Accepted);
    }

    #[test]
    fn missing_powerhouse_credentials_refuse_before_any_cloud_call() {
        let (dir, work) = temp_repo();
        let fake = base_fake();
        fake.on_exec("probe", Ok(probe_json()));
        let mgr = CloudManager::with(CloudStore::open(dir.path().join("cloud-runs.json")), fake.clone(), mem_secrets(false, true));
        let mut req = request(&work, "ph-test-base");
        req.provider = "claude".into();
        req.fake_script = None;
        let err = do_submit(&mgr, None, req).unwrap_err();
        assert!(err.contains("Claude credential"), "{err}");
        assert_eq!(fake.calls(), vec!["snaplist"], "only the snapshot lookup happened");
        assert!(mgr.store.lock().unwrap().list().is_empty());
        let mgr2 = CloudManager::with(CloudStore::open(dir.path().join("cloud-runs2.json")), fake.clone(), mem_secrets(true, false));
        let err = do_submit(&mgr2, None, request(&work, "ph-test-base")).unwrap_err();
        assert!(err.contains("GitHub token"), "{err}");
    }

    #[test]
    fn names_derive_from_the_branch_and_stay_powerhouse_owned() {
        let run_id = "11111111-2222-4333-8444-555555555555";
        // A clean branch maps by plain substitution, no hash suffix.
        assert_eq!(task_vm_name(Some("feat/foo-bar"), run_id), "ph-feat-foo-bar");
        assert_eq!(park_snapshot_name("ph-feat-foo-bar"), "ph-feat-foo-bar-park");
        assert_eq!(task_vm_name(Some("main"), run_id), "ph-main");
        // Detached HEAD falls back to the run id.
        assert_eq!(task_vm_name(None, run_id), "ph-11111111");
        assert_eq!(park_snapshot_name("ph-11111111"), "ph-11111111-park");
        // Case folding, dash collapsing and trimming could collide branches:
        // a deterministic hash suffix keeps them distinct.
        let folded = task_vm_name(Some("Feat/Foo"), run_id);
        assert!(folded.starts_with("ph-feat-foo-") && folded.len() == "ph-feat-foo-".len() + 6, "{folded}");
        assert_ne!(folded, task_vm_name(Some("feat//foo"), run_id));
        assert_eq!(folded, task_vm_name(Some("Feat/Foo"), "another-run-id"), "independent of the run id");
        // Truncation keeps determinism through the hash.
        let long = "feature/a-very-long-branch-name-that-goes-on-and-on";
        let name = task_vm_name(Some(long), run_id);
        assert!(name.len() <= OWNED_PREFIX.len() + SLUG_MAX + 7, "{name}");
        assert_eq!(name, task_vm_name(Some(long), "other"));
        assert_ne!(name, task_vm_name(Some(&format!("{long}-v2")), run_id));
        // A branch with no usable characters still gets a stable name.
        let odd = task_vm_name(Some("///"), run_id);
        assert_eq!(odd.len(), OWNED_PREFIX.len() + 6, "{odd}");
        // Every generated name passes the ownership guard.
        for b in [Some("feat/foo-bar"), Some("Feat/Foo"), Some(long), Some("///"), None] {
            assert!(ensure_owned(&task_vm_name(b, run_id)).is_ok(), "{b:?}");
        }
        assert_eq!(source_snapshot_version(Some("snapshot/powerhouse-base:3")), Some(("powerhouse-base".into(), "v3".into())));
        assert_eq!(source_snapshot_version(Some("fork/powerhouse-cloud-base")), None);
        assert_eq!(source_snapshot_version(None), None);
    }

    #[test]
    fn submission_on_a_feature_branch_uses_the_branch_named_vm() {
        let (dir, work) = temp_repo();
        // Same commit as main (already on the remote), new branch name.
        std::process::Command::new("git").arg("-C").arg(&work).args(["checkout", "-q", "-b", "feat/foo-bar"]).output().unwrap();
        let fake = Arc::new(Fake { echo_submit: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v1");
        fake.on_exec("probe", Ok(probe_json()));
        let mgr = manager(fake.clone(), dir.path());
        let rec = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap();
        assert_eq!(rec.source_branch.as_deref(), Some("feat/foo-bar"));
        assert_eq!(rec.task_vm.as_ref().unwrap().name, "ph-feat-foo-bar");
    }

    #[test]
    fn second_submit_on_the_same_branch_is_refused_while_the_first_holds_resources() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake { echo_submit: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v1");
        fake.on_exec("probe", Ok(probe_json()));
        let mgr = manager(fake.clone(), dir.path());
        let first = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap();
        assert_eq!(first.phase, Phase::Accepted);
        assert!(first.holds_resources());
        // Same branch, VM still held: refused before any cloud side effect.
        let creates_before = fake.count("new ");
        let err = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap_err();
        assert!(err.contains("already in the cloud") && err.contains(&short(&first.run_id)) && err.contains("Discard"), "{err}");
        assert_eq!(fake.count("new "), creates_before, "no second machine was created");
        assert_eq!(mgr.store.lock().unwrap().list().len(), 1, "no second record either");
        // A parked run still blocks the branch (its park snapshot would collide).
        let mut parked = load(&mgr, &first.run_id).unwrap();
        parked.set_machine(MachineState::Parked, now_ms());
        parked.vm_released = true;
        parked.park_snapshot = Some(SnapshotHandle { name: "ph-main-park".into(), version: Some("v1".into()), size: None });
        mgr.store.lock().unwrap().put(parked).unwrap();
        fake.machines.lock().unwrap().clear();
        let err = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap_err();
        assert!(err.contains("parked snapshot"), "{err}");
        // Once discarded, the branch is free again.
        let mut released = load(&mgr, &first.run_id).unwrap();
        released.set_machine(MachineState::Released, now_ms());
        released.park_snapshot = None;
        mgr.store.lock().unwrap().put(released).unwrap();
        let rec = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap();
        assert_eq!(rec.phase, Phase::Accepted);
        assert_eq!(rec.task_vm.as_ref().unwrap().name, "ph-main");
    }

    // --- one-click submission ---------------------------------------------------

    /// Origin fetches over https (so the manifest validates) but pushes to
    /// the local bare remote, so quick submit's push lands somewhere real.
    fn split_push_origin(work: &str, remote: &Path) {
        std::process::Command::new("git").arg("-C").arg(work).args(["remote", "set-url", "origin", "https://example.invalid/remote.git"]).output().unwrap();
        std::process::Command::new("git").arg("-C").arg(work).args(["config", "remote.origin.pushurl"]).arg(remote).output().unwrap();
    }

    fn quick_request(source: &str, base: &str) -> QuickSubmitRequest {
        QuickSubmitRequest {
            repo_id: "repo".into(), repo_path: source.into(), repo_name: "work".into(), source_path: source.into(),
            base_snapshot: base.into(), machine_ceiling: None, checks: vec![], deadline_seconds: 900,
            permission_mode: "dontAsk".into(), allowed_tools: vec![], max_turns: None, max_budget_usd: None,
            model: None, provider: "fake".into(), fake_script: Some("complete".into()), env_names: vec![], chat_id: None,
        }
    }

    #[test]
    fn project_env_values_travel_only_in_the_credentials_file() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake { echo_submit: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v1");
        fake.on_exec("probe", Ok(probe_json()));
        let store = mem_secrets(true, true);
        store.set(&secrets::project_env_slot("repo", "FOO_API_KEY"), "supersecret123").unwrap();
        let mgr = CloudManager::with(CloudStore::open(dir.path().join("cloud-runs.json")), fake.clone(), store);
        let mut req = request(&work, "ph-test-base");
        req.env_names = vec!["FOO_API_KEY".into()];
        let rec = do_submit(&mgr, None, req).unwrap();
        assert_eq!(rec.phase, Phase::Accepted);
        // The credentials file travelled; the value is nowhere in the record
        // or the persisted store.
        assert!(fake.calls().iter().any(|c| c.contains(".creds")), "{:?}", fake.calls());
        let persisted = std::fs::read_to_string(dir.path().join("cloud-runs.json")).unwrap();
        assert!(!persisted.contains("supersecret123"), "env value leaked into the run store");
        assert!(!serde_json::to_string(&rec.manifest).unwrap().contains("supersecret123"), "env value leaked into the manifest");
        // A configured name without a value refuses the submission up front.
        let mut req = request(&work, "ph-test-base");
        req.env_names = vec!["MISSING_KEY".into()];
        let err = do_submit(&mgr, None, req).unwrap_err();
        assert!(err.contains("MISSING_KEY") && err.contains("no value"), "{err}");
    }

    #[test]
    fn quick_submit_checkpoints_pushes_and_uses_the_plan_doc() {
        let (dir, work, remote) = temp_repo_with(false);
        split_push_origin(&work, &remote);
        std::fs::write(Path::new(&work).join("wip.txt"), "unfinished").unwrap();
        std::fs::create_dir_all(Path::new(&work).join(".powerhouse")).unwrap();
        std::fs::write(Path::new(&work).join(".powerhouse").join("handoff-20260922-101010.md"), "# The plan\ndo the thing").unwrap();
        let fake = Arc::new(Fake { echo_submit: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v1");
        fake.on_exec("probe", Ok(probe_json()));
        let mgr = manager(fake.clone(), dir.path());
        let out = do_quick_submit(&mgr, None, quick_request(&work, "ph-test-base")).unwrap();
        let QuickSubmitOutcome::Accepted { record } = out else { panic!("expected accepted: {out:?}") };
        assert_eq!(record.phase, Phase::Accepted);
        assert_eq!(record.task_vm.as_ref().unwrap().name, "ph-main");
        assert_eq!(record.manifest.task.text, QUICK_TASK_TEXT);
        assert_eq!(record.manifest.context.brief_markdown, "# The plan\ndo the thing");
        // The worktree is clean, the WIP commit exists and is on origin.
        assert!(git(Path::new(&work), &["status", "--porcelain"]).unwrap().trim().is_empty());
        assert_eq!(git(Path::new(&work), &["log", "-1", "--format=%s"]).unwrap(), "WIP: send to cloud");
        let head = head_sha(&work);
        assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]).unwrap(), head);
        assert_eq!(record.manifest.source.commit_sha, head);
        // `.powerhouse/` never enters the checkpoint commit.
        assert!(!git(Path::new(&work), &["ls-files"]).unwrap().contains(".powerhouse"), "plan docs stay untracked");
    }

    #[test]
    fn quick_submit_refuses_with_a_structured_reason_before_any_side_effect() {
        let (dir, work) = temp_repo();
        std::fs::write(Path::new(&work).join("wip.txt"), "unfinished").unwrap();
        let fake = base_fake();
        let mgr = CloudManager::with(CloudStore::open(dir.path().join("cloud-runs.json")), fake.clone(), mem_secrets(false, true));
        let mut req = quick_request(&work, "ph-test-base");
        req.provider = "claude".into();
        req.fake_script = None;
        let out = do_quick_submit(&mgr, None, req).unwrap();
        let QuickSubmitOutcome::NeedsAttention { stage, reason } = out else { panic!("expected attention") };
        assert_eq!(stage, "preflight");
        assert!(reason.contains("Claude credential"), "{reason}");
        // No side effects: the worktree is still dirty, nothing was recorded.
        assert!(!git(Path::new(&work), &["status", "--porcelain"]).unwrap().trim().is_empty());
        assert_ne!(git(Path::new(&work), &["log", "-1", "--format=%s"]).unwrap(), "WIP: send to cloud");
        assert!(mgr.store.lock().unwrap().list().is_empty());
        assert_eq!(fake.count("new "), 0);
    }

    #[test]
    fn quick_submit_without_a_plan_doc_generates_a_stub_brief() {
        let (dir, work, remote) = temp_repo_with(false);
        split_push_origin(&work, &remote);
        let fake = Arc::new(Fake { echo_submit: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v1");
        fake.on_exec("probe", Ok(probe_json()));
        let mgr = manager(fake.clone(), dir.path());
        let out = do_quick_submit(&mgr, None, quick_request(&work, "ph-test-base")).unwrap();
        let QuickSubmitOutcome::Accepted { record } = out else { panic!("{out:?}") };
        let brief = &record.manifest.context.brief_markdown;
        assert!(brief.contains("Recent commits") && brief.contains("init"), "{brief}");
    }

    #[test]
    fn quick_submit_second_click_points_at_the_live_run() {
        let (dir, work, remote) = temp_repo_with(false);
        split_push_origin(&work, &remote);
        let fake = Arc::new(Fake { echo_submit: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v1");
        fake.on_exec("probe", Ok(probe_json()));
        let mgr = manager(fake.clone(), dir.path());
        let QuickSubmitOutcome::Accepted { record } = do_quick_submit(&mgr, None, quick_request(&work, "ph-test-base")).unwrap() else {
            panic!("first submit should be accepted")
        };
        let out = do_quick_submit(&mgr, None, quick_request(&work, "ph-test-base")).unwrap();
        let QuickSubmitOutcome::NeedsAttention { stage, reason } = out else { panic!("{out:?}") };
        assert_eq!(stage, "preflight");
        assert!(reason.contains("already in the cloud") && reason.contains(&short(&record.run_id)), "{reason}");
    }

    #[test]
    fn quick_submit_on_a_detached_head_needs_attention() {
        let (dir, work, _remote) = temp_repo_with(false);
        let sha = head_sha(&work);
        std::process::Command::new("git").arg("-C").arg(&work).args(["checkout", "-q", &sha]).output().unwrap();
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let QuickSubmitOutcome::NeedsAttention { stage, reason } = do_quick_submit(&mgr, None, quick_request(&work, "ph-test-base")).unwrap() else {
            panic!("expected attention")
        };
        assert_eq!(stage, "preflight");
        assert!(reason.contains("detached"), "{reason}");
        assert!(fake.calls().is_empty(), "refused before any cloud call");
    }

    #[test]
    fn quick_submit_surfaces_push_failures_verbatim() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        std::process::Command::new("git").arg("-C").arg(&work).args(["remote", "set-url", "origin", "/nonexistent/remote.git"]).output().unwrap();
        let QuickSubmitOutcome::NeedsAttention { stage, reason } = do_quick_submit(&mgr, None, quick_request(&work, "ph-test-base")).unwrap() else {
            panic!("expected attention")
        };
        assert_eq!(stage, "push");
        assert!(reason.contains("git push failed"), "{reason}");
        assert!(mgr.store.lock().unwrap().list().is_empty());
    }

    #[test]
    fn park_uses_the_stored_vm_name_never_a_recomputed_one() {
        // A record whose stored VM name does not match what today's naming
        // would produce (e.g. created before a rename): park must derive the
        // snapshot from the record, not recompute from branch or run id.
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        fake.machine("ph-legacy-name", "running");
        let mut rec = accepted_record(&work, run_id);
        rec.task_vm = Some(VmRef { name: "ph-legacy-name".into(), id: None });
        rec.source_branch = Some("feat/foo-bar".into());
        rec.machine = MachineState::Holding;
        rec.machine_changed_ms = 1;
        rec.snapshot = Some(snapshot_of(run_id, "failed"));
        mgr.store.lock().unwrap().put(rec).unwrap();
        fake.on_exec("inspect", Ok(snap_json(run_id, "failed", 2, 1, false)));
        let r = do_park(&mgr, None, run_id).unwrap();
        assert_eq!(r.park_snapshot.as_ref().unwrap().name, "ph-legacy-name-park");
        assert!(fake.snapshots.lock().unwrap().contains_key("ph-legacy-name-park"));
        assert!(fake.calls().iter().any(|c| c == "snapsave ph-legacy-name ph-legacy-name-park"), "{:?}", fake.calls());
    }

    #[test]
    fn lost_create_ack_is_reconciled_by_name() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake { echo_submit: true, create_timeout_but_exists: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v1");
        fake.on_exec("probe", Ok(probe_json()));
        let mgr = manager(fake.clone(), dir.path());
        let rec = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap();
        assert_eq!(rec.phase, Phase::Accepted);
        assert_eq!(fake.count("new "), 1, "exactly one create despite the timeout: {:?}", fake.calls());
    }

    #[test]
    fn machine_ceiling_refuses_before_creating() {
        let (dir, work) = temp_repo();
        let fake = base_fake();
        for i in 0..18 {
            fake.machine(&format!("other-{i}"), "running");
        }
        let mgr = manager(fake.clone(), dir.path());
        let err = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap_err();
        assert!(err.contains("18 machines") && err.contains("ceiling is 18"), "{err}");
        assert_eq!(fake.count("new "), 0);
        let rec = &mgr.store.lock().unwrap().list()[0];
        assert_eq!(rec.phase, Phase::SubmitFailed);
        assert_eq!(rec.machine, MachineState::Released);
        assert!(rec.vm_released && !rec.holds_resources());
        // A raised ceiling lets it through.
        fake.on_exec("probe", Ok(probe_json()));
        let mut req = request(&work, "ph-test-base");
        req.machine_ceiling = Some(19);
        let err = do_submit(&mgr, None, req).unwrap_err();
        assert!(!err.contains("ceiling"), "{err}");
        assert_eq!(fake.count("new "), 1);
    }

    #[test]
    fn failed_submission_after_creation_releases_the_vm() {
        let (dir, work) = temp_repo();
        let fake = base_fake();
        fake.on_exec("probe", Ok(serde_json::json!({"ok": {"protocol_version": 99, "runner_version": "0.0.1", "agents": [], "os": "Linux", "arch": "x86_64", "systemd": true, "cgroup_v2": true, "agent_user_ready": true, "store_ready": true, "claude_version": null, "git_version": "git", "ambient_secret_names": [], "pending_credentials": 0}}).to_string()));
        let mgr = manager(fake.clone(), dir.path());
        let err = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap_err();
        assert!(err.contains("protocol 99"), "{err}");
        let rec = &mgr.store.lock().unwrap().list()[0];
        assert_eq!(rec.phase, Phase::SubmitFailed);
        assert_eq!(rec.machine, MachineState::Released);
        assert!(rec.vm_released);
        assert_eq!(fake.count("remove ph-"), 1, "{:?}", fake.calls());
        assert!(fake.machines.lock().unwrap().is_empty(), "no machine left behind");
    }

    #[test]
    fn machine_built_from_a_newer_snapshot_version_is_refused_and_released() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake { bump_base_on_create: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v1");
        let mgr = manager(fake.clone(), dir.path());
        let err = do_submit(&mgr, None, request(&work, "ph-test-base")).unwrap_err();
        assert!(err.contains("built from snapshot ph-test-base v2") && err.contains("recorded v1"), "{err}");
        assert!(fake.machines.lock().unwrap().is_empty(), "the mismatched machine was removed");
        assert_eq!(mgr.store.lock().unwrap().list()[0].machine, MachineState::Released);
    }

    // --- sync and lifecycle -------------------------------------------------------

    #[test]
    fn completed_run_releases_only_after_cache_and_remote_are_verified() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        let vm = task_vm_name(None, run_id);
        fake.machine(&vm, "running");
        mgr.store.lock().unwrap().put(accepted_record(&work, run_id)).unwrap();
        let sha = head_sha(&work);
        // Completed, but the branch is not on the remote yet: hold the release.
        fake.on_exec("inspect", Ok(snap_json(run_id, "completed", 20, 2, false)));
        fake.on_exec("events", Ok(events_json(run_id, &[1, 2])));
        fake.on_exec("result", Ok(result_json(run_id, Some(&sha), true)));
        fake.on_exec("diff", Ok(diff_json()));
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        assert_eq!(r.state(), Some(RunState::Completed));
        assert!(r.diff_cached.is_some());
        assert!(!r.remote_verified);
        assert_eq!(r.machine, MachineState::Active);
        assert!(r.machine_error.as_deref().unwrap().contains("release pending"), "{:?}", r.machine_error);
        assert_eq!(fake.count("remove "), 0);
        assert!(std::fs::read_to_string(mgr.store.lock().unwrap().cache_dir(run_id).join("diff.patch")).unwrap().starts_with("diff --git"));
        // Publish the branch; the next sync verifies and releases exactly once.
        publish_branch(&work, run_id);
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        assert!(r.remote_verified);
        assert_eq!(r.machine, MachineState::Released);
        assert!(r.vm_released && !r.holds_resources());
        assert!(r.machine_error.is_none());
        assert_eq!(fake.count(&format!("remove {vm}")), 1, "{:?}", fake.calls());
        // Later syncs are served from cache and make no calls.
        let before = fake.calls().len();
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        assert_eq!(r.state(), Some(RunState::Completed));
        assert_eq!(fake.calls().len(), before);
        // The diff is still readable after the VM is gone.
        let patch = std::fs::read_to_string(mgr.store.lock().unwrap().cache_dir(run_id).join("diff.patch")).unwrap();
        assert!(patch.contains("diff --git"));
    }

    // --- return to branch -------------------------------------------------------

    #[test]
    fn quick_submit_remembers_the_origin_chat() {
        let (dir, work, remote) = temp_repo_with(false);
        split_push_origin(&work, &remote);
        let fake = Arc::new(Fake { echo_submit: true, ..Default::default() });
        fake.snapshot("ph-test-base", "v1");
        fake.on_exec("probe", Ok(probe_json()));
        let mgr = manager(fake.clone(), dir.path());
        let mut req = quick_request(&work, "ph-test-base");
        req.chat_id = Some("chat-42".into());
        let QuickSubmitOutcome::Accepted { record } = do_quick_submit(&mgr, None, req).unwrap() else {
            panic!("expected accepted")
        };
        assert_eq!(record.origin_chat_id.as_deref(), Some("chat-42"));
    }

    #[test]
    fn completed_run_returns_home_by_fast_forwarding_and_deleting_the_output_branch() {
        let (dir, work, remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        let (source_sha, result_sha, mut rec) = completed_return_setup(&work, run_id, &fake);
        rec.origin_chat_id = Some("chat-1".into());
        mgr.store.lock().unwrap().put(rec).unwrap();
        assert_eq!(head_sha(&work), source_sha);
        fake.on_exec("inspect", Ok(snap_json(run_id, "completed", 20, 2, false)));
        fake.on_exec("events", Ok(events_json(run_id, &[1, 2])));
        fake.on_exec("result", Ok(result_json(run_id, Some(&result_sha), true)));
        fake.on_exec("diff", Ok(diff_json()));
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        assert_eq!(r.returned, Some(ReturnOutcome::FastForwarded { sha: result_sha.clone() }));
        assert!(r.return_error.is_none(), "{:?}", r.return_error);
        assert_eq!(r.origin_chat_id.as_deref(), Some("chat-1"));
        // Local branch and origin both carry the cloud commit now.
        assert_eq!(head_sha(&work), result_sha);
        assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]).unwrap(), result_sha);
        // The output branch is gone from the remote after a clean return.
        assert!(branch_missing(&remote, run_id), "output branch should be deleted");
        // The VM released as usual (return does not block it).
        assert_eq!(r.machine, MachineState::Released);
    }

    #[test]
    fn a_local_commit_during_the_run_diverges_and_leaves_the_branch_untouched() {
        let (dir, work, remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        let (_source_sha, result_sha, rec) = completed_return_setup(&work, run_id, &fake);
        mgr.store.lock().unwrap().put(rec).unwrap();
        // The user commits locally while the run is in flight.
        std::fs::write(Path::new(&work).join("local.txt"), "mine").unwrap();
        let local_head = git_commit(&work, "local work");
        fake.on_exec("inspect", Ok(snap_json(run_id, "completed", 20, 2, false)));
        fake.on_exec("events", Ok(events_json(run_id, &[1, 2])));
        fake.on_exec("result", Ok(result_json(run_id, Some(&result_sha), true)));
        fake.on_exec("diff", Ok(diff_json()));
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        match r.returned {
            Some(ReturnOutcome::Diverged { reason }) => assert!(reason.contains("moved"), "{reason}"),
            other => panic!("expected diverged, got {other:?}"),
        }
        // Branch untouched; the output branch survives for the review import.
        assert_eq!(head_sha(&work), local_head);
        assert!(!branch_missing(&remote, run_id), "output branch kept when diverged");
        assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]).unwrap(), _source_sha);
    }

    #[test]
    fn a_dirty_worktree_diverges_without_moving_the_branch() {
        let (dir, work, remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        let (source_sha, result_sha, rec) = completed_return_setup(&work, run_id, &fake);
        mgr.store.lock().unwrap().put(rec).unwrap();
        std::fs::write(Path::new(&work).join("a.txt"), "uncommitted edit").unwrap();
        fake.on_exec("inspect", Ok(snap_json(run_id, "completed", 20, 2, false)));
        fake.on_exec("events", Ok(events_json(run_id, &[1, 2])));
        fake.on_exec("result", Ok(result_json(run_id, Some(&result_sha), true)));
        fake.on_exec("diff", Ok(diff_json()));
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        match r.returned {
            Some(ReturnOutcome::Diverged { reason }) => assert!(reason.contains("uncommitted"), "{reason}"),
            other => panic!("expected diverged, got {other:?}"),
        }
        assert_eq!(git(Path::new(&work), &["rev-parse", "HEAD"]).unwrap(), source_sha);
        assert!(!branch_missing(&remote, run_id));
    }

    #[test]
    fn a_failed_run_reports_to_chat_without_touching_git() {
        let (dir, work, remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        let vm = task_vm_name(None, run_id);
        fake.machine(&vm, "running");
        let source_sha = head_sha(&work);
        let mut rec = accepted_record(&work, run_id);
        rec.source_branch = Some("main".into());
        rec.origin_chat_id = Some("chat-1".into());
        mgr.store.lock().unwrap().put(rec).unwrap();
        fake.on_exec("inspect", Ok(snap_json(run_id, "failed", 20, 2, false)));
        fake.on_exec("events", Ok(events_json(run_id, &[1, 2])));
        fake.on_exec("result", Ok(result_json(run_id, Some("b"), false)));
        fake.on_exec("diff", Ok(diff_json()));
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        assert_eq!(r.returned, Some(ReturnOutcome::ReportedOnly));
        assert_eq!(r.machine, MachineState::Holding);
        // No integration: branch and origin untouched.
        assert_eq!(head_sha(&work), source_sha);
        assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]).unwrap(), source_sha);
    }

    #[test]
    fn a_run_that_finished_while_the_app_was_closed_returns_on_the_next_tick() {
        let (dir, work, remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        let (_source_sha, result_sha, mut rec) = completed_return_setup(&work, run_id, &fake);
        // The run finished, the VM was already released, but the return never ran.
        rec.snapshot = Some(snapshot_of(run_id, "completed"));
        rec.result = Some(
            serde_json::from_str::<Response<ResultManifest>>(&result_json(run_id, Some(&result_sha), true))
                .unwrap()
                .into_result()
                .unwrap(),
        );
        rec.remote_verified = true;
        rec.diff_cached = Some(DiffMeta { bytes: 1, truncated: false });
        rec.machine = MachineState::Released;
        rec.vm_released = true;
        mgr.store.lock().unwrap().put(rec).unwrap();
        let actions = do_lifecycle_tick(&mgr, None).unwrap();
        assert!(actions.iter().any(|a| a.contains("fast-forwarded")), "{actions:?}");
        let r = load(&mgr, run_id).unwrap();
        assert_eq!(r.returned, Some(ReturnOutcome::FastForwarded { sha: result_sha.clone() }));
        assert_eq!(head_sha(&work), result_sha);
        assert!(branch_missing(&remote, run_id));
    }

    #[test]
    fn completed_run_with_uncached_events_is_not_released_yet() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        fake.machine(&task_vm_name(None, run_id), "running");
        mgr.store.lock().unwrap().put(accepted_record(&work, run_id)).unwrap();
        let sha = head_sha(&work);
        publish_branch(&work, run_id);
        // The runner says 5 events exist but serves only 2 (a lost page).
        fake.on_exec("inspect", Ok(snap_json(run_id, "completed", 20, 5, false)));
        fake.on_exec("events", Ok(events_json(run_id, &[1, 2])));
        fake.on_exec("result", Ok(result_json(run_id, Some(&sha), true)));
        fake.on_exec("diff", Ok(diff_json()));
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        assert_eq!(r.machine, MachineState::Active);
        assert!(r.machine_error.as_deref().unwrap().contains("events cached up to 2 of 5"), "{:?}", r.machine_error);
        assert_eq!(fake.count("remove "), 0);
        // The missing events arrive; the lifecycle tick finishes the release.
        fake.clear_exec("events");
        fake.on_exec("events", Ok(events_json(run_id, &[3, 4, 5])));
        let actions = do_lifecycle_tick(&mgr, None).unwrap();
        assert!(actions.iter().any(|a| a.contains("now Released")), "{actions:?}");
        assert_eq!(fake.count("remove "), 1);
    }

    #[test]
    fn failed_run_holds_then_parks_after_the_hold_period() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        let vm = task_vm_name(None, run_id);
        fake.machine(&vm, "running");
        mgr.store.lock().unwrap().put(accepted_record(&work, run_id)).unwrap();
        fake.on_exec("inspect", Ok(snap_json(run_id, "failed", 20, 2, false)));
        fake.on_exec("events", Ok(events_json(run_id, &[1, 2])));
        fake.on_exec("result", Ok(result_json(run_id, Some("b"), false)));
        fake.on_exec("diff", Ok(diff_json()));
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        assert_eq!(r.state(), Some(RunState::Failed));
        assert_eq!(r.machine, MachineState::Holding);
        assert!(r.diff_cached.is_some(), "partial diff cached while the VM is up");
        assert_eq!(fake.count("remove "), 0);
        // Not due yet: nothing happens.
        let actions = do_lifecycle_tick(&mgr, None).unwrap();
        assert!(actions.is_empty(), "{actions:?}");
        assert_eq!(fake.count("snapsave "), 0);
        // Age the hold past the timer.
        let mut aged = load(&mgr, run_id).unwrap();
        aged.machine_changed_ms = now_ms() - (hold_secs() + 1) * 1000;
        mgr.store.lock().unwrap().put(aged).unwrap();
        let actions = do_lifecycle_tick(&mgr, None).unwrap();
        assert!(actions.iter().any(|a| a.ends_with("parked")), "{actions:?}");
        let r = load(&mgr, run_id).unwrap();
        assert_eq!(r.machine, MachineState::Parked);
        assert!(r.vm_released);
        let park = r.park_snapshot.clone().unwrap();
        assert_eq!(park.name, "ph-11111111-park");
        assert_eq!(park.version.as_deref(), Some("v1"));
        assert!(r.holds_resources());
        let calls = fake.calls();
        let save_at = calls.iter().position(|c| c == &format!("snapsave {vm} ph-11111111-park")).unwrap();
        let remove_at = calls.iter().position(|c| c == &format!("remove {vm}")).unwrap();
        assert!(save_at < remove_at, "snapshot before destroy: {calls:?}");
        assert!(fake.machines.lock().unwrap().is_empty());
        assert!(fake.snapshots.lock().unwrap().contains_key("ph-11111111-park"));
        // Parked runs are served from cache.
        let before = fake.calls().len();
        assert_eq!(do_sync(&mgr, None, run_id, false).unwrap().machine, MachineState::Parked);
        assert_eq!(fake.calls().len(), before);
    }

    #[test]
    fn park_and_discard_are_refused_while_the_runner_reports_the_run_live() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        fake.machine(&task_vm_name(None, run_id), "running");
        let mut rec = accepted_record(&work, run_id);
        rec.machine = MachineState::Holding;
        rec.machine_changed_ms = 1;
        rec.snapshot = Some(snapshot_of(run_id, "cancelled"));
        mgr.store.lock().unwrap().put(rec).unwrap();
        // The runner disagrees: the unit is still active.
        fake.on_exec("inspect", Ok(snap_json(run_id, "cancelled", 2, 1, true)));
        let err = do_park(&mgr, None, run_id).unwrap_err();
        assert!(err.contains("still live"), "{err}");
        assert_eq!(fake.count("snapsave "), 0);
        assert_eq!(fake.count("remove "), 0);
        assert_eq!(load(&mgr, run_id).unwrap().machine, MachineState::Holding);
        let err = do_release(&mgr, None, run_id).unwrap_err();
        assert!(err.contains("still reports"), "{err}");
        assert_eq!(fake.count("remove "), 0);
    }

    #[test]
    fn lost_snapshot_save_ack_is_reconciled_by_name() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = Arc::new(Fake { save_timeout_but_exists: true, ..Default::default() });
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        fake.machine(&task_vm_name(None, run_id), "running");
        let mut rec = accepted_record(&work, run_id);
        rec.machine = MachineState::Holding;
        rec.machine_changed_ms = 1;
        rec.snapshot = Some(snapshot_of(run_id, "failed"));
        mgr.store.lock().unwrap().put(rec).unwrap();
        fake.on_exec("inspect", Ok(snap_json(run_id, "failed", 2, 1, false)));
        let r = do_park(&mgr, None, run_id).unwrap();
        assert_eq!(r.machine, MachineState::Parked);
        assert_eq!(r.park_snapshot.as_ref().unwrap().version.as_deref(), Some("v1"));
        assert_eq!(fake.count("snapsave "), 1);
        assert!(fake.machines.lock().unwrap().is_empty());
    }

    #[test]
    fn restore_recreates_the_vm_from_the_park_snapshot_and_discard_removes_both() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        let vm = task_vm_name(None, run_id);
        fake.snapshot("ph-11111111-park", "v1");
        let mut rec = accepted_record(&work, run_id);
        rec.machine = MachineState::Parked;
        rec.vm_released = true;
        rec.park_snapshot = Some(SnapshotHandle { name: "ph-11111111-park".into(), version: Some("v1".into()), size: Some("8.8G".into()) });
        rec.snapshot = Some(snapshot_of(run_id, "failed"));
        mgr.store.lock().unwrap().put(rec).unwrap();
        assert!(load(&mgr, run_id).unwrap().holds_resources(), "forget must refuse while the snapshot exists");
        let r = do_restore(&mgr, None, run_id).unwrap();
        assert_eq!(r.machine, MachineState::Holding);
        assert!(!r.vm_released);
        assert!(r.park_snapshot.is_some(), "the park snapshot stays until release");
        assert!(fake.calls().iter().any(|c| c == &format!("new {vm} from ph-11111111-park iso=true 0/0")), "{:?}", fake.calls());
        // Discard removes the VM and the snapshot, then nothing is held.
        fake.on_exec("inspect", Ok(snap_json(run_id, "failed", 2, 1, false)));
        let r = do_release(&mgr, None, run_id).unwrap();
        assert_eq!(r.machine, MachineState::Released);
        assert!(r.vm_released && r.park_snapshot.is_none() && !r.holds_resources());
        assert_eq!(fake.count(&format!("remove {vm}")), 1);
        assert_eq!(fake.count("snaprm ph-11111111-park"), 1);
        assert!(fake.machines.lock().unwrap().is_empty() && !fake.snapshots.lock().unwrap().contains_key("ph-11111111-park"));
    }

    #[test]
    fn discard_of_a_held_run_and_lost_remove_ack_reconcile() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        let vm = task_vm_name(None, run_id);
        fake.machine(&vm, "running");
        let mut rec = accepted_record(&work, run_id);
        rec.machine = MachineState::Holding;
        rec.snapshot = Some(snapshot_of(run_id, "cancelled"));
        mgr.store.lock().unwrap().put(rec).unwrap();
        fake.on_exec("inspect", Ok(snap_json(run_id, "cancelled", 2, 1, false)));
        let r = do_release(&mgr, None, run_id).unwrap();
        assert_eq!(r.machine, MachineState::Released);
        assert!(fake.machines.lock().unwrap().is_empty());
        // Simulate a lost `remove` acknowledgement: intent persisted, machine still there.
        fake.machine(&vm, "running");
        let mut r = load(&mgr, run_id).unwrap();
        r.vm_released = false;
        mgr.store.lock().unwrap().put(r).unwrap();
        let actions = do_lifecycle_tick(&mgr, None).unwrap();
        assert!(actions.iter().any(|a| a.contains("lost acknowledgement")), "{actions:?}");
        assert!(fake.machines.lock().unwrap().is_empty());
        assert!(load(&mgr, run_id).unwrap().vm_released);
    }

    #[test]
    fn sync_never_regresses_from_stale_snapshots() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555";
        fake.machine(&task_vm_name(None, run_id), "running");
        mgr.store.lock().unwrap().put(accepted_record(&work, run_id)).unwrap();
        fake.on_exec("events", Ok(events_json(run_id, &[1, 2])));
        fake.on_exec("result", Ok(result_json(run_id, Some("b"), false)));
        fake.on_exec("diff", Ok(diff_json()));
        fake.on_exec("inspect", Ok(snap_json(run_id, "blocked", 20, 2, false)));
        let r = do_sync(&mgr, None, run_id, false).unwrap();
        assert_eq!(r.state(), Some(RunState::Blocked));
        assert_eq!(r.event_cursor, 2);
        assert!(r.result.is_some());
        assert_eq!(r.machine, MachineState::Holding);
        fake.clear_exec("inspect");
        fake.on_exec("inspect", Ok(snap_json(run_id, "running", 5, 2, true)));
        let r2 = do_sync(&mgr, None, run_id, false).unwrap();
        assert_eq!(r2.state(), Some(RunState::Blocked));
        assert_eq!(r2.machine, MachineState::Holding);
    }

    #[test]
    fn sync_keeps_cache_and_reports_transport_errors() {
        let (dir, _work) = temp_repo();
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555".to_string();
        let mut rec = super::super::store::tests_support::record_with_vm(&run_id, "ph-11111111");
        rec.phase = Phase::Accepted;
        rec.snapshot = Some(RunSnapshot { run_id: run_id.clone(), manifest_digest: "d".into(), state: RunState::Running, stage: None, last_event_seq: 3, accepted_at_ms: 1, updated_at_ms: 1, started_at_ms: None, finished_at_ms: None, error: None, cancel_requested: false, result_available: false, unit_active: Some(true) });
        mgr.store.lock().unwrap().put(rec).unwrap();
        // No machine, no exec scripted → transport error.
        let r = do_sync(&mgr, None, &run_id, false).unwrap();
        assert!(r.last_sync_error.is_some());
        assert_eq!(r.state(), Some(RunState::Running));
        assert!(r.is_active());
        assert_eq!(r.machine, MachineState::Active);
        assert_eq!(fake.count("remove "), 0);
    }

    #[test]
    fn forget_refuses_active_runs_and_runs_that_hold_resources() {
        let (dir, _work) = temp_repo();
        let fake = base_fake();
        let mgr = manager(fake, dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555".to_string();
        let mut rec = super::super::store::tests_support::record_with_vm(&run_id, "ph-11111111");
        rec.phase = Phase::Accepted;
        mgr.store.lock().unwrap().put(rec).unwrap();
        let r = load(&mgr, &run_id).unwrap();
        assert!(r.is_active());
        assert!(r.holds_resources(), "an active managed run holds its VM");
        let mut released = r.clone();
        released.machine = MachineState::Released;
        released.vm_released = true;
        assert!(!released.holds_resources());
    }

    #[test]
    fn legacy_unmanaged_records_are_never_touched() {
        let (dir, work, _remote) = temp_repo_with(false);
        let fake = base_fake();
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "49c6291e-290c-49e5-a2d0-4e17f8f8dba9";
        fake.machine("powerhouse-main", "stopped");
        let mut rec = accepted_record(&work, run_id);
        rec.task_vm = Some(VmRef { name: "powerhouse-main".into(), id: None });
        rec.machine = MachineState::Unmanaged;
        rec.snapshot = Some(snapshot_of(run_id, "completed"));
        mgr.store.lock().unwrap().put(rec).unwrap();
        let actions = do_lifecycle_tick(&mgr, None).unwrap();
        assert!(actions.is_empty());
        assert!(do_release(&mgr, None, run_id).unwrap_err().contains("not managed"));
        assert!(do_park(&mgr, None, run_id).is_err());
        assert!(fake.calls().is_empty(), "{:?}", fake.calls());
        assert!(fake.machines.lock().unwrap().contains_key("powerhouse-main"));
    }

    #[test]
    fn inventory_lists_powerhouse_resources_against_the_ceiling() {
        let fake = base_fake();
        fake.machine("ph-aaaaaaaa", "running");
        fake.machine("legal-ai-app", "running");
        fake.machine("powerhouse-main", "stopped");
        fake.snapshot("ph-aaaaaaaa-park", "v1");
        fake.snapshot("golden-copy", "v3");
        let inv = inventory(fake.as_ref(), Some("ph-test-base"), 18).unwrap();
        assert_eq!(inv.total_machines, 3);
        let mut names: Vec<_> = inv.machines.iter().map(|m| m.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["ph-aaaaaaaa", "powerhouse-main"]);
        let mut snaps: Vec<_> = inv.snapshots.iter().map(|s| s.name.clone()).collect();
        snaps.sort();
        assert_eq!(snaps, vec!["ph-aaaaaaaa-park", "ph-test-base"]);
        assert_eq!((inv.ceiling, inv.org_slots), (18, 20));
    }
}

/// Real-cloud end-to-end for the desktop backend. Ignored by default; run with
///   POWERHOUSE_CLOUD_E2E_SNAPSHOT=<base snapshot> POWERHOUSE_CLOUD_E2E_SOURCE=<local repo> \
///   cargo test --manifest-path src-tauri/Cargo.toml cloud_e2e -- --ignored --nocapture
/// The local repo's `origin` must be a remote the task VM can fetch from and
/// push to. Set POWERHOUSE_CLOUD_E2E_SCRIPT=fail (with the fake provider) and
/// POWERHOUSE_CLOUD_HOLD_SECS=30 to exercise hold → park → restore → discard.
#[cfg(test)]
mod e2e {
    use super::*;

    #[test]
    #[ignore]
    fn cloud_e2e_fake_agent_through_desktop_backend() {
        let base = match std::env::var("POWERHOUSE_CLOUD_E2E_SNAPSHOT") {
            Ok(b) => b,
            Err(_) => return,
        };
        let source = std::env::var("POWERHOUSE_CLOUD_E2E_SOURCE").expect("POWERHOUSE_CLOUD_E2E_SOURCE");
        let dir = tempfile::tempdir().unwrap();
        let store_path = std::env::var("POWERHOUSE_CLOUD_E2E_STORE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dir.path().join("cloud-runs.json"));
        let wait_secs: u64 = std::env::var("POWERHOUSE_CLOUD_E2E_WAIT_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
        let fresh = || CloudManager::with(CloudStore::open(store_path.clone()), Arc::new(BoxdCli::default()), Arc::new(secrets::Keychain));
        if let Ok(existing) = std::env::var("POWERHOUSE_CLOUD_E2E_IMPORT") {
            let imported = do_import(&fresh(), None, &existing).expect("import");
            eprintln!("IMPORT OK: {} at {} ({})", imported.branch, imported.worktree_path, imported.result_sha);
            return;
        }
        if let Ok(existing) = std::env::var("POWERHOUSE_CLOUD_E2E_RESUME") {
            let r = do_sync(&fresh(), None, &existing, true).expect("sync");
            eprintln!("RESUME state={:?} machine={:?} events={} err={:?} result={:?}", r.state(), r.machine, r.events.len(), r.last_sync_error, r.result.as_ref().map(|x| (x.result_sha.clone(), x.published)));
            return;
        }
        let mgr = fresh();
        let provider = std::env::var("POWERHOUSE_CLOUD_E2E_PROVIDER").unwrap_or_else(|_| "fake".into());
        let script = std::env::var("POWERHOUSE_CLOUD_E2E_SCRIPT").unwrap_or_else(|_| "slow-complete".into());
        let task = std::env::var("POWERHOUSE_CLOUD_E2E_TASK").unwrap_or_else(|_| "E2E: add CLOUD_RUN.md".into());
        let check = std::env::var("POWERHOUSE_CLOUD_E2E_CHECK").unwrap_or_else(|_| "test -f CLOUD_RUN.md".into());
        let expect_file = std::env::var("POWERHOUSE_CLOUD_E2E_EXPECT_FILE").unwrap_or_else(|_| "CLOUD_RUN.md".into());
        let req = SubmitRequest {
            repo_id: "e2e".into(),
            repo_path: source.clone(),
            repo_name: Path::new(&source).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "e2e".into()),
            source_path: source.clone(),
            task: task.clone(),
            acceptance_criteria: vec![format!("{expect_file} exists and the check passes")],
            base_snapshot: base,
            base_snapshot_version: None,
            machine_ceiling: None,
            checks: vec![CheckSpec { name: "acceptance".into(), command: check }],
            deadline_seconds: 900,
            permission_mode: "acceptEdits".into(),
            allowed_tools: vec!["Read".into(), "Edit".into(), "Write".into(), "Glob".into(), "Grep".into(), "Bash".into()],
            max_turns: Some(30),
            max_budget_usd: Some(1.0),
            model: std::env::var("POWERHOUSE_CLOUD_E2E_MODEL").ok(),
            provider: provider.clone(),
            fake_script: (provider == "fake").then(|| script.clone()),
            brief: format!("# Plan\n\n1. Read the repository layout.\n2. {task}\n3. Make the acceptance check pass: it verifies {expect_file} exists.\n"),
            env_names: vec![],
            chat_id: None,
        };
        let t0 = Instant::now();
        let rec = do_submit(&mgr, None, req).expect("submit");
        eprintln!("accepted run {} on {:?} after {:?} (base {:?})", rec.run_id, rec.task_vm, t0.elapsed(), rec.manifest.workspace.base_snapshot);
        assert_eq!(rec.phase, Phase::Accepted);
        let run_id = rec.run_id.clone();
        let vm = rec.task_vm.clone().unwrap().name;
        drop(mgr);

        // "Close the app": a brand-new manager reloads the receipt from disk and
        // reconciles purely by run id.
        let mgr2 = fresh();
        let deadline = Instant::now() + Duration::from_secs(wait_secs);
        let mut last = None;
        while Instant::now() < deadline {
            let r = do_sync(&mgr2, None, &run_id, false).expect("sync");
            eprintln!("state={:?} machine={:?} events={} cursor={} err={:?} merr={:?}", r.state(), r.machine, r.events.len(), r.event_cursor, r.last_sync_error, r.machine_error);
            let done = r.state().map(|s| s.is_terminal()).unwrap_or(false);
            last = Some(r);
            if done {
                break;
            }
            std::thread::sleep(Duration::from_secs(5));
        }
        let r = last.expect("synced");
        let boxd = BoxdCli::default();
        if script == "fail" {
            // Hold → park → restore → inspect → discard.
            assert_eq!(r.state(), Some(RunState::Failed), "{:?}", r.snapshot);
            assert_eq!(r.machine, MachineState::Holding);
            let deadline = Instant::now() + Duration::from_secs(hold_secs() + 900);
            loop {
                let actions = do_lifecycle_tick(&mgr2, None).expect("tick");
                let r = load(&mgr2, &run_id).unwrap();
                eprintln!("tick: {actions:?} machine={:?} merr={:?}", r.machine, r.machine_error);
                if r.machine == MachineState::Parked {
                    break;
                }
                assert!(Instant::now() < deadline, "not parked in time");
                std::thread::sleep(Duration::from_secs(10));
            }
            let parked = load(&mgr2, &run_id).unwrap();
            assert!(matches!(boxd.machine_get(&vm), Err(TransportError::NotFound(_))), "VM must be gone after park");
            let park = parked.park_snapshot.clone().unwrap();
            assert!(boxd.snapshots_list().unwrap().iter().any(|s| s.name == park.name && s.is_ready()));
            eprintln!("PARKED: snapshot {} {:?} {:?}", park.name, park.version, park.size);
            let t1 = Instant::now();
            let restored = do_restore(&mgr2, None, &run_id).expect("restore");
            eprintln!("RESTORED in {:?}: machine={:?}", t1.elapsed(), restored.machine);
            assert_eq!(restored.machine, MachineState::Holding);
            let snap: RunSnapshot = runner_call(&boxd, &vm, &["inspect", &run_id], Duration::from_secs(60)).expect("runner has the run after restore");
            assert_eq!(snap.state, RunState::Failed);
            let ws = boxd.exec(&vm, &["sudo".into(), "-n".into(), "ls".into(), format!("/var/lib/powerhouse-runner-work/{run_id}")], Duration::from_secs(30)).unwrap();
            eprintln!("workspace after restore: {}", ws.output.trim());
            assert_eq!(ws.exit_code, 0);
            let released = do_release(&mgr2, None, &run_id).expect("discard");
            assert_eq!(released.machine, MachineState::Released);
            assert!(matches!(boxd.machine_get(&vm), Err(TransportError::NotFound(_))));
            assert!(!boxd.snapshots_list().unwrap().iter().any(|s| s.name == park.name));
            eprintln!("E2E PARK/RESTORE/DISCARD OK: run {run_id}");
            return;
        }
        assert_eq!(r.state(), Some(RunState::Completed), "{:?}", r.snapshot);
        let res = r.result.clone().expect("result");
        assert!(res.published);
        assert!(res.changed_files.iter().any(|f| f == &expect_file), "changed files: {:?}", res.changed_files);
        let claims = r.events.iter().filter(|e| e.kind == "run.claimed").count();
        assert_eq!(claims, 1, "exactly one agent execution");
        // Release: the completed run's VM must be gone once the cache is complete.
        let mut r = r;
        let deadline = Instant::now() + Duration::from_secs(120);
        while r.machine != MachineState::Released && Instant::now() < deadline {
            let _ = do_lifecycle_tick(&mgr2, None);
            r = load(&mgr2, &run_id).unwrap();
            eprintln!("release: machine={:?} merr={:?}", r.machine, r.machine_error);
            if r.machine != MachineState::Released {
                std::thread::sleep(Duration::from_secs(5));
            }
        }
        assert_eq!(r.machine, MachineState::Released, "{:?}", r.machine_error);
        assert!(r.vm_released && r.diff_cached.is_some() && r.remote_verified);
        assert!(matches!(boxd.machine_get(&vm), Err(TransportError::NotFound(_))), "VM must be gone after release");
        let ph: Vec<_> = boxd.machine_list().unwrap().into_iter().filter(|m| m.name.starts_with(OWNED_PREFIX)).map(|m| m.name).collect();
        eprintln!("E2E OK: run {} result {:?}; VM {vm} released; remaining ph-* machines: {ph:?}", run_id, res.result_sha);
    }
}
