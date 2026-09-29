//! Cloud workspace commands: start (checkpoint, push, VM, clone, first turn),
//! send (a follow-up turn), poll (log lines + finish), stop, archive.
//! See `workspace.rs` for the VM layout.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};

use super::secrets::{self, Keychain, SecretStore};
use super::transport::{Boxd, BoxdCli, TransportError};
use super::workspace::{self as ws, CloudWorkspace, Exit, Status, Store, TurnResult};
use crate::git::git;

const UPDATE_EVENT: &str = "cloud-workspace-update";
const REMOVED_EVENT: &str = "cloud-workspace-removed";
const VM_READY_TIMEOUT: Duration = Duration::from_secs(180);
const EXEC_TIMEOUT: Duration = Duration::from_secs(60);
const SETUP_TIMEOUT: Duration = Duration::from_secs(600);

pub struct CloudManager {
    pub store: Mutex<Store>,
    pub boxd: Arc<dyn Boxd>,
    pub secrets: Arc<dyn SecretStore>,
    /// Powerhouse's GitHub connection, used when no Keychain token serves a remote.
    pub github_fallback: fn() -> Option<String>,
    /// One lock per workspace: start/send/stop/archive wait, polls skip.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Default for CloudManager {
    fn default() -> Self {
        Self::with(Store::open(Store::default_path()), Arc::new(BoxdCli::default()), Arc::new(Keychain))
    }
}

impl CloudManager {
    pub fn with(store: Store, boxd: Arc<dyn Boxd>, secrets: Arc<dyn SecretStore>) -> Self {
        Self { store: Mutex::new(store), boxd, secrets, github_fallback: crate::github::token, locks: Mutex::new(HashMap::new()) }
    }

    fn lock_for(&self, id: &str) -> Arc<Mutex<()>> {
        self.locks.lock().unwrap().entry(id.to_string()).or_default().clone()
    }

    fn get(&self, id: &str) -> Result<CloudWorkspace, String> {
        self.store.lock().unwrap().get(id).cloned().ok_or_else(|| "unknown cloud workspace".to_string())
    }
}

/// Where record changes go: the webview in the app, nowhere in tests.
pub type Notify<'a> = &'a dyn Fn(&CloudWorkspace);

fn save(mgr: &CloudManager, notify: Notify, w: &mut CloudWorkspace) -> Result<(), String> {
    w.updated_at_ms = now_ms();
    mgr.store.lock().unwrap().put(w.clone())?;
    notify(w);
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn transport(e: TransportError) -> String {
    e.to_string()
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub repo_id: String,
    pub branch_id: String,
    pub worktree_path: String,
    pub chat_id: Option<String>,
    pub agent: String,
    pub model: Option<String>,
    /// The chat handed off as text; empty = provision only and wait for a prompt.
    pub handoff: String,
    pub env_names: Vec<String>,
    /// Also write the project env vars to `~/repo/.env` on the VM.
    #[serde(default)]
    pub write_env_file: bool,
}

// --- start -----------------------------------------------------------------------

struct Preflight {
    branch: String,
    remote_url: String,
}

/// Everything a start needs that can be checked locally, without side effects:
/// a checked-out branch, a GitHub-style `origin`, the Claude token, a GitHub
/// token for that remote, and a value for every project env var. Returns every
/// problem, not just the first, so the Cloud button can list them.
fn preflight(mgr: &CloudManager, repo_id: &str, worktree: &Path, env_names: &[String]) -> Result<Preflight, Vec<String>> {
    let mut problems = vec![];
    let branch = git(worktree, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().filter(|b| !b.is_empty());
    if branch.is_none() {
        problems.push("The worktree is on a detached HEAD; check out a branch first.".to_string());
    }
    let remote_url = match git(worktree, &["remote", "get-url", "origin"]) {
        Err(_) => {
            problems.push("The repository has no `origin` remote for the cloud machine to clone.".to_string());
            None
        }
        Ok(origin) => {
            let url = ws::https_remote(&origin);
            if url.is_none() {
                problems.push(format!("The cloud machine needs a GitHub-style remote; `origin` is {origin}."));
            }
            url
        }
    };
    let store = mgr.secrets.as_ref();
    let claude = store.get(secrets::CLAUDE_OAUTH).map(|v| v.is_some_and(|v| !v.trim().is_empty()));
    match claude {
        Ok(true) => {}
        Ok(false) => problems.push("Claude key missing, set it in Settings → Cloud.".to_string()),
        Err(e) => problems.push(e),
    }
    if let Some(url) = &remote_url {
        if github_token(mgr, url).is_none() {
            problems.push("GitHub token missing, connect GitHub or add one in Settings → Cloud.".to_string());
        }
    }
    match secrets::missing_project_env(store, repo_id, env_names) {
        Ok(missing) if missing.is_empty() => {}
        Ok(missing) => problems.push(format!("No value for {}, set it in Project settings.", missing.join(", "))),
        Err(e) => problems.push(e),
    }
    match (branch, remote_url) {
        (Some(branch), Some(remote_url)) if problems.is_empty() => Ok(Preflight { branch, remote_url }),
        _ => Err(problems),
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Readiness {
    pub ready: bool,
    /// One sentence per problem, saying where to fix it.
    pub missing: Vec<String>,
}

pub fn readiness(mgr: &CloudManager, repo_id: &str, worktree: &Path, env_names: &[String]) -> Readiness {
    match preflight(mgr, repo_id, worktree, env_names) {
        Ok(_) => Readiness { ready: true, missing: vec![] },
        Err(missing) => Readiness { ready: false, missing },
    }
}

/// Validates what can be checked locally and records the workspace; the slow
/// part (checkpoint, push, VM, clone, first turn) is [`provision`], run in the
/// background so the chat shows each stage.
pub fn begin(mgr: &CloudManager, notify: Notify, req: &StartRequest) -> Result<CloudWorkspace, String> {
    if req.agent != "claude" {
        return Err("This agent cannot run in the cloud yet. Supported: Claude.".into());
    }
    // Fail on a missing branch, remote or credential now, not after a VM exists.
    let Preflight { branch, remote_url } =
        preflight(mgr, &req.repo_id, Path::new(&req.worktree_path), &req.env_names).map_err(|p| p.join(" "))?;

    let existing = mgr.store.lock().unwrap().for_branch(&req.branch_id).cloned();
    let mut w = match existing {
        Some(w) if !w.status.accepts_prompt() => {
            return Err(format!("This branch is already busy in the cloud on {}.", w.vm_name));
        }
        Some(mut w) => {
            // A reused workspace: same VM, fresh checkout, new chat context.
            w.chat_id = req.chat_id.clone();
            w.model = req.model.clone();
            w.remote_url = remote_url;
            w.worktree_path = req.worktree_path.clone();
            w.branch_name = branch.clone();
            w.session_id = None;
            w.last_result = None;
            w.write_env_file = req.write_env_file;
            w
        }
        None => CloudWorkspace {
            id: uuid::Uuid::new_v4().to_string(),
            repo_id: req.repo_id.clone(),
            branch_id: req.branch_id.clone(),
            branch_name: branch.clone(),
            worktree_path: req.worktree_path.clone(),
            remote_url,
            vm_name: ws::vm_name(&branch),
            status: Status::Creating,
            stage: None,
            agent: req.agent.clone(),
            model: req.model.clone(),
            chat_id: req.chat_id.clone(),
            created_at_ms: now_ms(),
            updated_at_ms: now_ms(),
            last_error: None,
            turn: 0,
            log_offset: 0,
            session_id: None,
            last_result: None,
            write_env_file: req.write_env_file,
        },
    };
    w.status = Status::Creating;
    w.stage = Some("Preparing branch".into());
    w.last_error = None;
    save(mgr, notify, &mut w)?;
    Ok(w)
}

/// Checkpoint, push, VM, clone, and the first turn when there is a handoff.
/// Any failure lands on the record as `failed` with the reason.
pub fn provision(mgr: &CloudManager, notify: Notify, id: &str, req: &StartRequest) {
    let lock = mgr.lock_for(id);
    let _held = lock.lock().unwrap();
    let Ok(mut w) = mgr.get(id) else { return };
    if let Err(e) = provision_inner(mgr, notify, &mut w, req) {
        w.status = Status::Failed;
        w.stage = None;
        w.last_error = Some(e);
        let _ = save(mgr, notify, &mut w);
    }
}

fn provision_inner(mgr: &CloudManager, notify: Notify, w: &mut CloudWorkspace, req: &StartRequest) -> Result<(), String> {
    let worktree = PathBuf::from(&w.worktree_path);
    let stage = |w: &mut CloudWorkspace, s: &str| {
        w.stage = Some(s.into());
        save(mgr, notify, w)
    };

    // The cloud clones the remote, so unpushed or uncommitted work would be
    // left behind. `.powerhouse/` stays excluded from the checkpoint.
    crate::handoff::ensure_powerhouse_dir(&worktree);
    let dirty = !git(&worktree, &["status", "--porcelain"])?.trim().is_empty();
    if dirty {
        stage(w, "Committing uncommitted work")?;
        git(&worktree, &["add", "-A"])?;
        git(&worktree, &["commit", "-m", "WIP: send to cloud"])?;
    }
    stage(w, "Pushing branch")?;
    push(mgr, &worktree, &w.remote_url, &w.branch_name)?;

    stage(w, "Starting cloud machine")?;
    ensure_running(mgr.boxd.as_ref(), &w.vm_name)?;

    stage(w, "Cloning repository")?;
    let env = env_vars(mgr, &w.repo_id, &w.remote_url, &req.env_names)?;
    let name = git(&worktree, &["config", "user.name"]).unwrap_or_else(|_| "Powerhouse".into());
    let email = git(&worktree, &["config", "user.email"]).unwrap_or_else(|_| "powerhouse@localhost".into());
    exec_ok(mgr.boxd.as_ref(), &w.vm_name, r#"mkdir -p "$HOME/.ph" && chmod 700 "$HOME/.ph""#, EXEC_TIMEOUT)?;
    upload(mgr.boxd.as_ref(), &w.vm_name, "env", secrets::render_env_file(&env)?.as_bytes())?;
    upload(mgr.boxd.as_ref(), &w.vm_name, "run.sh", ws::RUN_SCRIPT.as_bytes())?;
    exec_ok(mgr.boxd.as_ref(), &w.vm_name, &ws::setup_script(&w.remote_url, &w.branch_name, &name, &email), SETUP_TIMEOUT)
        .map_err(|e| format!("preparing the clone failed: {}", super::redact_stderr(&e)))?;
    if w.write_env_file {
        write_dotenv(mgr, w, &req.env_names)?;
    }

    if req.handoff.trim().is_empty() {
        w.status = Status::Ready;
        w.stage = None;
        return save(mgr, notify, w);
    }
    let prompt = ws::turn_prompt(true, &w.branch_name, &req.handoff);
    launch_turn(mgr, notify, w, &prompt)
}

fn push(mgr: &CloudManager, worktree: &Path, remote_url: &str, branch: &str) -> Result<(), String> {
    let has_upstream = git(worktree, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
    let args: Vec<&str> = if has_upstream { vec!["push", "origin", branch] } else { vec!["push", "-u", "origin", branch] };
    // The user's own credentials first; a GUI app often has none, so fall back
    // to the token the VM uses. Never force.
    git_env(worktree, &args, &[])
        .or_else(|e| match github_token(mgr, remote_url) {
            Some(token) => git_env(worktree, &args, &token_env(&token)),
            None => Err(e),
        })
        .map(|_| ())
        .map_err(|e| format!("git push failed: {e}"))
}

/// Uploads a prompt and starts the next turn detached.
fn launch_turn(mgr: &CloudManager, notify: Notify, w: &mut CloudWorkspace, prompt: &str) -> Result<(), String> {
    let turn = w.turn + 1;
    upload(mgr.boxd.as_ref(), &w.vm_name, &format!("turn-{turn}.prompt"), prompt.as_bytes())?;
    exec_ok(mgr.boxd.as_ref(), &w.vm_name, &ws::launch_command(turn, w.model.as_deref(), w.session_id.as_deref()), EXEC_TIMEOUT)?;
    w.turn = turn;
    w.log_offset = 0;
    w.status = Status::Running;
    w.stage = Some("Agent working".into());
    w.last_error = None;
    save(mgr, notify, w)
}

// --- send / stop / archive -------------------------------------------------------

pub fn send(mgr: &CloudManager, notify: Notify, id: &str, text: &str, env_names: &[String], write_env_file: bool) -> Result<CloudWorkspace, String> {
    let lock = mgr.lock_for(id);
    let _held = lock.lock().unwrap();
    let mut w = mgr.get(id)?;
    if !w.status.accepts_prompt() {
        return Err("The cloud agent is still working; wait for it or stop it.".into());
    }
    ensure_running(mgr.boxd.as_ref(), &w.vm_name)?;
    // Tokens may have changed since the last turn.
    let env = env_vars(mgr, &w.repo_id, &w.remote_url, env_names)?;
    upload(mgr.boxd.as_ref(), &w.vm_name, "env", secrets::render_env_file(&env)?.as_bytes())?;
    w.write_env_file = write_env_file;
    if write_env_file {
        write_dotenv(mgr, &w, env_names)?;
    }
    // A fresh session (no turn yet on this chat) gets the full preamble.
    let prompt = ws::turn_prompt(w.session_id.is_none(), &w.branch_name, text);
    launch_turn(mgr, notify, &mut w, &prompt)?;
    Ok(w)
}

pub fn stop(mgr: &CloudManager, id: &str) -> Result<(), String> {
    let lock = mgr.lock_for(id);
    let _held = lock.lock().unwrap();
    let w = mgr.get(id)?;
    if w.status != Status::Running {
        return Ok(());
    }
    // The next poll sees the `stopped` marker and finishes the turn.
    exec_ok(mgr.boxd.as_ref(), &w.vm_name, &ws::stop_command(w.turn), EXEC_TIMEOUT).map(|_| ())
}

/// Destroys the VM and forgets the workspace. The branch keeps everything that
/// was pushed.
pub fn archive(mgr: &CloudManager, id: &str) -> Result<(), String> {
    let lock = mgr.lock_for(id);
    let _held = lock.lock().unwrap();
    let w = mgr.get(id)?;
    match mgr.boxd.machine_remove(&w.vm_name) {
        Ok(()) | Err(TransportError::NotFound(_)) => {}
        Err(e) => return Err(transport(e)),
    }
    mgr.store.lock().unwrap().remove(id)?;
    mgr.locks.lock().unwrap().remove(id);
    Ok(())
}

// --- poll ------------------------------------------------------------------------

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    pub workspace: CloudWorkspace,
    /// New stream-json lines of the current turn, in order.
    pub lines: Vec<String>,
    pub turn: u32,
}

/// Reads new log lines; when the turn has exited and the log is drained,
/// inspects the clone, brings the branch home, and settles the record.
pub fn poll(mgr: &CloudManager, notify: Notify, id: &str) -> Result<PollResult, String> {
    let lock = mgr.lock_for(id);
    // A start/send/stop in progress owns the record; report it unchanged.
    let Ok(_held) = lock.try_lock() else {
        let w = mgr.get(id)?;
        return Ok(PollResult { turn: w.turn, workspace: w, lines: vec![] });
    };
    let mut w = mgr.get(id)?;
    if w.status != Status::Running {
        return Ok(PollResult { turn: w.turn, workspace: w, lines: vec![] });
    }
    let out = exec_ok(mgr.boxd.as_ref(), &w.vm_name, &ws::poll_command(w.turn, w.log_offset), EXEC_TIMEOUT)?;
    let mut chunk = ws::parse_poll(&out);
    if chunk.full && chunk.consumed == 0 {
        // One line longer than a slice: skip it rather than stall.
        let len = exec_ok(mgr.boxd.as_ref(), &w.vm_name, &ws::line_length_command(w.turn, w.log_offset), EXEC_TIMEOUT)?;
        chunk.consumed = len.trim().parse().unwrap_or(0);
        chunk.lines = vec![r#"{"type":"ph_skipped","reason":"line too long"}"#.into()];
    }
    let facts = ws::scan_lines(&chunk.lines);
    if facts.session_id.is_some() {
        w.session_id = facts.session_id.clone();
    }
    w.log_offset += chunk.consumed;
    let drained = !chunk.full;
    let turn = w.turn;
    match chunk.exit {
        Exit::Running => {}
        _ if !drained => {}
        exit => finish_turn(mgr, &mut w, exit, facts)?,
    }
    save(mgr, notify, &mut w)?;
    Ok(PollResult { workspace: w, lines: chunk.lines, turn })
}

fn finish_turn(mgr: &CloudManager, w: &mut CloudWorkspace, exit: Exit, facts: ws::LogFacts) -> Result<(), String> {
    let boxd = mgr.boxd.as_ref();
    let (head, unpushed, dirty) = exec_ok(boxd, &w.vm_name, ws::INSPECT_COMMAND, EXEC_TIMEOUT)
        .map(|o| ws::parse_inspect(&o))
        .unwrap_or((None, 0, 0));
    let (ok, summary) = match (&exit, facts.result) {
        (Exit::Stopped, _) => (false, "Stopped.".to_string()),
        (Exit::Code(0), Some((text, false))) => (true, text),
        (_, Some((text, true))) if !text.trim().is_empty() => (false, text),
        (Exit::Code(code), _) => {
            let err = exec_ok(boxd, &w.vm_name, &ws::err_tail_command(w.turn), EXEC_TIMEOUT).unwrap_or_default();
            let err = super::redact_stderr(err.trim());
            (false, if err.is_empty() { format!("The agent exited with code {code}.") } else { err })
        }
        (Exit::Running, _) => unreachable!("finish_turn is only called after exit"),
    };
    let local = bring_home(mgr, w);
    w.status = match exit {
        Exit::Stopped => Status::Stopped,
        _ if ok => Status::Done,
        _ => Status::Failed,
    };
    w.stage = None;
    w.last_error = (!ok && exit != Exit::Stopped).then(|| summary.clone());
    w.last_result = Some(TurnResult { turn: w.turn, ok, summary, head, unpushed_commits: unpushed, dirty_files: dirty, local, cost_usd: facts.cost_usd });
    Ok(())
}

/// Fetches the branch and fast-forwards the worktree when that is safe.
/// Returns what happened, for the result card.
fn bring_home(mgr: &CloudManager, w: &CloudWorkspace) -> String {
    let worktree = Path::new(&w.worktree_path);
    let fetch = ["fetch", "origin", w.branch_name.as_str()];
    let fetched = git_env(worktree, &fetch, &[]).or_else(|e| match github_token(mgr, &w.remote_url) {
        Some(t) => git_env(worktree, &fetch, &token_env(&t)),
        None => Err(e),
    });
    if let Err(e) = fetched {
        return format!("Could not fetch the branch: {e}");
    }
    pull_local(worktree, &w.branch_name)
}

/// `git merge --ff-only origin/<branch>` when the worktree is clean.
pub fn pull_local(worktree: &Path, branch: &str) -> String {
    let upstream = format!("origin/{branch}");
    let behind = git(worktree, &["rev-list", "--count", &format!("HEAD..{upstream}")]).unwrap_or_default();
    if behind.trim() == "0" {
        return "Your worktree already has everything.".into();
    }
    match git(worktree, &["status", "--porcelain"]) {
        Ok(s) if !s.trim().is_empty() => return "Not pulled: your worktree has uncommitted changes.".into(),
        Err(e) => return format!("Not pulled: {e}"),
        _ => {}
    }
    match git(worktree, &["merge", "--ff-only", &upstream]) {
        Ok(_) => format!("Pulled {} commit(s) into your worktree.", behind.trim()),
        Err(_) => "Not pulled: your local branch has diverged from the cloud's.".into(),
    }
}

// --- helpers ---------------------------------------------------------------------

fn env_vars(mgr: &CloudManager, repo_id: &str, remote_url: &str, env_names: &[String]) -> Result<Vec<(String, String)>, String> {
    let project = secrets::project_env_values(mgr.secrets.as_ref(), repo_id, env_names)?;
    secrets::workspace_env(mgr.secrets.as_ref(), remote_url, &project, (mgr.github_fallback)())
}

/// Writes the project env vars (never the tokens) to `~/repo/.env`, staged
/// through an upload so values never appear in argv, and only when git
/// ignores `.env` in the clone.
fn write_dotenv(mgr: &CloudManager, w: &CloudWorkspace, env_names: &[String]) -> Result<(), String> {
    let vars = secrets::project_env_values(mgr.secrets.as_ref(), &w.repo_id, env_names)?;
    upload(mgr.boxd.as_ref(), &w.vm_name, "dotenv", secrets::render_dotenv(&vars)?.as_bytes())?;
    exec_ok(mgr.boxd.as_ref(), &w.vm_name, ws::WRITE_DOTENV_COMMAND, EXEC_TIMEOUT).map(|_| ()).map_err(|e| {
        if e.contains(ws::DOTENV_NOT_IGNORED) {
            "`.env` is not gitignored in this repo; not writing it (the agent could commit it).".to_string()
        } else {
            format!("writing .env failed: {e}")
        }
    })
}

fn github_token(mgr: &CloudManager, remote_url: &str) -> Option<String> {
    secrets::github_token_for(mgr.secrets.as_ref(), remote_url).or_else(mgr.github_fallback)
}

fn token_env(token: &str) -> Vec<(String, String)> {
    vec![
        ("GIT_CONFIG_COUNT".into(), "1".into()),
        ("GIT_CONFIG_KEY_0".into(), "http.extraHeader".into()),
        ("GIT_CONFIG_VALUE_0".into(), format!("Authorization: {}", crate::github::basic_auth_header(token))),
    ]
}

fn git_env(cwd: &Path, args: &[&str], env: &[(String, String)]) -> Result<String, String> {
    let mut cmd = std::process::Command::new(crate::git::GIT);
    cmd.current_dir(cwd).args(args).env("GIT_TERMINAL_PROMPT", "0");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(super::redact_stderr(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// Starts the VM if needed (creating it on first use) and waits until it runs.
fn ensure_running(boxd: &dyn Boxd, vm: &str) -> Result<(), String> {
    let info = match boxd.machine_get(vm) {
        Ok(info) => info,
        Err(TransportError::NotFound(_)) => boxd.machine_new(vm).map_err(transport)?,
        Err(e) => return Err(transport(e)),
    };
    if info.status != "running" {
        // Suspended or hibernated machines wake on start; a starting one is a no-op.
        let _ = boxd.machine_start(vm);
    }
    let deadline = std::time::Instant::now() + VM_READY_TIMEOUT;
    loop {
        if boxd.machine_get(vm).map_err(transport)?.status == "running" {
            return Ok(());
        }
        if std::time::Instant::now() > deadline {
            return Err(format!("{vm} did not start within {}s", VM_READY_TIMEOUT.as_secs()));
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Runs `script` with bash on the VM; non-zero exit is an error carrying the output.
fn exec_ok(boxd: &dyn Boxd, vm: &str, script: &str, timeout: Duration) -> Result<String, String> {
    let argv = vec!["bash".to_string(), "-lc".to_string(), script.to_string()];
    let out = boxd.exec(vm, &argv, timeout).map_err(transport)?;
    if out.exit_code != 0 {
        return Err(format!("exit {}: {}", out.exit_code, out.output.trim()));
    }
    Ok(out.output)
}

/// Copies `bytes` to `~/.ph/<name>` on the VM through a private temp file.
fn upload(boxd: &dyn Boxd, vm: &str, name: &str, bytes: &[u8]) -> Result<(), String> {
    let dir = tempfile::Builder::new().prefix("ph-cloud-").tempdir().map_err(|e| e.to_string())?;
    let path = dir.path().join(name);
    {
        use std::io::Write;
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut f = opts.open(&path).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
    }
    boxd.cp_to(&path, vm, &format!("/home/boxd/.ph/{name}")).map_err(transport)
    // `dir` drops here and deletes the local copy.
}

// --- tauri -----------------------------------------------------------------------

fn emitter(app: &AppHandle) -> impl Fn(&CloudWorkspace) + '_ {
    move |w: &CloudWorkspace| {
        let _ = app.emit(UPDATE_EVENT, w);
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cloud_workspace_list(state: State<CloudManager>) -> Vec<CloudWorkspace> {
    state.store.lock().unwrap().items.clone()
}

#[tauri::command]
pub async fn cloud_workspace_start(app: AppHandle, request: StartRequest) -> Result<CloudWorkspace, String> {
    let handle = app.clone();
    let req = request.clone();
    let w = blocking(move || begin(&handle.state::<CloudManager>(), &emitter(&handle), &req)).await?;
    let id = w.id.clone();
    std::thread::spawn(move || provision(&app.state::<CloudManager>(), &emitter(&app), &id, &request));
    Ok(w)
}

#[tauri::command]
pub async fn cloud_workspace_send(app: AppHandle, id: String, text: String, env_names: Vec<String>, write_env_file: bool) -> Result<CloudWorkspace, String> {
    blocking(move || send(&app.state::<CloudManager>(), &emitter(&app), &id, &text, &env_names, write_env_file)).await
}

#[tauri::command]
pub async fn cloud_workspace_poll(app: AppHandle, id: String) -> Result<PollResult, String> {
    blocking(move || poll(&app.state::<CloudManager>(), &emitter(&app), &id)).await
}

#[tauri::command]
pub async fn cloud_workspace_stop(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || stop(&app.state::<CloudManager>(), &id)).await
}

#[tauri::command]
pub async fn cloud_workspace_archive(app: AppHandle, id: String) -> Result<(), String> {
    let handle = app.clone();
    let removed = id.clone();
    blocking(move || archive(&handle.state::<CloudManager>(), &id)).await?;
    let _ = app.emit(REMOVED_EVENT, removed);
    Ok(())
}

/// Fast-forwards the worktree to what the cloud pushed.
#[tauri::command]
pub async fn cloud_workspace_pull(app: AppHandle, id: String) -> Result<String, String> {
    blocking(move || {
        let mgr = app.state::<CloudManager>();
        let w = mgr.get(&id)?;
        Ok(bring_home(&mgr, &w))
    })
    .await
}

#[tauri::command]
pub fn cloud_secret_status(state: State<CloudManager>, remote_url: Option<String>) -> Result<secrets::SecretStatus, String> {
    secrets::status_for(state.secrets.as_ref(), remote_url.as_deref())
}

/// `name` is `claude_oauth_token`, `github_token`, a scoped
/// `github_token:<owner>[/<repo>]`, or a project env slot. Empty clears it.
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
    /// Whether a non-empty value is stored (values never leave the Keychain here).
    pub set: bool,
}

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

const ENV_FILE_MAX: u64 = 256 * 1024;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct EnvImport {
    /// Names whose values were stored.
    pub imported: Vec<String>,
    /// `NAME: reason` for each variable left out. Never a value.
    pub skipped: Vec<String>,
    /// Lines that are not `KEY=value` with a valid key.
    pub invalid: usize,
}

/// Whether `file` is a plain `.env` or `.env.<suffix>` filename, not a path.
fn is_env_file_name(file: &str) -> bool {
    match file.strip_prefix(".env") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('.')
            .is_some_and(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')),
        None => false,
    }
}

/// Reads `<dir>/<file>` and stores every value in the repo's project env slots.
/// Re-importing overwrites, so a second run is idempotent.
pub fn import_env_file(store: &dyn SecretStore, repo_id: &str, dir: &Path, file: &str) -> Result<EnvImport, String> {
    if !is_env_file_name(file) {
        return Err(format!("`{file}` is not a .env filename (use .env or .env.<name>)"));
    }
    let path = dir.join(file);
    let meta = std::fs::metadata(&path).map_err(|_| format!("no {file} in {}", dir.display()))?;
    if meta.len() > ENV_FILE_MAX {
        return Err(format!("{file} is larger than {} KiB", ENV_FILE_MAX / 1024));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading {file}: {e}"))?;
    let (vars, invalid) = secrets::parse_dotenv(&text);
    let mut out = EnvImport { invalid, ..Default::default() };
    for (name, value) in vars {
        if secrets::RESERVED_ENV.contains(&name.as_str()) {
            out.skipped.push(format!("{name}: set in Settings → Cloud"));
        } else if value.trim().is_empty() {
            out.skipped.push(format!("{name}: empty"));
        } else {
            store.set(&secrets::project_env_slot(repo_id, &name), value.trim())?;
            out.imported.push(name);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn cloud_readiness(app: AppHandle, repo_id: String, worktree_path: String, env_names: Vec<String>) -> Result<Readiness, String> {
    blocking(move || Ok(readiness(&app.state::<CloudManager>(), &repo_id, Path::new(&worktree_path), &env_names))).await
}

/// `file` defaults to `.env`; only a filename in the worktree is accepted.
#[tauri::command]
pub fn cloud_import_env_file(state: State<CloudManager>, repo_id: String, worktree_path: String, file: Option<String>) -> Result<EnvImport, String> {
    let file = file.filter(|f| !f.trim().is_empty()).unwrap_or_else(|| ".env".into());
    import_env_file(state.secrets.as_ref(), &repo_id, Path::new(&worktree_path), file.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::secrets::MemoryStore;
    use crate::cloud::transport::{ExecOutput, MachineInfo, TResult};

    /// Answers exec by the first matching needle; records every script.
    struct FakeBoxd {
        answers: Vec<(&'static str, String)>,
        scripts: Mutex<Vec<String>>,
    }

    impl Boxd for FakeBoxd {
        fn machine_get(&self, vm: &str) -> TResult<MachineInfo> {
            Ok(MachineInfo { name: vm.into(), id: None, status: "running".into() })
        }
        fn machine_start(&self, _: &str) -> TResult<()> {
            Ok(())
        }
        fn machine_new(&self, vm: &str) -> TResult<MachineInfo> {
            self.machine_get(vm)
        }
        fn machine_remove(&self, _: &str) -> TResult<()> {
            Ok(())
        }
        fn cp_to(&self, _: &Path, _: &str, _: &str) -> TResult<()> {
            Ok(())
        }
        fn exec(&self, _: &str, argv: &[String], _: Duration) -> TResult<ExecOutput> {
            let script = argv.last().cloned().unwrap_or_default();
            self.scripts.lock().unwrap().push(script.clone());
            let output = self.answers.iter().find(|(needle, _)| script.contains(needle)).map(|(_, a)| a.clone()).unwrap_or_default();
            Ok(ExecOutput { output, exit_code: 0 })
        }
    }

    fn running(dir: &Path) -> CloudWorkspace {
        CloudWorkspace {
            id: "w1".into(),
            repo_id: "r".into(),
            branch_id: "b".into(),
            branch_name: "main".into(),
            worktree_path: dir.to_string_lossy().into(),
            remote_url: "https://github.com/a/b.git".into(),
            vm_name: "ph-main".into(),
            status: Status::Running,
            stage: Some("Agent working".into()),
            agent: "claude".into(),
            model: None,
            chat_id: Some("c".into()),
            created_at_ms: 1,
            updated_at_ms: 1,
            last_error: None,
            turn: 1,
            log_offset: 0,
            session_id: None,
            last_result: None,
            write_env_file: false,
        }
    }

    fn manager(dir: &Path, answers: Vec<(&'static str, String)>) -> CloudManager {
        let mut store = Store::open(dir.join("ws.json"));
        store.put(running(dir)).unwrap();
        let mut mgr = CloudManager::with(store, Arc::new(FakeBoxd { answers, scripts: Mutex::new(vec![]) }), Arc::new(MemoryStore::default()));
        mgr.github_fallback = || None;
        mgr
    }

    #[test]
    fn poll_streams_lines_then_settles_the_turn() {
        let dir = tempfile::tempdir().unwrap();
        let init = r#"{"type":"system","subtype":"init","session_id":"s1"}"#;
        let mgr = manager(dir.path(), vec![("turn-1.exit", format!("-\n{init}\n{{\"partial"))]);
        let seen = Mutex::new(vec![]);
        let notify = |w: &CloudWorkspace| seen.lock().unwrap().push(w.status);
        let out = poll(&mgr, &notify, "w1").unwrap();
        assert_eq!(out.lines, vec![init.to_string()]);
        assert_eq!(out.workspace.status, Status::Running);
        assert_eq!(out.workspace.session_id.as_deref(), Some("s1"));
        assert_eq!(out.workspace.log_offset, init.len() as u64 + 1);
        assert_eq!(*seen.lock().unwrap(), vec![Status::Running]);

        // The turn exits: the result is read, the clone inspected, the record settled.
        let result = r#"{"type":"result","is_error":false,"result":"Done: fixed X","total_cost_usd":0.1}"#;
        let mgr = manager(dir.path(), vec![
            ("turn-1.exit", format!("0\n{result}\n")),
            ("rev-parse HEAD", "abcdef1\n1\n0\n".into()),
        ]);
        let out = poll(&mgr, &|_: &CloudWorkspace| {}, "w1").unwrap();
        let w = out.workspace;
        assert_eq!(w.status, Status::Done);
        let r = w.last_result.unwrap();
        assert!(r.ok);
        assert_eq!(r.summary, "Done: fixed X");
        assert_eq!((r.head.as_deref(), r.unpushed_commits), (Some("abcdef1"), 1));
        assert!(r.local.starts_with("Could not fetch"), "{}", r.local); // not a git repo
        assert_eq!(mgr.store.lock().unwrap().get("w1").unwrap().status, Status::Done);
    }

    #[test]
    fn a_failed_turn_reports_the_agent_stderr_and_a_stop_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = manager(dir.path(), vec![("turn-1.exit", "1\n".into()), (".err", "Invalid API key\n".into())]);
        let w = poll(&mgr, &|_: &CloudWorkspace| {}, "w1").unwrap().workspace;
        assert_eq!(w.status, Status::Failed);
        assert_eq!(w.last_error.as_deref(), Some("Invalid API key"));

        let mgr = manager(dir.path(), vec![("turn-1.exit", "stopped\n".into())]);
        let w = poll(&mgr, &|_: &CloudWorkspace| {}, "w1").unwrap().workspace;
        assert_eq!(w.status, Status::Stopped);
        assert_eq!(w.last_error, None);
    }

    #[test]
    fn a_running_workspace_refuses_a_second_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = manager(dir.path(), vec![]);
        let err = send(&mgr, &|_: &CloudWorkspace| {}, "w1", "more", &[], false).unwrap_err();
        assert!(err.contains("still working"), "{err}");
    }

    #[test]
    fn only_claude_can_go_to_the_cloud() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = manager(dir.path(), vec![]);
        let req = StartRequest {
            repo_id: "r".into(),
            branch_id: "b2".into(),
            worktree_path: dir.path().to_string_lossy().into(),
            chat_id: None,
            agent: "codex".into(),
            model: None,
            handoff: String::new(),
            env_names: vec![],
            write_env_file: false,
        };
        assert!(begin(&mgr, &|_: &CloudWorkspace| {}, &req).unwrap_err().contains("Supported: Claude"));
    }

    #[test]
    fn readiness_lists_every_missing_key_until_they_are_set() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "feat"]).unwrap();
        git(&repo, &["remote", "add", "origin", "git@github.com:a/b.git"]).unwrap();
        let mgr = manager(dir.path(), vec![]);
        let names = vec!["API_KEY".to_string()];

        let r = readiness(&mgr, "r", &repo, &names);
        assert!(!r.ready);
        assert_eq!(r.missing.len(), 3, "{:?}", r.missing);
        assert!(r.missing[0].contains("Claude key missing"), "{:?}", r.missing);
        assert!(r.missing[1].contains("GitHub token missing"), "{:?}", r.missing);
        assert!(r.missing[2].contains("API_KEY"), "{:?}", r.missing);

        mgr.secrets.set(secrets::CLAUDE_OAUTH, "tok").unwrap();
        mgr.secrets.set("github_token:a", "gh").unwrap();
        mgr.secrets.set(&secrets::project_env_slot("r", "API_KEY"), "v").unwrap();
        let r = readiness(&mgr, "r", &repo, &names);
        assert!(r.ready, "{:?}", r.missing);

        // `begin` refuses with the same reasons, before any VM exists.
        mgr.secrets.clear(secrets::CLAUDE_OAUTH).unwrap();
        let req = StartRequest {
            repo_id: "r".into(),
            branch_id: "b2".into(),
            worktree_path: repo.to_string_lossy().into(),
            chat_id: None,
            agent: "claude".into(),
            model: None,
            handoff: String::new(),
            env_names: names,
            write_env_file: false,
        };
        assert!(begin(&mgr, &|_: &CloudWorkspace| {}, &req).unwrap_err().contains("Claude key missing"));
    }

    #[test]
    fn env_import_stores_values_and_refuses_paths_big_files_and_reserved_names() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        std::fs::write(dir.path().join(".env"), "API_KEY=abc\nGH_TOKEN=nope\nBLANK=\nbad line\n").unwrap();
        let out = import_env_file(&store, "r", dir.path(), ".env").unwrap();
        assert_eq!(out.imported, vec!["API_KEY".to_string()]);
        assert_eq!(out.skipped, vec!["GH_TOKEN: set in Settings → Cloud".to_string(), "BLANK: empty".to_string()]);
        assert_eq!(out.invalid, 1);
        assert_eq!(store.get("project_env:r:API_KEY").unwrap().as_deref(), Some("abc"));
        assert_eq!(store.get("project_env:r:GH_TOKEN").unwrap(), None);
        // A second import is idempotent.
        let again = import_env_file(&store, "r", dir.path(), ".env").unwrap();
        assert_eq!(again.imported, out.imported);
        assert_eq!(store.0.lock().unwrap().len(), 1);

        std::fs::write(dir.path().join(".env.local"), "X=1\n").unwrap();
        assert_eq!(import_env_file(&store, "r", dir.path(), ".env.local").unwrap().imported, vec!["X".to_string()]);
        for bad in ["../x", "../.env", "sub/.env", ".env.", ".envrc", "/etc/passwd", ".env.a/b"] {
            assert!(import_env_file(&store, "r", dir.path(), bad).unwrap_err().contains("not a .env filename"), "{bad}");
        }
        std::fs::write(dir.path().join(".env.big"), "A=".to_string() + &"x".repeat(300 * 1024)).unwrap();
        assert!(import_env_file(&store, "r", dir.path(), ".env.big").unwrap_err().contains("larger"));
        assert!(import_env_file(&store, "r", dir.path(), ".env.missing").unwrap_err().contains("no .env.missing"));
    }

    /// Real boxd, fake agent: proves detach, polling, exit and stop on a VM.
    /// `PH_CLOUD_E2E=1 cargo test cloud_mechanics_on_a_real_vm -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn cloud_mechanics_on_a_real_vm() {
        if std::env::var("PH_CLOUD_E2E").is_err() {
            return;
        }
        let boxd = BoxdCli::default();
        let vm = format!("ph-e2e-{}", &uuid::Uuid::new_v4().to_string()[..6]);
        let result = std::panic::catch_unwind(|| {
            ensure_running(&boxd, &vm).unwrap();
            exec_ok(&boxd, &vm, r#"mkdir -p "$HOME/.ph" "$HOME/repo" "$HOME/.local/bin" && chmod 700 "$HOME/.ph""#, EXEC_TIMEOUT).unwrap();
            upload(&boxd, &vm, "env", b"export FAKE_TOKEN='x'\n").unwrap();
            upload(&boxd, &vm, "run.sh", ws::RUN_SCRIPT.as_bytes()).unwrap();
            // A stand-in for claude: echoes its args and stdin as stream-json.
            let fake = r#"#!/bin/bash
p=$(cat)
echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-1\"}"
if [ "$p" = "hang" ]; then sleep 600; fi
echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"args: $*\"}]}}"
echo "{\"type\":\"result\",\"is_error\":false,\"result\":\"did $p with $FAKE_TOKEN\",\"session_id\":\"sess-1\"}"
"#;
            upload(&boxd, &vm, "fake-claude", fake.as_bytes()).unwrap();
            exec_ok(&boxd, &vm, r#"rm -f "$HOME/.local/bin/claude"; cp "$HOME/.ph/fake-claude" "$HOME/.local/bin/claude" && chmod +x "$HOME/.local/bin/claude""#, EXEC_TIMEOUT).unwrap();

            // The real setup script against a public repo: clone, branch, upstream.
            let setup = ws::setup_script("https://github.com/octocat/Hello-World.git", "master", "PH Test", "ph@test");
            let out = exec_ok(&boxd, &vm, &format!("rmdir \"$HOME/repo\" && {setup}"), SETUP_TIMEOUT).unwrap();
            assert!(out.contains("ready"), "{out}");
            // Idempotent on a reused VM.
            assert!(exec_ok(&boxd, &vm, &setup, SETUP_TIMEOUT).unwrap().contains("ready"));
            let (head, unpushed, dirty) = ws::parse_inspect(&exec_ok(&boxd, &vm, ws::INSPECT_COMMAND, EXEC_TIMEOUT).unwrap());
            assert!(head.is_some());
            assert_eq!((unpushed, dirty), (0, 0));

            // `.env` is refused while git would not ignore it, then written once it is.
            let dotenv = secrets::render_dotenv(&[("API_KEY".into(), "a b'c".into())]).unwrap();
            upload(&boxd, &vm, "dotenv", dotenv.as_bytes()).unwrap();
            let err = exec_ok(&boxd, &vm, ws::WRITE_DOTENV_COMMAND, EXEC_TIMEOUT).unwrap_err();
            assert!(err.contains(ws::DOTENV_NOT_IGNORED), "{err}");
            assert!(exec_ok(&boxd, &vm, r#"test ! -e "$HOME/repo/.env" && test ! -e "$HOME/.ph/dotenv""#, EXEC_TIMEOUT).is_ok());
            exec_ok(&boxd, &vm, r#"echo .env >> "$HOME/repo/.git/info/exclude""#, EXEC_TIMEOUT).unwrap();
            upload(&boxd, &vm, "dotenv", dotenv.as_bytes()).unwrap();
            exec_ok(&boxd, &vm, ws::WRITE_DOTENV_COMMAND, EXEC_TIMEOUT).unwrap();
            let out = exec_ok(&boxd, &vm, r#"cd "$HOME/repo" && stat -c %a .env && cat .env && git status --porcelain"#, EXEC_TIMEOUT).unwrap();
            assert_eq!(out.trim(), format!("600\n{}", dotenv.trim()), "the .env must be private and invisible to git");

            // Turn 1 runs to completion.
            upload(&boxd, &vm, "turn-1.prompt", b"work").unwrap();
            exec_ok(&boxd, &vm, &ws::launch_command(1, Some("opus"), None), EXEC_TIMEOUT).unwrap();
            let mut lines = vec![];
            let mut offset = 0;
            let deadline = std::time::Instant::now() + Duration::from_secs(60);
            loop {
                let chunk = ws::parse_poll(&exec_ok(&boxd, &vm, &ws::poll_command(1, offset), EXEC_TIMEOUT).unwrap());
                offset += chunk.consumed;
                lines.extend(chunk.lines);
                if chunk.exit != Exit::Running {
                    assert_eq!(chunk.exit, Exit::Code(0));
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "turn 1 never exited");
                std::thread::sleep(Duration::from_secs(1));
            }
            let facts = ws::scan_lines(&lines);
            assert_eq!(facts.session_id.as_deref(), Some("sess-1"));
            assert_eq!(facts.result, Some(("did work with x".into(), false)));
            assert!(lines[1].contains("--model opus"), "{lines:?}");

            // Turn 2 hangs and is stopped: the whole group dies, the marker is set.
            upload(&boxd, &vm, "turn-2.prompt", b"hang").unwrap();
            exec_ok(&boxd, &vm, &ws::launch_command(2, None, Some("sess-1")), EXEC_TIMEOUT).unwrap();
            std::thread::sleep(Duration::from_secs(3));
            exec_ok(&boxd, &vm, &ws::stop_command(2), EXEC_TIMEOUT).unwrap();
            let chunk = ws::parse_poll(&exec_ok(&boxd, &vm, &ws::poll_command(2, 0), EXEC_TIMEOUT).unwrap());
            assert_eq!(chunk.exit, Exit::Stopped);
            assert_eq!(chunk.lines.len(), 1, "{:?}", chunk.lines);
            let left = exec_ok(&boxd, &vm, "pgrep -x sleep | wc -l", EXEC_TIMEOUT).unwrap();
            assert_eq!(left.trim(), "0", "the agent's children survived the stop");
        });
        let _ = boxd.machine_remove(&vm);
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}
