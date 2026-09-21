//! Thin wrappers over `systemd-run` / `systemctl`. The transient unit is the
//! supervisor: its cgroup bounds every process a run spawns.

use std::process::Command;
use std::time::Duration;

use crate::paths;

#[derive(Debug, Clone, PartialEq)]
pub enum UnitStatus {
    Active,
    Inactive,
    NotFound,
    Unknown(String),
}

pub fn is_available() -> bool {
    Command::new("systemctl")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn cgroup_v2() -> bool {
    std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").exists()
}

pub fn unit_status(unit: &str) -> UnitStatus {
    let out = match Command::new("systemctl")
        .args(["show", unit, "-p", "LoadState", "-p", "ActiveState"])
        .output()
    {
        Ok(o) => o,
        Err(e) => return UnitStatus::Unknown(e.to_string()),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut load = "";
    let mut active = "";
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("LoadState=") {
            load = v.trim();
        } else if let Some(v) = line.strip_prefix("ActiveState=") {
            active = v.trim();
        }
    }
    match (load, active) {
        ("not-found", _) => UnitStatus::NotFound,
        (_, "active") | (_, "activating") | (_, "reloading") | (_, "deactivating") => {
            UnitStatus::Active
        }
        (_, "inactive") | (_, "failed") => UnitStatus::Inactive,
        _ => UnitStatus::Unknown(text.trim().to_string()),
    }
}

/// Launch the executor for `run_id` as a transient system service.
/// `backstop_secs` is systemd's own RuntimeMaxSec: the executor enforces the
/// real deadline itself, this only guarantees termination if it cannot.
pub fn launch_executor(run_id: &str, backstop_secs: u64, bin: &str) -> Result<String, String> {
    let unit = paths::unit_name(run_id);
    let results = paths::results_dir(run_id);
    std::fs::create_dir_all(&results).map_err(|e| e.to_string())?;
    let log = results.join("executor.log");
    let mut cmd = Command::new("systemd-run");
    cmd.arg(format!("--unit={unit}"))
        .arg("--service-type=exec")
        .arg("--collect")
        .arg("--property=KillMode=mixed")
        .arg("--property=TimeoutStopSec=20")
        .arg(format!("--property=RuntimeMaxSec={backstop_secs}"))
        .arg("--property=Restart=no")
        .arg("--property=ProtectHome=read-only")
        .arg("--property=PrivateTmp=yes")
        .arg("--property=NoNewPrivileges=no")
        .arg(format!("--property=ExecStopPost={bin} finalize {run_id}"))
        .arg(format!("--property=StandardOutput=append:{}", log.display()))
        .arg(format!("--property=StandardError=append:{}", log.display()))
        .arg("--setenv=POWERHOUSE_RUNNER_ROOT=".to_string() + &paths::root().to_string_lossy())
        .arg("--setenv=POWERHOUSE_RUNNER_WORK_ROOT=".to_string() + &paths::work_root().to_string_lossy())
        .arg("--")
        .arg(bin)
        .arg("execute")
        .arg(run_id);
    let out = cmd.output().map_err(|e| format!("systemd-run failed to start: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "systemd-run exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(unit)
}

pub fn stop_unit(unit: &str) -> Result<(), String> {
    let out = Command::new("systemctl")
        .args(["stop", "--no-block", unit])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Own cgroup path (v2), e.g. `/system.slice/powerhouse-run-x.service`.
pub fn own_cgroup() -> Option<String> {
    let text = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    text.lines()
        .find_map(|l| l.strip_prefix("0::").map(|s| s.to_string()))
}

/// PIDs in the cgroup other than ourselves.
pub fn cgroup_pids(cgroup: &str) -> Vec<i32> {
    let path = format!("/sys/fs/cgroup{cgroup}/cgroup.procs");
    let me = std::process::id() as i32;
    std::fs::read_to_string(path)
        .map(|t| {
            t.lines()
                .filter_map(|l| l.trim().parse::<i32>().ok())
                .filter(|p| *p != me)
                .collect()
        })
        .unwrap_or_default()
}

/// SIGTERM then SIGKILL everything else in our cgroup; returns leftovers.
pub fn sweep_cgroup(grace: Duration) -> Vec<i32> {
    let Some(cg) = own_cgroup() else {
        return vec![];
    };
    let pids = cgroup_pids(&cg);
    for p in &pids {
        unsafe {
            libc::kill(*p, libc::SIGTERM);
        }
    }
    let start = std::time::Instant::now();
    while start.elapsed() < grace && !cgroup_pids(&cg).is_empty() {
        std::thread::sleep(Duration::from_millis(100));
    }
    for p in cgroup_pids(&cg) {
        unsafe {
            libc::kill(p, libc::SIGKILL);
        }
    }
    std::thread::sleep(Duration::from_millis(200));
    cgroup_pids(&cg)
}

pub fn write_reconcile_unit(bin: &str) -> Result<(), String> {
    let unit = format!(
        "[Unit]\nDescription=Powerhouse runner: reconcile runs after boot\nAfter=local-fs.target\n\n[Service]\nType=oneshot\nExecStart={bin} reconcile --reason boot\n\n[Install]\nWantedBy=multi-user.target\n"
    );
    let path = format!("/etc/systemd/system/{}", paths::RECONCILE_UNIT);
    crate::util::write_atomic(std::path::Path::new(&path), unit.as_bytes(), 0o644)
        .map_err(|e| e.to_string())?;
    for args in [
        vec!["daemon-reload"],
        vec!["enable", paths::RECONCILE_UNIT],
    ] {
        let out = Command::new("systemctl").args(&args).output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "systemctl {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    Ok(())
}
