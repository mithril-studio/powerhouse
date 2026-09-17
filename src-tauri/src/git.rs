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

    let default_branch = git(
        &root_path,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .map(|s| s.strip_prefix("origin/").unwrap_or(&s).to_string())
    .or_else(|| git(&root_path, &["symbolic-ref", "--short", "HEAD"]).ok())
    .unwrap_or_else(|| "HEAD".to_string());

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

    match git(&repo, &args) {
        Ok(_) => Ok(worktree_str),
        Err(first_err) => {
            // Stale worktree metadata is the common failure — prune and retry once.
            let _ = git(&repo, &["worktree", "prune"]);
            git(&repo, &args).map(|_| worktree_str).map_err(|_| first_err)
        }
    }
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
