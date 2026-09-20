//! boxd access for the desktop. Everything goes through the external `boxd`
//! CLI with `--json`, argument vectors, and explicit timeouts. The trait lets
//! tests drive the whole submission flow without a cloud.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

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
    Other(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::CliMissing => f.write_str(
                "the boxd CLI is not installed. Install it from https://boxd.sh and run `boxd auth`.",
            ),
            TransportError::Unauthenticated(m) => write!(f, "boxd is not authenticated: {m}"),
            TransportError::NotFound(m) => write!(f, "boxd machine not found: {m}"),
            TransportError::Timeout(m) => write!(f, "boxd command timed out: {m}"),
            TransportError::Other(m) => write!(f, "boxd: {m}"),
        }
    }
}

pub type TResult<T> = Result<T, TransportError>;

pub trait Boxd: Send + Sync {
    fn auth(&self) -> TResult<serde_json::Value>;
    fn machine_get(&self, vm: &str) -> TResult<MachineInfo>;
    fn machine_start(&self, vm: &str) -> TResult<()>;
    fn fork(&self, source: &str, name: &str, suspend_secs: u64, hibernate_secs: u64) -> TResult<MachineInfo>;
    fn config_set(&self, vm: &str, key: &str, value: &str) -> TResult<()>;
    fn cp_to(&self, local: &Path, vm: &str, remote_path: &str) -> TResult<()>;
    fn exec(&self, vm: &str, argv: &[String], timeout: Duration) -> TResult<ExecOutput>;
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
}

impl Boxd for BoxdCli {
    fn auth(&self) -> TResult<serde_json::Value> {
        self.json(&["auth", "--json"], Duration::from_secs(30))
    }

    fn machine_get(&self, vm: &str) -> TResult<MachineInfo> {
        let v = self.json(&["machine", "get", vm, "--json"], Duration::from_secs(60))?;
        serde_json::from_value(v).map_err(|e| TransportError::Other(format!("machine get: {e}")))
    }

    fn machine_start(&self, vm: &str) -> TResult<()> {
        self.json(&["machine", "start", vm, "--json"], Duration::from_secs(180))
            .map(|_| ())
    }

    fn fork(&self, source: &str, name: &str, suspend_secs: u64, hibernate_secs: u64) -> TResult<MachineInfo> {
        let s = suspend_secs.to_string();
        let h = hibernate_secs.to_string();
        let v = self.json(
            &[
                "machine",
                "fork",
                source,
                name,
                "--auto-suspend-timeout",
                &s,
                "--auto-hibernate-timeout",
                &h,
                "--json",
            ],
            Duration::from_secs(300),
        )?;
        // Fork responses omit status; normalise to what `get` returns.
        let mut info: MachineInfo = serde_json::from_value(serde_json::json!({
            "name": v.get("name").cloned().unwrap_or(serde_json::Value::String(name.into())),
            "id": v.get("id").cloned(),
            "status": v.get("status").cloned().unwrap_or(serde_json::Value::String("starting".into())),
            "source": v.get("source").cloned(),
        }))
        .map_err(|e| TransportError::Other(format!("fork: {e}")))?;
        if info.name.is_empty() {
            info.name = name.to_string();
        }
        Ok(info)
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
}
