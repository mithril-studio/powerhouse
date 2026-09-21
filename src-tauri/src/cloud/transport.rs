//! boxd access for the desktop. Everything goes through the external `boxd`
//! CLI with `--json`, argument vectors, and explicit timeouts. The trait lets
//! tests drive the whole submission and lifecycle flow without a cloud.
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
    #[serde(default)]
    pub isolated: Option<String>,
    #[serde(default)]
    pub auto_suspend: Option<String>,
    #[serde(default)]
    pub auto_hibernate: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

/// One row of `boxd snapshots list --json`. Versions are strings such as
/// `v1`; `snapshots save` reports them as integers, normalised here.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SnapshotInfo {
    pub name: String,
    #[serde(default, deserialize_with = "version_string")]
    pub version: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
}

fn version_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let v: Option<serde_json::Value> = serde::Deserialize::deserialize(d)?;
    Ok(v.and_then(|v| match v {
        serde_json::Value::String(s) => Some(if s.starts_with('v') { s } else { format!("v{s}") }),
        serde_json::Value::Number(n) => Some(format!("v{n}")),
        _ => None,
    }))
}

impl SnapshotInfo {
    pub fn is_ready(&self) -> bool {
        self.status == "ready"
    }
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
    fn auth(&self) -> TResult<serde_json::Value>;
    fn machine_list(&self) -> TResult<Vec<MachineInfo>>;
    fn machine_get(&self, vm: &str) -> TResult<MachineInfo>;
    fn machine_start(&self, vm: &str) -> TResult<()>;
    /// `boxd machine new <name> --from-snapshot <snapshot> [--isolated] --auto-suspend-timeout s --auto-hibernate-timeout h`.
    fn machine_new_from_snapshot(&self, name: &str, snapshot: &str, isolated: bool, suspend_secs: u64, hibernate_secs: u64) -> TResult<MachineInfo>;
    /// Destroys a machine. `vm` must be Powerhouse-owned (`ph-…`).
    fn machine_remove(&self, vm: &str) -> TResult<()>;
    fn config_set(&self, vm: &str, key: &str, value: &str) -> TResult<()>;
    fn cp_to(&self, local: &Path, vm: &str, remote_path: &str) -> TResult<()>;
    fn exec(&self, vm: &str, argv: &[String], timeout: Duration) -> TResult<ExecOutput>;
    fn snapshots_list(&self) -> TResult<Vec<SnapshotInfo>>;
    /// Saves memory + disk of a *running* machine under `name` (re-saving bumps the version).
    fn snapshot_save(&self, vm: &str, name: &str) -> TResult<SnapshotInfo>;
    /// Deletes a snapshot and its replicas. `name` must be Powerhouse-owned (`ph-…`).
    fn snapshot_remove(&self, name: &str) -> TResult<()>;
}

pub struct BoxdCli {
    pub binary: String,
}

impl Default for BoxdCli {
    fn default() -> Self {
        Self { binary: "boxd".into() }
    }
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
        let mut child = Command::new(&self.binary)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
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
            "source": v.get("source").cloned(),
        }))
        .map_err(|e| TransportError::Other(format!("machine new: {e}")))?;
        if info.name.is_empty() {
            info.name = name.to_string();
        }
        Ok(info)
    }
}

impl Boxd for BoxdCli {
    fn auth(&self) -> TResult<serde_json::Value> {
        self.json(&["auth", "--json"], Duration::from_secs(30))
    }

    fn machine_list(&self) -> TResult<Vec<MachineInfo>> {
        let v = self.json(&["machine", "list", "--json"], Duration::from_secs(60))?;
        serde_json::from_value(v).map_err(|e| TransportError::Other(format!("machine list: {e}")))
    }

    fn machine_get(&self, vm: &str) -> TResult<MachineInfo> {
        let v = self.json(&["machine", "get", vm, "--json"], Duration::from_secs(60))?;
        serde_json::from_value(v).map_err(|e| TransportError::Other(format!("machine get: {e}")))
    }

    fn machine_start(&self, vm: &str) -> TResult<()> {
        self.json(&["machine", "start", vm, "--json"], Duration::from_secs(180))
            .map(|_| ())
    }

    fn machine_new_from_snapshot(&self, name: &str, snapshot: &str, isolated: bool, suspend_secs: u64, hibernate_secs: u64) -> TResult<MachineInfo> {
        ensure_owned(name)?;
        let s = suspend_secs.to_string();
        let h = hibernate_secs.to_string();
        let mut args = vec![
            "machine",
            "new",
            name,
            "--from-snapshot",
            snapshot,
            "--auto-suspend-timeout",
            &s,
            "--auto-hibernate-timeout",
            &h,
        ];
        if isolated {
            args.push("--isolated");
        }
        args.push("--json");
        let v = self.json(&args, Duration::from_secs(300))?;
        Self::machine_from_create(v, name)
    }

    fn machine_remove(&self, vm: &str) -> TResult<()> {
        ensure_owned(vm)?;
        self.json(&["machine", "remove", vm, "--confirm", "--json"], Duration::from_secs(180))
            .map(|_| ())
    }

    fn config_set(&self, vm: &str, key: &str, value: &str) -> TResult<()> {
        self.json(&["machine", "config", "set", vm, key, value, "--json"], Duration::from_secs(60))
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

    fn snapshots_list(&self) -> TResult<Vec<SnapshotInfo>> {
        let v = self.json(&["snapshots", "list", "--json"], Duration::from_secs(60))?;
        serde_json::from_value(v).map_err(|e| TransportError::Other(format!("snapshots list: {e}")))
    }

    fn snapshot_save(&self, vm: &str, name: &str) -> TResult<SnapshotInfo> {
        // Saving copies memory and disk; the CLI blocks until the platform
        // has the snapshot (observed 14 s for an 8.7 GB base).
        let v = self.json(&["snapshots", "save", vm, name, "--json"], Duration::from_secs(600))?;
        let info = SnapshotInfo {
            name: v.get("name").and_then(|n| n.as_str()).unwrap_or(name).to_string(),
            version: v.get("version").and_then(|n| match n {
                serde_json::Value::Number(n) => Some(format!("v{n}")),
                serde_json::Value::String(s) => Some(if s.starts_with('v') { s.clone() } else { format!("v{s}") }),
                _ => None,
            }),
            status: v.get("status").and_then(|s| s.as_str()).unwrap_or("unknown").to_string(),
            size: v.get("size_bytes").and_then(|b| b.as_u64()).map(human_size),
            id: v.get("snapshot_id").and_then(|s| s.as_str()).map(|s| s.to_string()),
        };
        Ok(info)
    }

    fn snapshot_remove(&self, name: &str) -> TResult<()> {
        ensure_owned(name)?;
        self.json(&["snapshots", "remove", name, "--confirm", "--json"], Duration::from_secs(180))
            .map(|_| ())
    }
}

pub fn human_size(bytes: u64) -> String {
    let g = bytes as f64 / 1_073_741_824.0;
    if g >= 1.0 {
        format!("{g:.1}G")
    } else {
        format!("{:.0}M", bytes as f64 / 1_048_576.0)
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
        assert!(ensure_owned("ph-1a2b3c4d-park").is_ok());
        assert!(ensure_owned("ph-").is_err());
        assert!(ensure_owned("powerhouse-main").is_err());
        assert!(ensure_owned("legal-ai-app").is_err());
        assert!(ensure_owned("ph-x y").is_err());
        assert!(ensure_owned("").is_err());
    }

    #[test]
    fn cli_refuses_to_remove_unowned_names_before_spawning() {
        // A binary that cannot exist: the guard must fire first.
        let cli = BoxdCli { binary: "/nonexistent/boxd".into() };
        assert_eq!(cli.machine_remove("legal-ai-app"), Err(TransportError::NotOwned("legal-ai-app".into())));
        assert_eq!(cli.snapshot_remove("golden-copy"), Err(TransportError::NotOwned("golden-copy".into())));
        assert_eq!(cli.machine_new_from_snapshot("mine", "powerhouse-base", true, 0, 0).unwrap_err(), TransportError::NotOwned("mine".into()));
        // Owned names reach the (missing) CLI.
        assert_eq!(cli.machine_remove("ph-deadbeef"), Err(TransportError::CliMissing));
    }

    #[test]
    fn snapshot_rows_normalise_versions() {
        let rows: Vec<SnapshotInfo> = serde_json::from_str(
            r#"[{"name":"a","version":"v3","status":"ready","size":"8.8G","used":"80"},{"name":"b","version":2,"status":"saving"}]"#,
        )
        .unwrap();
        assert_eq!(rows[0].version.as_deref(), Some("v3"));
        assert!(rows[0].is_ready());
        assert_eq!(rows[1].version.as_deref(), Some("v2"));
        assert!(!rows[1].is_ready());
        assert_eq!(human_size(9_316_577_280), "8.7G");
    }
}
