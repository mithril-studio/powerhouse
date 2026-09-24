use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const GIT: &str = "/usr/bin/git";
const SENTINEL: &str = "<!-- handoff-complete -->";

/// The exact prose the button types and the slash-command files carry. Kept in
/// sync with `src/lib/handoff.ts` (HANDOFF_INSTRUCTION).
const HANDOFF_INSTRUCTION: &str = "Write a complete handoff document to `.powerhouse/handoff-<YYYYMMDD-HHMMSS>.md` (relative to the repo root) covering: the task and goal, work completed, key decisions and why, files touched, current state, immediate next steps, and gotchas. Write it in a single operation and end the file with the exact line `<!-- handoff-complete -->`.";

/// Per-branch stop flags for the running poll threads.
#[derive(Default)]
pub struct HandoffWatchers(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

/// Best-effort: seed `/handoff` slash-commands for claude (convenience only —
/// the watcher catches manual handoffs regardless). Never overwrites.
#[tauri::command]
pub fn handoff_ensure_commands() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("cannot resolve home directory")?;
    let targets = [
        home.join(".claude").join("commands").join("handoff.md"),
    ];
    for path in targets {
        if path.exists() {
            continue;
        }
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        let _ = std::fs::write(&path, HANDOFF_INSTRUCTION);
    }
    Ok(())
}

/// Creates `<worktree>/.powerhouse/` and repo-wide-excludes it (so handoff docs
/// never show up in `git status`). Shared with worktree creation.
pub fn ensure_powerhouse_dir(worktree: &Path) {
    let _ = std::fs::create_dir_all(worktree.join(".powerhouse"));

    let common = match run_git(worktree, &["rev-parse", "--git-common-dir"]) {
        Ok(c) if !c.is_empty() => c,
        _ => return,
    };
    let mut common_path = PathBuf::from(&common);
    if common_path.is_relative() {
        common_path = worktree.join(common_path);
    }
    let exclude = common_path.join("info").join("exclude");
    if let Some(parent) = exclude.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == ".powerhouse/") {
        return;
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(".powerhouse/\n");
    let _ = std::fs::write(&exclude, next);
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new(GIT)
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn snapshot_existing(dir: &Path) -> HashSet<PathBuf> {
    let mut set = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if is_handoff_file(&p) {
                set.insert(p);
            }
        }
    }
    set
}

fn is_handoff_file(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("handoff-") && n.ends_with(".md"))
        .unwrap_or(false)
}

/// Blocks until the file looks fully written: nonempty, two equal reads, and the
/// completion sentinel — with a size-stable fallback and a ~6s ceiling.
fn wait_stable(path: &Path) -> bool {
    let mut prev: Option<String> = None;
    for i in 0..20 {
        std::thread::sleep(Duration::from_millis(300));
        let cur = std::fs::read_to_string(path).unwrap_or_default();
        if !cur.is_empty() {
            let stable = prev.as_deref() == Some(cur.as_str());
            if stable && (cur.contains(SENTINEL) || i >= 3) {
                return true;
            }
        }
        prev = Some(cur);
    }
    true // best-effort: the file exists, emit anyway
}

#[tauri::command]
pub fn handoff_watch_start(
    app: AppHandle,
    state: State<HandoffWatchers>,
    branch_id: String,
    worktree_path: String,
) -> Result<(), String> {
    let worktree = PathBuf::from(&worktree_path);
    ensure_powerhouse_dir(&worktree);

    // Idempotent: never run two threads for one branch.
    {
        let map = state.0.lock().unwrap();
        if map.contains_key(&branch_id) {
            return Ok(());
        }
    }

    let dir = worktree.join(".powerhouse");
    let stop = Arc::new(AtomicBool::new(false));
    state.0.lock().unwrap().insert(branch_id.clone(), stop.clone());

    std::thread::spawn(move || {
        let mut seen = snapshot_existing(&dir);
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(500));
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !is_handoff_file(&path) || seen.contains(&path) {
                    continue;
                }
                seen.insert(path.clone());
                if !wait_stable(&path) {
                    continue;
                }
                let rel = path
                    .strip_prefix(&worktree)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                let _ = app.emit(
                    "handoff-created",
                    HandoffEvent {
                        branch_id: branch_id.clone(),
                        path: path.to_string_lossy().to_string(),
                        rel_path: rel,
                    },
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn handoff_watch_stop(state: State<HandoffWatchers>, branch_id: String) -> Result<(), String> {
    if let Some(stop) = state.0.lock().unwrap().remove(&branch_id) {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HandoffEvent {
    branch_id: String,
    path: String,
    rel_path: String,
}
