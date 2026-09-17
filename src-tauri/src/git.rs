use std::path::{Path, PathBuf};
use std::process::Command;

const GIT: &str = "/usr/bin/git";

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
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

fn slugify(s: &str) -> String {
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

#[tauri::command]
pub fn git_remove_worktree(repo_path: String, worktree_path: String) -> Result<(), String> {
    let repo = PathBuf::from(&repo_path);
    git(&repo, &["worktree", "remove", "--force", &worktree_path])?;
    let _ = git(&repo, &["worktree", "prune"]);
    Ok(())
}
