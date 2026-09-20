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
}

/// Parse `KEY=VALUE` lines from the root-only credentials file.
pub fn load_secrets() -> Secrets {
    let mut claude = vec![];
    let mut git = None;
    if let Ok(text) = std::fs::read_to_string(paths::CREDENTIALS_FILE) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let v = v.trim().trim_matches('"').to_string();
                match k.trim() {
                    "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" => {
                        claude.push((k.trim().to_string(), v))
                    }
                    "GIT_PUBLISH_TOKEN" => git = Some(v),
                    _ => {}
                }
            }
        }
    }
    Secrets {
        claude,
        git_publish_token: git,
    }
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
        secrets: load_secrets(),
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
            eprintln!("run {run_id}: {e}");
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
    let home = paths::agent_home(&m.run_id);
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    chown_recursive(&work, ctx.uid, ctx.gid)?;
    std::fs::set_permissions(&work, std::os::unix::fs::PermissionsExt::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Spawn the agent under the unprivileged identity and stream its output.
fn run_agent(ctx: &mut Ctx) -> Result<(AgentOutcome, Option<i32>, Option<Stop>), String> {
    let m = ctx.row.manifest.clone();
    let secrets: Vec<(String, String)> = match m.agent.provider {
        AgentProvider::Claude => ctx.secrets.claude.clone(),
        AgentProvider::Fake => vec![],
    };
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

    loop {
        // Drain available lines without blocking for long.
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(line)) => {
                    if raw_bytes < MAX_RAW_LOG_BYTES {
                        let _ = raw.write_all(line.as_bytes());
                        let _ = raw.write_all(b"\n");
                        raw_bytes += line.len() as u64 + 1;
                    }
                    record_agent_line(ctx, &mut outcome, &line);
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
        if exit.is_none() {
            if let Ok(Some(status)) = child.try_wait() {
                exit = Some(status.code());
            }
        }
        if exit.is_some() && eof {
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

fn record_agent_line(ctx: &mut Ctx, outcome: &mut AgentOutcome, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => serde_json::json!({ "type": "raw", "text": tail_utf8(trimmed, 8192).0 }),
    };
    outcome.absorb(&value);
    if ctx.agent_events >= MAX_AGENT_EVENTS {
        ctx.agent_events_dropped += 1;
        return;
    }
    ctx.agent_events += 1;
    let kind = format!(
        "agent.{}",
        value.get("type").and_then(|t| t.as_str()).unwrap_or("raw")
    );
    ctx.event(&kind, value);
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
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", &home)
        .env("USER", paths::AGENT_USER)
        .env("LANG", "C.UTF-8")
        .env("TERM", "dumb")
        .env("CI", "1")
        .current_dir(&ctx.workspace)
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
            touched.push(row.run_id.clone());
        }
    }
    Ok(touched)
}
