//! Where a Claude Code session lives on disk, shared by both ends of a
//! session handoff: the desktop packs a chat and the runner installs it into
//! the agent's HOME; after the agent stops the runner packs it again and the
//! desktop restores it. The only file I/O in this crate.
//!
//! Paths inside the bundle are rewritten on every hop, so each side sees its
//! own working directory in the conversation.

use std::path::{Path, PathBuf};

use crate::{
    claude_project_slug, sha256_hex, split_bundle_path, BundleFile, SessionBundle, SessionSpec,
    MAX_SESSION_BUNDLE_BYTES,
};

/// Brief written by the runner itself; never sent home.
pub const RUNNER_BRIEF: &str = "cloud-task.md";
/// Per-file cap when packing; larger files stay on the VM.
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// Where the session's files live for one side of the trip.
pub struct Layout {
    /// The agent's HOME (`~` for Claude Code).
    pub home: PathBuf,
    /// The working directory the session belongs to.
    pub cwd: PathBuf,
}

impl Layout {
    pub fn project_dir(&self) -> PathBuf {
        self.home
            .join(".claude")
            .join("projects")
            .join(claude_project_slug(&self.cwd.to_string_lossy()))
    }

    fn todos_dir(&self) -> PathBuf {
        self.home.join(".claude").join("todos")
    }

    pub fn powerhouse_dir(&self) -> PathBuf {
        self.cwd.join(".powerhouse")
    }

    /// Absolute destination of a bundle path on this side.
    pub fn resolve(&self, bundle_path: &str) -> Result<PathBuf, String> {
        let (root, rest) = split_bundle_path(bundle_path)?;
        let base = match root {
            "project" => self.project_dir(),
            "todos" => self.todos_dir(),
            _ => self.powerhouse_dir(),
        };
        Ok(base.join(rest))
    }
}

/// Read and verify a bundle file against the manifest's pin.
pub fn read_verified(path: &Path, spec: &SessionSpec) -> Result<SessionBundle, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("session bundle unreadable: {e}"))?;
    if bytes.len() as u64 != spec.bundle_bytes {
        return Err(format!("session bundle is {} bytes, manifest pinned {}", bytes.len(), spec.bundle_bytes));
    }
    let digest = sha256_hex(&bytes);
    if digest != spec.bundle_sha256 {
        return Err(format!("session bundle digest {digest} does not match the manifest"));
    }
    let bundle = SessionBundle::from_bytes(&bytes)?;
    if bundle.session_id != spec.session_id {
        return Err("session bundle belongs to a different session".into());
    }
    Ok(bundle)
}

/// Unpack `bundle` (already addressed to the desktop's cwd) into `layout`,
/// rewriting paths to `layout.cwd`. Returns the number of files written.
pub fn install(mut bundle: SessionBundle, layout: &Layout) -> Result<usize, String> {
    bundle.rebase(&layout.cwd.to_string_lossy());
    for f in &bundle.files {
        let dest = layout.resolve(&f.path)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&dest, f.content.as_bytes()).map_err(|e| format!("{}: {e}", dest.display()))?;
    }
    Ok(bundle.files.len())
}

/// Pack session `session_id` from `layout`, addressed to `home_cwd` (the
/// working directory on the receiving side). `.powerhouse/` documents come
/// along except the runner's own brief.
pub fn capture(session_id: &str, layout: &Layout, home_cwd: &str, claude_version: Option<String>) -> Result<SessionBundle, String> {
    let project = layout.project_dir();
    let transcript = project.join(format!("{session_id}.jsonl"));
    if !transcript.is_file() {
        return Err(format!("no transcript for session {session_id} at {}", transcript.display()));
    }
    let mut files = vec![];
    let mut total = 0u64;
    let mut push = |path: String, file: &Path| -> Result<(), String> {
        let meta = std::fs::symlink_metadata(file).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            return Ok(());
        }
        let Ok(content) = String::from_utf8(std::fs::read(file).map_err(|e| e.to_string())?) else {
            return Ok(());
        };
        total += content.len() as u64;
        if total > MAX_SESSION_BUNDLE_BYTES / 2 {
            return Err(format!("session is larger than {} bytes", MAX_SESSION_BUNDLE_BYTES / 2));
        }
        files.push(BundleFile { path, content });
        Ok(())
    };
    push(SessionBundle::transcript_path(session_id), &transcript)?;
    for (rel, file) in walk(&project.join(session_id)) {
        push(format!("project/{session_id}/{rel}"), &file)?;
    }
    if let Ok(rd) = std::fs::read_dir(layout.todos_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with(session_id) {
                push(format!("todos/{name}"), &e.path())?;
            }
        }
    }
    for (rel, file) in walk(&layout.powerhouse_dir()) {
        if rel != RUNNER_BRIEF {
            push(format!("powerhouse/{rel}"), &file)?;
        }
    }
    let mut bundle = SessionBundle {
        session_id: session_id.to_string(),
        cwd: layout.cwd.to_string_lossy().to_string(),
        claude_version,
        files,
    };
    bundle.rebase(home_cwd);
    bundle.validate()?;
    Ok(bundle)
}

/// Regular files under `dir`, as (`a/b.txt`, path), sorted; symlinks skipped.
fn walk(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = vec![];
    let mut stack = vec![(String::new(), dir.to_path_buf())];
    while let Some((prefix, d)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push((rel, e.path())),
                Ok(t) if t.is_file() => out.push((rel, e.path())),
                _ => {}
            }
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0b1bf178-c3a1-458b-b925-a841edf79619";

    fn desktop_bundle() -> SessionBundle {
        SessionBundle {
            session_id: SID.into(),
            cwd: "/Users/j/wt/app".into(),
            claude_version: None,
            files: vec![
                BundleFile { path: SessionBundle::transcript_path(SID), content: "{\"cwd\":\"/Users/j/wt/app\"}\n".into() },
                BundleFile { path: format!("project/{SID}/subagents/agent-1.jsonl"), content: "{\"f\":\"/Users/j/wt/app/x\"}\n".into() },
                BundleFile { path: format!("todos/{SID}-agent-{SID}.json"), content: "[]".into() },
                BundleFile { path: "powerhouse/handoff-1.md".into(), content: "# plan".into() },
            ],
        }
    }

    #[test]
    fn install_then_capture_round_trips_with_paths_rewritten() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout { home: tmp.path().join("home"), cwd: tmp.path().join("repo") };
        std::fs::create_dir_all(&layout.cwd).unwrap();
        assert_eq!(install(desktop_bundle(), &layout).unwrap(), 4);

        let cwd = layout.cwd.to_string_lossy().to_string();
        let transcript = layout.project_dir().join(format!("{SID}.jsonl"));
        assert_eq!(std::fs::read_to_string(&transcript).unwrap(), format!("{{\"cwd\":\"{cwd}\"}}\n"));
        assert!(layout.cwd.join(".powerhouse/handoff-1.md").is_file());

        // The agent keeps talking and the runner writes its own brief.
        let mut t = std::fs::read_to_string(&transcript).unwrap();
        t.push_str(&format!("{{\"cloud\":\"{cwd}/new.rs\"}}\n"));
        std::fs::write(&transcript, t).unwrap();
        std::fs::write(layout.cwd.join(".powerhouse").join(RUNNER_BRIEF), "brief").unwrap();

        let back = capture(SID, &layout, "/Users/j/wt/app", Some("2.1".into())).unwrap();
        assert_eq!(back.cwd, "/Users/j/wt/app");
        let main = back.files.iter().find(|f| f.path == SessionBundle::transcript_path(SID)).unwrap();
        assert_eq!(main.content, "{\"cwd\":\"/Users/j/wt/app\"}\n{\"cloud\":\"/Users/j/wt/app/new.rs\"}\n");
        let paths: Vec<&str> = back.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&format!("project/{SID}/subagents/agent-1.jsonl").as_str()));
        assert!(paths.contains(&"powerhouse/handoff-1.md"));
        assert!(!paths.iter().any(|p| p.ends_with(RUNNER_BRIEF)));
    }

    #[test]
    fn capture_without_a_transcript_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = Layout { home: tmp.path().join("home"), cwd: tmp.path().join("repo") };
        assert!(capture(SID, &layout, "/x", None).unwrap_err().contains("no transcript"));
    }

    #[test]
    fn read_verified_checks_size_digest_and_session() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("b.json");
        let bytes = desktop_bundle().to_bytes();
        std::fs::write(&path, &bytes).unwrap();
        let spec = SessionSpec { session_id: SID.into(), bundle_sha256: sha256_hex(&bytes), bundle_bytes: bytes.len() as u64 };
        assert!(read_verified(&path, &spec).is_ok());
        let mut wrong = spec.clone();
        wrong.bundle_sha256 = "0".repeat(64);
        assert!(read_verified(&path, &wrong).unwrap_err().contains("digest"));
        let mut other = spec.clone();
        other.session_id = "11111111-1111-4111-8111-111111111111".into();
        assert!(read_verified(&path, &other).unwrap_err().contains("different session"));
    }
}
