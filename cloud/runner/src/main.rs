//! `powerhouse-runner`: the in-VM supervisor CLI. Every public operation prints
//! one JSON envelope on stdout and exits 0 (`{"ok": …}`) or 1 (`{"error": …}`).

mod agent;
mod exec;
mod fake;
mod gitops;
mod paths;
mod store;
mod systemd;
mod util;

use clap::{Parser, Subcommand};
use powerhouse_cloud_protocol::{
    AgentProvider, CredentialStatus, ProbeInfo, RunManifest, RunSnapshot, RunState, RunnerError,
    PROTOCOL_VERSION,
};
use store::{Store, StoreError};

const RUNNER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "powerhouse-runner", version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Report protocol/runner version and environment readiness.
    Probe,
    /// Idempotent installation: users, directories, store, boot reconcile unit.
    Install {
        /// Also install this binary to /usr/local/bin.
        #[arg(long, default_value_t = true)]
        install_binary: bool,
        /// Copy CLAUDE_CODE_OAUTH_TOKEN / GITHUB_PAT_TOKEN from the calling
        /// environment into the root-only credentials file.
        #[arg(long)]
        credentials_from_env: bool,
    },
    /// Print the canonical digest of a manifest (what `submit` will compute).
    Digest {
        #[arg(long)]
        manifest: std::path::PathBuf,
    },
    /// Accept a manifest and launch its supervised executor.
    Submit {
        #[arg(long)]
        manifest: std::path::PathBuf,
        /// SHA-256 the client computed; mismatch means a damaged upload.
        #[arg(long)]
        expect_digest: Option<String>,
    },
    /// Authoritative snapshot of one run.
    Inspect { run_id: String },
    /// Snapshots of all runs.
    List,
    /// Ordered event page.
    Events {
        run_id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
        #[arg(long, default_value_t = 200)]
        limit: u64,
    },
    /// Record cancellation intent and stop the supervisor unit.
    Cancel { run_id: String },
    /// Result manifest, when available.
    Result { run_id: String },
    /// The result diff (bounded).
    Diff { run_id: String },
    /// Reconcile live runs whose supervisor is gone.
    Reconcile {
        #[arg(long, default_value = "manual")]
        reason: String,
    },
    /// Internal: the per-run executor (launched by systemd-run).
    #[command(hide = true)]
    Execute { run_id: String },
    /// Internal: ExecStopPost hook.
    #[command(hide = true)]
    Finalize { run_id: String },
    /// Internal: deterministic fake agent.
    #[command(hide = true)]
    FakeAgent { script: String },
}

fn main() {
    let cli = Cli::parse();
    let self_bin = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| paths::DEFAULT_BIN.to_string());
    let code = match cli.cmd {
        Cmd::Probe => respond(probe()),
        Cmd::Install { install_binary, credentials_from_env } => {
            respond(install(&self_bin, install_binary, credentials_from_env))
        }
        Cmd::Digest { manifest } => respond(digest_of(&manifest)),
        Cmd::Submit { manifest, expect_digest } => respond(submit(&manifest, expect_digest.as_deref())),
        Cmd::Inspect { run_id } => respond(inspect(&run_id)),
        Cmd::List => respond(list()),
        Cmd::Events { run_id, after, limit } => respond(
            open_store().and_then(|s| s.events(&run_id, after, limit).map_err(store_err)),
        ),
        Cmd::Cancel { run_id } => respond(cancel(&run_id)),
        Cmd::Result { run_id } => respond(result(&run_id)),
        Cmd::Diff { run_id } => respond(diff(&run_id)),
        Cmd::Reconcile { reason } => respond(
            exec::reconcile(&reason)
                .map(|ids| serde_json::json!({ "reconciled": ids }))
                .map_err(|e| RunnerError::new("reconcile_failed", e)),
        ),
        Cmd::Execute { run_id } => match exec::execute(&run_id, &self_bin) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        Cmd::Finalize { run_id } => match exec::finalize(&run_id) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        Cmd::FakeAgent { script } => fake::run(&script),
    };
    std::process::exit(code);
}

fn respond<T: serde::Serialize>(r: Result<T, RunnerError>) -> i32 {
    match r {
        Ok(v) => {
            println!("{}", serde_json::json!({ "ok": v }));
            0
        }
        Err(e) => {
            println!("{}", serde_json::json!({ "error": e }));
            1
        }
    }
}

fn store_err(e: StoreError) -> RunnerError {
    match e {
        StoreError::Conflict(m) => RunnerError::new("conflict", m),
        StoreError::NotFound(m) => RunnerError::new("not_found", m),
        StoreError::Invalid(m) => RunnerError::new("invalid", m),
        StoreError::Sqlite(e) => RunnerError::new("store", e.to_string()),
    }
}

fn open_store() -> Result<Store, RunnerError> {
    Store::open(&paths::db_path()).map_err(store_err)
}

fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

fn probe() -> Result<ProbeInfo, RunnerError> {
    let os = std::process::Command::new("uname")
        .arg("-s")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let arch = std::process::Command::new("uname")
        .arg("-m")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let claude_version = std::process::Command::new("claude")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let git_version = std::process::Command::new("git")
        .arg("--version")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let secrets = exec::load_secrets();
    Ok(ProbeInfo {
        protocol_version: PROTOCOL_VERSION,
        runner_version: RUNNER_VERSION.to_string(),
        agents: vec![AgentProvider::Claude, AgentProvider::Fake],
        os,
        arch,
        systemd: systemd::is_available(),
        cgroup_v2: systemd::cgroup_v2(),
        agent_user_ready: exec::agent_uid_gid().is_ok(),
        store_ready: paths::db_path().exists(),
        claude_version,
        git_version,
        credentials: CredentialStatus {
            claude: !secrets.claude.is_empty(),
            git_publish: secrets.git_publish_token.is_some(),
        },
    })
}

fn install(self_bin: &str, install_binary: bool, credentials_from_env: bool) -> Result<serde_json::Value, RunnerError> {
    if !is_root() {
        return Err(RunnerError::new("not_root", "install must run as root"));
    }
    let mut steps = vec![];
    // Agent identity: system user, no login shell, no sudo/docker groups.
    if exec::agent_uid_gid().is_err() {
        let out = std::process::Command::new("useradd")
            .args(["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", "--user-group", paths::AGENT_USER])
            .output()
            .map_err(|e| RunnerError::new("useradd", e.to_string()))?;
        if !out.status.success() {
            return Err(RunnerError::new("useradd", String::from_utf8_lossy(&out.stderr).trim()));
        }
        steps.push("created agent user");
    }
    for (dir, mode) in [
        (paths::root(), 0o700),
        (paths::manifests_dir(), 0o700),
        (paths::root().join("results"), 0o700),
        (paths::root().join("publish"), 0o700),
        (paths::trusted_home(), 0o700),
        (paths::work_root(), 0o711),
    ] {
        std::fs::create_dir_all(&dir).map_err(|e| RunnerError::new("mkdir", format!("{}: {e}", dir.display())))?;
        std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(mode))
            .map_err(|e| RunnerError::new("chmod", e.to_string()))?;
    }
    Store::open(&paths::db_path()).map_err(store_err)?;
    std::fs::set_permissions(paths::db_path(), std::os::unix::fs::PermissionsExt::from_mode(0o600)).ok();
    steps.push("store ready");
    if install_binary && self_bin != paths::DEFAULT_BIN {
        let tmp = format!("{}.tmp", paths::DEFAULT_BIN);
        std::fs::copy(self_bin, &tmp).map_err(|e| RunnerError::new("install_binary", e.to_string()))?;
        std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o755)).ok();
        std::fs::rename(&tmp, paths::DEFAULT_BIN).map_err(|e| RunnerError::new("install_binary", e.to_string()))?;
        steps.push("binary installed");
    }
    if systemd::is_available() {
        systemd::write_reconcile_unit(paths::DEFAULT_BIN).map_err(|e| RunnerError::new("reconcile_unit", e))?;
        steps.push("reconcile unit enabled");
    }
    if credentials_from_env {
        let mut lines = vec![];
        for (from, to) in [
            ("CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"),
            ("GITHUB_PAT_TOKEN", "GIT_PUBLISH_TOKEN"),
        ] {
            if let Ok(v) = std::env::var(from) {
                if !v.trim().is_empty() {
                    lines.push(format!("{to}={}", v.trim()));
                }
            }
        }
        if lines.is_empty() {
            return Err(RunnerError::new("no_credentials", "no credential variables present in the calling environment"));
        }
        let path = std::path::Path::new(paths::CREDENTIALS_FILE);
        util::write_atomic(path, format!("{}\n", lines.join("\n")).as_bytes(), 0o600)
            .map_err(|e| RunnerError::new("credentials", e.to_string()))?;
        steps.push("credentials stored (root-only)");
    }
    Ok(serde_json::json!({ "steps": steps, "probe": probe()? }))
}

fn digest_of(path: &std::path::Path) -> Result<serde_json::Value, RunnerError> {
    let bytes = std::fs::read(path).map_err(|e| RunnerError::new("manifest_unreadable", e.to_string()))?;
    let manifest: RunManifest =
        serde_json::from_slice(&bytes).map_err(|e| RunnerError::new("manifest_invalid", e.to_string()))?;
    manifest.validate().map_err(|m| RunnerError::new("manifest_invalid", m))?;
    Ok(serde_json::json!({ "run_id": manifest.run_id, "digest": manifest.digest() }))
}

fn submit(manifest_path: &std::path::Path, expect_digest: Option<&str>) -> Result<powerhouse_cloud_protocol::Receipt, RunnerError> {
    let bytes = std::fs::read(manifest_path).map_err(|e| RunnerError::new("manifest_unreadable", e.to_string()))?;
    if bytes.len() > 1024 * 1024 {
        return Err(RunnerError::new("manifest_too_large", "manifest exceeds 1 MiB"));
    }
    let manifest: RunManifest =
        serde_json::from_slice(&bytes).map_err(|e| RunnerError::new("manifest_invalid", e.to_string()))?;
    manifest.validate().map_err(|m| RunnerError::new("manifest_invalid", m))?;
    let digest = manifest.digest();
    if let Some(expected) = expect_digest {
        if expected != digest {
            return Err(RunnerError::new(
                "digest_mismatch",
                format!("uploaded manifest digest {digest} does not match expected {expected}"),
            ));
        }
    }
    let mut store = open_store()?;
    let receipt = store.submit(&manifest).map_err(store_err)?;
    // Keep the accepted manifest in root-only storage (idempotent rewrite).
    let _ = util::write_atomic(
        &paths::manifests_dir().join(format!("{}.json", manifest.run_id)),
        &bytes,
        0o600,
    );
    if receipt.duplicate {
        return Ok(receipt);
    }
    // Launch boundary: checkpoint intent, then hand the run to systemd.
    let unit = paths::unit_name(&manifest.run_id);
    store.record_launch_attempt(&manifest.run_id, &unit).map_err(store_err)?;
    let backstop = manifest.deadline_seconds + 180;
    match systemd::launch_executor(&manifest.run_id, backstop, paths::DEFAULT_BIN) {
        Ok(_) => {
            let _ = store.append_event(&manifest.run_id, "run.launched", &serde_json::json!({ "unit": unit }));
            Ok(receipt)
        }
        Err(e) => {
            // Definite launch failure: nothing is running, say so durably.
            let _ = store.finish(
                &manifest.run_id,
                RunState::Failed,
                Some(powerhouse_cloud_protocol::RunError { stage: "launch".into(), message: e.clone() }),
                None,
            );
            let row = store.get(&manifest.run_id).map_err(store_err)?;
            Ok(powerhouse_cloud_protocol::Receipt {
                run_id: receipt.run_id,
                manifest_digest: receipt.manifest_digest,
                state: row.state,
                event_cursor: row.last_event_seq,
                accepted_at_ms: receipt.accepted_at_ms,
                duplicate: false,
            })
        }
    }
}

fn snapshot_with_unit(row: &store::RunRow) -> RunSnapshot {
    let unit_active = row.unit_name.as_ref().map(|u| {
        matches!(systemd::unit_status(u), systemd::UnitStatus::Active)
    });
    row.snapshot(unit_active)
}

fn inspect(run_id: &str) -> Result<RunSnapshot, RunnerError> {
    // Lazy reconciliation keeps snapshots honest without a daemon.
    let _ = exec::reconcile("inspect");
    let store = open_store()?;
    let row = store.get(run_id).map_err(store_err)?;
    Ok(snapshot_with_unit(&row))
}

fn list() -> Result<Vec<RunSnapshot>, RunnerError> {
    let _ = exec::reconcile("list");
    let store = open_store()?;
    Ok(store.list().map_err(store_err)?.iter().map(snapshot_with_unit).collect())
}

fn cancel(run_id: &str) -> Result<RunSnapshot, RunnerError> {
    let mut store = open_store()?;
    let row = store.request_cancel(run_id).map_err(store_err)?;
    if row.state.is_live() {
        if let Some(unit) = &row.unit_name {
            if matches!(systemd::unit_status(unit), systemd::UnitStatus::Active) {
                if let Err(e) = systemd::stop_unit(unit) {
                    let _ = store.append_event(run_id, "run.cancel_stop_error", &serde_json::json!({ "message": e }));
                }
            }
        }
    }
    drop(store);
    let _ = exec::reconcile("cancel");
    let store = open_store()?;
    let row = store.get(run_id).map_err(store_err)?;
    Ok(snapshot_with_unit(&row))
}

fn result(run_id: &str) -> Result<powerhouse_cloud_protocol::ResultManifest, RunnerError> {
    let store = open_store()?;
    let row = store.get(run_id).map_err(store_err)?;
    row.result
        .ok_or_else(|| RunnerError::new("not_available", format!("run {run_id} has no result yet (state {})", row.state.as_str())))
}

fn diff(run_id: &str) -> Result<serde_json::Value, RunnerError> {
    powerhouse_cloud_protocol::validate_run_id(run_id).map_err(|m| RunnerError::new("invalid", m))?;
    let path = paths::results_dir(run_id).join("diff.patch");
    let bytes = std::fs::read(&path).map_err(|_| RunnerError::new("not_available", "no diff recorded"))?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    let (cut, truncated) = util::truncate_utf8(&text, 2 * 1024 * 1024);
    Ok(serde_json::json!({ "patch": cut, "truncated": truncated, "bytes": bytes.len() }))
}
