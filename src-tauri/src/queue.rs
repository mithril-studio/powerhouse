// Git-native merge queue engine. A "PR" is a local branch candidate. Each
// candidate is merged into a throwaway worktree cut from (origin/)main, the
// repo's configured check steps run there, and only a fully-green tested
// commit is fast-forwarded onto main (then pushed). One worker thread per repo
// = single writer on main. Mirrors the streaming/cancel pattern from pty.rs.
use crate::git::{git, slugify};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const LOG_CAP: usize = 256 * 1024;

#[derive(Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum QState {
    Queued,
    Validating,
    Merging,
    Merged,
    Failed,
    Canceled,
    // Frontend-only: set on hydrate for entries a crash cut short. Never
    // constructed by the engine, but part of the serialized state contract.
    #[allow(dead_code)]
    Interrupted,
}

impl QState {
    fn is_live(self) -> bool {
        matches!(self, QState::Queued | QState::Validating | QState::Merging)
    }
    fn is_terminal(self) -> bool {
        !self.is_live()
    }
}

#[derive(Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum StepStatus {
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, serde::Serialize)]
pub struct StepState {
    name: String,
    command: String,
    status: StepStatus,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
}

#[derive(Clone, serde::Serialize)]
pub struct QueueEntry {
    id: String,
    repo_id: String,
    branch: String,
    state: QState,
    steps: Vec<StepState>,
    error: Option<String>,
    merge_commit: Option<String>,
    created_at: u64,
    finished_at: Option<u64>,
}

#[derive(serde::Deserialize)]
pub struct StepInput {
    name: String,
    command: String,
    // `type` is reserved for future "agent" steps; ignored for now.
}

#[derive(Clone, serde::Serialize)]
struct LogChunk {
    step: usize,
    chunk: String,
}

struct RepoQueue {
    repo_path: String,
    default_branch: String,
    push: bool,
    entries: Vec<QueueEntry>,
    running: bool,
    swept: bool,
    cancel: Option<Arc<AtomicBool>>,
    child: Arc<Mutex<Option<Child>>>,
    logs: HashMap<(String, usize), String>,
}

impl RepoQueue {
    fn new(repo_path: String, default_branch: String, push: bool) -> Self {
        Self {
            repo_path,
            default_branch,
            push,
            entries: Vec::new(),
            running: false,
            swept: false,
            cancel: None,
            child: Arc::new(Mutex::new(None)),
            logs: HashMap::new(),
        }
    }
}

#[derive(Default)]
pub struct QueueManager(Mutex<HashMap<String, RepoQueue>>);

impl QueueManager {
    /// App-exit hygiene: flag every running entry and kill its check child.
    pub fn kill_running(&self) {
        let map = self.0.lock().unwrap();
        for q in map.values() {
            if let Some(c) = &q.cancel {
                c.store(true, Ordering::Relaxed);
            }
            if let Some(child) = q.child.lock().unwrap().as_mut() {
                let _ = child.kill();
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// First 8 hex chars are a strictly-increasing per-session counter, so the
/// derived worktree dir (`entry-id`[..8]) is unique within a session.
fn gen_id() -> String {
    let c = ID_COUNTER.fetch_add(1, Ordering::Relaxed) as u32;
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u32)
        .unwrap_or(0);
    format!("{c:08x}{n:08x}")
}

fn repo_slug(repo_path: &str) -> String {
    slugify(
        &Path::new(repo_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".into()),
    )
}

fn queue_base(repo_path: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join(".powerhouse")
        .join("worktrees")
        .join(repo_slug(repo_path))
        .join(".queue")
}

fn worktree_path(repo_path: &str, entry_id: &str) -> PathBuf {
    let short = &entry_id[..entry_id.len().min(8)];
    queue_base(repo_path).join(short)
}

fn cleanup_worktree(repo: &Path, wt: &Path) {
    let wt_str = wt.to_string_lossy().to_string();
    let _ = git(repo, &["worktree", "remove", "--force", &wt_str]);
    if wt.exists() {
        let _ = std::fs::remove_dir_all(wt);
    }
    let _ = git(repo, &["worktree", "prune"]);
}

/// Remove any leftover `.queue/*` worktrees from a previous session.
fn sweep(repo_path: &str) {
    let repo = Path::new(repo_path);
    let base = queue_base(repo_path);
    if let Ok(rd) = std::fs::read_dir(&base) {
        for entry in rd.flatten() {
            cleanup_worktree(repo, &entry.path());
        }
    }
    let _ = git(repo, &["worktree", "prune"]);
}

// --- shared-state helpers -------------------------------------------------

fn emit_update(app: &AppHandle, repo_id: &str) {
    let mgr = app.state::<QueueManager>();
    let entries = {
        let map = mgr.0.lock().unwrap();
        map.get(repo_id)
            .map(|q| q.entries.clone())
            .unwrap_or_default()
    };
    let _ = app.emit(&format!("queue-update-{repo_id}"), entries);
}

fn update_entry<F: FnOnce(&mut QueueEntry)>(
    app: &AppHandle,
    repo_id: &str,
    entry_id: &str,
    f: F,
) {
    let mgr = app.state::<QueueManager>();
    {
        let mut map = mgr.0.lock().unwrap();
        if let Some(q) = map.get_mut(repo_id) {
            if let Some(e) = q.entries.iter_mut().find(|e| e.id == entry_id) {
                f(e);
            }
        }
    }
    emit_update(app, repo_id);
}

fn append_log(app: &AppHandle, repo_id: &str, entry_id: &str, idx: usize, chunk: &str) {
    let mgr = app.state::<QueueManager>();
    let mut map = mgr.0.lock().unwrap();
    if let Some(q) = map.get_mut(repo_id) {
        let buf = q.logs.entry((entry_id.to_string(), idx)).or_default();
        buf.push_str(chunk);
        if buf.len() > LOG_CAP {
            let mut cut = buf.len() - LOG_CAP;
            while cut < buf.len() && !buf.is_char_boundary(cut) {
                cut += 1;
            }
            buf.drain(..cut);
        }
    }
}

// --- commands -------------------------------------------------------------

#[tauri::command]
pub fn queue_enqueue(
    app: AppHandle,
    state: State<QueueManager>,
    repo_id: String,
    repo_path: String,
    default_branch: String,
    branch: String,
    workflow: Vec<StepInput>,
    push: bool,
) -> Result<QueueEntry, String> {
    let entry;
    let need_worker;
    {
        let mut map = state.0.lock().unwrap();
        let q = map
            .entry(repo_id.clone())
            .or_insert_with(|| RepoQueue::new(repo_path.clone(), default_branch.clone(), push));
        // Refresh the config snapshot for subsequently-popped entries.
        q.repo_path = repo_path;
        q.default_branch = default_branch;
        q.push = push;

        if q.entries.iter().any(|e| e.branch == branch && e.state.is_live()) {
            return Err(format!("{branch} is already in the queue"));
        }

        let steps = workflow
            .into_iter()
            .map(|s| StepState {
                name: s.name,
                command: s.command,
                status: StepStatus::Pending,
                exit_code: None,
                duration_ms: None,
            })
            .collect();
        let e = QueueEntry {
            id: gen_id(),
            repo_id: repo_id.clone(),
            branch,
            state: QState::Queued,
            steps,
            error: None,
            merge_commit: None,
            created_at: now_ms(),
            finished_at: None,
        };
        q.entries.push(e.clone());
        entry = e;
        need_worker = !q.running;
        if need_worker {
            q.running = true;
        }
    }
    emit_update(&app, &repo_id);
    if need_worker {
        spawn_worker(app.clone(), repo_id);
    }
    Ok(entry)
}

#[tauri::command]
pub fn queue_cancel(
    app: AppHandle,
    state: State<QueueManager>,
    repo_id: String,
    entry_id: String,
) -> Result<(), String> {
    {
        let mut map = state.0.lock().unwrap();
        if let Some(q) = map.get_mut(&repo_id) {
            if let Some(e) = q.entries.iter_mut().find(|e| e.id == entry_id) {
                match e.state {
                    QState::Queued => {
                        e.state = QState::Canceled;
                        e.finished_at = Some(now_ms());
                    }
                    QState::Validating | QState::Merging => {
                        if let Some(c) = &q.cancel {
                            c.store(true, Ordering::Relaxed);
                        }
                        if let Some(child) = q.child.lock().unwrap().as_mut() {
                            let _ = child.kill();
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    emit_update(&app, &repo_id);
    Ok(())
}

#[tauri::command]
pub fn queue_state(
    state: State<QueueManager>,
    repo_id: String,
) -> Result<Vec<QueueEntry>, String> {
    Ok(state
        .0
        .lock()
        .unwrap()
        .get(&repo_id)
        .map(|q| q.entries.clone())
        .unwrap_or_default())
}

#[tauri::command]
pub fn queue_step_log(
    state: State<QueueManager>,
    repo_id: String,
    entry_id: String,
    step: usize,
) -> Result<String, String> {
    Ok(state
        .0
        .lock()
        .unwrap()
        .get(&repo_id)
        .and_then(|q| q.logs.get(&(entry_id, step)).cloned())
        .unwrap_or_default())
}

#[tauri::command]
pub fn queue_dismiss(
    app: AppHandle,
    state: State<QueueManager>,
    repo_id: String,
    entry_id: String,
) -> Result<(), String> {
    {
        let mut map = state.0.lock().unwrap();
        if let Some(q) = map.get_mut(&repo_id) {
            q.entries
                .retain(|e| !(e.id == entry_id && e.state.is_terminal()));
            q.logs.retain(|(id, _), _| id != &entry_id);
        }
    }
    emit_update(&app, &repo_id);
    Ok(())
}

// --- worker ---------------------------------------------------------------

struct Job {
    entry_id: String,
    branch: String,
    repo_path: String,
    default_branch: String,
    push: bool,
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    steps: Vec<(String, String)>, // (name, command)
}

enum Outcome {
    Merged(String),
    Failed(String),
    Canceled,
}

fn spawn_worker(app: AppHandle, repo_id: String) {
    std::thread::spawn(move || {
        // Sweep leftover worktrees once per session, before the first entry.
        let sweep_path = {
            let mgr = app.state::<QueueManager>();
            let mut map = mgr.0.lock().unwrap();
            match map.get_mut(&repo_id) {
                Some(q) if !q.swept => {
                    q.swept = true;
                    Some(q.repo_path.clone())
                }
                _ => None,
            }
        };
        if let Some(p) = sweep_path {
            sweep(&p);
        }

        loop {
            let job = {
                let mgr = app.state::<QueueManager>();
                let mut map = mgr.0.lock().unwrap();
                let q = match map.get_mut(&repo_id) {
                    Some(q) => q,
                    None => return,
                };
                match q.entries.iter().position(|e| e.state == QState::Queued) {
                    None => {
                        q.running = false;
                        return;
                    }
                    Some(i) => {
                        let cancel = Arc::new(AtomicBool::new(false));
                        q.cancel = Some(cancel.clone());
                        q.entries[i].state = QState::Validating;
                        let e = &q.entries[i];
                        Job {
                            entry_id: e.id.clone(),
                            branch: e.branch.clone(),
                            repo_path: q.repo_path.clone(),
                            default_branch: q.default_branch.clone(),
                            push: q.push,
                            cancel,
                            child: q.child.clone(),
                            steps: e
                                .steps
                                .iter()
                                .map(|s| (s.name.clone(), s.command.clone()))
                                .collect(),
                        }
                    }
                }
            };
            emit_update(&app, &repo_id);

            let outcome = run_pipeline(&app, &repo_id, &job);

            let now = now_ms();
            update_entry(&app, &repo_id, &job.entry_id, |e| {
                match &outcome {
                    Outcome::Merged(sha) => {
                        e.state = QState::Merged;
                        e.merge_commit = Some(sha.clone());
                    }
                    Outcome::Failed(msg) => {
                        e.state = QState::Failed;
                        e.error = Some(msg.clone());
                    }
                    Outcome::Canceled => {
                        e.state = QState::Canceled;
                    }
                }
                e.finished_at = Some(now);
            });

            record_run(&app, &repo_id, &job, &outcome, now);

            let mgr = app.state::<QueueManager>();
            let mut map = mgr.0.lock().unwrap();
            if let Some(q) = map.get_mut(&repo_id) {
                q.cancel = None;
                *q.child.lock().unwrap() = None;
            }
        }
    });
}

/// Queue entries have real, known outcomes (exit codes, step durations), so
/// each finished entry lands in telemetry as a completed 'process-only' run,
/// with the entry snapshot as its raw evidence row.
fn record_run(app: &AppHandle, repo_id: &str, job: &Job, outcome: &Outcome, finished_at: u64) {
    let (exit_code, reason) = match outcome {
        Outcome::Merged(_) => (Some(0), "exit"),
        Outcome::Failed(_) => (Some(1), "exit"),
        Outcome::Canceled => (None, "killed"),
    };
    let entry = {
        let mgr = app.state::<QueueManager>();
        let map = mgr.0.lock().unwrap();
        map.get(repo_id)
            .and_then(|q| q.entries.iter().find(|e| e.id == job.entry_id).cloned())
    };
    let Some(entry) = entry else { return };
    let repo_label = Path::new(&job.repo_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned());
    let sys_raw = serde_json::to_string(&entry).unwrap_or_else(|_| "{}".into());
    app.state::<crate::telemetry::Telemetry>().record_completed_run(
        crate::telemetry::RunSpec {
            source: "queue",
            coverage: "process-only",
            chat_id: None,
            agent_command: None,
            cwd: Some(job.repo_path.clone()),
            repo_id: Some(repo_id.to_string()),
            source_sha: entry.merge_commit.clone(),
            repo_label,
            branch_label: Some(job.branch.clone()),
        },
        entry.created_at as i64,
        finished_at as i64,
        exit_code,
        reason,
        sys_raw,
    );
}

/// Runs a git subcommand against `origin`, injecting a transient GitHub-token
/// `Authorization` header for HTTPS remotes so private-repo fetch/push work
/// without ambient credentials. No-op for SSH remotes or when disconnected
/// (falls back to whatever git is already configured with). Always
/// non-interactive — never blocks the worker on a credential prompt.
fn git_origin(repo: &Path, origin_https: bool, args: &[&str]) -> Result<(), String> {
    let auth = if origin_https {
        crate::github::token().map(|t| {
            format!("http.extraheader=AUTHORIZATION: {}", crate::github::basic_auth_header(&t))
        })
    } else {
        None
    };
    let mut cmd = Command::new(crate::git::GIT);
    cmd.current_dir(repo).env("GIT_TERMINAL_PROMPT", "0");
    if let Some(cfg) = &auth {
        cmd.arg("-c").arg(cfg);
    }
    cmd.args(args);
    let out = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn run_pipeline(app: &AppHandle, repo_id: &str, job: &Job) -> Outcome {
    let repo = Path::new(&job.repo_path);
    let cancelled = || job.cancel.load(Ordering::Relaxed);

    // Validate against origin/<main> when a remote exists, else local <main>.
    let has_origin = git(repo, &["remote"])
        .map(|s| s.lines().any(|l| l.trim() == "origin"))
        .unwrap_or(false);
    // HTTPS origins can carry the OAuth token; SSH origins use keys as-is.
    let origin_https = has_origin
        && git(repo, &["remote", "get-url", "origin"])
            .map(|u| u.starts_with("https://"))
            .unwrap_or(false);
    let target = if has_origin {
        if let Err(e) = git_origin(repo, origin_https, &["fetch", "origin", &job.default_branch]) {
            return Outcome::Failed(format!("git fetch origin failed:\n{e}"));
        }
        format!("origin/{}", job.default_branch)
    } else {
        job.default_branch.clone()
    };
    if cancelled() {
        return Outcome::Canceled;
    }

    // Fresh throwaway worktree cut from the target tip.
    let wt = worktree_path(&job.repo_path, &job.entry_id);
    let wt_str = wt.to_string_lossy().to_string();
    if let Some(parent) = wt.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if wt.exists() {
        cleanup_worktree(repo, &wt);
    }
    if let Err(e) = git(repo, &["worktree", "add", "--detach", &wt_str, &target]) {
        return Outcome::Failed(format!("could not create worktree:\n{e}"));
    }

    // Merge the candidate. Conflict → abort, fail, queue continues.
    let msg = format!("Merge {} (powerhouse queue)", job.branch);
    if let Err(e) = git(&wt, &["merge", "--no-ff", "-m", &msg, &job.branch]) {
        let _ = git(&wt, &["merge", "--abort"]);
        cleanup_worktree(repo, &wt);
        return Outcome::Failed(format!("merge conflict:\n{e}"));
    }
    if cancelled() {
        cleanup_worktree(repo, &wt);
        return Outcome::Canceled;
    }

    // Run check steps in the merged worktree.
    for (idx, (name, cmd)) in job.steps.iter().enumerate() {
        if cancelled() {
            cleanup_worktree(repo, &wt);
            return Outcome::Canceled;
        }
        update_entry(app, repo_id, &job.entry_id, |e| {
            e.steps[idx].status = StepStatus::Running;
        });
        let start = Instant::now();
        let res = execute_step(app, repo_id, &job.entry_id, idx, cmd, &wt, &job.cancel, &job.child);
        let dur = start.elapsed().as_millis() as u64;
        match res {
            StepResult::Passed => update_entry(app, repo_id, &job.entry_id, |e| {
                e.steps[idx].status = StepStatus::Passed;
                e.steps[idx].exit_code = Some(0);
                e.steps[idx].duration_ms = Some(dur);
            }),
            StepResult::Failed(code) => {
                update_entry(app, repo_id, &job.entry_id, |e| {
                    e.steps[idx].status = StepStatus::Failed;
                    e.steps[idx].exit_code = Some(code);
                    e.steps[idx].duration_ms = Some(dur);
                    for j in (idx + 1)..e.steps.len() {
                        e.steps[j].status = StepStatus::Skipped;
                    }
                });
                cleanup_worktree(repo, &wt);
                return Outcome::Failed(format!("step “{name}” failed (exit {code})"));
            }
            StepResult::Canceled => {
                cleanup_worktree(repo, &wt);
                return Outcome::Canceled;
            }
            StepResult::SpawnError(err) => {
                update_entry(app, repo_id, &job.entry_id, |e| {
                    e.steps[idx].status = StepStatus::Failed;
                    e.steps[idx].duration_ms = Some(dur);
                });
                cleanup_worktree(repo, &wt);
                return Outcome::Failed(format!("could not run step “{name}”: {err}"));
            }
        }
    }

    // All green — land the exact tested merge commit by fast-forward only.
    let m = match git(&wt, &["rev-parse", "HEAD"]) {
        Ok(s) => s,
        Err(e) => {
            cleanup_worktree(repo, &wt);
            return Outcome::Failed(format!("could not resolve merge commit:\n{e}"));
        }
    };
    update_entry(app, repo_id, &job.entry_id, |e| {
        e.state = QState::Merging;
        e.merge_commit = Some(m.clone());
    });

    let head = git(repo, &["symbolic-ref", "--short", "HEAD"]).unwrap_or_default();
    let land = if head == job.default_branch {
        git(repo, &["merge", "--ff-only", &m])
    } else {
        git(repo, &["branch", "-f", &job.default_branch, &m])
    };
    if let Err(e) = land {
        cleanup_worktree(repo, &wt);
        return Outcome::Failed(format!("could not land on {}:\n{e}", job.default_branch));
    }

    if job.push && has_origin {
        if let Err(e) = git_origin(repo, origin_https, &["push", "origin", &job.default_branch]) {
            cleanup_worktree(repo, &wt);
            return Outcome::Failed(format!("push to origin rejected (did origin move?):\n{e}"));
        }
    }

    cleanup_worktree(repo, &wt);
    Outcome::Merged(m)
}

enum StepResult {
    Passed,
    Failed(i32),
    Canceled,
    SpawnError(String),
}

fn execute_step(
    app: &AppHandle,
    repo_id: &str,
    entry_id: &str,
    idx: usize,
    cmd: &str,
    cwd: &Path,
    cancel: &Arc<AtomicBool>,
    child_slot: &Arc<Mutex<Option<Child>>>,
) -> StepResult {
    let mut child = match Command::new("/bin/zsh")
        .args(["-lc", cmd])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return StepResult::SpawnError(e.to_string()),
    };

    let pipes: Vec<Box<dyn Read + Send>> = [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    *child_slot.lock().unwrap() = Some(child);

    let readers: Vec<_> = pipes
        .into_iter()
        .map(|mut pipe| {
            let app = app.clone();
            let repo_id = repo_id.to_string();
            let entry_id = entry_id.to_string();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match pipe.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                            append_log(&app, &repo_id, &entry_id, idx, &chunk);
                            let _ = app.emit(
                                &format!("queue-log-{entry_id}"),
                                LogChunk { step: idx, chunk },
                            );
                        }
                    }
                }
            })
        })
        .collect();

    // Poll for exit; kill on cancel.
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            if let Some(c) = child_slot.lock().unwrap().as_mut() {
                let _ = c.kill();
            }
        }
        let done = {
            let mut guard = child_slot.lock().unwrap();
            match guard.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(s)) => Some(Ok(s)),
                    Ok(None) => None,
                    Err(e) => Some(Err(e.to_string())),
                },
                None => Some(Err("check process vanished".to_string())),
            }
        };
        if let Some(res) = done {
            break res;
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    for r in readers {
        let _ = r.join();
    }
    *child_slot.lock().unwrap() = None;

    if cancel.load(Ordering::Relaxed) {
        return StepResult::Canceled;
    }
    match status {
        Ok(s) => {
            let code = s.code().unwrap_or(-1);
            if code == 0 {
                StepResult::Passed
            } else {
                StepResult::Failed(code)
            }
        }
        Err(e) => StepResult::SpawnError(e),
    }
}

