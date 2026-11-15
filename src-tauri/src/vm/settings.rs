//! Settings → Cloud and project env vars: tokens and per-project values in
//! the Keychain, read by image builds and chat VMs. Values never leave Rust
//! except into a VM's `~/.ph/env`.

use std::path::Path;

use tauri::State;

use super::commands::VmManager;
use crate::cloud::secrets::{self, SecretStore};

#[tauri::command]
pub fn cloud_secret_status(state: State<VmManager>, remote_url: Option<String>) -> Result<secrets::SecretStatus, String> {
    secrets::status_for(state.secrets.as_ref(), remote_url.as_deref())
}

/// `name` is `claude_oauth_token`, `github_token`, a scoped
/// `github_token:<owner>[/<repo>]`, or a project env slot. Empty clears it.
#[tauri::command]
pub fn cloud_set_secret(state: State<VmManager>, name: String, value: String, remote_url: Option<String>) -> Result<secrets::SecretStatus, String> {
    if !secrets::KNOWN.contains(&name.as_str()) && !secrets::is_github_slot(&name) && !secrets::is_project_env_slot(&name) {
        return Err(format!("unknown secret {name}"));
    }
    if name.len() > 200 || name.chars().any(|c| c.is_whitespace()) {
        return Err("invalid secret name".into());
    }
    if value.trim().is_empty() {
        state.secrets.clear(&name)?;
    } else {
        state.secrets.set(&name, value.trim())?;
    }
    secrets::status_for(state.secrets.as_ref(), remote_url.as_deref())
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct EnvVarStatus {
    pub name: String,
    /// Whether a non-empty value is stored (values never leave the Keychain here).
    pub set: bool,
}

#[tauri::command]
pub fn cloud_project_env_status(state: State<VmManager>, repo_id: String, names: Vec<String>) -> Result<Vec<EnvVarStatus>, String> {
    names
        .into_iter()
        .map(|name| {
            if !secrets::is_env_var_name(&name) {
                return Err(format!("`{name}` is not a valid environment variable name"));
            }
            let set = state
                .secrets
                .get(&secrets::project_env_slot(&repo_id, &name))?
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            Ok(EnvVarStatus { name, set })
        })
        .collect()
}

const ENV_FILE_MAX: u64 = 256 * 1024;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct EnvImport {
    /// Names whose values were stored.
    pub imported: Vec<String>,
    /// `NAME: reason` for each variable left out. Never a value.
    pub skipped: Vec<String>,
    /// Lines that are not `KEY=value` with a valid key.
    pub invalid: usize,
}

/// Whether `file` is a plain `.env` or `.env.<suffix>` filename, not a path.
fn is_env_file_name(file: &str) -> bool {
    match file.strip_prefix(".env") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('.')
            .is_some_and(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')),
        None => false,
    }
}

/// Reads `<dir>/<file>` and stores every value in the repo's project env slots.
/// Re-importing overwrites, so a second run is idempotent.
pub fn import_env_file(store: &dyn SecretStore, repo_id: &str, dir: &Path, file: &str) -> Result<EnvImport, String> {
    if !is_env_file_name(file) {
        return Err(format!("`{file}` is not a .env filename (use .env or .env.<name>)"));
    }
    let path = dir.join(file);
    let meta = std::fs::metadata(&path).map_err(|_| format!("no {file} in {}", dir.display()))?;
    if meta.len() > ENV_FILE_MAX {
        return Err(format!("{file} is larger than {} KiB", ENV_FILE_MAX / 1024));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading {file}: {e}"))?;
    let (vars, invalid) = secrets::parse_dotenv(&text);
    let mut out = EnvImport { invalid, ..Default::default() };
    for (name, value) in vars {
        if secrets::RESERVED_ENV.contains(&name.as_str()) {
            out.skipped.push(format!("{name}: set in Settings → Cloud"));
        } else if value.trim().is_empty() {
            out.skipped.push(format!("{name}: empty"));
        } else {
            store.set(&secrets::project_env_slot(repo_id, &name), value.trim())?;
            out.imported.push(name);
        }
    }
    Ok(out)
}

/// `file` defaults to `.env`; only a filename in the worktree is accepted.
#[tauri::command]
pub fn cloud_import_env_file(state: State<VmManager>, repo_id: String, worktree_path: String, file: Option<String>) -> Result<EnvImport, String> {
    let file = file.filter(|f| !f.trim().is_empty()).unwrap_or_else(|| ".env".into());
    import_env_file(state.secrets.as_ref(), &repo_id, Path::new(&worktree_path), file.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::secrets::MemoryStore;

    #[test]
    fn env_import_stores_values_and_refuses_paths_big_files_and_reserved_names() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        std::fs::write(dir.path().join(".env"), "API_KEY=abc\nGH_TOKEN=nope\nBLANK=\nbad line\n").unwrap();
        let out = import_env_file(&store, "r", dir.path(), ".env").unwrap();
        assert_eq!(out.imported, vec!["API_KEY".to_string()]);
        assert_eq!(out.skipped, vec!["GH_TOKEN: set in Settings → Cloud".to_string(), "BLANK: empty".to_string()]);
        assert_eq!(out.invalid, 1);
        assert_eq!(store.get("project_env:r:API_KEY").unwrap().as_deref(), Some("abc"));
        assert_eq!(store.get("project_env:r:GH_TOKEN").unwrap(), None);
        // A second import is idempotent.
        let again = import_env_file(&store, "r", dir.path(), ".env").unwrap();
        assert_eq!(again.imported, out.imported);
        assert_eq!(store.0.lock().unwrap().len(), 1);

        std::fs::write(dir.path().join(".env.local"), "X=1\n").unwrap();
        assert_eq!(import_env_file(&store, "r", dir.path(), ".env.local").unwrap().imported, vec!["X".to_string()]);
        for bad in ["../x", "../.env", "sub/.env", ".env.", ".envrc", "/etc/passwd", ".env.a/b"] {
            assert!(import_env_file(&store, "r", dir.path(), bad).unwrap_err().contains("not a .env filename"), "{bad}");
        }
        std::fs::write(dir.path().join(".env.big"), "A=".to_string() + &"x".repeat(300 * 1024)).unwrap();
        assert!(import_env_file(&store, "r", dir.path(), ".env.big").unwrap_err().contains("larger"));
        assert!(import_env_file(&store, "r", dir.path(), ".env.missing").unwrap_err().contains("no .env.missing"));
    }
}
