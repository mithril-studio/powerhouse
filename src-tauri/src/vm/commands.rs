//! Tauri commands for VM image builds and cloud chat VMs.

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use super::builds::{self, BuildRequest, BuildStore, RepoBuilds, VmBuild};
use super::chats::{self, CreateRequest};
use super::config::VmConfig;
use crate::cloud::secrets::{Keychain, SecretStore};
use crate::cloud::transport::{Boxd, BoxdCli};

const BUILD_EVENT: &str = "vm-build-update";

pub struct VmManager {
    pub builds: Arc<Mutex<BuildStore>>,
    pub boxd: Arc<dyn Boxd>,
    pub secrets: Arc<dyn SecretStore>,
    /// Absolute path of the boxd CLI, for commands the chat pane spawns.
    pub boxd_bin: String,
    /// One mirror or commit-and-push at a time per worktree.
    sync_locks: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<()>>>>>,
}

impl VmManager {
    fn sync_lock(&self, worktree: &str) -> Arc<Mutex<()>> {
        self.sync_locks.lock().unwrap().entry(worktree.to_string()).or_default().clone()
    }
}

impl Default for VmManager {
    fn default() -> Self {
        let cli = BoxdCli::default();
        Self {
            builds: Arc::new(Mutex::new(BuildStore::open(BuildStore::default_path()))),
            boxd_bin: cli.binary.clone(),
            boxd: Arc::new(cli),
            secrets: Arc::new(Keychain),
            sync_locks: Default::default(),
        }
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Creates the chat's VM from the project's active image and checks out its
/// branch (seconds). Returns the VM name.
#[tauri::command]
pub async fn vm_chat_create(state: State<'_, VmManager>, req: CreateRequest) -> Result<String, String> {
    let (boxd, secrets, builds) = (state.boxd.clone(), state.secrets.clone(), state.builds.clone());
    blocking(move || {
        let deps = chats::Deps {
            boxd: boxd.as_ref(),
            secrets: secrets.as_ref(),
            github_fallback: crate::github::token(),
            builds: &builds,
            git_user: git_user(&req.repo_path),
        };
        chats::create(&deps, &req)
    })
    .await
}

/// Wakes the VM if needed. Called before every attach.
#[tauri::command]
pub async fn vm_chat_ensure_running(state: State<'_, VmManager>, vm: String) -> Result<(), String> {
    let boxd = state.boxd.clone();
    blocking(move || chats::ensure_running(boxd.as_ref(), &vm)).await
}

#[tauri::command]
pub async fn vm_chat_remove(state: State<'_, VmManager>, vm: String) -> Result<(), String> {
    let boxd = state.boxd.clone();
    blocking(move || chats::remove(boxd.as_ref(), &vm)).await
}

/// The command line `acp_spawn` runs to reach the chat's agent on its VM.
#[tauri::command]
pub fn vm_agent_command(
    state: State<VmManager>,
    vm: String,
    chat_id: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    let mut env: Vec<(String, String)> = env.unwrap_or_default().into_iter().collect();
    env.sort();
    chats::agent_command(&state.boxd_bin, &vm, &chat_id, &env)
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

/// Makes the cloud branch's local worktree mirror its VM (after each turn).
/// Returns the snapshot commit.
#[tauri::command]
pub async fn vm_chat_mirror(state: State<'_, VmManager>, vm: String, worktree: String, branch: String) -> Result<String, String> {
    let (boxd, lock) = (state.boxd.clone(), state.sync_lock(&worktree));
    blocking(move || {
        let _held = lock.lock().unwrap();
        super::sync::mirror(boxd.as_ref(), &vm, Path::new(&worktree), &branch)
    })
    .await
}

/// Commits everything on the VM, pushes the branch, and resets the local
/// branch to it (before a merge). Returns the pushed commit.
#[tauri::command]
pub async fn vm_chat_commit_push(
    state: State<'_, VmManager>,
    vm: String,
    worktree: String,
    branch: String,
    message: String,
) -> Result<String, String> {
    let (boxd, lock) = (state.boxd.clone(), state.sync_lock(&worktree));
    blocking(move || {
        let _held = lock.lock().unwrap();
        super::sync::commit_and_push(boxd.as_ref(), &vm, Path::new(&worktree), &branch, &message)
    })
    .await
}

/// Deletes a cloud branch's mirror ref from the remote (cleanup, best effort).
#[tauri::command]
pub async fn vm_chat_drop_mirror(repo_path: String, branch: String) -> Result<(), String> {
    blocking(move || {
        super::sync::drop_wip_ref(Path::new(&repo_path), &branch);
        Ok(())
    })
    .await
}

/// After a merge: deletes the chat VM only if it is clean and still at
/// `merged_head`. Returns whether it was deleted.
#[tauri::command]
pub async fn vm_chat_retire(state: State<'_, VmManager>, vm: String, merged_head: String) -> Result<bool, String> {
    let boxd = state.boxd.clone();
    blocking(move || chats::retire(boxd.as_ref(), &vm, &merged_head)).await
}
