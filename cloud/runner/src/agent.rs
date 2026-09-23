//! Headless agent adapters and stream-json parsing. The runner reads the
//! provider's structured events; it never derives success from prose.

use std::path::Path;
use std::process::Command;

use powerhouse_cloud_protocol::{AgentProvider, RunManifest};

/// What the executor learned from the agent's structured output.
#[derive(Debug, Default, Clone)]
pub struct AgentOutcome {
    pub session_id: Option<String>,
    pub result_subtype: Option<String>,
    pub summary: Option<String>,
    pub usage: Option<serde_json::Value>,
    pub total_cost_usd: Option<f64>,
    pub num_turns: Option<u64>,
    pub permission_denials: Vec<serde_json::Value>,
    pub is_error: bool,
    pub saw_result: bool,
}

impl AgentOutcome {
    /// Feed one parsed stream-json line.
    pub fn absorb(&mut self, value: &serde_json::Value) {
        let t = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(sid) = value.get("session_id").and_then(|v| v.as_str()) {
            self.session_id.get_or_insert_with(|| sid.to_string());
        }
        if t == "result" {
            self.saw_result = true;
            self.result_subtype = value
                .get("subtype")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            self.summary = value
                .get("result")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            self.usage = value.get("usage").cloned();
            self.total_cost_usd = value.get("total_cost_usd").and_then(|v| v.as_f64());
            self.num_turns = value.get("num_turns").and_then(|v| v.as_u64());
            self.is_error = value.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
            if let Some(d) = value.get("permission_denials").and_then(|v| v.as_array()) {
                self.permission_denials = d.clone();
            }
        }
    }

    /// Classify the finished agent. `Blocked` means the provider stopped for a
    /// reason a human must resolve (limits, permissions); `Failed` means the
    /// process or provider errored; `Done` means the agent itself finished.
    pub fn classify(&self, exit_code: Option<i32>) -> AgentVerdict {
        match (exit_code, self.result_subtype.as_deref()) {
            (Some(75), _) => AgentVerdict::Blocked("agent reported it needs input or permission".into()),
            (_, Some("error_max_turns")) => AgentVerdict::Blocked("turn limit reached before the task finished".into()),
            (_, Some("error_max_budget_usd")) => AgentVerdict::Blocked("budget limit reached before the task finished".into()),
            (Some(0), Some("success")) if !self.is_error => AgentVerdict::Done,
            (Some(0), Some(other)) => AgentVerdict::Failed(format!("agent ended with result {other}")),
            (Some(0), None) if !self.saw_result => {
                AgentVerdict::Failed("agent exited 0 without a structured result".into())
            }
            (Some(0), None) => AgentVerdict::Done,
            (Some(code), _) => AgentVerdict::Failed(format!("agent exited with status {code}")),
            (None, _) => AgentVerdict::Failed("agent was killed by a signal".into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentVerdict {
    Done,
    Blocked(String),
    Failed(String),
}

/// Build the provider command. Credentials arrive through `secrets` and go
/// into the child's environment only.
pub fn build_command(
    manifest: &RunManifest,
    spec: &powerhouse_cloud_protocol::AgentSpec,
    self_bin: &str,
    workspace: &Path,
    home: &Path,
    secrets: &[(String, String)],
) -> Command {
    let mut cmd = match spec.provider {
        AgentProvider::Fake => {
            let mut c = Command::new(self_bin);
            c.arg("fake-agent")
                .arg(spec.fake_script.clone().unwrap_or_else(|| "complete".into()));
            c
        }
        AgentProvider::Claude => {
            let mut c = Command::new(claude_binary());
            c.arg("--print")
                .arg("--verbose")
                .arg("--output-format")
                .arg("stream-json")
                .arg("--permission-mode")
                .arg(&spec.permission_mode)
                .arg("--session-id")
                .arg(uuid::Uuid::new_v4().to_string());
            if let Some(m) = &spec.model {
                c.arg("--model").arg(m);
            }
            if let Some(n) = spec.max_turns {
                c.arg("--max-turns").arg(n.to_string());
            }
            if let Some(b) = spec.max_budget_usd {
                c.arg("--max-budget-usd").arg(format!("{b}"));
            }
            if !spec.allowed_tools.is_empty() {
                c.arg("--allowedTools").arg(spec.allowed_tools.join(","));
            }
            c.arg("--").arg(build_prompt(manifest));
            c
        }
    };
    cmd.env_clear();
    cmd.env("PATH", format!("{}:/usr/local/bin:/usr/bin:/bin", crate::paths::AGENT_TOOLS_BIN));
    cmd.env("HOME", home);
    cmd.env("USER", crate::paths::AGENT_USER);
    cmd.env("LANG", "C.UTF-8");
    cmd.env("TERM", "dumb");
    cmd.env("CI", "1");
    cmd.env("DISABLE_AUTOUPDATER", "1");
    cmd.env("POWERHOUSE_RUN_ID", &manifest.run_id);
    for (k, v) in secrets {
        cmd.env(k, v);
    }
    cmd.current_dir(workspace);
    cmd
}

/// Claude staged for the agent identity, falling back to PATH lookup.
pub fn claude_binary() -> String {
    let staged = format!("{}/claude", crate::paths::AGENT_TOOLS_BIN);
    if Path::new(&staged).exists() {
        staged
    } else {
        "claude".to_string()
    }
}

pub fn build_prompt(m: &RunManifest) -> String {
    let mut p = String::new();
    p.push_str("You are running unattended inside an isolated cloud workspace checked out at commit ");
    p.push_str(&m.source.commit_sha);
    p.push_str(" of ");
    p.push_str(&m.source.repo_name);
    p.push_str(".\n\nRead `.powerhouse/cloud-task.md` first: it holds the task, the acceptance criteria, the checks that will run, and the plan and context prepared in Powerhouse.\n\nTask:\n");
    p.push_str(&m.task.text);
    if !m.task.acceptance_criteria.is_empty() {
        p.push_str("\n\nAcceptance criteria:\n");
        for c in &m.task.acceptance_criteria {
            p.push_str("- ");
            p.push_str(c);
            p.push('\n');
        }
    }
    if !m.checks.is_empty() {
        p.push_str("\nThese checks run automatically after you finish; make them pass:\n");
        for c in &m.checks {
            p.push_str("- ");
            p.push_str(&c.command);
            p.push('\n');
        }
    }
    p.push_str(
        "\nRules: work only inside the current directory. Do not push, do not create pull requests, do not switch branches. \
Leave your changes in the working tree (committing is optional). Nobody can answer questions; if you are blocked, \
explain why in your final message and stop. End with a short summary of what you changed and any remaining concerns.",
    );
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_structured_outcomes() {
        let mut o = AgentOutcome::default();
        o.absorb(&serde_json::json!({"type":"system","subtype":"init","session_id":"s1"}));
        o.absorb(&serde_json::json!({"type":"result","subtype":"success","result":"did it","session_id":"s1","total_cost_usd":0.5}));
        assert_eq!(o.session_id.as_deref(), Some("s1"));
        assert_eq!(o.summary.as_deref(), Some("did it"));
        assert_eq!(o.classify(Some(0)), AgentVerdict::Done);
        assert!(matches!(o.classify(Some(1)), AgentVerdict::Failed(_)));

        let mut b = AgentOutcome::default();
        b.absorb(&serde_json::json!({"type":"result","subtype":"error_max_turns","is_error":true}));
        assert!(matches!(b.classify(Some(0)), AgentVerdict::Blocked(_)));

        let none = AgentOutcome::default();
        assert!(matches!(none.classify(Some(0)), AgentVerdict::Failed(_)));
        assert!(matches!(none.classify(None), AgentVerdict::Failed(_)));
        assert!(matches!(none.classify(Some(75)), AgentVerdict::Blocked(_)));
    }

    #[test]
    fn prose_success_is_not_success() {
        let mut o = AgentOutcome::default();
        o.absorb(&serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"Task complete! All checks pass."}]}}));
        assert!(matches!(o.classify(Some(0)), AgentVerdict::Failed(_)));
    }
}
