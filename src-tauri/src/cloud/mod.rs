//! Cloud workspaces: a branch continued by Claude on a boxd VM. See
//! docs/cloud-workspaces.md.
pub mod commands;
pub mod secrets;
pub mod transport;
pub mod workspace;

/// Strip token-looking material from git's stderr before it reaches the UI.
pub fn redact_stderr(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            if (w.contains("://") && w.contains('@')) || w.starts_with("ghp_") || w.starts_with("github_pat_") {
                "[redacted]".to_string()
            } else {
                w.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
