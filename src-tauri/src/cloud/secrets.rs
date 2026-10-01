//! Powerhouse's own credentials for cloud workspaces, kept in the macOS
//! Keychain and written to the workspace VM's `~/.ph/env` (outside the repo,
//! so the agent can never commit them).

use std::collections::HashMap;
use std::sync::Mutex;

pub const SERVICE: &str = "Powerhouse";
pub const CLAUDE_OAUTH: &str = "claude_oauth_token";
pub const GITHUB_TOKEN: &str = "github_token";
pub const KNOWN: [&str; 2] = [CLAUDE_OAUTH, GITHUB_TOKEN];

/// `owner/repo` from an https remote, if it looks like a GitHub-style URL.
pub fn owner_repo(remote_url: &str) -> Option<(String, String)> {
    let rest = remote_url.strip_prefix("https://")?;
    let mut parts = rest.split('/');
    let _host = parts.next()?;
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches(".git").to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

/// Keychain account names to try for a remote, most specific first:
/// `github_token:<owner>/<repo>`, `github_token:<owner>`, `github_token`.
pub fn github_token_candidates(remote_url: &str) -> Vec<String> {
    let mut v = vec![];
    if let Some((owner, repo)) = owner_repo(remote_url) {
        v.push(format!("{GITHUB_TOKEN}:{owner}/{repo}"));
        v.push(format!("{GITHUB_TOKEN}:{owner}"));
    }
    v.push(GITHUB_TOKEN.to_string());
    v
}

/// Whether a name is a GitHub token slot (default or scoped).
pub fn is_github_slot(name: &str) -> bool {
    name == GITHUB_TOKEN || name.starts_with(&format!("{GITHUB_TOKEN}:"))
}

pub const PROJECT_ENV_PREFIX: &str = "project_env:";

/// A valid environment variable name: `[A-Za-z_][A-Za-z0-9_]*`.
pub fn is_env_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Keychain slot holding one project env value: `project_env:<repo_id>:<NAME>`.
/// Names live in the repo's config; only values live here.
pub fn project_env_slot(repo_id: &str, name: &str) -> String {
    format!("{PROJECT_ENV_PREFIX}{repo_id}:{name}")
}

/// Whether a name is a project env slot with a well-formed variable name.
pub fn is_project_env_slot(name: &str) -> bool {
    name.strip_prefix(PROJECT_ENV_PREFIX)
        .and_then(|rest| rest.split_once(':'))
        .map(|(repo, var)| !repo.is_empty() && is_env_var_name(var))
        .unwrap_or(false)
}

/// Configured names without a stored value. An invalid name is an error.
pub fn missing_project_env(store: &dyn SecretStore, repo_id: &str, names: &[String]) -> Result<Vec<String>, String> {
    let mut missing = vec![];
    for name in names {
        if !is_env_var_name(name) {
            return Err(format!("`{name}` is not a valid environment variable name"));
        }
        if store.get(&project_env_slot(repo_id, name))?.filter(|v| !v.trim().is_empty()).is_none() {
            missing.push(name.clone());
        }
    }
    Ok(missing)
}

/// Resolve a repo's configured env names to `(name, value)` pairs. Every
/// configured name must have a stored value: a silent skip would send a run
/// out with a half-configured environment.
pub fn project_env_values(store: &dyn SecretStore, repo_id: &str, names: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut out = vec![];
    let mut missing = vec![];
    for name in names {
        if !is_env_var_name(name) {
            return Err(format!("`{name}` is not a valid environment variable name"));
        }
        match store.get(&project_env_slot(repo_id, name))?.filter(|v| !v.trim().is_empty()) {
            Some(v) => out.push((name.clone(), v.trim().to_string())),
            None => missing.push(name.as_str()),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "no value is stored for the project env var(s) {}. Set them in the project settings (right-click the project), or remove them there.",
            missing.join(", ")
        ));
    }
    Ok(out)
}

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
    /// Keychain entry that would serve the queried remote, when one exists.
    pub github_slot: Option<String>,
}

/// Status for a specific remote: `github_slot` names which Keychain entry
/// would be used, so the form can say "using github_token:mithril-studio".
pub fn status_for(store: &dyn SecretStore, remote_url: Option<&str>) -> Result<SecretStatus, String> {
    let claude = store.get(CLAUDE_OAUTH)?.map(|v| !v.trim().is_empty()).unwrap_or(false);
    let (github, github_slot) = match resolve_github(store, remote_url.unwrap_or(""))? {
        Some((slot, _)) => (true, Some(slot)),
        None => (false, None),
    };
    Ok(SecretStatus { claude, github, github_slot })
}

/// The GitHub token stored for a remote, most specific Keychain slot first.
pub fn github_token_for(store: &dyn SecretStore, remote_url: &str) -> Option<String> {
    resolve_github(store, remote_url).ok().flatten().map(|(_, v)| v)
}

fn resolve_github(store: &dyn SecretStore, remote_url: &str) -> Result<Option<(String, String)>, String> {
    for name in github_token_candidates(remote_url) {
        if let Some(v) = store.get(&name)?.filter(|v| !v.trim().is_empty()) {
            return Ok(Some((name, v.trim().to_string())));
        }
    }
    Ok(None)
}

/// The variables a workspace VM gets: the Claude token, a GitHub token for the
/// remote (a Keychain slot, else `fallback_github`, Powerhouse's GitHub
/// connection), and the repo's project env vars. Both tokens are required: an
/// agent that cannot authenticate or push would only fail later, in the VM.
pub fn workspace_env(
    store: &dyn SecretStore,
    remote_url: &str,
    project_env: &[(String, String)],
    fallback_github: Option<String>,
) -> Result<Vec<(String, String)>, String> {
    let claude = store
        .get(CLAUDE_OAUTH)?
        .filter(|v| !v.trim().is_empty())
        .ok_or("no Claude token is stored. Run `claude setup-token` and paste the token under Settings → Cloud.")?;
    let github = match resolve_github(store, remote_url)? {
        Some((_, v)) => v,
        None => fallback_github.filter(|t| !t.trim().is_empty()).ok_or(
            "no GitHub token for this remote. Connect GitHub or add a token under Settings → Cloud.",
        )?,
    };
    let mut vars = vec![
        ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), claude.trim().to_string()),
        ("GH_TOKEN".to_string(), github.trim().to_string()),
    ];
    vars.extend(project_env.iter().cloned());
    Ok(vars)
}

/// Variables Powerhouse sets itself; a project value must never shadow them.
pub const RESERVED_ENV: [&str; 2] = ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"];

/// Parses a `.env` file into `(name, value)` pairs, in first-seen order with
/// the last duplicate's value, plus the number of lines that were skipped as
/// invalid. Blank lines and `#` comments are ignored; `export ` is optional;
/// matching quotes are stripped (double quotes unescape `\n`, `\"` and `\\`), and an
/// unquoted value ends at ` #`.
pub fn parse_dotenv(text: &str) -> (Vec<(String, String)>, usize) {
    let mut out: Vec<(String, String)> = vec![];
    let mut invalid = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map(str::trim_start).unwrap_or(line);
        let Some((key, raw)) = line.split_once('=') else {
            invalid += 1;
            continue;
        };
        let key = key.trim();
        if !is_env_var_name(key) {
            invalid += 1;
            continue;
        }
        let Some(value) = dotenv_value(raw.trim()) else {
            invalid += 1;
            continue;
        };
        match out.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => out.push((key.to_string(), value)),
        }
    }
    (out, invalid)
}

/// One value: quoted (up to the matching quote) or bare (up to ` #`).
/// `None` for an unterminated quote.
fn dotenv_value(raw: &str) -> Option<String> {
    let quote = raw.chars().next().filter(|c| *c == '"' || *c == '\'');
    let Some(q) = quote else {
        let bare = raw.find(" #").map(|i| &raw[..i]).unwrap_or(raw);
        return Some(bare.trim_end().to_string());
    };
    let body = &raw[1..];
    if q == '\'' {
        return body.find('\'').map(|end| body[..end].to_string());
    }
    let mut value = String::new();
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(value),
            '\\' => match chars.next() {
                Some('n') => value.push('\n'),
                Some('"') => value.push('"'),
                Some('\\') => value.push('\\'),
                Some(other) => {
                    value.push('\\');
                    value.push(other);
                }
                None => return None,
            },
            c => value.push(c),
        }
    }
    None
}

/// `NAME=value` lines for a repo's `.env`, readable by common dotenv parsers:
/// bare when the value is plain, single-quoted when it has no `'`, else
/// double-quoted with `\` and `"` escaped. A value with a line break is
/// refused rather than written in a form some parser would split.
pub fn render_dotenv(vars: &[(String, String)]) -> Result<String, String> {
    let mut out = String::new();
    for (name, value) in vars {
        if !is_env_var_name(name) {
            return Err(format!("`{name}` is not a valid environment variable name"));
        }
        if value.contains(['\n', '\r']) {
            return Err(format!("{name} has a line break, which a .env file cannot hold safely"));
        }
        let plain = value.chars().all(|c| c.is_ascii_alphanumeric() || "_./:@+,-".contains(c));
        let rendered = if plain {
            value.clone()
        } else if !value.contains('\'') {
            format!("'{value}'")
        } else {
            format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
        };
        out.push_str(&format!("{name}={rendered}\n"));
    }
    Ok(out)
}

/// `export NAME='value'` lines, single-quoted so any value survives `source`.
pub fn render_env_file(vars: &[(String, String)]) -> Result<String, String> {
    let mut out = String::new();
    for (name, value) in vars {
        if !is_env_var_name(name) {
            return Err(format!("`{name}` is not a valid environment variable name"));
        }
        out.push_str(&format!("export {name}='{}'\n", value.replace('\'', "'\\''")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_resolution_prefers_the_most_specific_slot() {
        let m = MemoryStore::default();
        m.set("github_token", "wide").unwrap();
        let remote = "https://github.com/mithril-studio/powerhouse.git";
        assert_eq!(resolve_github(&m, remote).unwrap().unwrap().0, "github_token");
        m.set("github_token:mithril-studio", "owner").unwrap();
        assert_eq!(resolve_github(&m, remote).unwrap().unwrap(), ("github_token:mithril-studio".into(), "owner".into()));
        m.set("github_token:mithril-studio/powerhouse", "repo").unwrap();
        assert_eq!(resolve_github(&m, remote).unwrap().unwrap().1, "repo");
        // A different owner falls back to the wide token.
        assert_eq!(resolve_github(&m, "https://github.com/joost/other.git").unwrap().unwrap().1, "wide");
    }

    #[test]
    fn project_env_slots_resolve_per_repo_and_render_as_env_lines() {
        let m = MemoryStore::default();
        m.set(&project_env_slot("repo-a", "FOO_API_KEY"), "s3cret").unwrap();
        assert!(is_project_env_slot("project_env:repo-a:FOO_API_KEY"));
        assert!(!is_project_env_slot("project_env:repo-a:1BAD"));
        assert!(!is_project_env_slot("project_env::FOO"));
        assert!(!is_project_env_slot("github_token"));
        // Repo A resolves; repo B does not see A's value.
        let names = vec!["FOO_API_KEY".to_string()];
        assert_eq!(project_env_values(&m, "repo-a", &names).unwrap(), vec![("FOO_API_KEY".into(), "s3cret".into())]);
        let err = project_env_values(&m, "repo-b", &names).unwrap_err();
        assert!(err.contains("FOO_API_KEY") && err.contains("no value"), "{err}");
        // A configured name without a value refuses instead of half-configuring the run.
        let err = project_env_values(&m, "repo-a", &["FOO_API_KEY".into(), "BAR".into()]).unwrap_err();
        assert!(err.contains("BAR"), "{err}");
    }

    #[test]
    fn workspace_env_needs_both_tokens_and_prefers_the_keychain_slot() {
        let m = MemoryStore::default();
        let remote = "https://github.com/mithril-studio/powerhouse.git";
        assert!(workspace_env(&m, remote, &[], Some("oauth".into())).unwrap_err().contains("Claude"));
        m.set(CLAUDE_OAUTH, "claude-tok").unwrap();
        assert!(workspace_env(&m, remote, &[], None).unwrap_err().contains("GitHub"));
        let vars = workspace_env(&m, remote, &[("FOO".into(), "bar".into())], Some("oauth".into())).unwrap();
        assert_eq!(vars[1], ("GH_TOKEN".into(), "oauth".into()));
        assert_eq!(vars[2], ("FOO".into(), "bar".into()));
        m.set("github_token:mithril-studio", "scoped").unwrap();
        assert_eq!(workspace_env(&m, remote, &[], Some("oauth".into())).unwrap()[1].1, "scoped");
    }

    #[test]
    fn env_file_quotes_values_for_the_shell() {
        let file = render_env_file(&[("A".into(), "it's $HOME".into()), ("B".into(), "x".into())]).unwrap();
        assert_eq!(file, "export A='it'\\''s $HOME'\nexport B='x'\n");
        assert!(render_env_file(&[("1BAD".into(), "x".into())]).is_err());
    }

    #[test]
    fn dotenv_rendering_quotes_as_needed_and_refuses_line_breaks() {
        let vars = [
            ("PLAIN".to_string(), "abc-1.2/x@y".to_string()),
            ("SPACE".to_string(), "a b $HOME".to_string()),
            ("QUOTE".to_string(), r#"it's "x" \y"#.to_string()),
            ("EMPTY".to_string(), String::new()),
        ];
        let file = render_dotenv(&vars).unwrap();
        assert_eq!(file, "PLAIN=abc-1.2/x@y\nSPACE='a b $HOME'\nQUOTE=\"it's \\\"x\\\" \\\\y\"\nEMPTY=\n");
        // What we write, we read back unchanged.
        let (back, invalid) = parse_dotenv(&file);
        assert_eq!(invalid, 0);
        assert_eq!(back, vars);
        assert!(render_dotenv(&[("A".into(), "x\ny".into())]).unwrap_err().contains("line break"));
        assert!(render_dotenv(&[("1A".into(), "x".into())]).is_err());
    }

    #[test]
    fn dotenv_parsing() {
        let text = r#"
# comment
PLAIN=abc
export EXPORTED=yes
SINGLE='$HOME # not a comment'
DOUBLE="line1\nline2 \"q\" # kept"
BARE=value # trailing comment
EMPTY=
SPACED = padded
1BAD=x
no_equals_sign
OPEN="never closed
PLAIN=overridden
"#;
        let (vars, invalid) = parse_dotenv(text);
        let get = |k: &str| vars.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("PLAIN"), Some("overridden"));
        assert_eq!(vars[0].0, "PLAIN", "a duplicate keeps its first position");
        assert_eq!(get("EXPORTED"), Some("yes"));
        assert_eq!(get("SINGLE"), Some("$HOME # not a comment"));
        assert_eq!(get("DOUBLE"), Some("line1\nline2 \"q\" # kept"));
        assert_eq!(get("BARE"), Some("value"));
        assert_eq!(get("EMPTY"), Some(""));
        assert_eq!(get("SPACED"), Some("padded"));
        assert_eq!(vars.len(), 7);
        assert_eq!(invalid, 3); // 1BAD, no_equals_sign, OPEN
    }

    #[test]
    fn owner_repo_parsing() {
        assert_eq!(owner_repo("https://github.com/a/b.git"), Some(("a".into(), "b".into())));
        assert_eq!(owner_repo("https://github.com/a/b"), Some(("a".into(), "b".into())));
        assert_eq!(owner_repo("git@github.com:a/b.git"), None);
        assert_eq!(github_token_candidates("git://x/y"), vec!["github_token".to_string()]);
    }
}
