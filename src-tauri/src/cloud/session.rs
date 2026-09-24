//! The desktop side of a session handoff: pack a chat's Claude Code session
//! for the cloud, and restore the continued session when the run comes home.
//! The on-disk layout is shared with the runner (`session_files`).

use std::path::{Path, PathBuf};

use powerhouse_cloud_protocol::session_files::{self, Layout};
use powerhouse_cloud_protocol::{split_bundle_path, SessionBundle, MAX_SESSION_BUNDLE_BYTES};

/// `~` as Claude Code sees it; `POWERHOUSE_CLAUDE_HOME` lets tests redirect it.
pub fn claude_home() -> PathBuf {
    std::env::var_os("POWERHOUSE_CLAUDE_HOME")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// Pack session `session_id` of the chat running in `cwd`. `Ok(None)` when
/// there is nothing to carry (the chat never wrote a transcript), so the send
/// falls back to a brief-only run.
pub fn pack(home: &Path, cwd: &Path, session_id: &str) -> Result<Option<SessionBundle>, String> {
    let layout = Layout { home: home.to_path_buf(), cwd: cwd.to_path_buf() };
    if !layout.project_dir().join(format!("{session_id}.jsonl")).is_file() {
        return Ok(None);
    }
    let version = std::process::Command::new("claude")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let cwd_s = cwd.to_string_lossy().to_string();
    let bundle = session_files::capture(session_id, &layout, &cwd_s, version)?;
    if bundle.to_bytes().len() as u64 > MAX_SESSION_BUNDLE_BYTES {
        return Err(format!("the chat is larger than {} MB and cannot travel to the cloud", MAX_SESSION_BUNDLE_BYTES / 1024 / 1024));
    }
    Ok(Some(bundle))
}

/// Write a session that came home into `cwd`'s Claude project. The previous
/// transcript is kept as `<id>.jsonl.pre-cloud`; `.powerhouse/` documents are
/// only added, never overwritten, because the worktree may have moved on.
/// Returns the number of files written.
pub fn restore(home: &Path, cwd: &Path, mut bundle: SessionBundle) -> Result<usize, String> {
    bundle.validate()?;
    bundle.rebase(&cwd.to_string_lossy());
    let layout = Layout { home: home.to_path_buf(), cwd: cwd.to_path_buf() };
    let transcript = layout.project_dir().join(format!("{}.jsonl", bundle.session_id));
    if transcript.is_file() {
        let backup = transcript.with_extension("jsonl.pre-cloud");
        std::fs::copy(&transcript, &backup).map_err(|e| format!("could not back up the local transcript: {e}"))?;
    }
    let mut written = 0;
    for f in &bundle.files {
        let (root, _) = split_bundle_path(&f.path)?;
        let dest = layout.resolve(&f.path)?;
        if root == "powerhouse" && dest.exists() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        let tmp = dest.with_extension("powerhouse-tmp");
        std::fs::write(&tmp, f.content.as_bytes()).map_err(|e| format!("{}: {e}", dest.display()))?;
        std::fs::rename(&tmp, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use powerhouse_cloud_protocol::claude_project_slug;

    /// Where Claude Code keeps `cwd`'s sessions.
    pub(crate) fn project_dir(home: &Path, cwd: &Path) -> PathBuf {
        home.join(".claude").join("projects").join(claude_project_slug(&cwd.to_string_lossy()))
    }

    const SID: &str = "0b1bf178-c3a1-458b-b925-a841edf79619";

    #[test]
    fn pack_is_none_without_a_transcript_and_carries_one_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let (home, cwd) = (tmp.path().join("home"), tmp.path().join("wt"));
        assert!(pack(&home, &cwd, SID).unwrap().is_none());
        let dir = project_dir(&home, &cwd);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{SID}.jsonl")), "{\"a\":1}\n").unwrap();
        std::fs::create_dir_all(cwd.join(".powerhouse")).unwrap();
        std::fs::write(cwd.join(".powerhouse/handoff-1.md"), "# plan").unwrap();
        let b = pack(&home, &cwd, SID).unwrap().unwrap();
        assert_eq!(b.cwd, cwd.to_string_lossy());
        assert_eq!(b.files.len(), 2);
    }

    #[test]
    fn restore_backs_up_the_transcript_and_never_clobbers_local_docs() {
        let tmp = tempfile::tempdir().unwrap();
        let (home, cwd) = (tmp.path().join("home"), tmp.path().join("wt"));
        let dir = project_dir(&home, &cwd);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{SID}.jsonl")), "local\n").unwrap();
        std::fs::create_dir_all(cwd.join(".powerhouse")).unwrap();
        std::fs::write(cwd.join(".powerhouse/handoff-1.md"), "local plan").unwrap();

        let bundle = SessionBundle {
            session_id: SID.into(),
            cwd: "/var/lib/w/run/repo".into(),
            claude_version: None,
            files: vec![
                powerhouse_cloud_protocol::BundleFile {
                    path: SessionBundle::transcript_path(SID),
                    content: "local\n{\"cwd\":\"/var/lib/w/run/repo\"}\n".into(),
                },
                powerhouse_cloud_protocol::BundleFile { path: "powerhouse/handoff-1.md".into(), content: "cloud plan".into() },
                powerhouse_cloud_protocol::BundleFile { path: "powerhouse/handoff-2.md".into(), content: "new".into() },
            ],
        };
        assert_eq!(restore(&home, &cwd, bundle).unwrap(), 2);
        let cwd_s = cwd.to_string_lossy();
        assert_eq!(
            std::fs::read_to_string(dir.join(format!("{SID}.jsonl"))).unwrap(),
            format!("local\n{{\"cwd\":\"{cwd_s}\"}}\n")
        );
        assert_eq!(std::fs::read_to_string(dir.join(format!("{SID}.jsonl.pre-cloud"))).unwrap(), "local\n");
        assert_eq!(std::fs::read_to_string(cwd.join(".powerhouse/handoff-1.md")).unwrap(), "local plan");
        assert_eq!(std::fs::read_to_string(cwd.join(".powerhouse/handoff-2.md")).unwrap(), "new");
    }
}
