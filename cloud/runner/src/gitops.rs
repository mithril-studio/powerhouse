//! Trusted Git operations. Every call here runs with a fixed, minimal
//! configuration: no system/global config, hooks disabled, prompts off. The
//! agent-owned checkout is only ever read as a work tree — its `.git`
//! directory (config, hooks, helpers) is never consulted.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use powerhouse_cloud_protocol::{is_full_sha, OUTPUT_BRANCH_PREFIX};

use crate::paths;

pub struct TrustedGit {
    /// The trusted repository (`.git` lives here).
    pub repo: PathBuf,
    /// Optional work tree override (the agent's checkout).
    pub work_tree: Option<PathBuf>,
    /// Extra env (e.g. publication auth), never logged.
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
}

pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub status: i32,
}

impl TrustedGit {
    pub fn new(repo: PathBuf) -> Self {
        Self {
            repo,
            work_tree: None,
            env: vec![],
            timeout: Duration::from_secs(600),
        }
    }

    pub fn with_work_tree(mut self, wt: PathBuf) -> Self {
        self.work_tree = Some(wt);
        self
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new("git");
        cmd.env_clear();
        cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin");
        cmd.env("HOME", paths::trusted_home());
        cmd.env("GIT_CONFIG_NOSYSTEM", "1");
        cmd.env("GIT_CONFIG_GLOBAL", "/dev/null");
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("GIT_ASKPASS", "/bin/false");
        cmd.env("SSH_ASKPASS", "/bin/false");
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new");
        cmd.env("LC_ALL", "C");
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        cmd.arg("--git-dir").arg(self.repo.join(".git"));
        if let Some(wt) = &self.work_tree {
            cmd.arg("--work-tree").arg(wt);
        }
        cmd.args([
            "-c",
            "core.hooksPath=/var/empty",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "credential.helper=",
            "-c",
            "core.pager=cat",
            "-c",
            "protocol.file.allow=never",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "gc.auto=0",
            "-c",
            "user.name=Powerhouse Cloud Runner",
            "-c",
            "user.email=cloud-runner@powerhouse.invalid",
        ]);
        cmd.args(args);
        cmd.stdin(Stdio::null());
        cmd
    }

    pub fn run(&self, args: &[&str]) -> Result<GitOutput, String> {
        let mut child = self
            .command(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("git {}: {e}", args.first().unwrap_or(&"")))?;
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if start.elapsed() > self.timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("git {} timed out", args.join(" ")));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        Ok(GitOutput {
            stdout: out.stdout,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            status: out.status.code().unwrap_or(-1),
        })
    }

    pub fn ok(&self, args: &[&str]) -> Result<String, String> {
        let out = self.run(args)?;
        if out.status == 0 {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(format!("git {} failed ({}): {}", args.join(" "), out.status, redact(&out.stderr)))
        }
    }

    pub fn raw(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        let out = self.run(args)?;
        if out.status == 0 {
            Ok(out.stdout)
        } else {
            Err(format!("git {} failed ({}): {}", args.join(" "), out.status, redact(&out.stderr)))
        }
    }
}

/// Strip anything that looks like a token from git's stderr.
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for word in s.split_whitespace() {
        if word.contains("://") && word.contains('@') {
            if let Some((scheme, rest)) = word.split_once("://") {
                if let Some((_, host)) = rest.split_once('@') {
                    out.push_str(scheme);
                    out.push_str("://[redacted]@");
                    out.push_str(host);
                    out.push(' ');
                    continue;
                }
            }
        }
        if word.starts_with("ghp_") || word.starts_with("github_pat_") || word.starts_with("gho_") {
            out.push_str("[redacted-token] ");
            continue;
        }
        out.push_str(word);
        out.push(' ');
    }
    out.trim_end().to_string()
}

/// Clone the trusted repository at exactly `sha` (no checkout of a moving
/// branch). Returns an error if the remote does not contain the commit.
pub fn clone_exact(remote: &str, sha: &str, dest: &Path, auth: &[(String, String)]) -> Result<(), String> {
    if !is_full_sha(sha) {
        return Err("refusing clone: not a full SHA".into());
    }
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut git = TrustedGit::new(dest.to_path_buf());
    git.env = auth.to_vec();
    git.ok(&["init", "--quiet", "--initial-branch=powerhouse-source"])?;
    git.ok(&["remote", "add", "origin", remote])?;
    // Fetch the single commit by SHA; falls back to a full fetch for servers
    // that do not allow SHA fetches.
    if git.run(&["fetch", "--quiet", "--no-tags", "origin", sha]).map(|o| o.status).unwrap_or(-1) != 0 {
        git.ok(&["fetch", "--quiet", "--no-tags", "origin"])?;
    }
    git.ok(&["cat-file", "-e", &format!("{sha}^{{commit}}")])
        .map_err(|_| format!("remote does not contain commit {sha}"))?;
    git.ok(&["update-ref", "refs/heads/powerhouse-source", sha])?;
    git.ok(&["symbolic-ref", "HEAD", "refs/heads/powerhouse-source"])?;
    git.ok(&["reset", "--hard", "--quiet", sha])?;
    let head = git.ok(&["rev-parse", "HEAD"])?;
    if head != sha {
        return Err(format!("checkout mismatch: HEAD is {head}, expected {sha}"));
    }
    Ok(())
}

/// Create the agent's checkout as a local clone of the trusted repo. The
/// agent's `origin` is repointed to the credential-free remote so it can see
/// where the code came from without any push capability.
pub fn create_agent_checkout(trusted: &Path, dest: &Path, remote: &str, sha: &str) -> Result<(), String> {
    let parent = dest.parent().ok_or("checkout has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut cmd = Command::new("git");
    cmd.env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", paths::trusted_home())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args(["-c", "protocol.file.allow=always", "clone", "--quiet", "--no-hardlinks", "--no-local"])
        .arg(trusted)
        .arg(dest)
        .stdin(Stdio::null());
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("clone for agent failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let git = TrustedGit::new(dest.to_path_buf()).with_work_tree(dest.to_path_buf());
    git.ok(&["remote", "set-url", "origin", remote])?;
    git.ok(&["checkout", "--quiet", "-B", "powerhouse-task", sha])?;
    let head = git.ok(&["rev-parse", "HEAD"])?;
    if head != sha {
        return Err(format!("agent checkout mismatch: HEAD is {head}, expected {sha}"));
    }
    Ok(())
}

/// Snapshot the agent work tree into the trusted repo as a tree object using a
/// private index. Nothing in the agent's `.git` is read.
pub fn snapshot_tree(trusted: &Path, work_tree: &Path) -> Result<String, String> {
    let index = trusted.join(".git").join("powerhouse-snapshot-index");
    let _ = std::fs::remove_file(&index);
    let mut git = TrustedGit::new(trusted.to_path_buf()).with_work_tree(work_tree.to_path_buf());
    git.env.push(("GIT_INDEX_FILE".into(), index.to_string_lossy().to_string()));
    git.ok(&["add", "--all", "--", "."])?;
    let tree = git.ok(&["write-tree"])?;
    Ok(tree)
}

/// Commit `tree` on top of `parent` if it differs; returns the result SHA
/// (the parent itself when unchanged).
pub fn commit_tree(trusted: &Path, tree: &str, parent: &str, message: &str) -> Result<String, String> {
    let git = TrustedGit::new(trusted.to_path_buf());
    let parent_tree = git.ok(&["rev-parse", &format!("{parent}^{{tree}}")])?;
    if parent_tree == tree {
        return Ok(parent.to_string());
    }
    let mut cmd = git.command(&["commit-tree", tree, "-p", parent]);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        stdin.write_all(message.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("commit-tree failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Debug)]
pub struct Published {
    pub already: bool,
}

/// Push `sha` to the run's unique branch. Refuses any other destination and
/// never forces. Idempotent: an existing identical ref is success.
pub fn publish(trusted: &Path, remote: &str, branch: &str, sha: &str, auth: &[(String, String)]) -> Result<Published, String> {
    if !branch.starts_with(OUTPUT_BRANCH_PREFIX) || branch.contains("..") || branch.ends_with('/') {
        return Err(format!("refusing to publish to non-run branch {branch}"));
    }
    if !is_full_sha(sha) {
        return Err("refusing publish: result is not a full SHA".into());
    }
    let mut git = TrustedGit::new(trusted.to_path_buf());
    git.env = auth.to_vec();
    let refname = format!("refs/heads/{branch}");
    let existing = git.ok(&["ls-remote", "--", remote, &refname])?;
    if let Some(remote_sha) = existing.split_whitespace().next() {
        if remote_sha == sha {
            return Ok(Published { already: true });
        }
        return Err(format!(
            "remote branch {branch} already exists at {remote_sha}, expected {sha}; not overwriting"
        ));
    }
    let refspec = format!("{sha}:{refname}");
    git.ok(&["push", "--quiet", "--", remote, &refspec])?;
    // Verify the acknowledgement by re-reading the remote ref.
    let after = git.ok(&["ls-remote", "--", remote, &refname])?;
    match after.split_whitespace().next() {
        Some(s) if s == sha => Ok(Published { already: false }),
        Some(s) => Err(format!("post-push verification found {s}, expected {sha}")),
        None => Err("post-push verification could not find the branch".into()),
    }
}

/// `Authorization` header for HTTPS pushes without writing the token to disk
/// or the command line.
pub fn https_auth_env(token: &str) -> Vec<(String, String)> {
    use base64::Engine;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    vec![
        ("GIT_CONFIG_COUNT".into(), "1".into()),
        ("GIT_CONFIG_KEY_0".into(), "http.extraHeader".into()),
        ("GIT_CONFIG_VALUE_0".into(), format!("Authorization: Basic {basic}")),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_userinfo_and_tokens() {
        let s = "fatal: https://x-access-token:ghp_abc123@github.com/o/r.git denied ghp_zzz";
        let r = redact(s);
        assert!(!r.contains("ghp_abc123"));
        assert!(!r.contains("ghp_zzz"));
        assert!(r.contains("[redacted]@github.com"));
    }

    #[test]
    fn publish_refuses_foreign_branches() {
        let dir = tempfile::tempdir().unwrap();
        let err = publish(dir.path(), "https://example.invalid/r.git", "main", &"a".repeat(40), &[]).unwrap_err();
        assert!(err.contains("non-run branch"));
        let err = publish(dir.path(), "https://example.invalid/r.git", "powerhouse/cloud/x/../main", &"a".repeat(40), &[]).unwrap_err();
        assert!(err.contains("non-run branch"));
    }
}
