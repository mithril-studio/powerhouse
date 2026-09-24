//! Versioned wire contracts between the Powerhouse desktop and the in-VM
//! runner. Everything here is plain data: no process handling, and no I/O
//! outside `session_files` (the on-disk layout of a Claude Code session that
//! both ends read and write).
//!
//! The runner speaks JSON on stdout. Every response is either
//! `{"ok": <payload>}` or `{"error": {"code": ..., "message": ...}}`.

pub mod session_files;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Bump when a change would make an older desktop and a newer runner (or the
/// reverse) misinterpret each other. Both sides reject mismatches.
pub const PROTOCOL_VERSION: u32 = 2;
/// Script requests require v3 so a deployed v2 runner cannot silently treat
/// them as agent work. Agent requests keep their existing v2 wire encoding.
pub const SCRIPT_PROTOCOL_VERSION: u32 = 3;
/// Agent runs that continue a desktop chat (`session` present) require v4, so
/// a runner that predates session handoff refuses them instead of silently
/// starting a fresh conversation.
pub const SESSION_PROTOCOL_VERSION: u32 = 4;

/// Cap on a session bundle (transcripts plus `.powerhouse/` documents).
pub const MAX_SESSION_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;

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

/// A boxd snapshot pinned by name and the version that was current when the
/// run was submitted (`boxd snapshots list` shows versions as `v1`, `v2`, …).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct SnapshotRef {
    pub name: String,
    #[serde(default)]
    pub version: Option<String>,
}

/// Where the task VM came from. Snapshot-based runs (protocol 2) record the
/// base snapshot; the legacy fork model recorded the base VM. Old manifests
/// deserialise with `base_snapshot` absent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct WorkspaceSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_snapshot: Option<SnapshotRef>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base_vm_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub base_vm_name: String,
}

impl WorkspaceSpec {
    pub fn from_snapshot(name: &str, version: Option<String>) -> Self {
        Self { base_snapshot: Some(SnapshotRef { name: name.to_string(), version }), ..Default::default() }
    }
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

/// A desktop Claude Code session the cloud agent continues instead of starting
/// fresh. The transcript travels as a separate [`SessionBundle`] file whose
/// digest is pinned here, so the manifest stays small and the bundle is
/// verified on arrival.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSpec {
    /// Claude Code session id (a lowercase UUID) to resume.
    pub session_id: String,
    /// SHA-256 of the bundle file's bytes.
    pub bundle_sha256: String,
    pub bundle_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CheckSpec {
    pub name: String,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptSpec {
    /// Bash source executed as the unprivileged workload user in the checkout.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<ScriptSpec>,
    #[serde(default)]
    pub checks: Vec<CheckSpec>,
    #[serde(default)]
    pub context: ContextSpec,
    pub deadline_seconds: u64,
    pub created_at_ms: u64,
    #[serde(default)]
    pub predecessor_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionSpec>,
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
        if ![PROTOCOL_VERSION, SCRIPT_PROTOCOL_VERSION, SESSION_PROTOCOL_VERSION].contains(&self.protocol_version) {
            return Err(format!(
                "protocol version {} not supported (runner accepts {PROTOCOL_VERSION}, {SCRIPT_PROTOCOL_VERSION} and {SESSION_PROTOCOL_VERSION})",
                self.protocol_version
            ));
        }
        match (&self.session, self.protocol_version) {
            (Some(session), SESSION_PROTOCOL_VERSION) => {
                validate_run_id(&session.session_id).map_err(|_| "session.session_id must be a lowercase UUID".to_string())?;
                if session.bundle_sha256.len() != 64 || !session.bundle_sha256.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
                    return Err("session.bundle_sha256 must be 64 lowercase hex characters".into());
                }
                if session.bundle_bytes == 0 || session.bundle_bytes > MAX_SESSION_BUNDLE_BYTES {
                    return Err(format!("session bundle must be 1..={MAX_SESSION_BUNDLE_BYTES} bytes"));
                }
            }
            (None, SESSION_PROTOCOL_VERSION) => return Err("protocol 4 requires a session".into()),
            (Some(_), _) => return Err("a session requires protocol 4".into()),
            (None, _) => {}
        }
        let agent_version = if self.session.is_some() { SESSION_PROTOCOL_VERSION } else { PROTOCOL_VERSION };
        match (&self.agent, &self.script, self.protocol_version) {
            (Some(agent), None, v) if v == agent_version => {
                if agent.permission_mode.is_empty() {
                    return Err("agent.permission_mode is required".into());
                }
                if agent.permission_mode == "bypassPermissions" && agent.provider == AgentProvider::Claude {
                    return Err("bypassPermissions is not allowed for cloud runs".into());
                }
                if self.output_branch != Self::expected_output_branch(&self.run_id) {
                    return Err(format!("output_branch must be {}", Self::expected_output_branch(&self.run_id)));
                }
            }
            (None, Some(script), SCRIPT_PROTOCOL_VERSION) => {
                if script.command.trim().is_empty() || script.command.len() > 64 * 1024 || script.command.contains('\0') {
                    return Err("script.command must be nonempty, at most 64 KiB, and contain no NUL bytes".into());
                }
                if !self.output_branch.is_empty() || !self.checks.is_empty() {
                    return Err("script runs cannot publish a branch or include agent checks".into());
                }
            }
            _ => return Err("specify exactly one workload: agent with protocol 2 (4 with a session) or script with protocol 3".into()),
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
        let has_snapshot = self.workspace.base_snapshot.as_ref().map(|s| !s.name.trim().is_empty()).unwrap_or(false);
        if !has_snapshot && self.workspace.base_vm_id.is_empty() {
            return Err("workspace.base_snapshot (or legacy base_vm_id) is required".into());
        }
        if !(MIN_DEADLINE_SECONDS..=MAX_DEADLINE_SECONDS).contains(&self.deadline_seconds) {
            return Err(format!(
                "deadline_seconds must be within {MIN_DEADLINE_SECONDS}..={MAX_DEADLINE_SECONDS}"
            ));
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

/// Lowercase hex SHA-256, as pinned in [`SessionSpec::bundle_sha256`].
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// --- session handoff -----------------------------------------------------------

/// One file of a [`SessionBundle`]. `path` is relative to a root that each side
/// maps to its own location:
/// - `project/…` → the Claude Code project directory for the session's cwd
///   (`~/.claude/projects/<slug>/`): the transcript and its sidecar directory
/// - `todos/…` → `~/.claude/todos/`
/// - `powerhouse/…` → `<cwd>/.powerhouse/` (handoff and plan documents)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BundleFile {
    pub path: String,
    pub content: String,
}

/// A Claude Code session packed for the trip between the desktop and a cloud
/// VM, in either direction. Text only: transcripts are JSONL and plan
/// documents are Markdown; anything else is left behind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionBundle {
    pub session_id: String,
    /// Absolute working directory the transcripts reference.
    pub cwd: String,
    #[serde(default)]
    pub claude_version: Option<String>,
    pub files: Vec<BundleFile>,
}

pub const BUNDLE_ROOTS: [&str; 3] = ["project", "todos", "powerhouse"];

impl SessionBundle {
    /// Bundle path of the session's main transcript.
    pub fn transcript_path(session_id: &str) -> String {
        format!("project/{session_id}.jsonl")
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_run_id(&self.session_id).map_err(|_| "bundle session_id must be a lowercase UUID".to_string())?;
        if !self.cwd.starts_with('/') || self.cwd.contains('\0') {
            return Err("bundle cwd must be an absolute path".into());
        }
        let transcript = Self::transcript_path(&self.session_id);
        if !self.files.iter().any(|f| f.path == transcript) {
            return Err(format!("bundle has no transcript {transcript}"));
        }
        let mut seen = std::collections::BTreeSet::new();
        for f in &self.files {
            split_bundle_path(&f.path)?;
            if !seen.insert(f.path.as_str()) {
                return Err(format!("bundle lists {} twice", f.path));
            }
        }
        Ok(())
    }

    /// Point every reference to the old cwd at `to`, in file contents and in
    /// `cwd` itself, so tool history and Claude's own records resolve on the
    /// receiving machine. Only whole path components match: `/w/app` is
    /// rewritten inside `/w/app/src` but never inside `/w/app-old`.
    pub fn rebase(&mut self, to: &str) {
        let from = self.cwd.clone();
        if from == to {
            return;
        }
        for f in &mut self.files {
            f.content = replace_path(&f.content, &from, to);
        }
        self.cwd = to.to_string();
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("bundle serializes")
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() as u64 > MAX_SESSION_BUNDLE_BYTES {
            return Err(format!("session bundle exceeds {MAX_SESSION_BUNDLE_BYTES} bytes"));
        }
        let bundle: SessionBundle = serde_json::from_slice(bytes).map_err(|e| format!("session bundle is invalid: {e}"))?;
        bundle.validate()?;
        Ok(bundle)
    }
}

/// `(root, relative)` for a bundle path, refusing anything that could escape
/// its root.
pub fn split_bundle_path(path: &str) -> Result<(&str, &str), String> {
    let bad = || format!("invalid bundle path {path:?}");
    if path.is_empty() || path.len() > 512 || path.contains('\\') || path.contains('\0') {
        return Err(bad());
    }
    let (root, rest) = path.split_once('/').ok_or_else(bad)?;
    if !BUNDLE_ROOTS.contains(&root) || rest.is_empty() {
        return Err(bad());
    }
    if rest.split('/').any(|c| c.is_empty() || c == "." || c == "..") {
        return Err(bad());
    }
    Ok((root, rest))
}

/// The directory name Claude Code uses under `~/.claude/projects/` for a
/// working directory: every character other than an ASCII letter or digit
/// becomes `-`.
pub fn claude_project_slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn replace_path(text: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(from) {
        let end = i + from.len();
        let continues = rest[end..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        out.push_str(&rest[..i]);
        out.push_str(if continues { from } else { to });
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<ScriptResult>,
    pub partial_work_preserved: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScriptResult {
    pub exit_code: Option<i32>,
    pub output_tail: String,
    pub output_truncated: bool,
    /// Retained redacted log bytes, accessible through script.output events.
    pub log_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProbeInfo {
    pub protocol_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_protocol_version: Option<u32>,
    /// Present when the runner can continue a desktop session (protocol 4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_protocol_version: Option<u32>,
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
            workspace: WorkspaceSpec::from_snapshot("powerhouse-base", Some("v1".into())),
            agent: Some(AgentSpec {
                provider: AgentProvider::Fake,
                model: None,
                permission_mode: "dontAsk".into(),
                allowed_tools: vec![],
                max_turns: Some(20),
                max_budget_usd: Some(1.0),
                fake_script: Some("complete".into()),
            }),
            script: None,
            checks: vec![CheckSpec {
                name: "unit".into(),
                command: "true".into(),
            }],
            context: ContextSpec { brief_markdown: "# Plan\n1. do it".into() },
            deadline_seconds: 900,
            created_at_ms: 1_789_849_454_000,
            predecessor_run_id: None,
            session: None,
        }
    }

    fn session_manifest() -> RunManifest {
        let mut m = manifest();
        m.protocol_version = SESSION_PROTOCOL_VERSION;
        m.session = Some(SessionSpec {
            session_id: "0b1bf178-c3a1-458b-b925-a841edf79619".into(),
            bundle_sha256: "a".repeat(64),
            bundle_bytes: 1024,
        });
        m
    }

    #[test]
    fn session_requests_require_protocol_4_and_the_reverse() {
        assert!(session_manifest().validate().is_ok());
        let mut m = session_manifest();
        m.protocol_version = PROTOCOL_VERSION;
        assert!(m.validate().unwrap_err().contains("protocol 4"));
        let mut m = manifest();
        m.protocol_version = SESSION_PROTOCOL_VERSION;
        assert!(m.validate().unwrap_err().contains("requires a session"));
        let mut m = session_manifest();
        m.session.as_mut().unwrap().session_id = "../x".into();
        assert!(m.validate().is_err());
        let mut m = session_manifest();
        m.session.as_mut().unwrap().bundle_bytes = MAX_SESSION_BUNDLE_BYTES + 1;
        assert!(m.validate().is_err());
        // A v2 runner never sees the field on a plain agent run.
        let v = serde_json::to_value(manifest()).unwrap();
        assert!(v.get("session").is_none());
    }

    fn bundle() -> SessionBundle {
        let sid = "0b1bf178-c3a1-458b-b925-a841edf79619";
        SessionBundle {
            session_id: sid.into(),
            cwd: "/Users/j/wt/app".into(),
            claude_version: Some("2.1.281".into()),
            files: vec![
                BundleFile {
                    path: SessionBundle::transcript_path(sid),
                    content: r#"{"cwd":"/Users/j/wt/app","x":"/Users/j/wt/app/src/a.rs /Users/j/wt/app-old/b /Users/j/wt/app."}"#.into(),
                },
                BundleFile { path: "powerhouse/handoff-1.md".into(), content: "see /Users/j/wt/app/README".into() },
            ],
        }
    }

    #[test]
    fn bundle_rebase_rewrites_whole_path_components_only() {
        let mut b = bundle();
        b.rebase("/var/lib/w/run/repo");
        assert_eq!(b.cwd, "/var/lib/w/run/repo");
        assert_eq!(
            b.files[0].content,
            r#"{"cwd":"/var/lib/w/run/repo","x":"/var/lib/w/run/repo/src/a.rs /Users/j/wt/app-old/b /var/lib/w/run/repo."}"#
        );
        assert_eq!(b.files[1].content, "see /var/lib/w/run/repo/README");
        // And back again: the round trip is lossless for the rewritten paths.
        b.rebase("/Users/j/wt/app");
        assert_eq!(b, bundle());
    }

    #[test]
    fn bundle_paths_cannot_escape_their_root() {
        assert!(bundle().validate().is_ok());
        for bad in ["project/../x", "etc/passwd", "project/", "/project/a", "project//a", "powerhouse/./a", "project/a\\b"] {
            assert!(split_bundle_path(bad).is_err(), "{bad}");
        }
        assert_eq!(split_bundle_path("project/sid/subagents/a.jsonl").unwrap(), ("project", "sid/subagents/a.jsonl"));
        let mut b = bundle();
        b.files.remove(0);
        assert!(b.validate().unwrap_err().contains("no transcript"));
        let bytes = bundle().to_bytes();
        assert_eq!(SessionBundle::from_bytes(&bytes).unwrap(), bundle());
    }

    #[test]
    fn project_slug_matches_claude_code() {
        assert_eq!(
            claude_project_slug("/Users/joost/.powerhouse/worktrees/powerhouse/x_y"),
            "-Users-joost--powerhouse-worktrees-powerhouse-x-y"
        );
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
    fn legacy_agent_wire_encoding_and_digest_are_unchanged() {
        // Exact v2 shape from d92d9f3: no script field (including null).
        let legacy: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/agent-v2.json")).unwrap();
        let parsed: RunManifest = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), legacy);
        assert_eq!(manifest(), parsed);
        assert_eq!(parsed.digest(), hex(&Sha256::digest(serde_json::to_vec(&legacy).unwrap())));
    }

    fn script_json() -> serde_json::Value {
        let mut value = serde_json::to_value(manifest()).unwrap();
        value.as_object_mut().unwrap().remove("agent");
        value["protocol_version"] = 3.into();
        value["output_branch"] = "".into();
        value["checks"] = serde_json::json!([]);
        value["script"] = serde_json::json!({"command": "printf 'workflow output\\n'"});
        value
    }

    #[test]
    fn script_request_roundtrips_without_an_agent_or_publication() {
        let value = script_json();
        let m: RunManifest = serde_json::from_value(value.clone()).unwrap();
        assert!(m.validate().is_ok());
        assert_eq!(serde_json::to_value(&m).unwrap(), value);
        let digest = m.digest();
        let mut changed = value;
        changed["script"]["command"] = "exit 7".into();
        assert_ne!(digest, serde_json::from_value::<RunManifest>(changed).unwrap().digest());
    }

    #[test]
    fn script_request_rejects_ambiguous_or_legacy_execution() {
        for change in [
            serde_json::json!({"protocol_version": 2}),
            serde_json::json!({"agent": manifest().agent}),
            serde_json::json!({"script": null}),
            serde_json::json!({"output_branch": "powerhouse/cloud/unexpected"}),
            serde_json::json!({"checks": [{"name": "hidden extra work", "command": "true"}]}),
        ] {
            let mut value = script_json();
            value.as_object_mut().unwrap().extend(change.as_object().unwrap().clone());
            let result = serde_json::from_value::<RunManifest>(value);
            assert!(result.is_err() || result.unwrap().validate().is_err());
        }
    }

    #[test]
    fn script_commands_are_bounded_and_reject_nul() {
        for command in [" ".to_string(), "echo\0injected".to_string(), "x".repeat(64 * 1024 + 1)] {
            let mut value = script_json();
            value["script"]["command"] = command.into();
            let m: RunManifest = serde_json::from_value(value).unwrap();
            assert!(m.validate().is_err());
        }
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
        m.agent.as_mut().unwrap().provider = AgentProvider::Claude;
        m.agent.as_mut().unwrap().permission_mode = "bypassPermissions".into();
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
