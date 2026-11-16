//! VM image builds: a repo's target branch cloned, tools and dependencies
//! installed, saved as a boxd snapshot that every new chat VM starts from.
//!
//! Build = fresh `ph-b-<slug>` VM → `~/.ph/env` → clone → `ph-agentd` and the
//! ACP adapter → `install` → `setup` → strip secrets → snapshot
//! `ph-<slug>-b<n>` → destroy the VM. The last [`KEEP`] successful builds per
//! repo are kept; the newest successful one is active unless another was
//! activated.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::config::{self, VmConfig};
use super::remote::{self, exec_ok, ADAPTER, AGENTD_PATH, AGENTD_SOURCE, REPO_DIR, WITH_ENV};
use crate::cloud::secrets::SecretStore;
use crate::cloud::transport::{Boxd, NewOpts, TransportError};
use crate::cloud::workspace as ws;

pub const KEEP: usize = 3;
const LOG_MAX: usize = 64 * 1024;
const STEP_TIMEOUT: Duration = Duration::from_secs(120);
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildStatus {
    Running,
    Ready,
    Failed,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmBuild {
    pub repo_id: String,
    pub number: u32,
    pub snapshot: String,
    pub branch: String,
    pub status: BuildStatus,
    /// What the build is doing now, or did last.
    pub step: String,
    /// The commit the image was built from.
    pub commit: Option<String>,
    pub error: Option<String>,
    /// Combined output of every step, capped at the last 64 KiB.
    pub log: String,
    pub started_ms: u64,
    pub finished_ms: Option<u64>,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct StoreFile {
    builds: Vec<VmBuild>,
    /// repo id → the build number new chats start from, when not the newest.
    #[serde(default)]
    active: HashMap<String, u32>,
}

pub struct BuildStore {
    path: PathBuf,
    data: StoreFile,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoBuilds {
    /// Newest first.
    pub builds: Vec<VmBuild>,
    pub active: Option<u32>,
}

impl BuildStore {
    pub fn default_path() -> PathBuf {
        dirs::home_dir().unwrap_or_default().join(".powerhouse").join("vm-builds.json")
    }

    /// Loads the store. A build still `running` was cut off by an app exit.
    pub fn open(path: PathBuf) -> Self {
        let mut data: StoreFile = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        for b in &mut data.builds {
            if b.status == BuildStatus::Running {
                b.status = BuildStatus::Failed;
                b.error = Some("Interrupted: Powerhouse quit during the build.".into());
            }
        }
        Self { path, data }
    }

    fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.data).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    pub fn put(&mut self, build: VmBuild) -> Result<(), String> {
        match self.data.builds.iter_mut().find(|b| b.repo_id == build.repo_id && b.number == build.number) {
            Some(existing) => *existing = build,
            None => self.data.builds.push(build),
        }
        self.save()
    }

    pub fn for_repo(&self, repo_id: &str) -> RepoBuilds {
        let mut builds: Vec<VmBuild> = self.data.builds.iter().filter(|b| b.repo_id == repo_id).cloned().collect();
        builds.sort_by(|a, b| b.number.cmp(&a.number));
        RepoBuilds { active: self.active_number(repo_id), builds }
    }

    fn active_number(&self, repo_id: &str) -> Option<u32> {
        let ready = |n: u32| {
            self.data.builds.iter().any(|b| b.repo_id == repo_id && b.number == n && b.status == BuildStatus::Ready)
        };
        if let Some(&n) = self.data.active.get(repo_id) {
            if ready(n) {
                return Some(n);
            }
        }
        self.data
            .builds
            .iter()
            .filter(|b| b.repo_id == repo_id && b.status == BuildStatus::Ready)
            .map(|b| b.number)
            .max()
    }

    /// The snapshot new chat VMs for this repo start from.
    pub fn active_snapshot(&self, repo_id: &str) -> Option<String> {
        let n = self.active_number(repo_id)?;
        self.data.builds.iter().find(|b| b.repo_id == repo_id && b.number == n).map(|b| b.snapshot.clone())
    }

    pub fn activate(&mut self, repo_id: &str, number: u32) -> Result<(), String> {
        let ok = self
            .data
            .builds
            .iter()
            .any(|b| b.repo_id == repo_id && b.number == number && b.status == BuildStatus::Ready);
        if !ok {
            return Err(format!("build {number} is not a ready build of this project"));
        }
        self.data.active.insert(repo_id.to_string(), number);
        self.save()
    }

    /// A pinned build is dropped once a newer build succeeds: building again
    /// means "use the new one".
    fn unpin(&mut self, repo_id: &str) {
        self.data.active.remove(repo_id);
    }

    pub fn running(&self, repo_id: &str) -> Option<&VmBuild> {
        self.data.builds.iter().find(|b| b.repo_id == repo_id && b.status == BuildStatus::Running)
    }

    fn next_number(&self, repo_id: &str) -> u32 {
        self.data.builds.iter().filter(|b| b.repo_id == repo_id).map(|b| b.number).max().unwrap_or(0) + 1
    }

    /// Removes failed builds beyond the newest one, and ready builds beyond
    /// the newest [`KEEP`] (never the active one). Returns the snapshots to delete.
    fn prune(&mut self, repo_id: &str) -> Vec<String> {
        let active = self.active_number(repo_id);
        let mut mine: Vec<&VmBuild> = self.data.builds.iter().filter(|b| b.repo_id == repo_id).collect();
        mine.sort_by(|a, b| b.number.cmp(&a.number));
        let mut ready_seen = 0;
        let mut failed_seen = 0;
        let mut drop: Vec<(u32, Option<String>)> = vec![];
        for b in mine {
            match b.status {
                BuildStatus::Running => {}
                BuildStatus::Ready => {
                    ready_seen += 1;
                    if ready_seen > KEEP && Some(b.number) != active {
                        drop.push((b.number, Some(b.snapshot.clone())));
                    }
                }
                BuildStatus::Failed => {
                    failed_seen += 1;
                    if failed_seen > 1 {
                        drop.push((b.number, None));
                    }
                }
            }
        }
        self.data.builds.retain(|b| !(b.repo_id == repo_id && drop.iter().any(|(n, _)| *n == b.number)));
        drop.into_iter().filter_map(|(_, s)| s).collect()
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRequest {
    pub repo_id: String,
    pub repo_name: String,
    pub repo_path: String,
    /// The target branch the image is built from.
    pub branch: String,
    pub env_names: Vec<String>,
}

pub struct Deps<'a> {
    pub boxd: &'a dyn Boxd,
    pub secrets: &'a dyn SecretStore,
    pub store: &'a std::sync::Mutex<BuildStore>,
    pub notify: &'a dyn Fn(&VmBuild),
    /// Git identity for commits made on chat VMs.
    pub git_user: (String, String),
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn build_vm_name(slug: &str) -> String {
    format!("ph-b-{slug}")
}

/// Records a new running build and returns it. Fails if one is already running.
pub fn begin(deps: &Deps, req: &BuildRequest) -> Result<VmBuild, String> {
    let mut store = deps.store.lock().unwrap();
    if let Some(b) = store.running(&req.repo_id) {
        return Err(format!("Build {} is still running.", b.number));
    }
    let number = store.next_number(&req.repo_id);
    let slug = remote::repo_slug(&req.repo_name, &req.repo_id);
    let build = VmBuild {
        repo_id: req.repo_id.clone(),
        number,
        snapshot: format!("ph-{slug}-b{number}"),
        branch: req.branch.clone(),
        status: BuildStatus::Running,
        step: "Starting".into(),
        commit: None,
        error: None,
        log: String::new(),
        started_ms: now_ms(),
        finished_ms: None,
    };
    store.put(build.clone())?;
    drop(store);
    (deps.notify)(&build);
    Ok(build)
}

struct Run<'a, 'b> {
    deps: &'a Deps<'b>,
    build: VmBuild,
}

impl Run<'_, '_> {
    fn step(&mut self, step: &str) {
        self.build.step = step.to_string();
        self.log(&format!("\n▸ {step}\n"));
    }

    fn log(&mut self, text: &str) {
        self.build.log.push_str(text);
        if self.build.log.len() > LOG_MAX {
            self.build.log = remote::tail(&self.build.log, LOG_MAX).to_string();
        }
        let _ = self.deps.store.lock().unwrap().put(self.build.clone());
        (self.deps.notify)(&self.build);
    }

    fn exec(&mut self, vm: &str, script: &str, timeout: Duration) -> Result<String, String> {
        let out = exec_ok(self.deps.boxd, vm, script, timeout)?;
        let trimmed = out.trim();
        if !trimmed.is_empty() {
            self.log(&format!("{}\n", remote::tail(trimmed, 8000)));
        }
        Ok(out)
    }
}

/// Runs the build recorded by [`begin`] to the end, then returns the final record.
pub fn run(deps: &Deps, req: &BuildRequest, build: VmBuild) -> VmBuild {
    let slug = remote::repo_slug(&req.repo_name, &req.repo_id);
    let vm = build_vm_name(&slug);
    let mut r = Run { deps, build };
    let result = steps(&mut r, req, &vm);

    // Never leave the build VM behind, whatever happened.
    let _ = deps.boxd.machine_remove(&vm);

    let mut store = deps.store.lock().unwrap();
    r.build.finished_ms = Some(now_ms());
    match result {
        Ok(()) => {
            r.build.status = BuildStatus::Ready;
            r.build.step = "Ready".into();
            store.unpin(&req.repo_id);
        }
        Err(e) => {
            r.build.status = BuildStatus::Failed;
            r.build.log.push_str(&format!("\n✗ {e}\n"));
            r.build.error = Some(e);
        }
    }
    let _ = store.put(r.build.clone());
    let stale = store.prune(&req.repo_id);
    let _ = store.save();
    drop(store);
    for snapshot in stale {
        let _ = deps.boxd.snapshot_remove(&snapshot);
    }
    (deps.notify)(&r.build);
    r.build
}

fn steps(r: &mut Run, req: &BuildRequest, vm: &str) -> Result<(), String> {
    let boxd = r.deps.boxd;
    let remote_url = local_remote(&req.repo_path)?;
    let config = local_config(&req.repo_path, &req.branch)?;

    r.step("Creating the build machine");
    match boxd.machine_remove(vm) {
        Ok(()) | Err(TransportError::NotFound(_)) => {}
        Err(_) => {} // nothing left over, or boxd will refuse the name below
    }
    let opts = NewOpts { vcpu: config.vcpu, auto_suspend_secs: Some(0), ..Default::default() };
    boxd.machine_new_with(vm, &opts).map_err(|e| e.to_string())?;
    remote::wait_running(boxd, vm)?;

    r.step("Uploading keys");
    remote::upload_env(
        boxd,
        r.deps.secrets,
        vm,
        &req.repo_id,
        &remote_url,
        &req.env_names,
    )?;

    r.step(&format!("Cloning {} ({})", remote_url, req.branch));
    let (name, email) = &r.deps.git_user;
    r.exec(vm, &ws::setup_script(&remote_url, &req.branch, name, email), SCRIPT_TIMEOUT)?;
    let commit = exec_ok(boxd, vm, &format!("git -C {REPO_DIR} rev-parse HEAD"), STEP_TIMEOUT)?;
    r.build.commit = Some(commit.trim().to_string());

    r.step("Installing ph-agentd and the Claude adapter");
    remote::upload(boxd, vm, AGENTD_PATH, AGENTD_SOURCE.as_bytes())?;
    // boxd reaches node through a symlink, so global npm installs (the adapter,
    // pnpm) land in a bin dir that login shells miss. Put it on their PATH.
    r.exec(vm, NODE_BIN_ON_PATH, STEP_TIMEOUT)?;
    r.exec(vm, &format!("npm install -g --silent {ADAPTER} && command -v claude-agent-acp"), SCRIPT_TIMEOUT)?;

    // The branch on the VM may hold a newer powerhouse.toml than the local ref.
    let on_vm = exec_ok(boxd, vm, &format!("cat {REPO_DIR}/{} 2>/dev/null || true", config::FILE), STEP_TIMEOUT)?;
    let config = if on_vm.trim().is_empty() { config } else { config::parse(&on_vm)? };
    let files = exec_ok(boxd, vm, &format!("ls -1A {REPO_DIR}"), STEP_TIMEOUT)?;
    let files: Vec<&str> = files.lines().map(str::trim).collect();

    if let Some(install) = &config.install {
        r.step(&format!("install: {install}"));
        r.exec(vm, &format!("{WITH_ENV}cd {REPO_DIR} && {install}"), SCRIPT_TIMEOUT)?;
    }
    match config::effective_setup(&config, &files) {
        Some(setup) => {
            r.step(&format!("setup: {setup}"));
            r.exec(vm, &format!("{WITH_ENV}cd {REPO_DIR} && {setup}"), SCRIPT_TIMEOUT)?;
        }
        None => r.log("No setup script and no lockfile found; skipping dependency install.\n"),
    }

    r.step("Saving the image");
    // Snapshots include memory and disk: no secrets and no agents in the image.
    exec_ok(
        boxd,
        vm,
        r#"rm -f "$HOME/.ph/env"; systemctl --user stop 'ph-agent-*' 2>/dev/null; sync"#,
        STEP_TIMEOUT,
    )?;
    boxd.snapshot_save(vm, &r.build.snapshot).map_err(|e| e.to_string())?;
    Ok(())
}

const NODE_BIN_ON_PATH: &str = r#"bin="$(dirname "$(readlink -f "$(command -v node)")")"
grep -q '# ph-node-bin' "$HOME/.profile" 2>/dev/null || echo "export PATH=\"$bin:\$PATH\" # ph-node-bin" >> "$HOME/.profile"
echo "node bin: $bin""#;

/// The https URL of `origin` in the local repo.
fn local_remote(repo_path: &str) -> Result<String, String> {
    let origin = crate::git::git(std::path::Path::new(repo_path), &["remote", "get-url", "origin"])
        .map_err(|_| "The repository has no `origin` remote for the VM to clone.".to_string())?;
    ws::https_remote(&origin).ok_or_else(|| format!("The VM needs a GitHub-style remote; `origin` is {origin}."))
}

/// `powerhouse.toml` as committed on the target branch locally (`origin/<branch>`
/// first). Missing means defaults.
pub fn local_config(repo_path: &str, branch: &str) -> Result<VmConfig, String> {
    let path = std::path::Path::new(repo_path);
    for rev in [format!("origin/{branch}"), branch.to_string()] {
        if let Ok(text) = crate::git::git(path, &["show", &format!("{rev}:{}", config::FILE)]) {
            return config::parse(&text);
        }
    }
    Ok(VmConfig::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::secrets::MemoryStore;
    use crate::cloud::transport::{ExecOutput, MachineInfo, TResult};
    use std::path::Path;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<String>>,
        fail_on: Option<&'static str>,
    }

    impl Fake {
        fn log(&self, s: String) {
            self.calls.lock().unwrap().push(s);
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Boxd for Fake {
        fn machine_list(&self) -> TResult<Vec<MachineInfo>> {
            Ok(vec![])
        }
        fn machine_get(&self, vm: &str) -> TResult<MachineInfo> {
            Ok(MachineInfo { name: vm.into(), status: "running".into(), ..Default::default() })
        }
        fn machine_start(&self, _: &str) -> TResult<()> {
            Ok(())
        }
        fn machine_stop(&self, _: &str) -> TResult<()> {
            Ok(())
        }
        fn machine_new(&self, vm: &str) -> TResult<MachineInfo> {
            self.machine_new_with(vm, &NewOpts::default())
        }
        fn machine_new_with(&self, vm: &str, opts: &NewOpts) -> TResult<MachineInfo> {
            self.log(format!("new {vm} vcpu={:?} suspend={:?}", opts.vcpu, opts.auto_suspend_secs));
            Ok(MachineInfo { name: vm.into(), status: "running".into(), ..Default::default() })
        }
        fn machine_remove(&self, vm: &str) -> TResult<()> {
            self.log(format!("remove {vm}"));
            Ok(())
        }
        fn cp_to(&self, _: &Path, _: &str, remote: &str) -> TResult<()> {
            self.log(format!("cp {remote}"));
            Ok(())
        }
        fn exec(&self, _: &str, argv: &[String], _: Duration) -> TResult<ExecOutput> {
            let script = argv.last().cloned().unwrap_or_default();
            self.log(format!("exec {script}"));
            if self.fail_on.is_some_and(|f| script.contains(f)) {
                return Ok(ExecOutput { output: "boom".into(), exit_code: 1 });
            }
            let output = if script.contains("rev-parse HEAD") {
                "abc123\n".to_string()
            } else if script.starts_with("ls -1A") {
                "package.json\npnpm-lock.yaml\n".to_string()
            } else {
                String::new()
            };
            Ok(ExecOutput { output, exit_code: 0 })
        }
        fn snapshot_save(&self, vm: &str, name: &str) -> TResult<()> {
            self.log(format!("snapshot {vm} {name}"));
            Ok(())
        }
        fn snapshot_remove(&self, name: &str) -> TResult<()> {
            self.log(format!("snapshot-rm {name}"));
            Ok(())
        }
    }

    fn git_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let g = |args: &[&str]| crate::git::git(p, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&["remote", "add", "origin", "git@github.com:me/app.git"]);
        std::fs::write(p.join(config::FILE), "[vm]\nvcpu = 4\ninstall = \"./tools.sh\"\n").unwrap();
        g(&["add", "."]);
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
        dir
    }

    fn secrets() -> MemoryStore {
        let s = MemoryStore::default();
        s.set(crate::cloud::secrets::CLAUDE_OAUTH, "claude-tok").unwrap();
        s.set("github_token", "gh-tok").unwrap();
        s
    }

    fn request(repo: &Path) -> BuildRequest {
        BuildRequest {
            repo_id: "r1".into(),
            repo_name: "App".into(),
            repo_path: repo.to_string_lossy().into(),
            branch: "main".into(),
            env_names: vec![],
        }
    }

    fn with_deps<T>(fake: &Fake, store: &Mutex<BuildStore>, f: impl FnOnce(&Deps) -> T) -> T {
        let secrets = secrets();
        let notify = |_: &VmBuild| {};
        let deps = Deps {
            boxd: fake,
            secrets: &secrets,
            store,
            notify: &notify,
            git_user: ("Me".into(), "me@x".into()),
        };
        f(&deps)
    }

    fn temp_store() -> (tempfile::TempDir, Mutex<BuildStore>) {
        let dir = tempfile::tempdir().unwrap();
        let store = BuildStore::open(dir.path().join("b.json"));
        (dir, Mutex::new(store))
    }

    #[test]
    fn a_build_runs_every_step_in_order_and_cleans_up() {
        let repo = git_repo();
        let fake = Fake::default();
        let (_d, store) = temp_store();
        let built = with_deps(&fake, &store, |deps| {
            let req = request(repo.path());
            let b = begin(deps, &req).unwrap();
            run(deps, &req, b)
        });
        assert_eq!(built.status, BuildStatus::Ready, "{}", built.log);
        assert_eq!(built.commit.as_deref(), Some("abc123"));
        let slug = remote::repo_slug("App", "r1");
        assert_eq!(built.snapshot, format!("ph-{slug}-b1"));

        let calls = fake.calls();
        let pos = |needle: &str| calls.iter().position(|c| c.contains(needle)).unwrap_or_else(|| panic!("no {needle} in {calls:#?}"));
        assert!(calls.iter().any(|c| c == &format!("new ph-b-{slug} vcpu=Some(4) suspend=Some(0)")));
        assert!(pos("cp /home/boxd/.ph/env") < pos("git clone"));
        assert!(pos("git clone") < pos("cp /home/boxd/.ph/ph-agentd.mjs"));
        assert!(pos("npm install -g") < pos("./tools.sh"));
        assert!(pos("./tools.sh") < pos("pnpm install --frozen-lockfile"));
        assert!(pos("pnpm install") < pos("rm -f \"$HOME/.ph/env\""));
        assert!(pos("rm -f \"$HOME/.ph/env\"") < pos("snapshot ph-b-"));
        assert!(calls.last().unwrap().starts_with(&format!("remove ph-b-{slug}")));
        assert_eq!(store.lock().unwrap().active_snapshot("r1"), Some(built.snapshot));
    }

    #[test]
    fn a_failed_step_marks_the_build_failed_and_still_removes_the_vm() {
        let repo = git_repo();
        let fake = Fake { fail_on: Some("./tools.sh"), ..Default::default() };
        let (_d, store) = temp_store();
        let built = with_deps(&fake, &store, |deps| {
            let req = request(repo.path());
            let b = begin(deps, &req).unwrap();
            run(deps, &req, b)
        });
        assert_eq!(built.status, BuildStatus::Failed);
        assert!(built.error.as_deref().unwrap().contains("boom"));
        assert!(fake.calls().last().unwrap().starts_with("remove ph-b-"));
        assert!(!fake.calls().iter().any(|c| c.starts_with("snapshot ")));
        assert_eq!(store.lock().unwrap().active_snapshot("r1"), None);
    }

    #[test]
    fn only_one_build_per_repo_at_a_time() {
        let repo = git_repo();
        let fake = Fake::default();
        let (_d, store) = temp_store();
        with_deps(&fake, &store, |deps| {
            let req = request(repo.path());
            begin(deps, &req).unwrap();
            assert!(begin(deps, &req).unwrap_err().contains("still running"));
        });
    }

    fn ready(n: u32) -> VmBuild {
        VmBuild {
            repo_id: "r1".into(),
            number: n,
            snapshot: format!("ph-x-b{n}"),
            branch: "main".into(),
            status: BuildStatus::Ready,
            step: "Ready".into(),
            commit: None,
            error: None,
            log: String::new(),
            started_ms: 0,
            finished_ms: Some(0),
        }
    }

    #[test]
    fn keeps_the_newest_ready_builds_and_the_active_one() {
        let (_d, store) = temp_store();
        let mut s = store.lock().unwrap();
        for n in 1..=5 {
            s.put(ready(n)).unwrap();
        }
        s.activate("r1", 1).unwrap();
        let removed = s.prune("r1");
        assert_eq!(removed, vec!["ph-x-b2".to_string()]);
        let left: Vec<u32> = s.for_repo("r1").builds.iter().map(|b| b.number).collect();
        assert_eq!(left, vec![5, 4, 3, 1]);
        assert_eq!(s.active_snapshot("r1").as_deref(), Some("ph-x-b1"));
    }

    #[test]
    fn a_new_successful_build_replaces_a_pinned_one() {
        let repo = git_repo();
        let fake = Fake::default();
        let (_d, store) = temp_store();
        store.lock().unwrap().put(ready(1)).unwrap();
        store.lock().unwrap().put(ready(2)).unwrap();
        store.lock().unwrap().activate("r1", 1).unwrap();
        let built = with_deps(&fake, &store, |deps| {
            let req = request(repo.path());
            let b = begin(deps, &req).unwrap();
            run(deps, &req, b)
        });
        assert_eq!(built.number, 3);
        assert_eq!(store.lock().unwrap().for_repo("r1").active, Some(3));
    }

    #[test]
    fn reopening_marks_interrupted_builds_failed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.json");
        let mut s = BuildStore::open(path.clone());
        s.put(VmBuild { status: BuildStatus::Running, ..ready(1) }).unwrap();
        let reopened = BuildStore::open(path);
        let b = &reopened.for_repo("r1").builds[0];
        assert_eq!(b.status, BuildStatus::Failed);
        assert!(b.error.as_deref().unwrap().contains("Interrupted"));
    }

    /// `PH_VM_E2E=1 cargo test vm_build_on_a_real_vm -- --ignored --nocapture`
    /// Builds an image of a public repo on boxd, restores a VM from it, checks
    /// what the image holds, then deletes the VM and the snapshot. About 1 min.
    #[test]
    #[ignore]
    fn vm_build_on_a_real_vm() {
        if std::env::var("PH_VM_E2E").is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let g = |args: &[&str]| crate::git::git(p, args).unwrap();
        g(&["init", "-q", "-b", "master"]);
        g(&["remote", "add", "origin", "https://github.com/octocat/Hello-World.git"]);
        std::fs::write(
            p.join(config::FILE),
            "[vm]\ninstall = \"echo tools > ~/installed.txt\"\nsetup = \"npm init -y >/dev/null && npm install --silent is-number\"\n",
        )
        .unwrap();
        g(&["add", "."]);
        g(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "cfg"]);

        let boxd = crate::cloud::transport::BoxdCli::default();
        let secrets = secrets();
        let (_d, store) = temp_store();
        let notify = |b: &VmBuild| eprintln!("[{}] {}", b.number, b.step);
        let deps = Deps {
            boxd: &boxd,
            secrets: &secrets,
            store: &store,
            notify: &notify,
            git_user: ("E2E".into(), "e2e@x".into()),
        };
        let mut req = request(p);
        req.repo_id = format!("e2e-{}", now_ms());
        req.repo_name = "e2e".into();
        req.branch = "master".into();
        let started = std::time::Instant::now();
        let b = begin(&deps, &req).unwrap();
        let built = run(&deps, &req, b);
        eprintln!("build took {:?}\n{}", started.elapsed(), built.log);
        assert_eq!(built.status, BuildStatus::Ready, "{:?}", built.error);

        let vm = format!("ph-e2e-restore-{}", now_ms() % 100000);
        let restored = boxd.machine_new_with(&vm, &NewOpts { from_snapshot: Some(built.snapshot.clone()), ..Default::default() });
        let checks = restored.map_err(|e| e.to_string()).and_then(|_| {
            remote::wait_running(&boxd, &vm)?;
            exec_ok(
                &boxd,
                &vm,
                "cd ~/repo && git log -1 --format=%H && test -f README && test -d node_modules/is-number && echo deps-ok; \
                 test -f ~/installed.txt && echo install-ok; test -f ~/.ph/ph-agentd.mjs && echo agentd-ok; \
                 test ! -e ~/.ph/env && echo no-secrets; ls \"$(npm prefix -g)/bin/claude-agent-acp\" >/dev/null && echo adapter-ok",
                Duration::from_secs(60),
            )
        });
        let _ = boxd.machine_remove(&vm);
        let _ = boxd.snapshot_remove(&built.snapshot);
        let out = checks.unwrap();
        eprintln!("{out}");
        for want in ["deps-ok", "install-ok", "agentd-ok", "no-secrets", "adapter-ok"] {
            assert!(out.contains(want), "missing {want} in {out}");
        }
        assert!(out.contains(built.commit.as_deref().unwrap()));
    }

    #[test]
    fn local_config_reads_the_committed_file() {
        let repo = git_repo();
        let c = local_config(&repo.path().to_string_lossy(), "main").unwrap();
        assert_eq!(c.vcpu, Some(4));
        assert_eq!(local_config(&repo.path().to_string_lossy(), "nope").unwrap(), VmConfig::default());
    }
}
