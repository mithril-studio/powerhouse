//! The Machines tab: every boxd machine on the account, with create, start,
//! stop and delete. Shells are not handled here: the
//! frontend runs `boxd connect <vm>` in a terminal, which brings its own SSH.
//!
//! Delete stays behind `ensure_owned`, so only `ph-…` machines can go.

use tauri::State;

use super::commands::CloudManager;
use super::transport::{ensure_owned, Boxd, MachineInfo, OWNED_PREFIX};
use super::workspace as ws;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineRow {
    pub name: String,
    pub status: String,
    pub url: Option<String>,
    pub size: Option<String>,
    /// Named `ph-…`: Powerhouse may delete it.
    pub owned: bool,
}

impl From<MachineInfo> for MachineRow {
    fn from(m: MachineInfo) -> Self {
        let owned = ensure_owned(&m.name).is_ok();
        Self { name: m.name, status: m.status, url: m.url, size: m.size, owned }
    }
}

/// A name boxd accepts and no CLI could read as a flag.
fn check_name(vm: &str) -> Result<(), String> {
    let ok = !vm.is_empty()
        && vm.len() <= 63
        && !vm.starts_with('-')
        && vm.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("`{vm}` is not a machine name: use lowercase letters, digits and dashes"))
    }
}

/// What the user typed, as a Powerhouse-owned name: trimmed, lowercased, `ph-` added.
pub fn owned_name(input: &str) -> Result<String, String> {
    let name = input.trim().to_lowercase();
    let name = if name.starts_with(OWNED_PREFIX) { name } else { format!("{OWNED_PREFIX}{name}") };
    check_name(&name)?;
    ensure_owned(&name).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Running machines first, then by name.
pub fn list(boxd: &dyn Boxd) -> Result<Vec<MachineRow>, String> {
    let mut rows: Vec<MachineRow> = boxd.machine_list().map_err(|e| e.to_string())?.into_iter().map(Into::into).collect();
    rows.sort_by(|a, b| (a.status != "running", &a.name).cmp(&(b.status != "running", &b.name)));
    Ok(rows)
}

pub fn create(boxd: &dyn Boxd, input: &str) -> Result<MachineRow, String> {
    let name = owned_name(input)?;
    if boxd.machine_list().map_err(|e| e.to_string())?.iter().any(|m| m.name == name) {
        return Err(format!("a machine named `{name}` already exists"));
    }
    boxd.machine_new(&name).map(Into::into).map_err(|e| e.to_string())
}

pub fn start(boxd: &dyn Boxd, vm: &str) -> Result<(), String> {
    check_name(vm)?;
    boxd.machine_start(vm).map_err(|e| e.to_string())
}

pub fn stop(boxd: &dyn Boxd, vm: &str) -> Result<(), String> {
    check_name(vm)?;
    boxd.machine_stop(vm).map_err(|e| e.to_string())
}

/// `confirm` must repeat the name: the UI makes the user type it.
pub fn remove(boxd: &dyn Boxd, vm: &str, confirm: &str) -> Result<(), String> {
    check_name(vm)?;
    if confirm.trim() != vm {
        return Err(format!("type `{vm}` to confirm"));
    }
    boxd.machine_remove(vm).map_err(|e| e.to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn machines_list(state: State<'_, CloudManager>) -> Result<Vec<MachineRow>, String> {
    let boxd = state.boxd.clone();
    blocking(move || list(boxd.as_ref())).await
}

/// The name a new machine for this branch gets, same as its cloud workspace VM.
#[tauri::command]
pub fn machine_suggest_name(branch: String) -> String {
    ws::vm_name(&branch)
}

#[tauri::command]
pub async fn machine_create(state: State<'_, CloudManager>, name: String) -> Result<MachineRow, String> {
    let boxd = state.boxd.clone();
    blocking(move || create(boxd.as_ref(), &name)).await
}

#[tauri::command]
pub async fn machine_start(state: State<'_, CloudManager>, vm: String) -> Result<(), String> {
    let boxd = state.boxd.clone();
    blocking(move || start(boxd.as_ref(), &vm)).await
}

#[tauri::command]
pub async fn machine_stop(state: State<'_, CloudManager>, vm: String) -> Result<(), String> {
    let boxd = state.boxd.clone();
    blocking(move || stop(boxd.as_ref(), &vm)).await
}

#[tauri::command]
pub async fn machine_remove(state: State<'_, CloudManager>, vm: String, confirm: String) -> Result<(), String> {
    let boxd = state.boxd.clone();
    blocking(move || remove(boxd.as_ref(), &vm, &confirm)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::transport::{ExecOutput, TResult, TransportError};
    use std::path::Path;
    use std::sync::Mutex;
    use std::time::Duration;

    #[derive(Default)]
    struct Fake {
        machines: Vec<MachineInfo>,
        calls: Mutex<Vec<String>>,
    }

    impl Fake {
        fn with(names: &[(&str, &str)]) -> Self {
            let machines = names
                .iter()
                .map(|(n, s)| MachineInfo { name: (*n).into(), status: (*s).into(), ..Default::default() })
                .collect();
            Self { machines, ..Default::default() }
        }
        fn log(&self, call: String) {
            self.calls.lock().unwrap().push(call);
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Boxd for Fake {
        fn machine_list(&self) -> TResult<Vec<MachineInfo>> {
            Ok(self.machines.clone())
        }
        fn machine_get(&self, vm: &str) -> TResult<MachineInfo> {
            self.machines.iter().find(|m| m.name == vm).cloned().ok_or_else(|| TransportError::NotFound(vm.into()))
        }
        fn machine_start(&self, vm: &str) -> TResult<()> {
            self.log(format!("start {vm}"));
            Ok(())
        }
        fn machine_stop(&self, vm: &str) -> TResult<()> {
            self.log(format!("stop {vm}"));
            Ok(())
        }
        fn machine_new(&self, vm: &str) -> TResult<MachineInfo> {
            ensure_owned(vm)?;
            self.log(format!("new {vm}"));
            Ok(MachineInfo { name: vm.into(), status: "starting".into(), ..Default::default() })
        }
        fn machine_remove(&self, vm: &str) -> TResult<()> {
            ensure_owned(vm)?;
            self.log(format!("remove {vm}"));
            Ok(())
        }
        fn cp_to(&self, _: &Path, _: &str, _: &str) -> TResult<()> {
            Ok(())
        }
        fn exec(&self, vm: &str, _: &[String], _: Duration) -> TResult<ExecOutput> {
            self.log(format!("exec {vm}"));
            Ok(ExecOutput { output: String::new(), exit_code: 0 })
        }
    }

    #[test]
    fn lists_running_first_and_flags_owned_machines() {
        let fake = Fake::with(&[("zeta", "stopped"), ("ph-b", "running"), ("alpha", "hibernated"), ("ph-a", "running")]);
        let rows = list(&fake).unwrap();
        let names: Vec<_> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["ph-a", "ph-b", "alpha", "zeta"]);
        assert!(rows[0].owned);
        assert!(!rows[2].owned);
    }

    #[test]
    fn new_machines_are_always_powerhouse_owned() {
        assert_eq!(owned_name(" Try-Machines ").unwrap(), "ph-try-machines");
        assert_eq!(owned_name("ph-x").unwrap(), "ph-x");
        assert!(owned_name("").is_err());
        assert!(owned_name("ph-").is_err());
        assert!(owned_name("has space").is_err());
        assert!(owned_name("--fork=prod").is_err());
    }

    #[test]
    fn create_refuses_an_existing_name() {
        let fake = Fake::with(&[("ph-taken", "running")]);
        assert!(create(&fake, "taken").unwrap_err().contains("already exists"));
        let row = create(&fake, "fresh").unwrap();
        assert_eq!(row.name, "ph-fresh");
        assert!(row.owned);
        assert_eq!(fake.calls(), ["new ph-fresh"]);
    }

    #[test]
    fn start_and_stop_reject_flag_like_names_before_calling_boxd() {
        let fake = Fake::with(&[]);
        assert!(stop(&fake, "--all").is_err());
        assert!(start(&fake, "").is_err());
        stop(&fake, "workflows").unwrap();
        start(&fake, "workflows").unwrap();
        assert_eq!(fake.calls(), ["stop workflows", "start workflows"]);
    }

    #[test]
    fn remove_needs_the_typed_name_and_an_owned_machine() {
        let fake = Fake::with(&[]);
        assert!(remove(&fake, "ph-a", "ph-b").unwrap_err().contains("type `ph-a`"));
        assert!(remove(&fake, "legal-ai-app", "legal-ai-app").unwrap_err().contains("only removes"));
        remove(&fake, "ph-a", " ph-a ").unwrap();
        assert_eq!(fake.calls(), ["remove ph-a"]);
    }

    /// Real boxd: the Machines tab's calls on a throwaway `ph-e2e-…` machine.
    /// `PH_CLOUD_E2E=1 cargo test machines_on_a_real_vm -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn machines_on_a_real_vm() {
        if std::env::var("PH_CLOUD_E2E").is_err() {
            return;
        }
        use crate::cloud::transport::BoxdCli;
        let boxd = BoxdCli::default();
        let vm = format!("ph-e2e-{}", &uuid::Uuid::new_v4().to_string()[..6]);
        let wait_for = |what: &str, secs: u64, ok: &dyn Fn() -> bool| {
            let t = std::time::Instant::now();
            while !ok() {
                assert!(t.elapsed().as_secs() < secs, "timed out waiting for {what}");
                std::thread::sleep(Duration::from_secs(3));
            }
            eprintln!("{what}: {}s", t.elapsed().as_secs());
        };
        let result = std::panic::catch_unwind(|| {
            let before = list(&boxd).unwrap();
            assert!(!before.is_empty(), "the account has machines");
            let row = create(&boxd, &vm).unwrap();
            assert!(row.owned);
            assert!(create(&boxd, &vm).unwrap_err().contains("already exists"));
            let status = || list(&boxd).unwrap().into_iter().find(|m| m.name == vm).map(|m| m.status);
            wait_for("running", 300, &|| status().as_deref() == Some("running"));
            stop(&boxd, &vm).unwrap();
            wait_for("stopped", 180, &|| status().as_deref() != Some("running"));
            eprintln!("after stop: {:?}", status());
            start(&boxd, &vm).unwrap();
            wait_for("running again", 300, &|| status().as_deref() == Some("running"));
        });
        let removed = remove(&boxd, &vm, &vm);
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
        removed.unwrap();
        assert!(list(&boxd).unwrap().iter().all(|m| m.name != vm), "{vm} is gone");
    }

}
