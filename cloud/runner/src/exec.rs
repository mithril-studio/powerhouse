//! The per-run executor. Runs as root inside the run's transient systemd unit
//! and owns every state transition: workspace preparation, agent supervision,
//! checks, snapshot, publication, and terminal outcome.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use powerhouse_cloud_protocol::{
    AgentProvider, CheckResult, CheckStatus, ResultManifest, RunError, RunState,
};

use crate::agent::{self, AgentOutcome, AgentVerdict};
use crate::gitops;
use crate::paths;
use crate::store::{RunRow, Store};
use crate::util::{now_ms, tail_utf8, write_atomic};

const MAX_AGENT_EVENTS: u64 = 20_000;
const MAX_RAW_LOG_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHECK_LOG_BYTES: usize = 1024 * 1024;
const CHECK_TAIL_BYTES: usize = 16 * 1024;
const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;
const KILL_GRACE: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stop {
    Cancelled,
    Deadline,
    Terminated,
}

pub struct Secrets {
    pub claude: Vec<(String, String)>,
    pub git_publish_token: Option<String>,
    /// Per-project env vars (`ENV.<NAME>=<value>` lines): exported into the
    /// agent's environment and written to `<workspace>/.env`. Never handed to
    /// trusted git operations.
    pub project_env: Vec<(String, String)>,
}

/// Parse `KEY=VALUE` lines. Only known keys are accepted; `ENV.<NAME>` marks
/// a per-project env var (a real variable name can never contain `.`).
pub fn parse_secrets(text: &str) -> Secrets {
    let mut claude = vec![];
    let mut git = None;
    let mut project_env = vec![];
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let v = v.trim().trim_matches('"').to_string();
            if v.is_empty() {
                continue;
            }
            match k.trim() {
                "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" => claude.push((k.trim().to_string(), v)),
                "GIT_PUBLISH_TOKEN" => git = Some(v),
                key => {
                    if let Some(name) = key.strip_prefix("ENV.") {
                        if !name.is_empty() && !name.contains(|c: char| c.is_whitespace() || c == '=') {
                            project_env.push((name.to_string(), v));
                        }
                    }
                }
            }
        }
    }
    Secrets { claude, git_publish_token: git, project_env }
}

/// The run's own credentials, delivered with its submission. Nothing ambient
/// is ever consulted.
pub fn load_secrets(run_id: &str) -> Secrets {
    match std::fs::read_to_string(paths::credentials_file(run_id)) {
        Ok(text) => parse_secrets(&text),
        Err(_) => Secrets { claude: vec![], git_publish_token: None, project_env: vec![] },
    }
}

/// Overwrite and remove a secret file. Best effort; absence is success.
pub fn shred(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(path) {
            use std::io::Write;
            let zeros = vec![0u8; meta.len() as usize];
            let _ = f.write_all(&zeros);
            let _ = f.sync_all();
        }
        let _ = std::fs::remove_file(path);
    }
}

pub fn shred_run_credentials(run_id: &str) {
    shred(&paths::credentials_file(run_id));
}

pub fn agent_uid_gid() -> Result<(u32, u32), String> {
    let out = Command::new("id")
        .args(["-u", paths::AGENT_USER])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("agent user {} does not exist; run install", paths::AGENT_USER));
    }
    let uid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().map_err(|_| "bad uid")?;
    let out = Command::new("id")
        .args(["-g", paths::AGENT_USER])
        .output()
        .map_err(|e| e.to_string())?;
    let gid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().map_err(|_| "bad gid")?;
    Ok((uid, gid))
}

fn chown_recursive(path: &Path, uid: u32, gid: u32) -> Result<(), String> {
    let out = Command::new("chown")
        .arg("-R")
        .arg(format!("{uid}:{gid}"))
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

struct Ctx {
    store: Store,
    row: RunRow,
    owner: String,
    self_bin: String,
    deadline: Instant,
    terminating: Arc<AtomicBool>,
    results: PathBuf,
    workspace: PathBuf,
    trusted: PathBuf,
    uid: u32,
    gid: u32,
    secrets: Secrets,
    agent_events: u64,
    agent_events_dropped: u64,
}

impl Ctx {
    fn event(&mut self, kind: &str, payload: serde_json::Value) {
        let _ = self.store.append_event(&self.row.run_id, kind, &payload);
    }

    fn stage(&mut self, state: RunState, stage: &str) -> Result<(), String> {
        self.store
            .set_stage(&self.row.run_id, &self.owner, state, stage)
            .map_err(|e| e.to_string())
    }

    fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    /// Why we should stop right now, if anything.
    fn stop_reason(&self) -> Option<Stop> {
        // Cancellation first: `cancel` records intent and then stops the unit,
        // so a SIGTERM that follows a cancel request is a cancel, not a crash.
        if self.store.cancel_requested(&self.row.run_id).unwrap_or(false) {
            return Some(Stop::Cancelled);
        }
        if self.remaining().is_zero() {
            return Some(Stop::Deadline);
        }
        if self.terminating.load(Ordering::Relaxed) {
            return Some(Stop::Terminated);
        }
        None
    }

    fn agent_command(&self, mut cmd: Command) -> Command {
        cmd.uid(self.uid).gid(self.gid).process_group(0);
        cmd
    }
}

fn kill_group(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
    let start = Instant::now();
    while start.elapsed() < KILL_GRACE {
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

/// Entry point for `powerhouse-runner execute <run_id>`.
pub fn execute(run_id: &str, self_bin: &str) -> Result<(), String> {
    let mut store = Store::open(&paths::db_path()).map_err(|e| e.to_string())?;
    let row = store.get(run_id).map_err(|e| e.to_string())?;
    let owner = uuid::Uuid::new_v4().to_string();
    if !store.claim(run_id, &owner, std::process::id()).map_err(|e| e.to_string())? {
        eprintln!("run {run_id} already owned; refusing duplicate execution");
        return Ok(());
    }
    let terminating = Arc::new(AtomicBool::new(false));
    let _ = signal_hook::flag::register(signal_hook::consts::SIGTERM, terminating.clone());
    let _ = signal_hook::flag::register(signal_hook::consts::SIGINT, terminating.clone());

    let (uid, gid) = match agent_uid_gid() {
        Ok(v) => v,
        Err(e) => {
            let _ = store.finish(
                run_id,
                RunState::Failed,
                Some(RunError { stage: "preparing".into(), message: e.clone() }),
                None,
            );
            return Err(e);
        }
    };
    let started = row.started_at_ms.unwrap_or_else(now_ms);
    let elapsed_ms = now_ms().saturating_sub(started);
    let total = Duration::from_secs(row.manifest.deadline_seconds);
    let deadline = Instant::now() + total.saturating_sub(Duration::from_millis(elapsed_ms));

    let mut ctx = Ctx {
        results: paths::results_dir(run_id),
        workspace: paths::workspace_dir(run_id),
        trusted: paths::publish_dir(run_id),
        store,
        row,
        owner,
        self_bin: self_bin.to_string(),
        deadline,
        terminating,
        uid,
        gid,
        secrets: load_secrets(run_id),
        agent_events: 0,
        agent_events_dropped: 0,
    };
    std::fs::create_dir_all(&ctx.results).map_err(|e| e.to_string())?;
    ctx.event(
        "run.executor_started",
        serde_json::json!({ "pid": std::process::id(), "deadline_seconds": ctx.row.manifest.deadline_seconds }),
    );

    let outcome = run_stages(&mut ctx);
    // Whatever happened, nothing of ours may outlive the executor.
    let leftovers = crate::systemd::sweep_cgroup(KILL_GRACE);
    if !leftovers.is_empty() {
        ctx.event("run.sweep_leftovers", serde_json::json!({ "pids": leftovers }));
    }
    match outcome {
        Ok(()) => Ok(()),
        Err(e) => {
            // An internal error is still a definite outcome: record it as
            // failed at the current stage so finalize does not have to guess.
            eprintln!("run {run_id}: {e}");
            let stage = ctx.store.get(run_id).ok().and_then(|r| r.stage).unwrap_or_else(|| "executor".into());
            let partial = empty_result(&ctx);
            let _ = finish(&mut ctx, RunState::Failed, Some(RunError { stage, message: e.clone() }), &partial);
            Ok(())
        }
    }
}

fn empty_result(ctx: &Ctx) -> ResultManifest {
    ResultManifest {
        run_id: ctx.row.run_id.clone(),
        source_sha: ctx.row.manifest.source.commit_sha.clone(),
        result_sha: None,
        output_branch: ctx.row.manifest.output_branch.clone(),
        published: false,
        publish_error: None,
        summary: None,
        concerns: vec![],
        checks_configured: !ctx.row.manifest.checks.is_empty(),
        checks: ctx
            .row
            .manifest
            .checks
            .iter()
            .map(|c| CheckResult {
                name: c.name.clone(),
                command: c.command.clone(),
                status: CheckStatus::NotRun,
                exit_code: None,
                started_at_ms: None,
                duration_ms: None,
                output_tail: String::new(),
                output_truncated: false,
            })
            .collect(),
        tree_changed_after_checks: false,
        changed_files: vec![],
        diff_bytes: 0,
        diff_truncated: false,
        provider_session_id: None,
        usage: None,
        agent_exit_code: None,
        partial_work_preserved: false,
    }
}

fn persist_result(ctx: &mut Ctx, result: &ResultManifest) {
    let _ = ctx.store.set_result(&ctx.row.run_id, result);
    if let Ok(json) = serde_json::to_vec_pretty(result) {
        let _ = write_atomic(&ctx.results.join("result.json"), &json, 0o600);
    }
}

fn finish(ctx: &mut Ctx, state: RunState, error: Option<RunError>, result: &ResultManifest) -> Result<(), String> {
    // Credentials live exactly as long as the run.
    shred_run_credentials(&ctx.row.run_id);
    ctx.secrets = Secrets { claude: vec![], git_publish_token: None, project_env: vec![] };
    persist_result(ctx, result);
    let first = ctx
        .store
        .finish(&ctx.row.run_id, state, error, Some(result))
        .map_err(|e| e.to_string())?;
    if !first {
        ctx.event("run.terminal_already_recorded", serde_json::json!({ "attempted": state.as_str() }));
    }
    Ok(())
}

fn stop_to_outcome(stop: Stop, stage: &str) -> (RunState, Option<RunError>) {
    match stop {
        Stop::Cancelled => (RunState::Cancelled, None),
        Stop::Deadline => (
            RunState::Failed,
            Some(RunError { stage: stage.into(), message: format!("deadline exceeded during {stage}") }),
        ),
        Stop::Terminated => (
            RunState::Interrupted,
            Some(RunError { stage: stage.into(), message: "executor was terminated by the supervisor".into() }),
        ),
    }
}

fn run_stages(ctx: &mut Ctx) -> Result<(), String> {
    let mut result = empty_result(ctx);

    // ---- preparing -------------------------------------------------------
    if let Some(stop) = ctx.stop_reason() {
        let (state, err) = stop_to_outcome(stop, "preparing");
        return finish(ctx, state, err, &result);
    }
    if let Err(e) = prepare_workspace(ctx) {
        ctx.event("workspace.error", serde_json::json!({ "message": e }));
        return finish(ctx, RunState::Failed, Some(RunError { stage: "preparing".into(), message: e }), &result);
    }
    result.partial_work_preserved = true;
    ctx.event(
        "workspace.ready",
        serde_json::json!({ "sha": ctx.row.manifest.source.commit_sha, "path": ctx.workspace }),
    );

    // ---- running ---------------------------------------------------------
    ctx.stage(RunState::Running, "agent")?;
    let (agent_outcome, exit_code, stop) = run_agent(ctx)?;
    result.provider_session_id = agent_outcome.session_id.clone();
    result.summary = agent_outcome.summary.clone();
    result.usage = agent_outcome.usage.clone();
    result.agent_exit_code = exit_code;
    for d in &agent_outcome.permission_denials {
        result.concerns.push(format!("permission denied: {d}"));
    }
    ctx.event(
        "agent.exited",
        serde_json::json!({ "exit_code": exit_code, "stopped_by": stop.map(|s| format!("{s:?}")), "session_id": agent_outcome.session_id }),
    );
    if let Some(stop) = stop {
        let (state, err) = stop_to_outcome(stop, "agent");
        return finish(ctx, state, err, &result);
    }
    match agent_outcome.classify(exit_code) {
        AgentVerdict::Done => {}
        AgentVerdict::Blocked(reason) => {
            return finish(ctx, RunState::Blocked, Some(RunError { stage: "agent".into(), message: reason }), &result);
        }
        AgentVerdict::Failed(reason) => {
            return finish(ctx, RunState::Failed, Some(RunError { stage: "agent".into(), message: reason }), &result);
        }
    }

    // ---- validating ------------------------------------------------------
    ctx.stage(RunState::Validating, "checks")?;
    let tested_tree = match gitops::snapshot_tree(&ctx.trusted, &ctx.workspace) {
        Ok(t) => t,
        Err(e) => {
            return finish(ctx, RunState::Failed, Some(RunError { stage: "validating".into(), message: format!("snapshot failed: {e}") }), &result);
        }
    };
    ctx.event("snapshot.tree", serde_json::json!({ "tree": tested_tree, "phase": "before_checks" }));
    let checks_verdict = run_checks(ctx, &mut result);
    let after_tree = gitops::snapshot_tree(&ctx.trusted, &ctx.workspace).unwrap_or_default();
    result.tree_changed_after_checks = after_tree != tested_tree;
    if result.tree_changed_after_checks {
        result.concerns.push("tracked files changed while checks ran; the published revision is the pre-check tree".into());
        ctx.event("snapshot.tree", serde_json::json!({ "tree": after_tree, "phase": "after_checks", "changed": true }));
    }
    if let Err(stop) = checks_verdict {
        let (state, err) = stop_to_outcome(stop, "validating");
        return finish(ctx, state, err, &result);
    }
    let checks_failed = result.checks.iter().find(|c| c.status == CheckStatus::Failed).cloned();

    // ---- publishing ------------------------------------------------------
    ctx.stage(RunState::Publishing, "publish")?;
    if let Some(stop) = ctx.stop_reason() {
        let (state, err) = stop_to_outcome(stop, "publishing");
        return finish(ctx, state, err, &result);
    }
    let publish_result = publish(ctx, &mut result, &tested_tree);

    if let Some(c) = checks_failed {
        let msg = match c.exit_code {
            Some(code) => format!("check “{}” failed (exit {code})", if c.name.is_empty() { &c.command } else { &c.name }),
            None => format!("check “{}” could not run", if c.name.is_empty() { &c.command } else { &c.name }),
        };
        return finish(ctx, RunState::Failed, Some(RunError { stage: "validating".into(), message: msg }), &result);
    }
    if let Err(e) = publish_result {
        return finish(ctx, RunState::Failed, Some(RunError { stage: "publishing".into(), message: e }), &result);
    }
    finish(ctx, RunState::Completed, None, &result)
}

fn prepare_workspace(ctx: &mut Ctx) -> Result<(), String> {
    let m = ctx.row.manifest.clone();
    std::fs::create_dir_all(paths::trusted_home()).map_err(|e| e.to_string())?;
    let auth = ctx
        .secrets
        .git_publish_token
        .as_ref()
        .filter(|_| m.source.remote_url.starts_with("https://"))
        .map(|t| gitops::https_auth_env(t))
        .unwrap_or_default();
    ctx.event("workspace.fetch", serde_json::json!({ "remote": m.source.remote_url, "sha": m.source.commit_sha }));
    gitops::clone_exact(&m.source.remote_url, &m.source.commit_sha, &ctx.trusted, &auth)?;
    let work = paths::work_dir(&m.run_id);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    gitops::create_agent_checkout(&ctx.trusted, &ctx.workspace, &m.source.remote_url, &m.source.commit_sha)?;
    // Context from the desktop: `.powerhouse/cloud-task.md`, excluded from
    // snapshots via the trusted repo's info/exclude (the agent's `.git` is
    // never consulted for ignore rules).
    let ph_dir = ctx.workspace.join(".powerhouse");
    std::fs::create_dir_all(&ph_dir).map_err(|e| e.to_string())?;
    let brief = render_brief(&m);
    std::fs::write(ph_dir.join("cloud-task.md"), brief).map_err(|e| e.to_string())?;
    // Per-project env vars: also on disk, so build/test tooling that reads
    // `.env` works. Excluded from snapshots below, like the brief.
    if !ctx.secrets.project_env.is_empty() {
        let env_text: String = ctx.secrets.project_env.iter().map(|(k, v)| format!("{k}={v}\n")).collect();
        std::fs::write(ctx.workspace.join(".env"), env_text).map_err(|e| e.to_string())?;
    }
    let exclude = ctx.trusted.join(".git").join("info").join("exclude");
    if let Some(parent) = exclude.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&exclude).map_err(|e| e.to_string())?;
        writeln!(f, ".powerhouse/").map_err(|e| e.to_string())?;
        writeln!(f, ".env").map_err(|e| e.to_string())?;
    }
    let home = paths::agent_home(&m.run_id);
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    chown_recursive(&work, ctx.uid, ctx.gid)?;
    std::fs::set_permissions(&work, std::os::unix::fs::PermissionsExt::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The brief the agent reads first: task, criteria, checks, and the plan the
/// desktop attached.
pub fn render_brief(m: &powerhouse_cloud_protocol::RunManifest) -> String {
    let mut out = String::new();
    out.push_str("# Cloud task\n\n");
    out.push_str(&format!("Run: {}\nRepository: {}\nSource commit: {}\n", m.run_id, m.source.repo_name, m.source.commit_sha));
    if let Some(b) = &m.source.source_branch {
        out.push_str(&format!("Source branch: {b}\n"));
    }
    out.push_str(&format!("Deadline: {} minutes\n\n## Task\n\n{}\n", m.deadline_seconds / 60, m.task.text.trim()));
    if !m.task.acceptance_criteria.is_empty() {
        out.push_str("\n## Acceptance criteria\n\n");
        for c in &m.task.acceptance_criteria {
            out.push_str(&format!("- {c}\n"));
        }
    }
    if !m.checks.is_empty() {
        out.push_str("\n## Checks that run after you finish\n\n");
        for c in &m.checks {
            out.push_str(&format!("- `{}`{}\n", c.command, if c.name.is_empty() { String::new() } else { format!(" ({})", c.name) }));
        }
    }
    if !m.context.brief_markdown.trim().is_empty() {
        out.push_str("\n## Context and plan from Powerhouse\n\n");
        out.push_str(m.context.brief_markdown.trim());
        out.push('\n');
    }
    out.push_str("\n## Rules\n\n- Work only inside this checkout. Do not push, open pull requests, or switch branches.\n- Nobody can answer questions; if blocked, explain why in your final message and stop.\n- End with a short summary of what changed and any remaining concerns.\n");
    out
}

/// Spawn the agent under the unprivileged identity and stream its output.
fn run_agent(ctx: &mut Ctx) -> Result<(AgentOutcome, Option<i32>, Option<Stop>), String> {
    let m = ctx.row.manifest.clone();
    // The fake provider walks the same delivery path as the real one, so tests
    // prove what the agent process can and cannot see.
    let mut secrets: Vec<(String, String)> = ctx.secrets.claude.clone();
    if m.agent.provider == AgentProvider::Claude && secrets.is_empty() {
        return Ok((
            AgentOutcome::default(),
            Some(78),
            None,
        ))
        .map(|(mut o, c, s)| {
            o.result_subtype = Some("no_credentials".into());
            (o, c, s)
        });
    }
    secrets.extend(ctx.secrets.project_env.iter().cloned());
    let home = paths::agent_home(&m.run_id);
    let mut cmd = agent::build_command(&m, &ctx.self_bin, &ctx.workspace, &home, &secrets);
    cmd.env("POWERHOUSE_RUNNER_ROOT", paths::root());
    let stderr_path = ctx.results.join("agent.stderr.log");
    let stderr_file = std::fs::File::create(&stderr_path).map_err(|e| e.to_string())?;
    let mut cmd = ctx.agent_command(cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::from(stderr_file));
    let mut child = cmd.spawn().map_err(|e| format!("could not start agent: {e}"))?;
    ctx.event("agent.started", serde_json::json!({ "pid": child.id(), "provider": m.agent.provider }));

    let stdout = child.stdout.take().ok_or("agent stdout missing")?;
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.split(b'\n') {
            match line {
                Ok(bytes) => {
                    let _ = tx.send(Some(String::from_utf8_lossy(&bytes).to_string()));
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(None);
    });

    let mut raw = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(ctx.results.join("agent.jsonl"))
        .map_err(|e| e.to_string())?;
    let mut raw_bytes: u64 = 0;
    let mut outcome = AgentOutcome::default();
    let mut eof = false;
    let mut stop: Option<Stop> = None;
    let mut exit: Option<Option<i32>> = None;
    // Once the agent process itself has exited, descendants holding the stdout
    // pipe (e.g. a backgrounded child) must not keep the run alive; but every
    // line that is still arriving is drained first.
    let mut exited = false;
    let mut last_line_at = Instant::now();

    loop {
        // Drain available lines (bounded burst), then store them in one transaction.
        let mut batch: Vec<(String, serde_json::Value)> = Vec::new();
        let drain_started = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(line)) => {
                    last_line_at = Instant::now();
                    if raw_bytes < MAX_RAW_LOG_BYTES {
                        let _ = raw.write_all(line.as_bytes());
                        let _ = raw.write_all(b"\n");
                        raw_bytes += line.len() as u64 + 1;
                    }
                    if let Some(ev) = classify_agent_line(ctx, &mut outcome, &line) {
                        batch.push(ev);
                    }
                    if batch.len() >= 500 || drain_started.elapsed() > Duration::from_secs(1) {
                        break;
                    }
                }
                Ok(None) => {
                    eof = true;
                    break;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    eof = true;
                    break;
                }
            }
        }
        if !batch.is_empty() {
            let _ = ctx.store.append_events(&ctx.row.run_id, &batch);
        }
        if exit.is_none() {
            if let Ok(Some(status)) = child.try_wait() {
                exit = Some(status.code());
                exited = true;
                // The agent is done; anything still in its process group is a stray.
                kill_group(&mut child);
            }
        }
        if exit.is_some() && eof {
            break;
        }
        if exited && !eof && last_line_at.elapsed() > Duration::from_secs(3) {
            ctx.event("agent.output_pipe_abandoned", serde_json::Value::Null);
            break;
        }
        if exit.is_none() && stop.is_none() {
            if let Some(reason) = ctx.stop_reason() {
                stop = Some(reason);
                ctx.event("agent.stopping", serde_json::json!({ "reason": format!("{reason:?}") }));
                kill_group(&mut child);
                exit = Some(child.try_wait().ok().flatten().and_then(|s| s.code()));
            }
        }
    }
    let _ = raw.flush();
    if ctx.agent_events_dropped > 0 {
        let dropped = ctx.agent_events_dropped;
        ctx.event("output.truncated", serde_json::json!({ "dropped_events": dropped, "raw_log": "agent.jsonl" }));
    }
    // Reap anything the agent left behind in its process group.
    kill_group(&mut child);
    Ok((outcome, exit.flatten(), stop))
}

/// Parse one output line, feed the outcome, and return the event to store
/// (or `None` once the per-run event budget is exhausted).
fn classify_agent_line(ctx: &mut Ctx, outcome: &mut AgentOutcome, line: &str) -> Option<(String, serde_json::Value)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => serde_json::json!({ "type": "raw", "text": tail_utf8(trimmed, 8192).0 }),
    };
    outcome.absorb(&value);
    if ctx.agent_events >= MAX_AGENT_EVENTS {
        ctx.agent_events_dropped += 1;
        return None;
    }
    ctx.agent_events += 1;
    let kind = format!(
        "agent.{}",
        value.get("type").and_then(|t| t.as_str()).unwrap_or("raw")
    );
    Some((kind, value))
}

/// Run every configured check in order under the agent identity. Returns
/// `Err(stop)` when the run must stop; check failures are recorded in
/// `result` and do not stop the remaining pipeline decisions.
fn run_checks(ctx: &mut Ctx, result: &mut ResultManifest) -> Result<(), Stop> {
    let checks = ctx.row.manifest.checks.clone();
    if checks.is_empty() {
        ctx.event("checks.none_configured", serde_json::Value::Null);
        return Ok(());
    }
    let mut failed = false;
    for (idx, check) in checks.iter().enumerate() {
        if failed {
            result.checks[idx].status = CheckStatus::Skipped;
            continue;
        }
        if let Some(stop) = ctx.stop_reason() {
            return Err(stop);
        }
        ctx.event("check.started", serde_json::json!({ "index": idx, "name": check.name, "command": check.command }));
        let started = now_ms();
        let t0 = Instant::now();
        let log_path = ctx.results.join(format!("check-{idx}.log"));
        let (exit, stop) = run_check_command(ctx, &check.command, &log_path);
        let dur = t0.elapsed().as_millis() as u64;
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        let (tail, truncated) = tail_utf8(&log, CHECK_TAIL_BYTES);
        let cr = &mut result.checks[idx];
        cr.started_at_ms = Some(started);
        cr.duration_ms = Some(dur);
        cr.exit_code = exit;
        cr.output_tail = tail.to_string();
        cr.output_truncated = truncated || log.len() >= MAX_CHECK_LOG_BYTES;
        cr.status = match exit {
            Some(0) => CheckStatus::Passed,
            _ => CheckStatus::Failed,
        };
        let status = cr.status;
        ctx.event(
            "check.finished",
            serde_json::json!({ "index": idx, "name": check.name, "exit_code": exit, "duration_ms": dur, "status": status }),
        );
        if let Some(stop) = stop {
            return Err(stop);
        }
        if status != CheckStatus::Passed {
            failed = true;
        }
    }
    Ok(())
}

fn run_check_command(ctx: &mut Ctx, command: &str, log_path: &Path) -> (Option<i32>, Option<Stop>) {
    let log = match std::fs::File::create(log_path) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let log_err = match log.try_clone() {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let home = paths::agent_home(&ctx.row.run_id);
    let mut cmd = Command::new("/bin/bash");
    cmd.arg("-c").arg(command);
    cmd.env_clear()
        .env("PATH", format!("{}:/usr/local/bin:/usr/bin:/bin", paths::AGENT_TOOLS_BIN))
        .env("HOME", &home)
        .env("USER", paths::AGENT_USER)
        .env("LANG", "C.UTF-8")
        .env("TERM", "dumb")
        .env("CI", "1");
    // Checks see the project env (build/test commands need the same keys the
    // agent had), never the model or git credentials.
    for (k, v) in &ctx.secrets.project_env {
        cmd.env(k, v);
    }
    cmd.current_dir(&ctx.workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    let mut cmd = ctx.agent_command(cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::write(log_path, format!("could not start check: {e}\n"));
            return (None, None);
        }
    };
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                kill_group(&mut child);
                return (status.code(), None);
            }
            Ok(None) => {}
            Err(_) => return (None, None),
        }
        if let Some(stop) = ctx.stop_reason() {
            kill_group(&mut child);
            return (None, Some(stop));
        }
        if let Ok(meta) = std::fs::metadata(log_path) {
            if meta.len() as usize > MAX_CHECK_LOG_BYTES {
                // Bound runaway output; the check keeps running but its log stops growing.
                let _ = std::fs::OpenOptions::new().write(true).open(log_path).and_then(|f| f.set_len(MAX_CHECK_LOG_BYTES as u64));
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn publish(ctx: &mut Ctx, result: &mut ResultManifest, tested_tree: &str) -> Result<(), String> {
    let m = ctx.row.manifest.clone();
    let message = format!(
        "Powerhouse cloud run {}\n\nTask: {}\nSource: {}\n",
        m.run_id,
        m.task.text.lines().next().unwrap_or(""),
        m.source.commit_sha
    );
    let result_sha = gitops::commit_tree(&ctx.trusted, tested_tree, &m.source.commit_sha, &message)?;
    result.result_sha = Some(result_sha.clone());
    ctx.event("publish.result_sha", serde_json::json!({ "result_sha": result_sha, "unchanged": result_sha == m.source.commit_sha }));

    let trusted = gitops::TrustedGit::new(ctx.trusted.clone());
    if result_sha != m.source.commit_sha {
        let names = trusted.ok(&["diff", "--name-only", &m.source.commit_sha, &result_sha])?;
        result.changed_files = names.lines().map(|s| s.to_string()).filter(|s| !s.is_empty()).collect();
        let mut patch = trusted.raw(&["diff", "--no-color", "--binary", &m.source.commit_sha, &result_sha])?;
        result.diff_bytes = patch.len() as u64;
        if patch.len() > MAX_DIFF_BYTES {
            patch.truncate(MAX_DIFF_BYTES);
            result.diff_truncated = true;
        }
        write_atomic(&ctx.results.join("diff.patch"), &patch, 0o600).map_err(|e| e.to_string())?;
    } else {
        write_atomic(&ctx.results.join("diff.patch"), b"", 0o600).map_err(|e| e.to_string())?;
    }
    persist_result(ctx, result);

    let auth = if m.source.remote_url.starts_with("https://") {
        match &ctx.secrets.git_publish_token {
            Some(t) => gitops::https_auth_env(t),
            None => {
                let msg = "no publication credential configured (GIT_PUBLISH_TOKEN); result kept locally".to_string();
                result.publish_error = Some(msg.clone());
                ctx.event("publish.skipped", serde_json::json!({ "reason": msg }));
                return Err(msg);
            }
        }
    } else {
        vec![]
    };
    match gitops::publish(&ctx.trusted, &m.source.remote_url, &m.output_branch, &result_sha, &auth) {
        Ok(p) => {
            result.published = true;
            ctx.event("publish.done", serde_json::json!({ "branch": m.output_branch, "result_sha": result_sha, "already_present": p.already }));
            Ok(())
        }
        Err(e) => {
            result.publish_error = Some(e.clone());
            ctx.event("publish.error", serde_json::json!({ "message": e }));
            Err(e)
        }
    }
}

/// `ExecStopPost` hook: runs after every process in the unit's cgroup is gone.
/// Converts a still-live run into the truthful terminal state.
pub fn finalize(run_id: &str) -> Result<(), String> {
    let mut store = Store::open(&paths::db_path()).map_err(|e| e.to_string())?;
    let row = store.get(run_id).map_err(|e| e.to_string())?;
    let service_result = std::env::var("SERVICE_RESULT").unwrap_or_else(|_| "unknown".into());
    let exit_code = std::env::var("EXIT_CODE").unwrap_or_default();
    let exit_status = std::env::var("EXIT_STATUS").unwrap_or_default();
    let _ = store.append_event(
        run_id,
        "unit.finished",
        &serde_json::json!({ "service_result": service_result, "exit_code": exit_code, "exit_status": exit_status, "state_before": row.state.as_str() }),
    );
    if row.state.is_terminal() {
        return Ok(());
    }
    let (state, error) = if row.cancel_requested {
        (RunState::Cancelled, None)
    } else if service_result == "timeout" {
        (
            RunState::Failed,
            Some(RunError { stage: row.stage.clone().unwrap_or_else(|| "unknown".into()), message: "supervisor backstop deadline exceeded".into() }),
        )
    } else {
        (
            RunState::Interrupted,
            Some(RunError {
                stage: row.stage.clone().unwrap_or_else(|| "unknown".into()),
                message: format!("executor ended without recording an outcome (service_result={service_result}, exit={exit_code}/{exit_status})"),
            }),
        )
    };
    let mut partial = row.result.clone().unwrap_or_else(|| {
        let mut r = ResultManifest {
            run_id: run_id.to_string(),
            source_sha: row.manifest.source.commit_sha.clone(),
            result_sha: None,
            output_branch: row.manifest.output_branch.clone(),
            published: false,
            publish_error: None,
            summary: None,
            concerns: vec![],
            checks_configured: !row.manifest.checks.is_empty(),
            checks: vec![],
            tree_changed_after_checks: false,
            changed_files: vec![],
            diff_bytes: 0,
            diff_truncated: false,
            provider_session_id: None,
            usage: None,
            agent_exit_code: None,
            partial_work_preserved: paths::workspace_dir(run_id).exists(),
        };
        r.checks = row
            .manifest
            .checks
            .iter()
            .map(|c| CheckResult {
                name: c.name.clone(),
                command: c.command.clone(),
                status: CheckStatus::NotRun,
                exit_code: None,
                started_at_ms: None,
                duration_ms: None,
                output_tail: String::new(),
                output_truncated: false,
            })
            .collect();
        r
    });
    partial.partial_work_preserved = paths::workspace_dir(run_id).exists();
    store.finish(run_id, state, error, Some(&partial)).map_err(|e| e.to_string())?;
    shred_run_credentials(run_id);
    Ok(())
}

/// Boot-time and lazy reconciliation: any live run whose unit is gone and whose
/// launch is old enough to rule out a race becomes `interrupted`.
pub fn reconcile(reason: &str) -> Result<Vec<String>, String> {
    let mut store = Store::open(&paths::db_path()).map_err(|e| e.to_string())?;
    let rows = store.list().map_err(|e| e.to_string())?;
    let mut touched = vec![];
    let now = now_ms();
    for row in rows.into_iter().filter(|r| r.state.is_live()) {
        let unit = row.unit_name.clone().unwrap_or_else(|| paths::unit_name(&row.run_id));
        let status = crate::systemd::unit_status(&unit);
        let age_ok = match row.launch_attempted_at_ms {
            Some(t) => now.saturating_sub(t) > 30_000,
            None => now.saturating_sub(row.accepted_at_ms) > 120_000,
        };
        let gone = matches!(status, crate::systemd::UnitStatus::Inactive | crate::systemd::UnitStatus::NotFound);
        if gone && (age_ok || reason == "boot") {
            let stage = row.stage.clone().unwrap_or_else(|| row.state.as_str().to_string());
            let (state, msg) = if row.cancel_requested {
                (RunState::Cancelled, "cancel requested and no executor is running".to_string())
            } else {
                (
                    RunState::Interrupted,
                    format!("execution ownership lost ({reason}): supervisor unit {unit} is {status:?}"),
                )
            };
            let _ = store.append_event(&row.run_id, "run.reconciled", &serde_json::json!({ "reason": reason, "unit": unit, "unit_status": format!("{status:?}") }));
            let _ = store.finish(&row.run_id, state, Some(RunError { stage, message: msg }), None);
            shred_run_credentials(&row.run_id);
            touched.push(row.run_id.clone());
        }
    }
    Ok(touched)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_secrets_accepts_known_keys_and_project_env_lines() {
        let s = parse_secrets(
            "CLAUDE_CODE_OAUTH_TOKEN=tok\nGIT_PUBLISH_TOKEN=git\nENV.FOO_API_KEY=abc\nENV.BAR=\"quoted\"\n# comment\nUNKNOWN=x\nENV.=bad\nENV.BAD NAME=x\n",
        );
        assert_eq!(s.claude, vec![("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "tok".to_string())]);
        assert_eq!(s.git_publish_token.as_deref(), Some("git"));
        assert_eq!(
            s.project_env,
            vec![("FOO_API_KEY".to_string(), "abc".to_string()), ("BAR".to_string(), "quoted".to_string())],
            "ENV.-prefixed lines become project env; malformed names are dropped"
        );
    }

    #[test]
    fn a_project_env_var_named_like_a_credential_stays_a_plain_env_var() {
        let s = parse_secrets("ENV.GIT_PUBLISH_TOKEN=nope\n");
        assert!(s.git_publish_token.is_none(), "trusted git never sees a project env value");
        assert_eq!(s.project_env, vec![("GIT_PUBLISH_TOKEN".to_string(), "nope".to_string())]);
    }
}
