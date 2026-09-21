//! Versioned wire contracts between the Powerhouse desktop and the in-VM
//! runner. Everything here is plain data: no I/O, no process handling.
//!
//! The runner speaks JSON on stdout. Every response is either
//! `{"ok": <payload>}` or `{"error": {"code": ..., "message": ...}}`.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Bump when a change would make an older desktop and a newer runner (or the
/// reverse) misinterpret each other. Both sides reject mismatches.
pub const PROTOCOL_VERSION: u32 = 1;

/// Prefix of every branch the runner is allowed to push. Enforced in code.
pub const OUTPUT_BRANCH_PREFIX: &str = "powerhouse/cloud/";

pub const MIN_DEADLINE_SECONDS: u64 = 60;
pub const MAX_DEADLINE_SECONDS: u64 = 24 * 60 * 60;

/// Hard cap on one event payload; larger output is split or truncated.
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 64 * 1024;
/// Hard cap on the events page size a client may request.
pub const MAX_EVENT_PAGE: u64 = 500;

// --- request -----------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TaskSpec {
    pub text: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SourceSpec {
    pub repo_name: String,
    /// Credential-free remote (https://host/owner/repo.git or ssh form).
    pub remote_url: String,
    /// Full 40-hex commit SHA; the runner verifies the checkout matches.
    pub commit_sha: String,
    #[serde(default)]
    pub source_branch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSpec {
    pub base_vm_id: String,
    pub base_vm_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentProvider {
    /// Headless Claude Code (`claude --print`).
    Claude,
    /// Deterministic in-repo fixture for tests; never offered in the UI.
    Fake,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentSpec {
    pub provider: AgentProvider,
    #[serde(default)]
    pub model: Option<String>,
    /// Passed through to the provider; never `bypassPermissions` by default.
    pub permission_mode: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// Provider-enforced when supported; still an estimate, not a hard bill cap.
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
    /// Fake-agent behaviour script (ignored for real providers).
    #[serde(default)]
    pub fake_script: Option<String>,
}

/// Context the desktop hands to the agent: the plan/brief rendered by
/// Powerhouse (handoff document, notes). Written into the workspace as
/// `.powerhouse/cloud-task.md`, excluded from the published tree.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ContextSpec {
    #[serde(default)]
    pub brief_markdown: String,
}

pub const MAX_BRIEF_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CheckSpec {
    pub name: String,
    pub command: String,
}

/// The immutable request. A retry re-sends this byte-for-byte (same digest);
/// a new attempt mints a new `run_id` and may set `predecessor_run_id`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunManifest {
    pub protocol_version: u32,
    pub run_id: String,
    pub task: TaskSpec,
    pub source: SourceSpec,
    pub output_branch: String,
    pub workspace: WorkspaceSpec,
    pub agent: AgentSpec,
    #[serde(default)]
    pub checks: Vec<CheckSpec>,
    #[serde(default)]
    pub context: ContextSpec,
    pub deadline_seconds: u64,
    pub created_at_ms: u64,
    #[serde(default)]
    pub predecessor_run_id: Option<String>,
}

impl RunManifest {
    pub fn expected_output_branch(run_id: &str) -> String {
        format!("{OUTPUT_BRANCH_PREFIX}{run_id}")
    }

    /// SHA-256 of the canonical JSON encoding. `serde_json` maps are sorted, so
    /// both sides derive identical bytes from identical content.
    pub fn digest(&self) -> String {
        let value = serde_json::to_value(self).expect("manifest serializes");
        let bytes = serde_json::to_vec(&value).expect("value serializes");
        hex(&Sha256::digest(bytes))
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(format!(
                "protocol version {} not supported (runner speaks {PROTOCOL_VERSION})",
                self.protocol_version
            ));
        }
        validate_run_id(&self.run_id)?;
        if self.task.text.trim().is_empty() {
            return Err("task text is empty".into());
        }
        if self.task.text.len() > 64 * 1024 {
            return Err("task text exceeds 64 KiB".into());
        }
        if !is_full_sha(&self.source.commit_sha) {
            return Err("source commit_sha must be 40 lowercase hex characters".into());
        }
        validate_remote_url(&self.source.remote_url)?;
        if self.source.repo_name.is_empty() || self.source.repo_name.len() > 200 {
            return Err("repo_name must be 1–200 characters".into());
        }
        if self.output_branch != Self::expected_output_branch(&self.run_id) {
            return Err(format!(
                "output_branch must be {}",
                Self::expected_output_branch(&self.run_id)
            ));
        }
        if self.workspace.base_vm_id.is_empty() {
            return Err("workspace.base_vm_id is required".into());
        }
        if !(MIN_DEADLINE_SECONDS..=MAX_DEADLINE_SECONDS).contains(&self.deadline_seconds) {
            return Err(format!(
                "deadline_seconds must be within {MIN_DEADLINE_SECONDS}..={MAX_DEADLINE_SECONDS}"
            ));
        }
        if self.agent.permission_mode.is_empty() {
            return Err("agent.permission_mode is required".into());
        }
        if self.agent.permission_mode == "bypassPermissions"
            && self.agent.provider == AgentProvider::Claude
        {
            return Err("bypassPermissions is not allowed for cloud runs".into());
        }
        if let Some(prev) = &self.predecessor_run_id {
            validate_run_id(prev)?;
        }
        if self.context.brief_markdown.len() > MAX_BRIEF_BYTES {
            return Err(format!("context brief exceeds {MAX_BRIEF_BYTES} bytes"));
        }
        if self.checks.len() > 50 {
            return Err("at most 50 checks".into());
        }
        for (i, c) in self.checks.iter().enumerate() {
            if c.command.trim().is_empty() {
                return Err(format!("check #{} has an empty command", i + 1));
            }
            if c.name.len() > 120 || c.command.len() > 4096 {
                return Err(format!("check #{} name/command too long", i + 1));
            }
        }
        Ok(())
    }
}

/// Run IDs are lowercase UUID v4 strings; the runner uses them in unit names
/// and paths, so nothing else is accepted.
pub fn validate_run_id(id: &str) -> Result<(), String> {
    let ok = id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit() && !b.is_ascii_uppercase(),
        });
    if ok {
        Ok(())
    } else {
        Err(format!("invalid run id {id:?}: expected a lowercase UUID"))
    }
}

pub fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Accepts https/ssh remotes without embedded credentials.
pub fn validate_remote_url(url: &str) -> Result<(), String> {
    if url.is_empty() || url.len() > 2048 {
        return Err("remote_url must be 1–2048 characters".into());
    }
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("remote_url contains whitespace or control characters".into());
    }
    if url.starts_with('-') {
        return Err("remote_url may not start with '-'".into());
    }
    if let Some(rest) = url.strip_prefix("https://") {
        let host = rest.split('/').next().unwrap_or("");
        if host.contains('@') {
            return Err("remote_url must not embed credentials".into());
        }
        if host.is_empty() {
            return Err("remote_url has no host".into());
        }
        return Ok(());
    }
    if let Some(rest) = url.strip_prefix("git://") {
        if rest.is_empty() {
            return Err("remote_url has no host".into());
        }
        return Ok(());
    }
    if let Some(rest) = url.strip_prefix("ssh://") {
        if rest.is_empty() {
            return Err("remote_url has no host".into());
        }
        return Ok(());
    }
    // scp-like: git@github.com:owner/repo.git
    if let Some((user_host, path)) = url.split_once(':') {
        if !path.is_empty() && !user_host.contains('/') && !path.starts_with("//") {
            return Ok(());
        }
    }
    Err("remote_url must be an https://, ssh://, git://, or user@host:path remote".into())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// --- state -------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Accepted,
    Preparing,
    Running,
    Validating,
    Publishing,
    Completed,
    Blocked,
    Failed,
    Cancelled,
    Interrupted,
}

impl RunState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RunState::Completed
                | RunState::Blocked
                | RunState::Failed
                | RunState::Cancelled
                | RunState::Interrupted
        )
    }

    pub fn is_live(self) -> bool {
        !self.is_terminal()
    }

    /// Position in the normal flow; terminal states are all "later" than any
    /// live state so a stale live snapshot can never regress a terminal one.
    pub fn rank(self) -> u8 {
        match self {
            RunState::Accepted => 0,
            RunState::Preparing => 1,
            RunState::Running => 2,
            RunState::Validating => 3,
            RunState::Publishing => 4,
            RunState::Completed
            | RunState::Blocked
            | RunState::Failed
            | RunState::Cancelled
            | RunState::Interrupted => 10,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            RunState::Accepted => "accepted",
            RunState::Preparing => "preparing",
            RunState::Running => "running",
            RunState::Validating => "validating",
            RunState::Publishing => "publishing",
            RunState::Completed => "completed",
            RunState::Blocked => "blocked",
            RunState::Failed => "failed",
            RunState::Cancelled => "cancelled",
            RunState::Interrupted => "interrupted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "accepted" => RunState::Accepted,
            "preparing" => RunState::Preparing,
            "running" => RunState::Running,
            "validating" => RunState::Validating,
            "publishing" => RunState::Publishing,
            "completed" => RunState::Completed,
            "blocked" => RunState::Blocked,
            "failed" => RunState::Failed,
            "cancelled" => RunState::Cancelled,
            "interrupted" => RunState::Interrupted,
            _ => return None,
        })
    }
}

/// Stage-tagged failure/blockage detail.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunError {
    pub stage: String,
    pub message: String,
}

/// Durable proof that the runner owns the run. Returned by `submit`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Receipt {
    pub run_id: String,
    pub manifest_digest: String,
    pub state: RunState,
    pub event_cursor: u64,
    pub accepted_at_ms: u64,
    /// True when this submit found an existing identical run.
    pub duplicate: bool,
}

/// Authoritative snapshot from `inspect`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunSnapshot {
    pub run_id: String,
    pub manifest_digest: String,
    pub state: RunState,
    #[serde(default)]
    pub stage: Option<String>,
    /// Highest event sequence durably stored.
    pub last_event_seq: u64,
    pub accepted_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default)]
    pub started_at_ms: Option<u64>,
    #[serde(default)]
    pub finished_at_ms: Option<u64>,
    #[serde(default)]
    pub error: Option<RunError>,
    pub cancel_requested: bool,
    pub result_available: bool,
    /// Whether the supervising unit is currently active (None if unknown).
    #[serde(default)]
    pub unit_active: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunEvent {
    pub seq: u64,
    pub ts_ms: u64,
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventPage {
    pub run_id: String,
    pub events: Vec<RunEvent>,
    /// Pass back as `after` to continue.
    pub next_after: u64,
    pub has_more: bool,
    /// Runner's current high-water mark at page time.
    pub last_event_seq: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Passed,
    Failed,
    Skipped,
    NotRun,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CheckResult {
    pub name: String,
    pub command: String,
    pub status: CheckStatus,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub started_at_ms: Option<u64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub output_tail: String,
    #[serde(default)]
    pub output_truncated: bool,
}

/// Persisted by the runner once the agent has stopped. Present for every
/// terminal outcome that produced anything inspectable.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResultManifest {
    pub run_id: String,
    pub source_sha: String,
    #[serde(default)]
    pub result_sha: Option<String>,
    pub output_branch: String,
    pub published: bool,
    #[serde(default)]
    pub publish_error: Option<String>,
    /// Agent's own summary — prose, not verification.
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub concerns: Vec<String>,
    pub checks_configured: bool,
    #[serde(default)]
    pub checks: Vec<CheckResult>,
    /// True when tracked files changed after checks ran (result is untrusted).
    pub tree_changed_after_checks: bool,
    pub changed_files: Vec<String>,
    pub diff_bytes: u64,
    pub diff_truncated: bool,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub usage: Option<serde_json::Value>,
    #[serde(default)]
    pub agent_exit_code: Option<i32>,
    pub partial_work_preserved: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProbeInfo {
    pub protocol_version: u32,
    pub runner_version: String,
    pub agents: Vec<AgentProvider>,
    pub os: String,
    pub arch: String,
    pub systemd: bool,
    pub cgroup_v2: bool,
    pub agent_user_ready: bool,
    pub store_ready: bool,
    #[serde(default)]
    pub claude_version: Option<String>,
    #[serde(default)]
    pub git_version: Option<String>,
    /// Names (never values) of secret-looking variables visible in the exec
    /// session that invoked the probe. Non-empty means the platform injects
    /// ambient credentials that the run itself never receives.
    #[serde(default)]
    pub ambient_secret_names: Vec<String>,
    /// Run ids whose per-run credential files are still on disk (live runs).
    #[serde(default)]
    pub pending_credentials: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunnerError {
    pub code: String,
    pub message: String,
}

impl RunnerError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Envelope of every runner response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Response<T> {
    Ok { ok: T },
    Err { error: RunnerError },
}

impl<T> Response<T> {
    pub fn into_result(self) -> Result<T, RunnerError> {
        match self {
            Response::Ok { ok } => Ok(ok),
            Response::Err { error } => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> RunManifest {
        let run_id = "0f4a2c6e-6a2b-4c4e-9f3a-1b2c3d4e5f60".to_string();
        RunManifest {
            protocol_version: PROTOCOL_VERSION,
            run_id: run_id.clone(),
            task: TaskSpec {
                text: "Add a README badge".into(),
                acceptance_criteria: vec!["badge renders".into()],
            },
            source: SourceSpec {
                repo_name: "powerhouse".into(),
                remote_url: "https://github.com/mithril-studio/powerhouse.git".into(),
                commit_sha: "db2b7c51b4cb9f64816e15675f2453fdb86a977f".into(),
                source_branch: Some("main".into()),
            },
            output_branch: RunManifest::expected_output_branch(&run_id),
            workspace: WorkspaceSpec {
                base_vm_id: "5a943507-3186-464c-b9f0-51f21f58c684".into(),
                base_vm_name: "powerhouse-cloud-base".into(),
            },
            agent: AgentSpec {
                provider: AgentProvider::Fake,
                model: None,
                permission_mode: "dontAsk".into(),
                allowed_tools: vec![],
                max_turns: Some(20),
                max_budget_usd: Some(1.0),
                fake_script: Some("complete".into()),
            },
            checks: vec![CheckSpec {
                name: "unit".into(),
                command: "true".into(),
            }],
            context: ContextSpec { brief_markdown: "# Plan\n1. do it".into() },
            deadline_seconds: 900,
            created_at_ms: 1_789_849_454_000,
            predecessor_run_id: None,
        }
    }

    #[test]
    fn digest_is_stable_and_content_sensitive() {
        let a = manifest();
        let b = manifest();
        assert_eq!(a.digest(), b.digest());
        let mut c = manifest();
        c.task.text.push('!');
        assert_ne!(a.digest(), c.digest());
        // Round-trip through JSON keeps the digest.
        let json = serde_json::to_string(&a).unwrap();
        let back: RunManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(a.digest(), back.digest());
    }

    #[test]
    fn validation_catches_bad_input() {
        assert!(manifest().validate().is_ok());
        let mut m = manifest();
        m.run_id = "../etc".into();
        assert!(m.validate().is_err());
        let mut m = manifest();
        m.output_branch = "main".into();
        assert!(m.validate().unwrap_err().contains("output_branch"));
        let mut m = manifest();
        m.source.remote_url = "https://user:token@github.com/x/y.git".into();
        assert!(m.validate().unwrap_err().contains("credentials"));
        let mut m = manifest();
        m.source.commit_sha = "abc".into();
        assert!(m.validate().is_err());
        let mut m = manifest();
        m.deadline_seconds = 5;
        assert!(m.validate().is_err());
        let mut m = manifest();
        m.protocol_version = 99;
        assert!(m.validate().unwrap_err().contains("protocol version"));
        let mut m = manifest();
        m.agent.provider = AgentProvider::Claude;
        m.agent.permission_mode = "bypassPermissions".into();
        assert!(m.validate().is_err());
    }

    #[test]
    fn remote_urls() {
        assert!(validate_remote_url("git@github.com:owner/repo.git").is_ok());
        assert!(validate_remote_url("ssh://git@github.com/owner/repo.git").is_ok());
        assert!(validate_remote_url("-oProxyCommand=evil").is_err());
        assert!(validate_remote_url("file:///etc").is_err());
        assert!(validate_remote_url("https://a b/repo").is_err());
    }

    #[test]
    fn terminal_states_outrank_live_states() {
        for live in [
            RunState::Accepted,
            RunState::Preparing,
            RunState::Running,
            RunState::Validating,
            RunState::Publishing,
        ] {
            for term in [
                RunState::Completed,
                RunState::Failed,
                RunState::Cancelled,
                RunState::Interrupted,
                RunState::Blocked,
            ] {
                assert!(term.rank() > live.rank());
                assert!(term.is_terminal() && live.is_live());
            }
        }
        assert_eq!(RunState::parse("publishing"), Some(RunState::Publishing));
        assert_eq!(RunState::parse("Publishing"), None);
    }

    #[test]
    fn response_envelope_round_trips() {
        let ok: Response<u32> = serde_json::from_str(r#"{"ok": 7}"#).unwrap();
        assert_eq!(ok.into_result().unwrap(), 7);
        let err: Response<u32> =
            serde_json::from_str(r#"{"error": {"code": "x", "message": "boom"}}"#).unwrap();
        assert_eq!(err.into_result().unwrap_err().code, "x");
    }
}
