//! Filesystem layout. Everything under `root()` is owned by root, mode 0700;
//! the agent identity can only reach `work_dir(run_id)`.

use std::path::PathBuf;

pub const DEFAULT_ROOT: &str = "/var/lib/powerhouse-runner";
pub const DEFAULT_WORK_ROOT: &str = "/var/lib/powerhouse-runner-work";
pub const DEFAULT_BIN: &str = "/usr/local/bin/powerhouse-runner";
pub const AGENT_USER: &str = "powerhouse-agent";
pub const UNIT_PREFIX: &str = "powerhouse-run-";
/// Tools staged for the unprivileged agent identity (root-owned, world-readable).
/// The base image keeps Claude under /home/boxd, which the agent cannot traverse.
pub const AGENT_TOOLS_BIN: &str = "/opt/powerhouse/bin";
pub const RECONCILE_UNIT: &str = "powerhouse-runner-reconcile.service";

/// `POWERHOUSE_RUNNER_ROOT` lets tests point the store somewhere writable.
pub fn root() -> PathBuf {
    std::env::var_os("POWERHOUSE_RUNNER_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_ROOT))
}

pub fn work_root() -> PathBuf {
    std::env::var_os("POWERHOUSE_RUNNER_WORK_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_WORK_ROOT))
}

pub fn db_path() -> PathBuf {
    root().join("runner.db")
}

pub fn manifests_dir() -> PathBuf {
    root().join("manifests")
}

/// Per-run credentials delivered with the submission; root-only, shredded at
/// the run's terminal state. There is deliberately no machine-wide file.
pub fn credentials_dir() -> PathBuf {
    root().join("credentials")
}

pub fn credentials_file(run_id: &str) -> PathBuf {
    credentials_dir().join(format!("{run_id}.env"))
}

pub fn results_dir(run_id: &str) -> PathBuf {
    root().join("results").join(run_id)
}

/// Trusted clone used for snapshots and publication; never touched by the agent.
pub fn publish_dir(run_id: &str) -> PathBuf {
    root().join("publish").join(run_id)
}

/// HOME for trusted git so no user-level config is ever read.
pub fn trusted_home() -> PathBuf {
    root().join("home")
}

pub fn work_dir(run_id: &str) -> PathBuf {
    work_root().join(run_id)
}

pub fn workspace_dir(run_id: &str) -> PathBuf {
    work_dir(run_id).join("repo")
}

pub fn agent_home(run_id: &str) -> PathBuf {
    work_dir(run_id).join("home")
}

pub fn unit_name(run_id: &str) -> String {
    format!("{UNIT_PREFIX}{run_id}.service")
}
