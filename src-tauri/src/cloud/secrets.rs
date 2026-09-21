//! Powerhouse's own credentials for cloud runs, kept in the macOS Keychain
//! and handed to a run only for its lifetime. Nothing here is read from
//! boxd, the base VM, or the user's other tools.

use std::collections::HashMap;
use std::sync::Mutex;

pub const SERVICE: &str = "Powerhouse";
pub const CLAUDE_OAUTH: &str = "claude_oauth_token";
pub const GITHUB_TOKEN: &str = "github_token";
pub const KNOWN: [&str; 2] = [CLAUDE_OAUTH, GITHUB_TOKEN];

pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn clear(&self, name: &str) -> Result<(), String>;
}

pub struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keychain: {e}")),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, name)
            .map_err(|e| e.to_string())?
            .set_password(value)
            .map_err(|e| format!("keychain: {e}"))
    }
    fn clear(&self, name: &str) -> Result<(), String> {
        match keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain: {e}")),
        }
    }
}

/// In-memory store for tests.
#[derive(Default)]
#[allow(dead_code)]
pub struct MemoryStore(pub Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
    fn clear(&self, name: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SecretStatus {
    pub claude: bool,
    pub github: bool,
}

pub fn status(store: &dyn SecretStore) -> Result<SecretStatus, String> {
    Ok(SecretStatus {
        claude: store.get(CLAUDE_OAUTH)?.map(|v| !v.trim().is_empty()).unwrap_or(false),
        github: store.get(GITHUB_TOKEN)?.map(|v| !v.trim().is_empty()).unwrap_or(false),
    })
}

/// The KEY=VALUE file a run receives. Only what this run needs.
pub fn render_run_credentials(store: &dyn SecretStore, need_claude: bool, need_git: bool) -> Result<String, String> {
    let mut lines = vec![];
    if need_claude {
        let v = store
            .get(CLAUDE_OAUTH)?
            .filter(|v| !v.trim().is_empty())
            .ok_or("no Claude credential is stored in Powerhouse. Run `claude setup-token` and paste the token in the cloud form.")?;
        lines.push(format!("CLAUDE_CODE_OAUTH_TOKEN={}", v.trim()));
    }
    if need_git {
        let v = store
            .get(GITHUB_TOKEN)?
            .filter(|v| !v.trim().is_empty())
            .ok_or("no GitHub token is stored in Powerhouse. Add a fine-grained token with contents:write for this repository in the cloud form.")?;
        lines.push(format!("GIT_PUBLISH_TOKEN={}", v.trim()));
    }
    Ok(format!("{}\n", lines.join("\n")))
}
