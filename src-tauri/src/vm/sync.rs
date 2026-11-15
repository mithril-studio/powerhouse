//! The local worktree of a cloud branch mirrors its VM, so Files, Changes,
//! Diff and the merge queue keep working on local git.
//!
//! - Mirror (after each turn): the VM commits its working tree (untracked
//!   files included, ignored ones not) to a throwaway commit on top of HEAD,
//!   without touching the branch or its index, and pushes it to
//!   `refs/ph/wip/<branch>`. The local worktree then takes the VM's HEAD as its
//!   branch tip and that snapshot as its working tree, so committed work shows
//!   as commits and uncommitted work as changes.
//! - Commit and push (before a merge): everything on the VM is committed and
//!   the branch pushed; the local branch is reset to it.
//!
//! The local worktree of a cloud branch is a read-only mirror: syncing
//! discards local edits there.

use std::path::Path;
use std::time::Duration;

use super::remote::{exec_ok, REPO_DIR};
use crate::cloud::transport::Boxd;

const SYNC_TIMEOUT: Duration = Duration::from_secs(300);

pub fn wip_ref(branch: &str) -> String {
    format!("refs/ph/wip/{branch}")
}

fn q(s: &str) -> String {
    shell_words::quote(s).into_owned()
}

/// Snapshots the VM's working tree and pushes it. Prints `<snapshot> <head>`.
pub fn snapshot_script(branch: &str) -> String {
    format!(
        r#"set -e; cd {REPO_DIR}
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
cp .git/index "$tmp" 2>/dev/null || true
GIT_INDEX_FILE="$tmp" git add -A
tree="$(GIT_INDEX_FILE="$tmp" git write-tree)"
head="$(git rev-parse HEAD)"
snap="$(git commit-tree "$tree" -p "$head" -m 'Powerhouse mirror snapshot')"
git push -q -f origin "$snap:{wip}"
echo "$snap $head""#,
        wip = q(&wip_ref(branch)),
    )
}

/// Commits everything on the VM (when anything changed) and pushes the
/// branch. Prints the pushed HEAD.
pub fn commit_push_script(branch: &str, message: &str) -> String {
    format!(
        r#"set -e; cd {REPO_DIR}
git add -A
git diff --cached --quiet || git commit -q -m {message}
git push -q origin {refspec}
git rev-parse HEAD"#,
        message = q(message),
        refspec = q(&format!("HEAD:refs/heads/{branch}")),
    )
}

/// `git <args>` against origin with the GitHub token for HTTPS remotes, as
/// the merge queue does; never prompts.
fn git_origin(worktree: &Path, args: &[&str]) -> Result<(), String> {
    let https = crate::git::git(worktree, &["remote", "get-url", "origin"])
        .map(|u| u.starts_with("https://"))
        .unwrap_or(false);
    crate::queue::git_origin(worktree, https, args)
}

fn last_line(out: &str) -> &str {
    out.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

fn is_sha(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Makes `worktree` show `snapshot` on top of `head`: the branch at `head`,
/// the working tree at `snapshot`, nothing staged. Both must be fetched.
pub fn apply_locally(worktree: &Path, head: &str, snapshot: &str) -> Result<(), String> {
    let git = |args: &[&str]| crate::git::git(worktree, args);
    git(&["reset", "-q", "--hard", head])?;
    git(&["clean", "-fdq"])?;
    git(&["read-tree", "-u", "--reset", snapshot])?;
    git(&["reset", "-q"])?;
    Ok(())
}

/// Mirrors the VM into the local worktree. Returns the snapshot commit.
pub fn mirror(boxd: &dyn Boxd, vm: &str, worktree: &Path, branch: &str) -> Result<String, String> {
    let out = exec_ok(boxd, vm, &snapshot_script(branch), SYNC_TIMEOUT)?;
    let mut parts = last_line(&out).split_whitespace();
    let (snapshot, head) = match (parts.next(), parts.next()) {
        (Some(s), Some(h)) if is_sha(s) && is_sha(h) => (s.to_string(), h.to_string()),
        _ => return Err(format!("unexpected snapshot output: {}", last_line(&out))),
    };
    let wip = wip_ref(branch);
    git_origin(worktree, &["fetch", "-q", "origin", &format!("+{wip}:{wip}")])?;
    apply_locally(worktree, &head, &snapshot)?;
    Ok(snapshot)
}

/// Commits and pushes everything on the VM, then points the local branch at
/// it. Returns the pushed commit.
pub fn commit_and_push(boxd: &dyn Boxd, vm: &str, worktree: &Path, branch: &str, message: &str) -> Result<String, String> {
    let out = exec_ok(boxd, vm, &commit_push_script(branch, message), SYNC_TIMEOUT)?;
    let head = last_line(&out).to_string();
    if !is_sha(&head) {
        return Err(format!("unexpected push output: {head}"));
    }
    let git = |args: &[&str]| crate::git::git(worktree, args);
    git_origin(worktree, &["fetch", "-q", "origin", &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}")])?;
    git(&["reset", "-q", "--hard", &head])?;
    git(&["clean", "-fdq"])?;
    Ok(head)
}

/// Deletes the branch's mirror ref on the remote (best effort, at cleanup).
pub fn drop_wip_ref(repo: &Path, branch: &str) {
    let wip = wip_ref(branch);
    let _ = git_origin(repo, &["push", "-q", "origin", &format!(":{wip}")]);
    let _ = crate::git::git(repo, &["update-ref", "-d", &wip]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, script: &str) -> String {
        let out = Command::new("bash").arg("-c").arg(script).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "{script}\n{}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    /// origin (bare) ← vm clone; local worktree clone. Runs the VM scripts with
    /// REPO_DIR swapped for the vm clone's path.
    struct World {
        _root: tempfile::TempDir,
        vm: std::path::PathBuf,
        local: std::path::PathBuf,
    }

    fn world() -> World {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        sh(r, "git init -q --bare origin.git && git clone -q origin.git vm 2>/dev/null && cd vm && git config user.name V && git config user.email v@v && printf 'node_modules\\n' > .gitignore && echo one > a.txt && echo keep > b.txt && git add -A && git commit -qm init && git push -q origin HEAD:refs/heads/main && git checkout -q -b feat");
        sh(r, "git clone -q origin.git local && cd local && git config user.name L && git config user.email l@l && git checkout -q -b feat origin/main");
        World { vm: r.join("vm"), local: r.join("local"), _root: root }
    }

    fn run_vm(w: &World, script: &str) -> String {
        sh(&w.vm, &script.replace(REPO_DIR, &w.vm.to_string_lossy()))
    }

    #[test]
    fn the_mirror_shows_commits_as_commits_and_edits_as_changes() {
        let w = world();
        // On the VM: one commit, then uncommitted edits, a deletion, a new file and an ignored dir.
        sh(&w.vm, "echo two > a.txt && git commit -qam 'agent commit' && echo three >> a.txt && rm b.txt && echo new > c.txt && mkdir -p node_modules && echo x > node_modules/x");
        let out = run_vm(&w, &snapshot_script("feat"));
        let mut it = last_line(&out).split_whitespace();
        let (snap, head) = (it.next().unwrap().to_string(), it.next().unwrap().to_string());

        // The VM's branch, index and files are untouched by the snapshot.
        assert_eq!(sh(&w.vm, "git rev-parse HEAD").trim(), head);
        assert!(sh(&w.vm, "git status --porcelain").contains("?? c.txt"));

        let wip = wip_ref("feat");
        crate::git::git(&w.local, &["fetch", "-q", "origin", &format!("+{wip}:{wip}")]).unwrap();
        std::fs::write(w.local.join("stale.txt"), "local junk").unwrap();
        apply_locally(&w.local, &head, &snap).unwrap();

        assert_eq!(sh(&w.local, "git rev-parse HEAD").trim(), head);
        assert_eq!(sh(&w.local, "git log -1 --format=%s").trim(), "agent commit");
        let status = sh(&w.local, "git status --porcelain");
        assert!(status.contains(" M a.txt"), "{status}");
        assert!(status.contains(" D b.txt"), "{status}");
        assert!(status.contains("?? c.txt"), "{status}");
        assert!(!status.contains("stale.txt") && !status.contains("node_modules"), "{status}");
        assert_eq!(std::fs::read_to_string(w.local.join("a.txt")).unwrap(), "two\nthree\n");
        assert_eq!(sh(&w.local, "git diff --cached --name-only").trim(), "", "nothing staged");
    }

    #[test]
    fn commit_and_push_lands_everything_on_the_branch() {
        let w = world();
        sh(&w.vm, "echo two > a.txt && echo new > c.txt");
        let out = run_vm(&w, &commit_push_script("feat", "Chat 1: it's done"));
        let head = last_line(&out).to_string();
        assert!(is_sha(&head));
        assert_eq!(sh(&w.vm, "git log -1 --format=%s").trim(), "Chat 1: it's done");
        assert_eq!(sh(&w.vm, "git status --porcelain").trim(), "");
        assert_eq!(sh(&w.vm, "git ls-remote origin refs/heads/feat").split_whitespace().next(), Some(head.as_str()));

        // Nothing to commit: no empty commit, still pushes.
        let again = run_vm(&w, &commit_push_script("feat", "x"));
        assert_eq!(last_line(&again), head);
    }

    /// `PH_VM_E2E=1 cargo test vm_sync_scripts_on_a_real_vm -- --ignored --nocapture`
    /// Runs both scripts through `boxd machine exec` on a fresh VM, against a
    /// bare repo on the VM as origin (nothing is pushed anywhere else).
    #[test]
    #[ignore]
    fn vm_sync_scripts_on_a_real_vm() {
        if std::env::var("PH_VM_E2E").is_err() {
            return;
        }
        use crate::cloud::transport::{BoxdCli, NewOpts};
        let boxd = BoxdCli::default();
        let vm = format!("ph-e2e-sync-{}", crate::vm::builds::now_ms() % 100000);
        boxd.machine_new_with(&vm, &NewOpts::default()).unwrap();
        let t = Duration::from_secs(120);
        let result = (|| -> Result<(), String> {
            crate::vm::remote::wait_running(&boxd, &vm)?;
            exec_ok(&boxd, &vm, "set -e; git init -q --bare ~/origin.git; git clone -q ~/origin.git ~/repo 2>/dev/null; cd ~/repo; \
                git config user.name V; git config user.email v@v; echo a > a.txt; git add -A; git commit -qm init; \
                git push -q origin HEAD:refs/heads/main; git checkout -q -b feat; echo b >> a.txt; echo n > new.txt", t)?;
            let out = exec_ok(&boxd, &vm, &snapshot_script("feat"), t)?;
            let mut it = last_line(&out).split_whitespace();
            let snap = it.next().unwrap_or_default().to_string();
            assert!(is_sha(&snap) && is_sha(it.next().unwrap_or_default()), "{out}");
            let remote = exec_ok(&boxd, &vm, "git -C ~/origin.git rev-parse refs/ph/wip/feat; git -C ~/repo status --porcelain", t)?;
            assert!(remote.starts_with(&snap), "{remote}");
            assert!(remote.contains("?? new.txt"), "the VM's own state is untouched: {remote}");
            let pushed = exec_ok(&boxd, &vm, &commit_push_script("feat", "Chat 1: it's \"done\""), t)?;
            let head = last_line(&pushed).to_string();
            let check = exec_ok(&boxd, &vm, "git -C ~/origin.git rev-parse refs/heads/feat; git -C ~/origin.git log -1 --format=%s feat", t)?;
            assert!(check.starts_with(&head), "{check}");
            assert!(check.contains("Chat 1: it's \"done\""), "{check}");
            Ok(())
        })();
        let _ = boxd.machine_remove(&vm);
        result.unwrap();
    }

    #[test]
    fn scripts_quote_what_they_interpolate() {
        assert!(commit_push_script("feat", "it's `rm -rf`").contains(r#"'it'\''s `rm -rf`'"#));
        assert!(snapshot_script("a b").contains("'refs/ph/wip/a b'"));
    }
}
