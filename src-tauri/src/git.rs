use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) const GIT: &str = "/usr/bin/git";

pub(crate) fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(GIT)
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Like `git()` but returns stdout verbatim (no trim) — diff/patch text must
/// keep its leading/trailing whitespace and trailing newline intact.
pub(crate) fn git_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(GIT)
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

pub(crate) fn slugify(s: &str) -> String {
    let slug: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let mut out = String::with_capacity(slug.len());
    for c in slug.chars() {
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    out.trim_matches('-').to_string()
}

#[derive(serde::Serialize)]
pub struct RepoInfo {
    pub root: String,
    pub name: String,
    pub default_branch: String,
}

#[tauri::command]
pub fn git_validate_repo(path: String) -> Result<RepoInfo, String> {
    let dir = PathBuf::from(&path);
    let root = git(&dir, &["rev-parse", "--show-toplevel"])
        .map_err(|_| format!("{path} is not a git repository"))?;
    let root_path = PathBuf::from(&root);

    git(&root_path, &["rev-parse", "HEAD"])
        .map_err(|_| "Repository has no commits yet — make an initial commit first".to_string())?;

    let default_branch = detect_target_branch(&root_path);

    let name = root_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.clone());

    Ok(RepoInfo {
        root,
        name,
        default_branch,
    })
}

/// Default parent directory for cloned/created projects: `~/conductor/repos`.
fn default_projects_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("conductor")
        .join("repos")
}

/// Repository name from a clone URL: the last path segment without `.git`.
fn repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let tail = trimmed.rsplit(['/', ':']).next()?.trim();
    let name = tail.strip_suffix(".git").unwrap_or(tail).trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Whether a clone URL is an HTTPS github.com remote — the only case where it's
/// safe to attach the stored GitHub token (attaching it to another host would
/// leak the credential). SSH remotes (`git@github.com:...`) authenticate via
/// keys, so they're excluded.
fn is_github_https(url: &str) -> bool {
    let u = url.trim();
    (u.starts_with("https://github.com/") || u.starts_with("https://www.github.com/"))
}

/// The staging trunk. When a project has `origin/test`, that branch is what
/// new worktrees are cut from and what the merge queue lands on — the test
/// server deploys from it. See AGENTS.md, "Branch & release flow".
pub(crate) const STAGING_BRANCH: &str = "test";

/// Resolve a project's target branch: `origin/test` when it exists, else the
/// remote's default (origin/HEAD), else the local HEAD. Stored on the repo at
/// add time and editable in the merge workflow modal.
pub(crate) fn detect_target_branch(root: &Path) -> String {
    let staging_ref = format!("refs/remotes/origin/{STAGING_BRANCH}");
    if git(root, &["rev-parse", "--verify", "--quiet", &staging_ref]).is_ok() {
        return STAGING_BRANCH.to_string();
    }
    git(root, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .map(|s| s.strip_prefix("origin/").unwrap_or(&s).to_string())
        .or_else(|| git(root, &["symbolic-ref", "--short", "HEAD"]).ok())
        .unwrap_or_else(|| "HEAD".to_string())
}

#[cfg(test)]
mod tests {
    use super::{detect_target_branch, git, git_target_commits, is_github_https, parse_log, repo_name_from_url};
    use std::path::Path;

    fn commit(work: &Path, file: &str, msg: &str) {
        std::fs::write(work.join(file), msg).unwrap();
        git(work, &["add", "."]).unwrap();
        git(work, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg]).unwrap();
    }

    #[test]
    fn parse_log_splits_records_and_flags_merges() {
        let out = "aaa\x1fa1\x1ffeat: one \x1f thing\x1fJoost\x1f1700000000\x1fp1\x1e\n\
                   bbb\x1fb1\x1fMerge branch 'x'\x1fBot\x1f1700000100\x1fp1 p2\x1e\n";
        let got = parse_log(out);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].short, "a1");
        assert_eq!(got[0].subject, "feat: one ");
        assert!(!got[0].merge);
        assert_eq!(got[1].author, "Bot");
        assert_eq!(got[1].time, 1700000100);
        assert!(got[1].merge);
        assert!(parse_log("").is_empty());
    }

    #[test]
    fn target_commits_lists_what_test_has_beyond_main() {
        let dir = tempfile::tempdir().unwrap();
        let work = repo_with_origin(dir.path());
        git(&work, &["checkout", "-qb", "test"]).unwrap();
        commit(&work, "a", "feat: on test 1");
        commit(&work, "b", "feat: on test 2");
        git(&work, &["push", "-q", "origin", "test"]).unwrap();

        let got = git_target_commits(work.to_string_lossy().to_string(), "test".into(), "main".into()).unwrap();
        assert_eq!(got.base.as_deref(), Some("main"));
        assert!(got.fetched);
        let subjects: Vec<_> = got.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["feat: on test 2", "feat: on test 1"], "newest first, base excluded");
        assert_eq!(got.commits[0].author, "t");
        assert!(got.commits[0].time > 0);
    }

    #[test]
    fn target_commits_falls_back_to_latest_when_base_is_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let work = repo_with_origin(dir.path());
        let got = git_target_commits(work.to_string_lossy().to_string(), "main".into(), "main".into()).unwrap();
        assert_eq!(got.base, None);
        assert_eq!(got.commits.len(), 1);
        assert_eq!(got.commits[0].subject, "init");
    }

    #[test]
    fn target_commits_reports_a_missing_remote_branch() {
        let dir = tempfile::tempdir().unwrap();
        let work = repo_with_origin(dir.path());
        let err = git_target_commits(work.to_string_lossy().to_string(), "test".into(), "main".into()).unwrap_err();
        assert!(err.contains("no branch “test”"), "{err}");
    }

    /// A repo with one commit on `main`, pushed to a bare `origin`.
    fn repo_with_origin(dir: &Path) -> std::path::PathBuf {
        let origin = dir.join("origin.git");
        let work = dir.join("work");
        git(dir, &["init", "--bare", "-b", "main", origin.to_str().unwrap()]).unwrap();
        git(dir, &["init", "-b", "main", work.to_str().unwrap()]).unwrap();
        std::fs::write(work.join("README"), "hi").unwrap();
        git(&work, &["add", "."]).unwrap();
        git(&work, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]).unwrap();
        git(&work, &["remote", "add", "origin", origin.to_str().unwrap()]).unwrap();
        git(&work, &["push", "-q", "-u", "origin", "main"]).unwrap();
        work
    }

    #[test]
    fn target_branch_is_the_remote_default_without_a_test_branch() {
        let dir = tempfile::tempdir().unwrap();
        let work = repo_with_origin(dir.path());
        git(&work, &["remote", "set-head", "origin", "main"]).unwrap();
        assert_eq!(detect_target_branch(&work), "main");
    }

    #[test]
    fn target_branch_prefers_origin_test_when_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let work = repo_with_origin(dir.path());
        git(&work, &["remote", "set-head", "origin", "main"]).unwrap();
        git(&work, &["branch", "test"]).unwrap();
        git(&work, &["push", "-q", "origin", "test"]).unwrap();
        assert_eq!(detect_target_branch(&work), "test");
    }

    #[test]
    fn a_local_test_branch_alone_does_not_count() {
        // Only the remote staging branch is the convention; a stray local
        // `test` must not redirect the queue.
        let dir = tempfile::tempdir().unwrap();
        let work = repo_with_origin(dir.path());
        git(&work, &["remote", "set-head", "origin", "main"]).unwrap();
        git(&work, &["branch", "test"]).unwrap();
        assert_eq!(detect_target_branch(&work), "main");
    }

    #[test]
    fn target_branch_falls_back_to_local_head_without_a_remote() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("solo");
        git(dir.path(), &["init", "-b", "trunk", work.to_str().unwrap()]).unwrap();
        assert_eq!(detect_target_branch(&work), "trunk");
    }

    #[test]
    fn parses_repo_name_from_various_url_shapes() {
        assert_eq!(repo_name_from_url("https://github.com/owner/repo").as_deref(), Some("repo"));
        assert_eq!(repo_name_from_url("https://github.com/owner/repo.git").as_deref(), Some("repo"));
        assert_eq!(repo_name_from_url("https://github.com/owner/repo/").as_deref(), Some("repo"));
        assert_eq!(repo_name_from_url("git@github.com:owner/repo.git").as_deref(), Some("repo"));
        assert_eq!(repo_name_from_url("  https://github.com/owner/My-Repo.git  ").as_deref(), Some("My-Repo"));
        assert_eq!(repo_name_from_url(""), None);
        assert_eq!(repo_name_from_url("   "), None);
    }

    #[test]
    fn recognizes_github_https_remotes_only() {
        assert!(is_github_https("https://github.com/owner/repo.git"));
        assert!(is_github_https("  https://github.com/owner/repo  "));
        assert!(!is_github_https("git@github.com:owner/repo.git"));
        assert!(!is_github_https("https://gitlab.com/owner/repo.git"));
        assert!(!is_github_https("https://evil.com/github.com/x.git"));
    }
}

/// Clone a git URL into `dest_parent` (default `~/conductor/repos`) and return
/// the new repository's info. Never overwrites an existing directory.
#[tauri::command]
pub fn git_clone_repo(url: String, dest_parent: Option<String>) -> Result<RepoInfo, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Enter a repository URL to clone.".to_string());
    }
    let name = repo_name_from_url(&url)
        .ok_or("Could not read a repository name from that URL.".to_string())?;
    let parent = dest_parent
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(default_projects_dir);
    std::fs::create_dir_all(&parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let target = parent.join(&name);
    if target.exists() {
        return Err(format!("{} already exists — pick another location.", target.display()));
    }
    let target_str = target.to_string_lossy().to_string();
    // Inject a transient GitHub-token Authorization header for HTTPS github.com
    // remotes so private-repo clones work without ambient credentials. Scoped to
    // github.com so the token never leaks to another host; no-op for SSH remotes
    // or when disconnected. Passed via `-c` so it never lands in repo config.
    let auth = is_github_https(&url)
        .then(crate::github::token)
        .flatten()
        .map(|t| format!("http.extraheader=AUTHORIZATION: {}", crate::github::basic_auth_header(&t)));
    let mut cmd = Command::new(GIT);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(cfg) = &auth {
        cmd.arg("-c").arg(cfg);
    }
    cmd.args(["clone", "--", &url, &target_str]);
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() { "git clone failed".into() } else { err });
    }
    git_validate_repo(target_str)
}

/// Create a fresh project directory under `dest_parent` (default
/// `~/conductor/repos`), `git init` it with an initial commit, and return its
/// info. Never overwrites an existing directory.
#[tauri::command]
pub fn git_init_repo(name: String, dest_parent: Option<String>) -> Result<RepoInfo, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a name for the new project.".to_string());
    }
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err("Use a plain folder name without slashes.".to_string());
    }
    let parent = dest_parent
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(default_projects_dir);
    std::fs::create_dir_all(&parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let target = parent.join(name);
    if target.exists() {
        return Err(format!("{} already exists — pick another name.", target.display()));
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    std::fs::write(target.join("README.md"), format!("# {name}\n"))
        .map_err(|e| e.to_string())?;
    git(&target, &["init", "-b", "main"])?;
    git(&target, &["add", "-A"])?;
    git(&target, &["-c", "user.name=Powerhouse", "-c", "user.email=powerhouse@local", "commit", "-m", "Initial commit"])?;
    git_validate_repo(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn git_create_worktree(
    repo_path: String,
    branch: String,
    base: String,
) -> Result<String, String> {
    let repo = PathBuf::from(&repo_path);
    let repo_slug = slugify(
        &repo
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".into()),
    );
    let branch_slug = slugify(&branch);
    if branch_slug.is_empty() {
        return Err("branch name is empty".to_string());
    }

    let home = dirs::home_dir().ok_or("cannot resolve home directory")?;
    let worktree_dir = home
        .join(".powerhouse")
        .join("worktrees")
        .join(&repo_slug)
        .join(&branch_slug);
    if worktree_dir.exists() {
        return Err(format!(
            "worktree path already exists: {}",
            worktree_dir.display()
        ));
    }
    if let Some(parent) = worktree_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let worktree_str = worktree_dir.to_string_lossy().to_string();
    let args = ["worktree", "add", "-b", &branch, &worktree_str, &base];

    let created = match git(&repo, &args) {
        Ok(_) => worktree_str,
        Err(first_err) => {
            // Stale worktree metadata is the common failure — prune and retry once.
            let _ = git(&repo, &["worktree", "prune"]);
            git(&repo, &args).map(|_| worktree_str).map_err(|_| first_err)?
        }
    };
    crate::handoff::ensure_powerhouse_dir(Path::new(&created));
    Ok(created)
}

/// Local branch names for `repo_path`, sorted with the most recently used first.
/// Used to pick the base branch when creating a new worktree.
#[tauri::command]
pub fn git_list_branches(repo_path: String) -> Result<Vec<String>, String> {
    let repo = PathBuf::from(&repo_path);
    let out = git(
        &repo,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            "refs/heads",
        ],
    )?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// One commit on the target branch, for the Merge tab's "on test" list.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct CommitInfo {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    /// Committer time, unix seconds.
    pub time: u64,
    pub merge: bool,
}

#[derive(serde::Serialize, Debug)]
pub struct TargetCommits {
    pub target: String,
    /// The production branch the range is measured against, when it exists
    /// at origin and differs from the target. `None` = latest commits only.
    pub base: Option<String>,
    /// Whether `git fetch origin` succeeded; when false the list is stale.
    pub fetched: bool,
    pub commits: Vec<CommitInfo>,
}

/// Record separator 0x1e between commits, unit separator 0x1f between fields,
/// so subjects can contain anything.
const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ct%x1f%P%x1e";
const TARGET_COMMITS_MAX: &str = "--max-count=100";

pub(crate) fn parse_log(out: &str) -> Vec<CommitInfo> {
    out.split('\x1e')
        .filter_map(|rec| {
            let rec = rec.trim_matches(|c| c == '\n' || c == '\r');
            if rec.is_empty() {
                return None;
            }
            let f: Vec<&str> = rec.splitn(6, '\x1f').collect();
            if f.len() < 6 {
                return None;
            }
            Some(CommitInfo {
                sha: f[0].to_string(),
                short: f[1].to_string(),
                subject: f[2].to_string(),
                author: f[3].to_string(),
                time: f[4].trim().parse().unwrap_or(0),
                merge: f[5].split_whitespace().count() > 1,
            })
        })
        .collect()
}

/// Best-effort `git fetch origin`, attaching the GitHub token for HTTPS
/// github.com remotes the same way clone does. Never prompts.
pub(crate) fn fetch_origin(repo: &Path) -> bool {
    let url = git(repo, &["remote", "get-url", "origin"]).unwrap_or_default();
    let auth = is_github_https(&url)
        .then(crate::github::token)
        .flatten()
        .map(|t| format!("http.extraheader=AUTHORIZATION: {}", crate::github::basic_auth_header(&t)));
    let mut cmd = Command::new(GIT);
    cmd.current_dir(repo).env("GIT_TERMINAL_PROMPT", "0");
    if let Some(cfg) = &auth {
        cmd.arg("-c").arg(cfg);
    }
    cmd.args(["fetch", "--quiet", "--prune", "origin"]);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

/// What is on `origin/<target>` and not yet on `origin/<base>` — the Merge
/// tab's session overview. Falls back to the latest commits on the target
/// when the base is the target itself or does not exist at origin.
#[tauri::command]
pub fn git_target_commits(repo_path: String, target: String, base: String) -> Result<TargetCommits, String> {
    let repo = PathBuf::from(&repo_path);
    let has_origin = git(&repo, &["remote"])
        .map(|s| s.lines().any(|l| l.trim() == "origin"))
        .unwrap_or(false);
    if !has_origin {
        return Err("This project has no origin remote.".to_string());
    }
    let fetched = fetch_origin(&repo);
    let target_ref = format!("origin/{target}");
    git(&repo, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{target_ref}")])
        .map_err(|_| format!("origin has no branch “{target}” yet."))?;
    let base_ref = format!("origin/{base}");
    let base_exists = base != target
        && git(&repo, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{base_ref}")]).is_ok();
    let range = if base_exists { format!("{base_ref}..{target_ref}") } else { target_ref };
    let out = git(&repo, &["log", TARGET_COMMITS_MAX, LOG_FORMAT, &range])?;
    Ok(TargetCommits {
        target,
        base: base_exists.then_some(base),
        fetched,
        commits: parse_log(&out),
    })
}

#[tauri::command]
pub fn git_remove_worktree(repo_path: String, worktree_path: String) -> Result<(), String> {
    let repo = PathBuf::from(&repo_path);
    git(&repo, &["worktree", "remove", "--force", &worktree_path])?;
    let _ = git(&repo, &["worktree", "prune"]);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ChangedFile {
    path: String,
    status: String,
}

/// Changed files in a worktree vs the merge-base with `base` (committed), plus
/// any uncommitted changes (marked with a trailing "*" on the status letter).
#[tauri::command]
pub fn git_changed_files(worktree_path: String, base: String) -> Result<Vec<ChangedFile>, String> {
    let wt = PathBuf::from(&worktree_path);
    let base_ref = git(&wt, &["merge-base", &base, "HEAD"]).unwrap_or(base);

    let mut files: Vec<ChangedFile> = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    // Committed changes: HEAD vs the merge base.
    let committed = git(&wt, &["diff", "--name-status", &base_ref, "HEAD"])?;
    for line in committed.lines().filter(|l| !l.trim().is_empty()) {
        let mut parts = line.split('\t');
        let status = parts.next().unwrap_or("").chars().next().unwrap_or('M');
        // Renames (Rxxx) list the new path last.
        if let Some(path) = parts.last() {
            seen.insert(path.to_string(), files.len());
            files.push(ChangedFile {
                path: path.to_string(),
                status: status.to_string(),
            });
        }
    }

    // Uncommitted changes (staged + working tree + untracked) → mark with "*".
    let porcelain = git(&wt, &["status", "--porcelain"])?;
    for line in porcelain.lines() {
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        let raw = line[3..].trim();
        // Renames appear as "old -> new"; keep the new path.
        let path = raw
            .rsplit(" -> ")
            .next()
            .unwrap_or(raw)
            .trim_matches('"')
            .to_string();
        let status = if xy.contains('?') {
            "A"
        } else if xy.contains('D') {
            "D"
        } else {
            "M"
        };
        match seen.get(&path) {
            Some(&i) => {
                let letter = files[i].status.trim_end_matches('*').to_string();
                files[i].status = format!("{letter}*");
            }
            None => files.push(ChangedFile {
                path,
                status: format!("{status}*"),
            }),
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Every file in the worktree: tracked (`ls-files`) + untracked (respecting
/// .gitignore), sorted and de-duplicated.
#[tauri::command]
pub fn git_list_files(worktree_path: String) -> Result<Vec<String>, String> {
    let wt = PathBuf::from(&worktree_path);
    let tracked = git(&wt, &["ls-files"])?;
    let untracked = git(&wt, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();

    let mut files: Vec<String> = tracked
        .lines()
        .chain(untracked.lines())
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    files.sort();
    files.dedup();
    Ok(files)
}

/// Working-tree contents of a single file. Binary files return a placeholder.
#[tauri::command]
pub fn git_file_content(worktree_path: String, path: String) -> Result<String, String> {
    let full = PathBuf::from(&worktree_path).join(&path);
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Ok("(binary file)".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// Unified diff for a single path: the merge base with `base` → working tree,
/// so committed and uncommitted changes are shown together.
#[tauri::command]
pub fn git_file_diff(
    worktree_path: String,
    base: String,
    path: String,
) -> Result<String, String> {
    let wt = PathBuf::from(&worktree_path);
    let base_ref = git(&wt, &["merge-base", &base, "HEAD"]).unwrap_or(base);
    let out = git_raw(&wt, &["diff", &base_ref, "--", &path])?;
    if !out.trim().is_empty() {
        return Ok(out);
    }
    // Untracked file — no tracked diff exists; diff against an empty file.
    Ok(git_raw(&wt, &["diff", "--no-index", "--", "/dev/null", &path]).unwrap_or_default())
}
