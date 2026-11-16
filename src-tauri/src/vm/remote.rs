//! Small operations on a VM, shared by builds and chats.

use std::time::{Duration, Instant};

use crate::cloud::secrets::{self, SecretStore};
use crate::cloud::transport::Boxd;

/// Where `ph-agentd` lives on every VM, and the script itself (embedded).
pub const AGENTD_PATH: &str = "/home/boxd/.ph/ph-agentd.mjs";
pub const AGENTD_SOURCE: &str = include_str!("../../../agentd/ph-agentd.mjs");
/// The Claude ACP adapter, pinned: images are built with it, chats run it.
pub const ADAPTER: &str = "@agentclientprotocol/claude-agent-acp@0.107.0";
pub const REPO_DIR: &str = "/home/boxd/repo";

const READY_TIMEOUT: Duration = Duration::from_secs(180);

/// Runs `script` with a login bash; non-zero exit is an error carrying the output.
pub fn exec_ok(boxd: &dyn Boxd, vm: &str, script: &str, timeout: Duration) -> Result<String, String> {
    let argv = vec!["bash".to_string(), "-lc".to_string(), script.to_string()];
    let out = boxd.exec(vm, &argv, timeout).map_err(|e| e.to_string())?;
    if out.exit_code != 0 {
        return Err(format!("exit {}: {}", out.exit_code, tail(&out.output, 4000)));
    }
    Ok(out.output)
}

/// Prefix for scripts that need the uploaded secrets as environment variables.
pub const WITH_ENV: &str = r#"set -a; [ -f "$HOME/.ph/env" ] && . "$HOME/.ph/env"; set +a; "#;

/// Copies `bytes` to `remote_path` on the VM through a private temp file.
pub fn upload(boxd: &dyn Boxd, vm: &str, remote_path: &str, bytes: &[u8]) -> Result<(), String> {
    let dir = tempfile::Builder::new().prefix("ph-vm-").tempdir().map_err(|e| e.to_string())?;
    let path = dir.path().join("upload");
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
    boxd.cp_to(&path, vm, remote_path).map_err(|e| e.to_string())
}

/// Writes `~/.ph/env` (Claude token, GitHub token, project env vars).
pub fn upload_env(
    boxd: &dyn Boxd,
    store: &dyn SecretStore,
    vm: &str,
    repo_id: &str,
    remote_url: &str,
    env_names: &[String],
) -> Result<(), String> {
    exec_ok(boxd, vm, r#"mkdir -p "$HOME/.ph" && chmod 700 "$HOME/.ph""#, Duration::from_secs(60))?;
    let project = secrets::project_env_values(store, repo_id, env_names)?;
    let env = secrets::workspace_env(store, remote_url, &project)?;
    upload(boxd, vm, "/home/boxd/.ph/env", secrets::render_env_file(&env)?.as_bytes())
}

/// Waits until boxd reports the machine running.
pub fn wait_running(boxd: &dyn Boxd, vm: &str) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if boxd.machine_get(vm).map_err(|e| e.to_string())?.status == "running" {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("{vm} did not start within {}s", READY_TIMEOUT.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// The last `max` bytes of `s`, on a char boundary.
pub fn tail(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Short, stable, owned-name-safe slug for a repo: `<name>-<hash4>`.
pub fn repo_slug(repo_name: &str, repo_id: &str) -> String {
    let mut name: String = repo_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    name = name.trim_matches('-').to_string();
    while name.contains("--") {
        name = name.replace("--", "-");
    }
    name.truncate(20);
    let name = name.trim_end_matches('-');
    let name = if name.is_empty() { "repo" } else { name };
    format!("{name}-{}", hash4(repo_id))
}

fn hash4(s: &str) -> String {
    // FNV-1a: stable across builds and platforms, unlike DefaultHasher.
    let mut h: u32 = 0x811c9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{:04x}", h & 0xffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_stable_short_and_safe() {
        let a = repo_slug("Powerhouse App!", "id-1");
        assert!(a.starts_with("powerhouse-app-"), "{a}");
        assert_eq!(a, repo_slug("Powerhouse App!", "id-1"));
        assert_ne!(a, repo_slug("Powerhouse App!", "id-2"));
        assert!(repo_slug("a-very-long-repository-name-indeed", "x").len() <= 25);
        assert!(repo_slug("!!!", "x").starts_with("repo-"));
    }

    #[test]
    fn tail_keeps_the_end_on_a_char_boundary() {
        assert_eq!(tail("abcdef", 3), "def");
        assert_eq!(tail("ab", 5), "ab");
        assert_eq!(tail("aé", 1), "");
    }

    #[test]
    fn agentd_is_embedded() {
        assert!(AGENTD_SOURCE.contains("class Relay"));
    }
}
