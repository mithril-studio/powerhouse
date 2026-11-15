//! Tauri commands for VM image builds.

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use super::builds::{self, BuildRequest, BuildStore, RepoBuilds, VmBuild};
use super::config::VmConfig;
use crate::cloud::secrets::{Keychain, SecretStore};
use crate::cloud::transport::{Boxd, BoxdCli};

const BUILD_EVENT: &str = "vm-build-update";

pub struct VmManager {
    pub builds: Arc<Mutex<BuildStore>>,
    pub boxd: Arc<dyn Boxd>,
    pub secrets: Arc<dyn SecretStore>,
}

impl Default for VmManager {
    fn default() -> Self {
        Self {
            builds: Arc::new(Mutex::new(BuildStore::open(BuildStore::default_path()))),
            boxd: Arc::new(BoxdCli::default()),
            secrets: Arc::new(Keychain),
        }
    }
}

/// The identity commits on a VM are made with: the repo's local git identity.
pub fn git_user(repo_path: &str) -> (String, String) {
    let get = |key: &str| {
        crate::git::git(Path::new(repo_path), &["config", key]).ok().filter(|v| !v.trim().is_empty())
    };
    (
        get("user.name").unwrap_or_else(|| "Powerhouse".into()),
        get("user.email").unwrap_or_else(|| "powerhouse@localhost".into()),
    )
}

#[tauri::command]
pub fn vm_builds(state: State<VmManager>, repo_id: String) -> RepoBuilds {
    state.builds.lock().unwrap().for_repo(&repo_id)
}

#[tauri::command]
pub fn vm_build_activate(state: State<VmManager>, repo_id: String, number: u32) -> Result<RepoBuilds, String> {
    let mut store = state.builds.lock().unwrap();
    store.activate(&repo_id, number)?;
    Ok(store.for_repo(&repo_id))
}

/// `powerhouse.toml` on the target branch, parsed; an error explains what is wrong.
#[tauri::command]
pub fn vm_config(repo_path: String, branch: String) -> Result<VmConfig, String> {
    builds::local_config(&repo_path, &branch)
}

/// Records the build and runs it in the background; progress arrives as
/// `vm-build-update` events carrying the whole record.
#[tauri::command]
pub fn vm_build_start(app: AppHandle, state: State<VmManager>, req: BuildRequest) -> Result<VmBuild, String> {
    let boxd = state.boxd.clone();
    let secrets = state.secrets.clone();
    let store = state.builds.clone();
    let git_user = git_user(&req.repo_path);
    let emit_app = app.clone();
    let notify = move |b: &VmBuild| {
        let _ = emit_app.emit(BUILD_EVENT, b);
    };
    let deps = builds::Deps {
        boxd: boxd.as_ref(),
        secrets: secrets.as_ref(),
        github_fallback: crate::github::token(),
        store: &store,
        notify: &notify,
        git_user: git_user.clone(),
    };
    let build = builds::begin(&deps, &req)?;
    let first = build.clone();
    std::thread::spawn(move || {
        let notify = move |b: &VmBuild| {
            let _ = app.emit(BUILD_EVENT, b);
        };
        let deps = builds::Deps {
            boxd: boxd.as_ref(),
            secrets: secrets.as_ref(),
            github_fallback: crate::github::token(),
            store: &store,
            notify: &notify,
            git_user,
        };
        builds::run(&deps, &req, build);
    });
    Ok(first)
}
