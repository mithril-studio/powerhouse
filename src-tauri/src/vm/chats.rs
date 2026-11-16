//! Cloud chat VMs: one per chat (and branch), restored from the project's
//! active image. The chat pane reaches the agent through [`agent_command`],
//! which runs `ph-agentd attach` over `boxd machine exec`.

use std::time::Duration;

use super::builds::BuildStore;
use super::config;
use super::remote::{self, exec_ok, AGENTD_PATH, REPO_DIR, WITH_ENV};
use crate::cloud::secrets::SecretStore;
use crate::cloud::transport::{Boxd, NewOpts};

pub const CHAT_PREFIX: &str = "ph-c-";
pub const MAX_CHAT_VMS: usize = 5;
/// boxd suspends a chat VM after this much idle network (memory kept; any
/// `exec` wakes it in about a second). A running turn is never idle:
/// ph-agentd pings while one runs, and an attached app holds a connection.
pub const AUTO_SUSPEND_SECS: u32 = 600;
const STEP_TIMEOUT: Duration = Duration::from_secs(120);
const SETUP_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// What the agent process on the VM runs: the boxd guide dropped, the uploaded
/// secrets as environment variables, then the ACP adapter.
///
/// boxd images link `~/.claude/CLAUDE.md` to boxd's own 45 KB guide to the VM
/// (its CLI, sharing, desktop, Hermes…), which Claude Code loads into every
/// session as user instructions: ~12k tokens a chat never needs. The script
/// drops that link, and only that link, so a CLAUDE.md written on the VM
/// survives. It runs on every agent start, so VMs from older images and a
/// link boxd puts back are covered too.
const AGENT_SCRIPT: &str = concat!(
    r#"[ "$(readlink "$HOME/.claude/CLAUDE.md")" = "$HOME/.config/boxd/AGENTS.md" ] && rm -f "$HOME/.claude/CLAUDE.md"; "#,
    r#"set -a; [ -f "$HOME/.ph/env" ] && . "$HOME/.ph/env"; set +a; exec claude-agent-acp"#
);

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub repo_id: String,
    pub repo_path: String,
    /// The new branch the chat works on.
    pub branch: String,
    /// What it starts from (the project's target branch).
    pub base: String,
    pub env_names: Vec<String>,
    /// Also write the project env vars to `~/repo/.env` (only if git ignores it).
    #[serde(default)]
    pub write_env_file: bool,
}

pub struct Deps<'a> {
    pub boxd: &'a dyn Boxd,
    pub secrets: &'a dyn SecretStore,
    pub builds: &'a std::sync::Mutex<BuildStore>,
    pub git_user: (String, String),
}

/// `ph-c-<branch>-<hash4(repo, branch)>`: readable, unique per repo and branch.
pub fn vm_name(repo_id: &str, branch: &str) -> String {
    let slug = remote::repo_slug(branch, &format!("{repo_id}\n{branch}"));
    format!("{CHAT_PREFIX}{slug}")
}

/// Restores the active image as the chat's VM and checks out its branch.
/// Returns the VM name. On failure the VM is removed again.
pub fn create(deps: &Deps, req: &CreateRequest) -> Result<String, String> {
    let snapshot = deps.builds.lock().unwrap().active_snapshot(&req.repo_id).ok_or(
        "This project has no VM image yet. Build one in Project settings → Cloud VM.",
    )?;
    let vm = vm_name(&req.repo_id, &req.branch);
    let others: Vec<String> = deps
        .boxd
        .machine_list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| m.name)
        .filter(|n| n.starts_with(CHAT_PREFIX) && *n != vm)
        .collect();
    if others.len() >= MAX_CHAT_VMS {
        return Err(format!(
            "You already have {MAX_CHAT_VMS} cloud chat VMs ({}). Delete a cloud branch to free one.",
            others.join(", ")
        ));
    }

    // Never replace an existing VM: it may hold work nobody has pushed.
    if deps.boxd.machine_get(&vm).is_ok() {
        return Err(format!(
            "A VM named {vm} already exists and may hold unpushed work. Delete it in Settings → Cloud → Machines, or delete this branch."
        ));
    }
    let opts = NewOpts { from_snapshot: Some(snapshot), auto_suspend_secs: Some(AUTO_SUSPEND_SECS), ..Default::default() };
    deps.boxd.machine_new_with(&vm, &opts).map_err(|e| e.to_string())?;
    match prepare(deps, req, &vm) {
        Ok(()) => Ok(vm),
        Err(e) => {
            let _ = deps.boxd.machine_remove(&vm);
            Err(e)
        }
    }
}

fn prepare(deps: &Deps, req: &CreateRequest, vm: &str) -> Result<(), String> {
    remote::wait_running(deps.boxd, vm)?;
    let origin = crate::git::git(std::path::Path::new(&req.repo_path), &["remote", "get-url", "origin"])
        .map_err(|_| "The repository has no `origin` remote.".to_string())?;
    let remote_url = crate::cloud::workspace::https_remote(&origin)
        .ok_or_else(|| format!("The VM needs a GitHub-style remote; `origin` is {origin}."))?;
    // The image may predate the current ph-agentd; chats always run this one.
    remote::upload(deps.boxd, vm, AGENTD_PATH, remote::AGENTD_SOURCE.as_bytes())?;
    remote::upload_env(
        deps.boxd,
        deps.secrets,
        vm,
        &req.repo_id,
        &remote_url,
        &req.env_names,
    )?;
    exec_ok(deps.boxd, vm, &checkout_script(&req.branch, &req.base, &deps.git_user), STEP_TIMEOUT)?;
    if req.write_env_file {
        write_dotenv(deps, req, vm)?;
    }

    let toml = exec_ok(deps.boxd, vm, &format!("cat {REPO_DIR}/{} 2>/dev/null || true", config::FILE), STEP_TIMEOUT)?;
    let cfg = config::parse(&toml)?;
    let files = exec_ok(deps.boxd, vm, &format!("ls -1A {REPO_DIR}"), STEP_TIMEOUT)?;
    let files: Vec<&str> = files.lines().map(str::trim).collect();
    if let Some(setup) = config::effective_setup(&cfg, &files) {
        exec_ok(deps.boxd, vm, &format!("{WITH_ENV}cd {REPO_DIR} && {setup}"), SETUP_TIMEOUT)
            .map_err(|e| format!("setup failed: {e}"))?;
    }
    Ok(())
}

/// Writes the project env vars (never the tokens) to `~/repo/.env`, staged
/// through an upload so values never appear in argv, and only when git
/// ignores `.env` in the clone.
fn write_dotenv(deps: &Deps, req: &CreateRequest, vm: &str) -> Result<(), String> {
    use crate::cloud::{secrets, workspace};
    let vars = secrets::project_env_values(deps.secrets, &req.repo_id, &req.env_names)?;
    remote::upload(deps.boxd, vm, "/home/boxd/.ph/dotenv", secrets::render_dotenv(&vars)?.as_bytes())?;
    exec_ok(deps.boxd, vm, workspace::WRITE_DOTENV_COMMAND, STEP_TIMEOUT).map(|_| ()).map_err(|e| {
        if e.contains(workspace::DOTENV_NOT_IGNORED) {
            "`.env` is not gitignored in this repo; not writing it (the agent could commit it).".to_string()
        } else {
            format!("writing .env failed: {e}")
        }
    })
}

/// Fetches and checks out a fresh branch from `origin/<base>`, without
/// tracking `base` (so a bare `git push` creates `origin/<branch>`).
pub fn checkout_script(branch: &str, base: &str, user: &(String, String)) -> String {
    let q = |s: &str| shell_words::quote(s).into_owned();
    format!(
        "set -e; cd {REPO_DIR}; git config user.name {name}; git config user.email {email}; \
         git config push.autoSetupRemote true; git fetch -q origin; \
         git checkout -q --no-track -B {branch} {start}; git log -1 --format=%h",
        name = q(&user.0),
        email = q(&user.1),
        branch = q(branch),
        start = q(&format!("origin/{base}")),
    )
}

/// The command the chat pane spawns to reach the chat's agent. `env` (the
/// model choice) reaches the agent through `boxd machine exec -e`.
pub fn agent_command(boxd_bin: &str, vm: &str, chat_id: &str, env: &[(String, String)]) -> Result<String, String> {
    if !vm.starts_with(CHAT_PREFIX) {
        return Err(format!("{vm} is not a Powerhouse chat VM"));
    }
    if !chat_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid chat id".into());
    }
    let mut argv: Vec<String> = vec![boxd_bin.into(), "machine".into(), "exec".into()];
    for (k, v) in env {
        if !crate::cloud::secrets::is_env_var_name(k) {
            return Err(format!("`{k}` is not a valid environment variable name"));
        }
        argv.extend(["-e".into(), format!("{k}={v}")]);
    }
    argv.extend(
        [vm, "--", "node", AGENTD_PATH, "attach", "--chat", chat_id, "--cwd", REPO_DIR, "--", "bash", "-c", AGENT_SCRIPT]
            .map(String::from),
    );
    Ok(shell_words::join(argv))
}

/// Makes sure the next `exec` reaches the VM. A suspended (standby) or paused
/// VM wakes on `exec` by itself; a stopped or hibernated one is started.
pub fn ensure_running(boxd: &dyn Boxd, vm: &str) -> Result<(), String> {
    let status = boxd.machine_get(vm).map_err(|e| e.to_string())?.status;
    if wakes_on_exec(&status) {
        return Ok(());
    }
    let _ = boxd.machine_start(vm);
    remote::wait_running(boxd, vm)
}

pub fn wakes_on_exec(status: &str) -> bool {
    matches!(status, "running" | "standby" | "suspended" | "paused")
}

/// After a merge: destroys the VM only when its clone is clean and still at
/// `merged_head`, so work done after the merge push is never lost. Returns
/// whether it was destroyed.
pub fn retire(boxd: &dyn Boxd, vm: &str, merged_head: &str) -> Result<bool, String> {
    let out = exec_ok(
        boxd,
        vm,
        &format!("cd {REPO_DIR} && git rev-parse HEAD && git status --porcelain | wc -l"),
        STEP_TIMEOUT,
    )?;
    let mut lines = out.lines().map(str::trim).filter(|l| !l.is_empty());
    let (head, dirty) = (lines.next().unwrap_or(""), lines.next().unwrap_or("1"));
    if head != merged_head.trim() || dirty != "0" {
        return Ok(false);
    }
    remove(boxd, vm)?;
    Ok(true)
}

/// Destroys a chat VM. Only `ph-c-…` names.
pub fn remove(boxd: &dyn Boxd, vm: &str) -> Result<(), String> {
    if !vm.starts_with(CHAT_PREFIX) {
        return Err(format!("{vm} is not a Powerhouse chat VM"));
    }
    match boxd.machine_remove(vm) {
        Ok(()) | Err(crate::cloud::transport::TransportError::NotFound(_)) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::secrets::MemoryStore;
    use crate::cloud::transport::{ExecOutput, MachineInfo, TResult};
    use crate::vm::builds::{BuildStatus, VmBuild};
    use std::path::Path;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        machines: Vec<String>,
        created: Mutex<Vec<String>>,
        calls: Mutex<Vec<String>>,
        fail_on: Option<&'static str>,
        /// What `git rev-parse HEAD; git status | wc -l` prints on the VM.
        clone_state: Option<&'static str>,
    }

    impl Boxd for Fake {
        fn machine_list(&self) -> TResult<Vec<MachineInfo>> {
            Ok(self.machines.iter().map(|n| MachineInfo { name: n.clone(), status: "running".into(), ..Default::default() }).collect())
        }
        fn machine_get(&self, vm: &str) -> TResult<MachineInfo> {
            let known = self.machines.iter().any(|m| m == vm) || self.created.lock().unwrap().iter().any(|m| m == vm);
            if !known {
                return Err(crate::cloud::transport::TransportError::NotFound(vm.into()));
            }
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
            self.created.lock().unwrap().push(vm.into());
            self.calls.lock().unwrap().push(format!("new {vm} from={:?} suspend={:?}", opts.from_snapshot, opts.auto_suspend_secs));
            Ok(MachineInfo { name: vm.into(), status: "running".into(), ..Default::default() })
        }
        fn machine_remove(&self, vm: &str) -> TResult<()> {
            self.calls.lock().unwrap().push(format!("remove {vm}"));
            Ok(())
        }
        fn cp_to(&self, _: &Path, _: &str, remote: &str) -> TResult<()> {
            self.calls.lock().unwrap().push(format!("cp {remote}"));
            Ok(())
        }
        fn exec(&self, _: &str, argv: &[String], _: Duration) -> TResult<ExecOutput> {
            let script = argv.last().cloned().unwrap_or_default();
            self.calls.lock().unwrap().push(format!("exec {script}"));
            if self.fail_on.is_some_and(|f| script.contains(f)) {
                return Ok(ExecOutput { output: "nope".into(), exit_code: 1 });
            }
            let output = if script.starts_with("ls -1A") {
                "pnpm-lock.yaml\n"
            } else if script.contains("git status --porcelain | wc -l") {
                self.clone_state.unwrap_or("")
            } else {
                ""
            };
            Ok(ExecOutput { output: output.into(), exit_code: 0 })
        }
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        crate::git::git(dir.path(), &["init", "-q"]).unwrap();
        crate::git::git(dir.path(), &["remote", "add", "origin", "git@github.com:me/app.git"]).unwrap();
        dir
    }

    fn store_with_image(dir: &Path) -> Mutex<BuildStore> {
        let mut s = BuildStore::open(dir.join("b.json"));
        s.put(VmBuild {
            repo_id: "r1".into(),
            number: 1,
            snapshot: "ph-app-b1".into(),
            branch: "main".into(),
            status: BuildStatus::Ready,
            step: "Ready".into(),
            commit: None,
            error: None,
            log: String::new(),
            started_ms: 0,
            finished_ms: Some(1),
        })
        .unwrap();
        Mutex::new(s)
    }

    fn create_with(fake: &Fake, builds: &Mutex<BuildStore>, repo: &Path) -> Result<String, String> {
        let secrets = MemoryStore::default();
        secrets.set(crate::cloud::secrets::CLAUDE_OAUTH, "c").unwrap();
        secrets.set("github_token", "g").unwrap();
        let deps = Deps { boxd: fake, secrets: &secrets, builds, git_user: ("Me".into(), "me@x".into()) };
        create(
            &deps,
            &CreateRequest {
                repo_id: "r1".into(),
                repo_path: repo.to_string_lossy().into(),
                branch: "swift-comet".into(),
                base: "test".into(),
                env_names: vec![],
                write_env_file: false,
            },
        )
    }

    #[test]
    fn creates_from_the_active_image_and_checks_out_the_branch() {
        let (repo, dir) = (repo(), tempfile::tempdir().unwrap());
        let builds = store_with_image(dir.path());
        let fake = Fake::default();
        let vm = create_with(&fake, &builds, repo.path()).unwrap();
        assert_eq!(vm, vm_name("r1", "swift-comet"));
        assert!(vm.starts_with("ph-c-swift-comet-"));
        let calls = fake.calls.lock().unwrap().clone();
        assert!(calls.contains(&format!("new {vm} from=Some(\"ph-app-b1\") suspend=Some({AUTO_SUSPEND_SECS})")), "{calls:#?}");
        assert!(calls.iter().any(|c| c == "cp /home/boxd/.ph/ph-agentd.mjs"), "{calls:#?}");
        let pos = |n: &str| calls.iter().position(|c| c.contains(n)).unwrap_or_else(|| panic!("no {n} in {calls:#?}"));
        assert!(pos("cp /home/boxd/.ph/env") < pos("checkout -q --no-track -B swift-comet origin/test"));
        assert!(pos("checkout -q") < pos("pnpm install"));
    }

    #[test]
    fn refuses_without_an_image_or_over_the_cap() {
        let (repo, dir) = (repo(), tempfile::tempdir().unwrap());
        let empty = Mutex::new(BuildStore::open(dir.path().join("none.json")));
        assert!(create_with(&Fake::default(), &empty, repo.path()).unwrap_err().contains("no VM image"));

        let builds = store_with_image(dir.path());
        let full = Fake { machines: (1..=5).map(|i| format!("ph-c-x{i}")).collect(), ..Default::default() };
        let err = create_with(&full, &builds, repo.path()).unwrap_err();
        assert!(err.contains("already have 5"), "{err}");
        assert!(full.calls.lock().unwrap().iter().all(|c| !c.starts_with("new ")));

        // Other machines don't count.
        let mixed = Fake { machines: vec!["ph-b-x".into(), "mine".into(), "ph-c-a".into()], ..Default::default() };
        assert!(create_with(&mixed, &builds, repo.path()).is_ok());
    }

    #[test]
    fn a_failed_setup_removes_the_vm() {
        let (repo, dir) = (repo(), tempfile::tempdir().unwrap());
        let builds = store_with_image(dir.path());
        let fake = Fake { fail_on: Some("pnpm install"), ..Default::default() };
        let err = create_with(&fake, &builds, repo.path()).unwrap_err();
        assert!(err.contains("setup failed"), "{err}");
        let calls = fake.calls.lock().unwrap().clone();
        assert!(calls.last().unwrap().starts_with("remove ph-c-"), "{calls:#?}");
        assert_eq!(calls.iter().filter(|c| c.starts_with("remove ")).count(), 1, "only the VM it created");
    }

    /// `PH_VM_E2E=1 cargo test vm_chat_on_a_real_vm -- --ignored --nocapture`
    /// Builds an image of a public repo, creates a chat VM from it, spawns the
    /// exact command the chat pane spawns (through zsh, like `acp_spawn`), and
    /// has real Claude answer over ACP. Then deletes the VM and the snapshot.
    /// Uses the Claude token boxd injects (`boxd env`), not the Keychain.
    #[test]
    #[ignore]
    fn vm_chat_on_a_real_vm() {
        use std::io::{BufRead, BufReader, Write};
        if std::env::var("PH_VM_E2E").is_err() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        crate::git::git(p, &["init", "-q", "-b", "master"]).unwrap();
        crate::git::git(p, &["remote", "add", "origin", "https://github.com/octocat/Hello-World.git"]).unwrap();
        std::fs::write(p.join("powerhouse.toml"), "[vm]\n").unwrap();
        crate::git::git(p, &["add", "."]).unwrap();
        crate::git::git(p, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "cfg"]).unwrap();

        let boxd = crate::cloud::transport::BoxdCli::default();
        let secrets = MemoryStore::default();
        secrets.set(crate::cloud::secrets::CLAUDE_OAUTH, "unused").unwrap();
        secrets.set("github_token", "unused").unwrap();
        let store_dir = tempfile::tempdir().unwrap();
        let builds = Mutex::new(BuildStore::open(store_dir.path().join("b.json")));
        let repo_id = format!("e2e-{}", crate::vm::builds::now_ms());
        let notify = |_: &crate::vm::builds::VmBuild| {};
        let bdeps = crate::vm::builds::Deps {
            boxd: &boxd,
            secrets: &secrets,
            store: &builds,
            notify: &notify,
            git_user: ("E2E".into(), "e2e@x".into()),
        };
        let req = crate::vm::builds::BuildRequest {
            repo_id: repo_id.clone(),
            repo_name: "e2e".into(),
            repo_path: p.to_string_lossy().into(),
            branch: "master".into(),
            env_names: vec![],
        };
        let b = crate::vm::builds::begin(&bdeps, &req).unwrap();
        let built = crate::vm::builds::run(&bdeps, &req, b);
        assert_eq!(built.status, BuildStatus::Ready, "{}", built.log);

        let deps = Deps { boxd: &boxd, secrets: &secrets, builds: &builds, git_user: ("E2E".into(), "e2e@x".into()) };
        let started = std::time::Instant::now();
        let created = create(
            &deps,
            &CreateRequest {
                repo_id,
                repo_path: p.to_string_lossy().into(),
                branch: "e2e-chat".into(),
                base: "master".into(),
                env_names: vec![],
                write_env_file: false,
            },
        );
        let outcome = created.and_then(|vm| {
            eprintln!("chat VM {vm} ready in {:?}", started.elapsed());
            // Use the token boxd injects instead of the placeholder uploaded above.
            exec_ok(&boxd, &vm, "sed -i '/CLAUDE_CODE_OAUTH_TOKEN/d' ~/.ph/env; git -C ~/repo branch --show-current", STEP_TIMEOUT)
                .map(|branch| (vm, branch))
        });
        let (vm, branch) = match outcome {
            Ok(v) => v,
            Err(e) => {
                let _ = boxd.snapshot_remove(&built.snapshot);
                panic!("{e}");
            }
        };

        let cmd = agent_command(&boxd.binary, &vm, "e2e-chat-1", &[("PH_E2E".into(), "a b'c".into())]).unwrap();
        let parts = shell_words::split(&cmd).unwrap();
        let mut child = std::process::Command::new("/bin/zsh")
            .args(["-lc", "exec \"$@\"", "powerhouse-acp"])
            .args(&parts)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut send = |v: serde_json::Value| writeln!(stdin, "{v}").unwrap();
        let mut wait_for = |id: u64, text: &mut String| -> serde_json::Value {
            for line in lines.by_ref() {
                let msg: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
                if let Some(t) = msg.pointer("/params/update/content/text").and_then(|t| t.as_str()) {
                    text.push_str(t);
                }
                if msg.get("id").and_then(|i| i.as_u64()) == Some(id) && msg.get("method").is_none() {
                    return msg;
                }
            }
            panic!("connection closed before response {id}");
        };
        let mut text = String::new();
        send(serde_json::json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}));
        let init = wait_for(0, &mut text);
        send(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd": REPO_DIR, "mcpServers": []}}));
        let session = wait_for(1, &mut text);
        let sid = session.pointer("/result/sessionId").and_then(|s| s.as_str()).unwrap_or_default().to_string();
        send(serde_json::json!({"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId": sid, "prompt": [{"type":"text","text":"Run `echo \"$PH_E2E\"` with Bash, then reply with exactly: PONG"}]}}));
        let done = wait_for(2, &mut text);
        let _ = child.kill();

        let _ = remove(&boxd, &vm);
        let _ = boxd.snapshot_remove(&built.snapshot);
        eprintln!("agent said: {text}");
        assert!(init.pointer("/result/agentCapabilities").is_some(), "{init}");
        assert_eq!(branch.trim(), "e2e-chat");
        assert_eq!(done.pointer("/result/stopReason").and_then(|s| s.as_str()), Some("end_turn"), "{done}");
        assert!(text.contains("PONG"), "{text}");
    }

    #[test]
    fn never_replaces_an_existing_vm() {
        let (repo, dir) = (repo(), tempfile::tempdir().unwrap());
        let builds = store_with_image(dir.path());
        let taken = Fake { machines: vec![vm_name("r1", "swift-comet")], ..Default::default() };
        let err = create_with(&taken, &builds, repo.path()).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert!(taken.calls.lock().unwrap().iter().all(|c| !c.starts_with("remove ") && !c.starts_with("new ")));
    }

    #[test]
    fn retire_keeps_a_vm_with_work_after_the_merge() {
        let head = "a".repeat(40);
        let clean = Fake { clone_state: Some(Box::leak(format!("{head}\n0\n").into_boxed_str())), ..Default::default() };
        assert!(retire(&clean, "ph-c-x", &head).unwrap());
        assert!(clean.calls.lock().unwrap().iter().any(|c| c == "remove ph-c-x"));

        for state in [format!("{head}\n3\n"), format!("{}\n0\n", "b".repeat(40))] {
            let busy = Fake { clone_state: Some(Box::leak(state.into_boxed_str())), ..Default::default() };
            assert!(!retire(&busy, "ph-c-x", &head).unwrap());
            assert!(busy.calls.lock().unwrap().iter().all(|c| !c.starts_with("remove ")));
        }
    }

    #[test]
    fn standby_and_paused_vms_wake_on_exec_but_stopped_ones_are_started() {
        assert!(wakes_on_exec("standby") && wakes_on_exec("running") && wakes_on_exec("paused"));
        assert!(!wakes_on_exec("stopped") && !wakes_on_exec("hibernated"));
    }

    #[test]
    fn the_agent_command_quotes_everything_and_refuses_foreign_vms() {
        let cmd = agent_command(
            "/Users/me/.local/bin/boxd",
            "ph-c-x-1a2b",
            "3f2c-uuid",
            &[("ANTHROPIC_MODEL".into(), "claude opus".into())],
        )
        .unwrap();
        let argv = shell_words::split(&cmd).unwrap();
        assert_eq!(&argv[..5], ["/Users/me/.local/bin/boxd", "machine", "exec", "-e", "ANTHROPIC_MODEL=claude opus"]);
        assert_eq!(argv[5], "ph-c-x-1a2b");
        assert!(argv.contains(&"attach".to_string()) && argv.contains(&"3f2c-uuid".to_string()));
        assert_eq!(argv.last().unwrap(), AGENT_SCRIPT);
        assert!(agent_command("boxd", "my-vm", "c", &[]).is_err());
        assert!(agent_command("boxd", "ph-c-x", "bad id;rm", &[]).is_err());
        assert!(remove(&Fake::default(), "specter-ai").is_err());
    }

    /// Runs the real agent script in a fake home, with a stub adapter on PATH.
    fn run_agent_script(home: &Path) {
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let stub = bin.join("claude-agent-acp");
        std::fs::write(&stub, "#!/bin/sh\necho adapter-ran\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let out = std::process::Command::new("bash")
            .args(["-c", AGENT_SCRIPT])
            .env("HOME", home)
            .env("PATH", path)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "adapter-ran");
    }

    #[test]
    #[cfg(unix)]
    fn the_agent_script_drops_the_boxd_guide_but_keeps_a_users_claude_md() {
        let home = tempfile::tempdir().unwrap();
        let (claude, boxd) = (home.path().join(".claude"), home.path().join(".config/boxd"));
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::create_dir_all(&boxd).unwrap();
        std::fs::write(boxd.join("AGENTS.md"), "# boxd VM\n").unwrap();
        let md = claude.join("CLAUDE.md");

        std::os::unix::fs::symlink(boxd.join("AGENTS.md"), &md).unwrap();
        run_agent_script(home.path());
        assert!(md.symlink_metadata().is_err(), "the boxd link is gone");
        assert!(boxd.join("AGENTS.md").exists(), "boxd's own file is untouched");

        std::fs::write(&md, "mine\n").unwrap();
        run_agent_script(home.path());
        assert_eq!(std::fs::read_to_string(&md).unwrap(), "mine\n");

        // No CLAUDE.md at all still starts the adapter.
        std::fs::remove_file(&md).unwrap();
        run_agent_script(home.path());
    }
}
