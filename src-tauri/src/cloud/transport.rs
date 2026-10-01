//! boxd access for the desktop. Everything goes through the external `boxd`
//! CLI with `--json`, argument vectors, and explicit timeouts. The trait lets
//! tests drive the workspace flow without a cloud.
//!
//! Naming contract: every machine or snapshot Powerhouse creates is named
//! `ph-…`. Destructive operations refuse any other name, so a bug in the
//! lifecycle code cannot delete an unrelated machine in the same org.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Prefix of every boxd resource Powerhouse owns and may destroy.
pub const OWNED_PREFIX: &str = "ph-";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct MachineInfo {
    pub name: String,
    #[serde(default)]
    pub id: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ExecOutput {
    pub output: String,
    pub exit_code: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TransportError {
    /// `boxd` is not installed or not on PATH.
    CliMissing,
    /// Not logged in / no org context.
    Unauthenticated(String),
    NotFound(String),
    Timeout(String),
    /// A destructive call named something Powerhouse does not own.
    NotOwned(String),
    Other(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::CliMissing => f.write_str(
                "the boxd CLI is not installed. Install it from https://boxd.sh and run `boxd auth`.",
            ),
            TransportError::Unauthenticated(m) => write!(f, "boxd is not authenticated: {m}"),
            TransportError::NotFound(m) => write!(f, "boxd resource not found: {m}"),
            TransportError::Timeout(m) => write!(f, "boxd command timed out: {m}"),
            TransportError::NotOwned(m) => write!(f, "refusing to touch `{m}`: Powerhouse only removes resources named `{OWNED_PREFIX}…`"),
            TransportError::Other(m) => write!(f, "boxd: {m}"),
        }
    }
}

pub type TResult<T> = Result<T, TransportError>;

/// Guard for destructive operations.
pub fn ensure_owned(name: &str) -> TResult<()> {
    let ok = name.starts_with(OWNED_PREFIX)
        && name.len() > OWNED_PREFIX.len()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(TransportError::NotOwned(name.to_string()))
    }
}

pub trait Boxd: Send + Sync {
    fn machine_get(&self, vm: &str) -> TResult<MachineInfo>;
    fn machine_start(&self, vm: &str) -> TResult<()>;
    /// `boxd machine new <name>`: a fresh machine from the org's default image.
    fn machine_new(&self, name: &str) -> TResult<MachineInfo>;
    /// Destroys a machine. `vm` must be Powerhouse-owned (`ph-…`).
    fn machine_remove(&self, vm: &str) -> TResult<()>;
    fn cp_to(&self, local: &Path, vm: &str, remote_path: &str) -> TResult<()>;
    fn exec(&self, vm: &str, argv: &[String], timeout: Duration) -> TResult<ExecOutput>;
}

pub struct BoxdCli {
    pub binary: String,
    /// Optional API key passed to boxd as `BOXD_TOKEN`. Lets auth work without
    /// depending on the cached `boxd auth login` session (e.g. a key from
    /// settings). `None` falls back to boxd's own stored credentials.
    pub token: Option<String>,
}

impl Default for BoxdCli {
    fn default() -> Self {
        Self {
            binary: resolve_boxd_binary(),
            token: std::env::var("BOXD_TOKEN").ok().filter(|s| !s.is_empty()),
        }
    }
}

/// Locate the `boxd` executable by absolute path.
///
/// A desktop app launched from Finder/Dock inherits the stripped launchd PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), which omits every dir boxd installs into.
/// Spawning bare `"boxd"` then fails with `NotFound` — surfaced to the user as
/// "the boxd CLI is not installed" — even though it is. Probe the known install
/// locations directly; fall back to `"boxd"` so a PATH that *does* contain it
/// (e.g. `tauri dev` launched from a shell) keeps working.
fn resolve_boxd_binary() -> String {
    if let Some(explicit) = std::env::var_os("BOXD_BIN") {
        if !explicit.is_empty() {
            return explicit.to_string_lossy().into_owned();
        }
    }
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(std::path::Path::new(&home).join(".local/bin/boxd"));
    }
    candidates.push("/opt/homebrew/bin/boxd".into());
    candidates.push("/usr/local/bin/boxd".into());
    first_existing(&candidates).unwrap_or_else(|| "boxd".into())
}

/// First candidate that resolves to a file (symlinks are followed), if any.
fn first_existing(candidates: &[std::path::PathBuf]) -> Option<String> {
    candidates
        .iter()
        .find(|c| c.is_file())
        .map(|c| c.to_string_lossy().into_owned())
}

/// The CLI prints upgrade notices around its JSON; find the JSON document.
pub fn extract_json(stdout: &str) -> Option<serde_json::Value> {
    let start = stdout.find(|c| c == '{' || c == '[')?;
    let candidate = &stdout[start..];
    let mut de = serde_json::Deserializer::from_str(candidate).into_iter::<serde_json::Value>();
    de.next().and_then(|r| r.ok())
}

impl BoxdCli {
    fn run(&self, args: &[&str], timeout: Duration) -> TResult<(String, String, i32)> {
        let mut cmd = Command::new(&self.binary);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(token) = &self.token {
            cmd.env("BOXD_TOKEN", token);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    TransportError::CliMissing
                } else {
                    TransportError::Other(e.to_string())
                }
            })?;
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if start.elapsed() > timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(TransportError::Timeout(format!("boxd {}", args.join(" "))));
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(TransportError::Other(e.to_string())),
            }
        }
        let out = child.wait_with_output().map_err(|e| TransportError::Other(e.to_string()))?;
        Ok((
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
            out.status.code().unwrap_or(-1),
        ))
    }

    fn json(&self, args: &[&str], timeout: Duration) -> TResult<serde_json::Value> {
        let (stdout, stderr, code) = self.run(args, timeout)?;
        let text = format!("{stdout}\n{stderr}");
        if code != 0 {
            let lower = text.to_lowercase();
            if lower.contains("not logged in") || lower.contains("unauthenticated") || lower.contains("auth login") {
                return Err(TransportError::Unauthenticated(stderr.trim().to_string()));
            }
            if lower.contains("not found") {
                return Err(TransportError::NotFound(stderr.trim().to_string()));
            }
            return Err(TransportError::Other(format!(
                "boxd {} exited {code}: {}",
                args.join(" "),
                stderr.trim()
            )));
        }
        extract_json(&stdout).ok_or_else(|| {
            TransportError::Other(format!("boxd {} returned no JSON", args.join(" ")))
        })
    }

    fn machine_from_create(v: serde_json::Value, name: &str) -> TResult<MachineInfo> {
        // Create responses omit status; normalise to what `get` returns.
        let mut info: MachineInfo = serde_json::from_value(serde_json::json!({
            "name": v.get("name").cloned().unwrap_or(serde_json::Value::String(name.into())),
            "id": v.get("id").cloned(),
            "status": v.get("status").cloned().unwrap_or(serde_json::Value::String("starting".into())),
        }))
        .map_err(|e| TransportError::Other(format!("machine new: {e}")))?;
        if info.name.is_empty() {
            info.name = name.to_string();
        }
        Ok(info)
    }
}

impl Boxd for BoxdCli {
    fn machine_get(&self, vm: &str) -> TResult<MachineInfo> {
        let v = self.json(&["machine", "get", vm, "--json"], Duration::from_secs(60))?;
        serde_json::from_value(v).map_err(|e| TransportError::Other(format!("machine get: {e}")))
    }

    fn machine_start(&self, vm: &str) -> TResult<()> {
        self.json(&["machine", "start", vm, "--json"], Duration::from_secs(180))
            .map(|_| ())
    }

    fn machine_new(&self, name: &str) -> TResult<MachineInfo> {
        ensure_owned(name)?;
        let v = self.json(&["machine", "new", name, "--json"], Duration::from_secs(300))?;
        Self::machine_from_create(v, name)
    }

    fn machine_remove(&self, vm: &str) -> TResult<()> {
        ensure_owned(vm)?;
        self.json(&["machine", "remove", vm, "--confirm", "--json"], Duration::from_secs(180))
            .map(|_| ())
    }

    fn cp_to(&self, local: &Path, vm: &str, remote_path: &str) -> TResult<()> {
        let local_s = local.to_string_lossy().to_string();
        let dest = format!("{vm}:{remote_path}");
        let (_, stderr, code) = self.run(&["machine", "cp", &local_s, &dest, "--json"], Duration::from_secs(300))?;
        if code != 0 {
            return Err(TransportError::Other(format!("cp failed: {}", stderr.trim())));
        }
        Ok(())
    }

    fn exec(&self, vm: &str, argv: &[String], timeout: Duration) -> TResult<ExecOutput> {
        let secs = (timeout.as_secs().max(5)).to_string();
        let mut args: Vec<&str> = vec!["machine", "exec", vm, "--timeout", &secs, "--json", "--"];
        for a in argv {
            args.push(a.as_str());
        }
        let v = self.json(&args, timeout + Duration::from_secs(30))?;
        serde_json::from_value(v).map_err(|e| TransportError::Other(format!("exec: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_json_after_notices() {
        let s = "(restarted client-utilities daemon)\n{\"name\":\"x\",\"status\":\"running\"}\n\n  A new version is available\n";
        let v = extract_json(s).unwrap();
        assert_eq!(v["status"], "running");
        assert!(extract_json("nothing here").is_none());
    }

    #[test]
    fn only_powerhouse_names_pass_the_destructive_guard() {
        assert!(ensure_owned("ph-1a2b3c4d").is_ok());
        assert!(ensure_owned("ph-fix-cloud").is_ok());
        assert!(ensure_owned("ph-").is_err());
        assert!(ensure_owned("powerhouse-main").is_err());
        assert!(ensure_owned("legal-ai-app").is_err());
        assert!(ensure_owned("ph-x y").is_err());
        assert!(ensure_owned("").is_err());
    }

    #[test]
    fn cli_refuses_to_remove_unowned_names_before_spawning() {
        // A binary that cannot exist: the guard must fire first.
        let cli = BoxdCli { binary: "/nonexistent/boxd".into(), token: None };
        assert_eq!(cli.machine_remove("legal-ai-app"), Err(TransportError::NotOwned("legal-ai-app".into())));
        assert_eq!(cli.machine_new("mine").unwrap_err(), TransportError::NotOwned("mine".into()));
        // Owned names reach the (missing) CLI.
        assert_eq!(cli.machine_remove("ph-deadbeef"), Err(TransportError::CliMissing));
    }

    #[test]
    fn binary_resolver_picks_the_first_existing_candidate() {
        // A real file that is guaranteed to exist: this test binary itself.
        let real = std::env::current_exe().unwrap();
        let missing = std::path::PathBuf::from("/nonexistent/boxd");
        assert_eq!(
            first_existing(&[missing.clone(), real.clone()]),
            Some(real.to_string_lossy().into_owned()),
        );
        // Later candidates never mask an earlier hit.
        assert_eq!(
            first_existing(&[real.clone(), missing.clone()]),
            Some(real.to_string_lossy().into_owned()),
        );
        assert_eq!(first_existing(&[missing]), None);
        assert_eq!(first_existing(&[]), None);
    }
}
