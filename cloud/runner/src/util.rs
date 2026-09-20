use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Write-then-rename with fsync on file and directory.
pub fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
        std::process::id()
    ));
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(mode);
        }
        #[cfg(not(unix))]
        let _ = mode;
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Ok(dir) = fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Keep at most `cap` trailing bytes on a UTF-8 boundary.
pub fn tail_utf8(s: &str, cap: usize) -> (&str, bool) {
    if s.len() <= cap {
        return (s, false);
    }
    let mut cut = s.len() - cap;
    while cut < s.len() && !s.is_char_boundary(cut) {
        cut += 1;
    }
    (&s[cut..], true)
}

pub fn truncate_utf8(s: &str, cap: usize) -> (&str, bool) {
    if s.len() <= cap {
        return (s, false);
    }
    let mut cut = cap;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    (&s[..cut], true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_respects_boundaries() {
        let s = "héllo wörld";
        let (t, cut) = tail_utf8(s, 4);
        assert!(cut);
        assert!(s.ends_with(t));
        assert!(t.len() <= 4);
        let (u, cut2) = truncate_utf8(s, 2);
        assert!(cut2);
        assert!(s.starts_with(u));
    }
}
