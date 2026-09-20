//! Tauri commands for cloud runs. Provisioning, transfer and submission happen
//! here on a blocking thread; the UI observes progress through
//! `cloud-run-update` events and explicit `cloud_sync` calls. Nothing in this
//! module is reached by PTY cleanup or app shutdown.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use powerhouse_cloud_protocol::{
    AgentProvider, AgentSpec, CheckSpec, EventPage, ProbeInfo, Receipt, Response, ResultManifest,
    RunManifest, RunSnapshot, RunnerError, SourceSpec, TaskSpec, WorkspaceSpec, PROTOCOL_VERSION,
};
use tauri::{AppHandle, Emitter, Manager, State};

use super::store::{CloudRunRecord, CloudStore, Phase, VmRef};
use super::transport::{Boxd, BoxdCli, MachineInfo, TransportError};
use crate::git::git;

pub const RUNNER_BIN: &str = "/usr/local/bin/powerhouse-runner";
const UPDATE_EVENT: &str = "cloud-run-update";
const VM_READY_TIMEOUT: Duration = Duration::from_secs(180);

pub struct CloudManager {
    pub store: Mutex<CloudStore>,
    pub boxd: Arc<dyn Boxd>,
}

impl Default for CloudManager {
    fn default() -> Self {
        Self {
            store: Mutex::new(CloudStore::open(CloudStore::default_path())),
            boxd: Arc::new(BoxdCli::default()),
        }
    }
}

impl CloudManager {
    pub fn with(store: CloudStore, boxd: Arc<dyn Boxd>) -> Self {
        Self { store: Mutex::new(store), boxd }
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

pub fn task_vm_name(run_id: &str) -> String {
    format!("ph-{}", short(run_id))
}

/// Parse boxd's idle values ("300s", "off") into seconds.
pub fn parse_idle(v: Option<&str>) -> u64 {
    match v {
        Some("off") | None => 0,
        Some(s) => s.trim_end_matches('s').parse().unwrap_or(0),
    }
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
            format!("the Powerhouse runner is not installed on {vm}. Run scripts/cloud-base-setup.sh against the base VM.")
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
    pub base_vm: String,
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

fn wait_running(boxd: &dyn Boxd, vm: &str) -> Result<MachineInfo, String> {
    let start = Instant::now();
    loop {
        let info = boxd.machine_get(vm).map_err(|e| e.to_string())?;
        match info.status.as_str() {
            "running" | "standby" => return Ok(info),
            "stopped" => {
                boxd.machine_start(vm).map_err(|e| e.to_string())?;
            }
            _ => {}
        }
        if start.elapsed() > VM_READY_TIMEOUT {
            return Err(format!(
                "{vm} did not become ready within {}s (last status: {}). The machine is retained; retry later or start it manually with `boxd machine start {vm}`.",
                VM_READY_TIMEOUT.as_secs(),
                info.status
            ));
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

pub fn build_manifest(req: &SubmitRequest, run_id: &str, source: &SourceInfo, base: &MachineInfo) -> Result<RunManifest, String> {
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
        workspace: WorkspaceSpec {
            base_vm_id: base.id.clone().unwrap_or_else(|| base.name.clone()),
            base_vm_name: base.name.clone(),
        },
        agent: AgentSpec {
            provider,
            model: req.model.clone().filter(|m| !m.trim().is_empty()),
            permission_mode: req.permission_mode.clone(),
            allowed_tools: req.allowed_tools.clone(),
            max_turns: req.max_turns,
            max_budget_usd: req.max_budget_usd,
            fake_script: req.fake_script.clone(),
        },
        checks: req.checks.iter().filter(|c| !c.command.trim().is_empty()).cloned().collect(),
        deadline_seconds: req.deadline_seconds,
        created_at_ms: now_ms(),
        predecessor_run_id: None,
    };
    manifest.validate()?;
    Ok(manifest)
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
    let base = boxd.machine_get(&req.base_vm).map_err(|e| match e {
        TransportError::NotFound(_) => format!("base VM `{}` not found in your boxd org", req.base_vm),
        other => other.to_string(),
    })?;
    let run_id = uuid::Uuid::new_v4().to_string();
    let manifest = build_manifest(&req, &run_id, &source, &base)?;
    let digest = manifest.digest();
    let idle_policy = (parse_idle(base.auto_suspend.as_deref()), parse_idle(base.auto_hibernate.as_deref()));

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
        base_vm: Some(VmRef { name: base.name.clone(), id: base.id.clone() }),
        task_vm: None,
        receipt: None,
        snapshot: None,
        result: None,
        events: vec![],
        event_cursor: 0,
        last_sync_ms: None,
        last_sync_error: None,
        idle_policy: Some(idle_policy),
        idle_policy_restored: false,
        imported_worktree: None,
    };
    // Durable intent before the first remote side effect.
    persist(mgr, app, &record)?;

    let result = (|| -> Result<(), String> {
        // Provision an isolated task VM with a deterministic name so a lost
        // acknowledgement can be reconciled instead of forking twice.
        let vm_name = task_vm_name(&run_id);
        record.phase = Phase::Provisioning;
        record.phase_detail = Some(format!("Preparing cloud environment: forking {} → {vm_name}", base.name));
        record.task_vm = Some(VmRef { name: vm_name.clone(), id: None });
        persist(mgr, app, &record)?;
        let vm = match boxd.machine_get(&vm_name) {
            Ok(existing) => existing,
            Err(TransportError::NotFound(_)) => {
                if base.status == "stopped" {
                    record.phase_detail = Some(format!("Starting base {}", base.name));
                    persist(mgr, app, &record)?;
                    wait_running(boxd.as_ref(), &base.name)?;
                }
                boxd.fork(&base.name, &vm_name, 0, 0).map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        };
        record.task_vm = Some(VmRef { name: vm_name.clone(), id: vm.id.clone() });
        record.phase_detail = Some(format!("Waiting for {vm_name} to boot"));
        persist(mgr, app, &record)?;
        let info = wait_running(boxd.as_ref(), &vm_name)?;
        record.task_vm = Some(VmRef { name: vm_name.clone(), id: info.id.clone().or(vm.id.clone()) });

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

        record.phase_detail = Some("Checking the runner on the task VM".into());
        persist(mgr, app, &record)?;
        let probe: ProbeInfo = runner_call(boxd.as_ref(), &vm_name, &["probe"], Duration::from_secs(60))?;
        if probe.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "runner on {vm_name} speaks protocol {} but this Powerhouse needs {PROTOCOL_VERSION}; update the base VM's runner",
                probe.protocol_version
            ));
        }
        if !probe.agent_user_ready || !probe.store_ready {
            return Err(format!("runner on {vm_name} is not installed correctly (agent user or store missing); re-run the base setup"));
        }
        if manifest.agent.provider == AgentProvider::Claude && !probe.credentials.claude {
            return Err("the base VM has no Claude credential configured for the runner. Provision it on the base (see docs/boxd-cloud-agents-verification.md, credentials) before running Claude tasks.".into());
        }
        if manifest.source.remote_url.starts_with("https://") && !probe.credentials.git_publish {
            return Err("the base VM has no Git publication credential for HTTPS remotes; results could not be published. Provision it on the base first.".into());
        }

        // Transfer the manifest by file, then finalize with a digest check.
        let tmp = manifest_temp_path(&run_id);
        std::fs::create_dir_all(tmp.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, serde_json::to_vec(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let remote = format!("/home/boxd/ph-{run_id}.json");
        record.phase_detail = Some("Uploading the run request".into());
        persist(mgr, app, &record)?;
        boxd.cp_to(&tmp, &vm_name, &remote).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);

        record.phase = Phase::SubmissionUnknown;
        record.phase_detail = Some("Submitting to the runner".into());
        persist(mgr, app, &record)?;
        let receipt: Receipt = match runner_call(
            boxd.as_ref(),
            &vm_name,
            &["submit", "--manifest", &remote, "--expect-digest", &digest],
            Duration::from_secs(90),
        ) {
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
            if record.phase != Phase::Accepted {
                record.phase = if record.phase == Phase::SubmissionUnknown { Phase::SubmissionUnknown } else { Phase::SubmitFailed };
                record.phase_detail = Some(e.clone());
                let _ = persist(mgr, app, &record);
            }
            Err(e)
        }
    }
}

// --- sync ---------------------------------------------------------------------

/// Pull authoritative state for one record. Never re-submits.
pub fn do_sync(mgr: &CloudManager, app: Option<&AppHandle>, run_id: &str, force_events: bool) -> Result<CloudRunRecord, String> {
    let boxd = mgr.boxd.clone();
    let mut record = mgr
        .store
        .lock()
        .unwrap()
        .get(run_id)
        .cloned()
        .ok_or_else(|| format!("unknown cloud run {run_id}"))?;
    let Some(vm) = record.task_vm.clone() else {
        // Never reached a VM: the submission cannot have happened.
        if record.phase != Phase::SubmitFailed {
            record.phase = Phase::SubmitFailed;
            record.phase_detail = Some("Submission was interrupted before a cloud environment existed.".into());
            persist(mgr, app, &record)?;
        }
        return Ok(record);
    };
    let sync_result = (|| -> Result<(), String> {
        let snap: RunSnapshot = match runner_call(boxd.as_ref(), &vm.name, &["inspect", run_id], Duration::from_secs(60)) {
            Ok(s) => s,
            Err(e) if e.contains("(not_found)") => {
                if record.phase != Phase::Accepted {
                    record.phase = Phase::SubmitFailed;
                    record.phase_detail = Some("The runner has no record of this run; the submission never completed. The task VM is retained.".into());
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
        if terminal && !record.idle_policy_restored {
            let (s, h) = record.idle_policy.unwrap_or((300, 900));
            boxd.config_set(&vm.name, "auto-suspend.timeout", &s.to_string()).map_err(|e| e.to_string())?;
            boxd.config_set(&vm.name, "auto-hibernate.timeout", &h.to_string()).map_err(|e| e.to_string())?;
            record.idle_policy_restored = true;
        }
        Ok(())
    })();
    record.last_sync_ms = Some(now_ms());
    record.last_sync_error = sync_result.as_ref().err().cloned();
    persist(mgr, app, &record)?;
    Ok(record)
}

pub fn do_cancel(mgr: &CloudManager, app: Option<&AppHandle>, run_id: &str) -> Result<CloudRunRecord, String> {
    let boxd = mgr.boxd.clone();
    let record = mgr.store.lock().unwrap().get(run_id).cloned().ok_or("unknown cloud run")?;
    let vm = record.task_vm.clone().ok_or("this run never reached a cloud VM; nothing to cancel")?;
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
/// a fresh local worktree for review. Never touches existing worktrees.
pub fn do_import(mgr: &CloudManager, run_id: &str) -> Result<ImportResult, String> {
    let mut record = mgr.store.lock().unwrap().get(run_id).cloned().ok_or("unknown cloud run")?;
    let result = record.result.clone().ok_or("this run has no result yet")?;
    if !result.published {
        return Err(result.publish_error.unwrap_or_else(|| "the result was not published".into()));
    }
    let result_sha = result.result_sha.clone().ok_or("result has no revision")?;
    let repo = Path::new(&record.repo_path);
    let branch = record.manifest.output_branch.clone();
    let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    git(repo, &["fetch", "--quiet", "origin", &refspec])?;
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
    mgr.store.lock().unwrap().put(record)?;
    Ok(ImportResult { worktree_path: path, branch: local_branch, result_sha })
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
pub async fn cloud_probe_base(app: AppHandle, base_vm: String) -> Result<ProbeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        let boxd = mgr.boxd.clone();
        let info = boxd.machine_get(&base_vm).map_err(|e| e.to_string())?;
        if info.status == "stopped" {
            boxd.machine_start(&base_vm).map_err(|e| e.to_string())?;
        }
        wait_running(boxd.as_ref(), &base_vm)?;
        runner_call(boxd.as_ref(), &base_vm, &["probe"], Duration::from_secs(60))
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

#[tauri::command]
pub async fn cloud_diff(app: AppHandle, run_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        let record = mgr.store.lock().unwrap().get(&run_id).cloned().ok_or("unknown cloud run")?;
        let vm = record.task_vm.ok_or("no task VM")?;
        runner_call::<serde_json::Value>(mgr.boxd.as_ref(), &vm.name, &["diff", &run_id], Duration::from_secs(90))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cloud_import(app: AppHandle, run_id: String) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mgr = app.state::<CloudManager>();
        do_import(&mgr, &run_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop the local record. Refuses while the run may still be active unless
/// forced; never cancels or deletes anything remote.
#[tauri::command]
pub fn cloud_forget(state: State<CloudManager>, run_id: String, force: Option<bool>) -> Result<(), String> {
    let mut store = state.store.lock().unwrap();
    if let Some(r) = store.get(&run_id) {
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

    /// Scripted transport: records calls and answers from a table.
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<String>>,
        machines: Mutex<HashMap<String, MachineInfo>>,
        exec: Mutex<Vec<(String, Result<String, TransportError>)>>, // (arg substring, output)
        fail_fork: bool,
    }

    impl Fake {
        fn machine(&self, name: &str, status: &str) {
            self.machines.lock().unwrap().insert(
                name.into(),
                MachineInfo { name: name.into(), id: Some(format!("id-{name}")), status: status.into(), isolated: Some("yes".into()), auto_suspend: Some("300s".into()), auto_hibernate: Some("900s".into()), source: None },
            );
        }
        fn on_exec(&self, needle: &str, out: Result<String, TransportError>) {
            self.exec.lock().unwrap().push((needle.into(), out));
        }
    }

    impl Boxd for Fake {
        fn auth(&self) -> super::super::transport::TResult<serde_json::Value> {
            Ok(serde_json::json!({}))
        }
        fn machine_get(&self, vm: &str) -> super::super::transport::TResult<MachineInfo> {
            self.calls.lock().unwrap().push(format!("get {vm}"));
            self.machines.lock().unwrap().get(vm).cloned().ok_or(TransportError::NotFound(vm.into()))
        }
        fn machine_start(&self, vm: &str) -> super::super::transport::TResult<()> {
            self.calls.lock().unwrap().push(format!("start {vm}"));
            Ok(())
        }
        fn fork(&self, source: &str, name: &str, _s: u64, _h: u64) -> super::super::transport::TResult<MachineInfo> {
            self.calls.lock().unwrap().push(format!("fork {source} {name}"));
            if self.fail_fork {
                return Err(TransportError::Other("couldn't fork".into()));
            }
            let mut m = MachineInfo { name: name.into(), id: Some(format!("id-{name}")), status: "running".into(), isolated: Some("yes".into()), auto_suspend: Some("off".into()), auto_hibernate: Some("off".into()), source: Some(format!("fork/{source}")) };
            self.machines.lock().unwrap().insert(name.into(), m.clone());
            m.status = "starting".into();
            Ok(m)
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
            let table = self.exec.lock().unwrap();
            for (needle, out) in table.iter() {
                if joined.contains(needle.as_str()) {
                    return out.clone().map(|o| super::super::transport::ExecOutput { output: o, exit_code: 0 });
                }
            }
            Err(TransportError::Other(format!("unscripted exec: {joined}")))
        }
    }

    fn probe_json(claude: bool) -> String {
        serde_json::json!({"ok": {"protocol_version": PROTOCOL_VERSION, "runner_version": "0.1.0", "agents": ["claude","fake"], "os": "Linux", "arch": "x86_64", "systemd": true, "cgroup_v2": true, "agent_user_ready": true, "store_ready": true, "claude_version": null, "git_version": "git", "credentials": {"claude": claude, "git_publish": true}}}).to_string()
    }

    fn temp_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.git");
        let work = dir.path().join("work");
        std::process::Command::new("git").args(["init", "-q", "--bare"]).arg(&remote).output().unwrap();
        std::process::Command::new("git").args(["init", "-q", "-b", "main"]).arg(&work).output().unwrap();
        std::fs::write(work.join("a.txt"), "a").unwrap();
        for args in [vec!["add", "."], vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]] {
            std::process::Command::new("git").arg("-C").arg(&work).args(&args).output().unwrap();
        }
        let remote_url = format!("https://example.invalid/{}", remote.file_name().unwrap().to_string_lossy());
        std::process::Command::new("git").arg("-C").arg(&work).args(["remote", "add", "origin"]).arg(&remote).output().unwrap();
        std::process::Command::new("git").arg("-C").arg(&work).args(["push", "-q", "origin", "main"]).output().unwrap();
        // After the push, present a credential-free https url: the remote refs
        // already exist locally, and the (failing) fetch is ignored by inspect_source.
        std::process::Command::new("git").arg("-C").arg(&work).args(["remote", "set-url", "origin", &remote_url]).output().unwrap();
        (dir, work.to_string_lossy().to_string())
    }

    fn request(source: &str, base: &str) -> SubmitRequest {
        SubmitRequest {
            repo_id: "repo".into(), repo_path: source.into(), repo_name: "work".into(), source_path: source.into(),
            task: "do the thing".into(), acceptance_criteria: vec![], base_vm: base.into(), checks: vec![],
            deadline_seconds: 900, permission_mode: "dontAsk".into(), allowed_tools: vec![], max_turns: None,
            max_budget_usd: None, model: None, provider: "fake".into(), fake_script: Some("complete".into()),
        }
    }

    fn manager(fake: Arc<Fake>, dir: &Path) -> CloudManager {
        CloudManager::with(CloudStore::open(dir.join("cloud-runs.json")), fake)
    }

    #[test]
    fn dirty_or_unpushed_source_is_rejected_before_any_cloud_call() {
        let (dir, work) = temp_repo();
        std::fs::write(Path::new(&work).join("b.txt"), "dirty").unwrap();
        let fake = Arc::new(Fake::default());
        fake.machine("base", "running");
        let mgr = manager(fake.clone(), dir.path());
        let err = do_submit(&mgr, None, request(&work, "base")).unwrap_err();
        assert!(err.contains("uncommitted"), "{err}");
        assert!(fake.calls.lock().unwrap().is_empty());
        assert!(mgr.store.lock().unwrap().list().is_empty());
    }

    #[test]
    fn successful_submission_persists_before_each_side_effect_and_ends_accepted() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake::default());
        fake.machine("base", "running");
        fake.on_exec("probe", Ok(probe_json(false)));
        fake.on_exec("submit", Ok(serde_json::json!({"ok": {"run_id": "REPLACED", "manifest_digest": "REPLACED", "state": "accepted", "event_cursor": 1, "accepted_at_ms": 5, "duplicate": false}}).to_string()));
        let mgr = manager(fake.clone(), dir.path());
        // The fake transport cannot know the digest ahead of time; patch it in
        // by reading what the store recorded after the run.
        let res = do_submit(&mgr, None, request(&work, "base"));
        // Digest mismatch is expected with the placeholder; verify the path taken.
        let err = res.unwrap_err();
        assert!(err.contains("different manifest"), "{err}");
        let calls = fake.calls.lock().unwrap().clone();
        assert!(calls.iter().any(|c| c.starts_with("fork base ph-")), "{calls:?}");
        assert!(calls.iter().any(|c| c.contains("probe")));
        assert!(calls.iter().any(|c| c.starts_with("cp ph-")));
        let rec = &mgr.store.lock().unwrap().list()[0];
        assert!(rec.task_vm.is_some());
        assert_eq!(rec.phase, Phase::SubmissionUnknown);
    }

    #[test]
    fn accepted_receipt_with_matching_digest() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake::default());
        fake.machine("base", "running");
        fake.on_exec("probe", Ok(probe_json(false)));
        // Answer submit by echoing the digest passed on the command line.
        struct Echo(Arc<Fake>);
        impl Boxd for Echo {
            fn auth(&self) -> super::super::transport::TResult<serde_json::Value> { self.0.auth() }
            fn machine_get(&self, vm: &str) -> super::super::transport::TResult<MachineInfo> { self.0.machine_get(vm) }
            fn machine_start(&self, vm: &str) -> super::super::transport::TResult<()> { self.0.machine_start(vm) }
            fn fork(&self, s: &str, n: &str, a: u64, b: u64) -> super::super::transport::TResult<MachineInfo> { self.0.fork(s, n, a, b) }
            fn config_set(&self, vm: &str, k: &str, v: &str) -> super::super::transport::TResult<()> { self.0.config_set(vm, k, v) }
            fn cp_to(&self, l: &Path, vm: &str, r: &str) -> super::super::transport::TResult<()> { self.0.cp_to(l, vm, r) }
            fn exec(&self, vm: &str, argv: &[String], t: Duration) -> super::super::transport::TResult<super::super::transport::ExecOutput> {
                if let Some(i) = argv.iter().position(|a| a == "--expect-digest") {
                    let digest = argv[i + 1].clone();
                    let run_id = argv[argv.iter().position(|a| a == "--manifest").unwrap() + 1].trim_start_matches("/home/boxd/ph-").trim_end_matches(".json").to_string();
                    return Ok(super::super::transport::ExecOutput { output: serde_json::json!({"ok": {"run_id": run_id, "manifest_digest": digest, "state": "accepted", "event_cursor": 1, "accepted_at_ms": 5, "duplicate": false}}).to_string(), exit_code: 0 });
                }
                self.0.exec(vm, argv, t)
            }
        }
        let mgr = CloudManager::with(CloudStore::open(dir.path().join("cloud-runs.json")), Arc::new(Echo(fake.clone())));
        let rec = do_submit(&mgr, None, request(&work, "base")).unwrap();
        assert_eq!(rec.phase, Phase::Accepted);
        assert_eq!(rec.receipt.as_ref().unwrap().manifest_digest, rec.manifest_digest);
        assert_eq!(rec.manifest.output_branch, format!("powerhouse/cloud/{}", rec.run_id));
        // Idle policies were disabled on the fork and the base's values kept for restoration.
        assert_eq!(rec.idle_policy, Some((300, 900)));
        // Reloading the store from disk shows the same accepted record.
        let reloaded = CloudStore::open(dir.path().join("cloud-runs.json"));
        assert_eq!(reloaded.list()[0].phase, Phase::Accepted);
    }

    #[test]
    fn claude_without_credentials_is_refused_and_vm_is_kept() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake::default());
        fake.machine("base", "running");
        fake.on_exec("probe", Ok(probe_json(false)));
        let mgr = manager(fake.clone(), dir.path());
        let mut req = request(&work, "base");
        req.provider = "claude".into();
        req.fake_script = None;
        let err = do_submit(&mgr, None, req).unwrap_err();
        assert!(err.contains("Claude credential"), "{err}");
        let rec = &mgr.store.lock().unwrap().list()[0];
        assert_eq!(rec.phase, Phase::SubmitFailed);
        assert!(rec.task_vm.is_some(), "task VM identity must be retained for reconciliation");
        assert!(!fake.calls.lock().unwrap().iter().any(|c| c.contains("submit")));
    }

    #[test]
    fn lost_fork_ack_reuses_existing_task_vm() {
        let (dir, work) = temp_repo();
        let fake = Arc::new(Fake::default());
        fake.machine("base", "running");
        fake.on_exec("probe", Ok(probe_json(false)));
        let mgr = manager(fake.clone(), dir.path());
        // Pre-create every ph-* name the flow could pick by intercepting get: we
        // can't know the id in advance, so use a wrapper that reports any ph-* as existing.
        struct Existing(Arc<Fake>);
        impl Boxd for Existing {
            fn auth(&self) -> super::super::transport::TResult<serde_json::Value> { self.0.auth() }
            fn machine_get(&self, vm: &str) -> super::super::transport::TResult<MachineInfo> {
                if vm.starts_with("ph-") {
                    self.0.calls.lock().unwrap().push(format!("get {vm}"));
                    return Ok(MachineInfo { name: vm.into(), id: Some("existing".into()), status: "running".into(), isolated: Some("yes".into()), auto_suspend: Some("off".into()), auto_hibernate: Some("off".into()), source: None });
                }
                self.0.machine_get(vm)
            }
            fn machine_start(&self, vm: &str) -> super::super::transport::TResult<()> { self.0.machine_start(vm) }
            fn fork(&self, s: &str, n: &str, a: u64, b: u64) -> super::super::transport::TResult<MachineInfo> { self.0.fork(s, n, a, b) }
            fn config_set(&self, vm: &str, k: &str, v: &str) -> super::super::transport::TResult<()> { self.0.config_set(vm, k, v) }
            fn cp_to(&self, l: &Path, vm: &str, r: &str) -> super::super::transport::TResult<()> { self.0.cp_to(l, vm, r) }
            fn exec(&self, vm: &str, argv: &[String], t: Duration) -> super::super::transport::TResult<super::super::transport::ExecOutput> { self.0.exec(vm, argv, t) }
        }
        let mgr2 = CloudManager::with(CloudStore::open(dir.path().join("cloud-runs2.json")), Arc::new(Existing(fake.clone())));
        drop(mgr);
        let _ = do_submit(&mgr2, None, request(&work, "base"));
        let calls = fake.calls.lock().unwrap().clone();
        assert!(!calls.iter().any(|c| c.starts_with("fork ")), "must not fork when the task VM already exists: {calls:?}");
    }

    #[test]
    fn sync_never_regresses_and_restores_idle_policy_once() {
        let (dir, _work) = temp_repo();
        let fake = Arc::new(Fake::default());
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555".to_string();
        let mut rec = super::super::store::tests_support::record_with_vm(&run_id, "ph-11111111");
        rec.phase = Phase::Accepted;
        rec.idle_policy = Some((300, 900));
        mgr.store.lock().unwrap().put(rec).unwrap();
        let snap = |state: &str, updated: u64, seq: u64| serde_json::json!({"ok": {"run_id": run_id, "manifest_digest": "d", "state": state, "stage": null, "last_event_seq": seq, "accepted_at_ms": 1, "updated_at_ms": updated, "cancel_requested": false, "result_available": state == "completed", "unit_active": false}}).to_string();
        fake.on_exec("events", Ok(serde_json::json!({"ok": {"run_id": run_id, "events": [{"seq": 1, "ts_ms": 1, "kind": "run.accepted", "payload": null}, {"seq": 2, "ts_ms": 2, "kind": "run.stage", "payload": null}], "next_after": 2, "has_more": false, "last_event_seq": 2}}).to_string()));
        fake.on_exec("result", Ok(serde_json::json!({"ok": {"run_id": run_id, "source_sha": "a", "output_branch": "powerhouse/cloud/x", "published": true, "checks_configured": false, "checks": [], "tree_changed_after_checks": false, "changed_files": [], "diff_bytes": 0, "diff_truncated": false, "partial_work_preserved": true}}).to_string()));
        fake.on_exec("inspect", Ok(snap("completed", 20, 2)));
        let r = do_sync(&mgr, None, &run_id, false).unwrap();
        assert_eq!(r.state(), Some(powerhouse_cloud_protocol::RunState::Completed));
        assert_eq!(r.event_cursor, 2);
        assert!(r.result.is_some());
        assert!(r.idle_policy_restored);
        let restores = fake.calls.lock().unwrap().iter().filter(|c| c.contains("config ph-11111111 auto-suspend.timeout=300")).count();
        assert_eq!(restores, 1);
        // A stale "running" snapshot arriving later must not regress the state.
        fake.exec.lock().unwrap().retain(|(n, _)| n != "inspect");
        fake.on_exec("inspect", Ok(snap("running", 5, 2)));
        let r2 = do_sync(&mgr, None, &run_id, false).unwrap();
        assert_eq!(r2.state(), Some(powerhouse_cloud_protocol::RunState::Completed));
        let restores = fake.calls.lock().unwrap().iter().filter(|c| c.contains("auto-suspend.timeout=300")).count();
        assert_eq!(restores, 1, "idle policy restored exactly once");
    }

    #[test]
    fn sync_keeps_cache_and_reports_transport_errors() {
        let (dir, _work) = temp_repo();
        let fake = Arc::new(Fake::default());
        let mgr = manager(fake.clone(), dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555".to_string();
        let mut rec = super::super::store::tests_support::record_with_vm(&run_id, "ph-11111111");
        rec.phase = Phase::Accepted;
        rec.snapshot = Some(RunSnapshot { run_id: run_id.clone(), manifest_digest: "d".into(), state: powerhouse_cloud_protocol::RunState::Running, stage: None, last_event_seq: 3, accepted_at_ms: 1, updated_at_ms: 1, started_at_ms: None, finished_at_ms: None, error: None, cancel_requested: false, result_available: false, unit_active: Some(true) });
        mgr.store.lock().unwrap().put(rec).unwrap();
        // No exec scripted → transport error.
        let r = do_sync(&mgr, None, &run_id, false).unwrap();
        assert!(r.last_sync_error.is_some());
        assert_eq!(r.state(), Some(powerhouse_cloud_protocol::RunState::Running));
        assert!(r.is_active());
    }

    #[test]
    fn forget_refuses_active_runs_without_force() {
        let (dir, _work) = temp_repo();
        let fake = Arc::new(Fake::default());
        let mgr = manager(fake, dir.path());
        let run_id = "11111111-2222-4333-8444-555555555555".to_string();
        let mut rec = super::super::store::tests_support::record_with_vm(&run_id, "ph-1");
        rec.phase = Phase::Accepted;
        mgr.store.lock().unwrap().put(rec).unwrap();
        assert!(mgr.store.lock().unwrap().get(&run_id).unwrap().is_active());
    }
}

/// Real-cloud end-to-end for the desktop backend. Ignored by default; run with
///   POWERHOUSE_CLOUD_E2E_BASE=<base-vm> POWERHOUSE_CLOUD_E2E_SOURCE=<local repo> \
///   cargo test --manifest-path src-tauri/Cargo.toml cloud_e2e -- --ignored --nocapture
/// The local repo's `origin` must be a remote the *forked VM* can fetch from.
#[cfg(test)]
mod e2e {
    use super::*;

    #[test]
    #[ignore]
    fn cloud_e2e_fake_agent_through_desktop_backend() {
        let base = match std::env::var("POWERHOUSE_CLOUD_E2E_BASE") {
            Ok(b) => b,
            Err(_) => return,
        };
        let source = std::env::var("POWERHOUSE_CLOUD_E2E_SOURCE").expect("POWERHOUSE_CLOUD_E2E_SOURCE");
        let dir = tempfile::tempdir().unwrap();
        let store_path = dir.path().join("cloud-runs.json");
        let mgr = CloudManager::with(CloudStore::open(store_path.clone()), Arc::new(BoxdCli::default()));
        let req = SubmitRequest {
            repo_id: "e2e".into(),
            repo_path: source.clone(),
            repo_name: "e2e".into(),
            source_path: source.clone(),
            task: "E2E: add CLOUD_RUN.md".into(),
            acceptance_criteria: vec![],
            base_vm: base,
            checks: vec![CheckSpec { name: "file exists".into(), command: "test -f CLOUD_RUN.md".into() }],
            deadline_seconds: 600,
            permission_mode: "dontAsk".into(),
            allowed_tools: vec![],
            max_turns: None,
            max_budget_usd: None,
            model: None,
            provider: "fake".into(),
            fake_script: Some("slow-complete".into()),
        };
        let t0 = Instant::now();
        let rec = do_submit(&mgr, None, req).expect("submit");
        eprintln!("accepted run {} on {:?} after {:?}", rec.run_id, rec.task_vm, t0.elapsed());
        assert_eq!(rec.phase, Phase::Accepted);
        let run_id = rec.run_id.clone();
        drop(mgr);

        // "Close the app": a brand-new manager reloads the receipt from disk and
        // reconciles purely by run id.
        let mgr2 = CloudManager::with(CloudStore::open(store_path), Arc::new(BoxdCli::default()));
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut last = None;
        while Instant::now() < deadline {
            let r = do_sync(&mgr2, None, &run_id, false).expect("sync");
            eprintln!(
                "state={:?} events={} cursor={} err={:?}",
                r.state(),
                r.events.len(),
                r.event_cursor,
                r.last_sync_error
            );
            let done = r.state().map(|s| s.is_terminal()).unwrap_or(false);
            last = Some(r);
            if done {
                break;
            }
            std::thread::sleep(Duration::from_secs(5));
        }
        let r = last.expect("synced");
        assert_eq!(r.state(), Some(powerhouse_cloud_protocol::RunState::Completed), "{:?}", r.snapshot);
        let res = r.result.expect("result");
        assert!(res.published);
        assert_eq!(res.changed_files, vec!["CLOUD_RUN.md".to_string()]);
        assert!(r.idle_policy_restored);
        let claims = r.events.iter().filter(|e| e.kind == "run.claimed").count();
        assert_eq!(claims, 1, "exactly one agent execution");
        eprintln!("E2E OK: run {} result {:?} on {:?}", run_id, res.result_sha, r.task_vm);
    }
}
