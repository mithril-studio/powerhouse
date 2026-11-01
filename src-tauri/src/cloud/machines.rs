//! The Machines tab: every boxd machine on the account, with create, start,
//! stop, delete and "open in editor". Shells are not handled here: the
//! frontend runs `boxd connect <vm>` in a terminal, which brings its own SSH.
//!
//! Delete stays behind `ensure_owned`, so only `ph-…` machines can go.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use tauri::State;

use super::commands::CloudManager;
use super::transport::{ensure_owned, Boxd, MachineInfo, OWNED_PREFIX};
use super::workspace as ws;

const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

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

/// Whether boxd's client daemon has written `Host <vm>.boxd` into the SSH config.
pub fn ssh_config_has_host(config: &str, vm: &str) -> bool {
    let alias = format!("{vm}.boxd");
    config.lines().any(|line| {
        let mut words = line.split_whitespace();
        words.next().is_some_and(|w| w.eq_ignore_ascii_case("host")) && words.any(|w| w == alias)
    })
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Editor {
    Vscode,
    Cursor,
}

/// The editor's Remote-SSH deep link. Opening a link avoids needing `code` or
/// `cursor` on the stripped PATH a Finder-launched app gets.
pub fn editor_url(editor: Editor, vm: &str, path: &str) -> String {
    let scheme = match editor {
        Editor::Vscode => "vscode",
        Editor::Cursor => "cursor",
    };
    format!("{scheme}://vscode-remote/ssh-remote+{vm}.boxd{path}")
}

/// `~/repo` when it exists (cloud workspaces clone there), otherwise `~`.
fn remote_folder(boxd: &dyn Boxd, vm: &str) -> Result<String, String> {
    let script = r#"if [ -d "$HOME/repo" ]; then echo "$HOME/repo"; else echo "$HOME"; fi"#;
    let out = boxd
        .exec(vm, &["bash".into(), "-lc".into(), script.into()], PROBE_TIMEOUT)
        .map_err(|e| e.to_string())?;
    let path = out.output.lines().map(str::trim).rfind(|l| l.starts_with('/')).unwrap_or_default();
    if out.exit_code != 0 || path.is_empty() || path.contains(char::is_whitespace) {
        return Err(format!("could not find the home folder on {vm}"));
    }
    Ok(path.to_string())
}

pub fn editor_link(boxd: &dyn Boxd, ssh_config: &str, vm: &str, editor: Editor) -> Result<String, String> {
    check_name(vm)?;
    if !ssh_config_has_host(ssh_config, vm) {
        return Err(format!(
            "~/.ssh/config has no `{vm}.boxd` entry yet. boxd's background service writes it shortly after a machine is created; try again in a minute."
        ));
    }
    Ok(editor_url(editor, vm, &remote_folder(boxd, vm)?))
}

fn read_ssh_config() -> String {
    let home = std::env::var_os("HOME").unwrap_or_default();
    std::fs::read_to_string(Path::new(&home).join(".ssh/config")).unwrap_or_default()
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

#[tauri::command]
pub async fn machine_open_in_editor(state: State<'_, CloudManager>, vm: String, editor: Editor) -> Result<(), String> {
    let boxd = state.boxd.clone();
    blocking(move || {
        let url = editor_link(boxd.as_ref(), &read_ssh_config(), &vm, editor)?;
        let status = Command::new("/usr/bin/open").arg(&url).status().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("could not open {url}: is the editor installed?"))
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::transport::{ExecOutput, TResult, TransportError};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        machines: Vec<MachineInfo>,
        exec_output: String,
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
            Ok(ExecOutput { output: self.exec_output.clone(), exit_code: 0 })
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

    const SSH_CONFIG: &str = "Include ~/.ssh/other\n# BEGIN boxd\nHost *.boxd *.boxd.sh boxd.sh\n    SetEnv X=1\n\nHost workflows.boxd workflows.boxd.sh\n    HostName workflows.boxd.sh\n# END boxd\n";

    #[test]
    fn finds_hosts_written_by_boxd() {
        assert!(ssh_config_has_host(SSH_CONFIG, "workflows"));
        assert!(!ssh_config_has_host(SSH_CONFIG, "work"));
        assert!(!ssh_config_has_host(SSH_CONFIG, "ph-new"));
        assert!(!ssh_config_has_host("# Host ph-a.boxd\n", "ph-a"));
    }

    #[test]
    fn editor_link_opens_the_repo_over_the_boxd_host_alias() {
        let fake = Fake { exec_output: "(notice)\n/home/boxd/repo\n".into(), ..Fake::with(&[]) };
        assert_eq!(
            editor_link(&fake, SSH_CONFIG, "workflows", Editor::Vscode).unwrap(),
            "vscode://vscode-remote/ssh-remote+workflows.boxd/home/boxd/repo"
        );
        assert_eq!(editor_url(Editor::Cursor, "a", "/home/boxd"), "cursor://vscode-remote/ssh-remote+a.boxd/home/boxd");
    }

    #[test]
    fn editor_link_explains_a_missing_ssh_entry_without_touching_the_vm() {
        let fake = Fake::with(&[]);
        assert!(editor_link(&fake, SSH_CONFIG, "ph-new", Editor::Vscode).unwrap_err().contains("no `ph-new.boxd` entry"));
        assert!(fake.calls().is_empty());
    }
}
