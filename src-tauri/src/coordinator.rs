//! Bridge to the always-on workflow coordinator (`server/`).
//!
//! The webview never sees the bearer token: it lives in the macOS Keychain
//! and is attached here, Rust-side, to a narrow HTTP proxy that only reaches
//! the configured coordinator's `/v1` API and `/health`.

use std::path::Path;
use std::time::Duration;

use crate::cloud::secrets::{Keychain, SecretStore};
use crate::git::git;

/// Keychain account under the shared "Powerhouse" service.
const TOKEN_SLOT: &str = "coordinator_token";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The coordinator URL must be https, or plain http only for loopback —
/// a bearer token must never travel unencrypted across a network.
fn parse_base_url(base_url: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(base_url.trim()).map_err(|e| format!("invalid coordinator URL: {e}"))?;
    match url.scheme() {
        "https" => {}
        "http" => {
            let host = url.host_str().unwrap_or("");
            if !(host == "127.0.0.1" || host == "localhost" || host == "[::1]") {
                return Err("http:// is only allowed for localhost; use https:// for remote coordinators".into());
            }
        }
        s => return Err(format!("unsupported URL scheme `{s}`")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("coordinator URL must not embed credentials".into());
    }
    Ok(url)
}

fn allowed_path(path: &str) -> bool {
    path == "/health" || (path.starts_with("/v1/") && !path.contains("..") && !path.contains('?'))
}

/// Remove userinfo from a remote URL so credentials never reach the server.
fn strip_credentials(remote: &str) -> String {
    match reqwest::Url::parse(remote) {
        Ok(mut url) if !url.username().is_empty() || url.password().is_some() => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.to_string()
        }
        _ => remote.to_string(),
    }
}

#[derive(serde::Serialize)]
pub struct CoordinatorResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

#[derive(serde::Serialize)]
pub struct RepoHead {
    pub remote_url: String,
    pub commit_sha: String,
    pub default_branch: String,
}

/// Whether a coordinator token is stored in the Keychain.
#[tauri::command]
pub fn coordinator_token_status() -> Result<bool, String> {
    Ok(Keychain.get(TOKEN_SLOT)?.map(|v| !v.trim().is_empty()).unwrap_or(false))
}

/// Store (or, with an empty string, clear) the coordinator bearer token.
#[tauri::command]
pub fn coordinator_set_token(token: String) -> Result<(), String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        Keychain.clear(TOKEN_SLOT)
    } else {
        Keychain.set(TOKEN_SLOT, trimmed)
    }
}

/// Authenticated proxy to the coordinator. Only `/health` and `/v1/...`
/// paths are reachable; the token is attached here and never returned.
#[tauri::command]
pub async fn coordinator_request(
    base_url: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<CoordinatorResponse, String> {
    let base = parse_base_url(&base_url)?;
    if !allowed_path(&path) {
        return Err(format!("path `{path}` is not part of the coordinator API"));
    }
    let url = base.join(path.trim_start_matches('/')).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = match method.as_str() {
        "GET" => client.get(url),
        "POST" => client.post(url),
        m => return Err(format!("unsupported method `{m}`")),
    };
    if path != "/health" {
        let token = Keychain
            .get(TOKEN_SLOT)?
            .filter(|v| !v.trim().is_empty())
            .ok_or("no coordinator token is stored. Paste the API token in the Workflows page.")?;
        req = req.bearer_auth(token.trim());
    }
    if let Some(json) = body {
        req = req.json(&json);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("coordinator unreachable: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null);
    Ok(CoordinatorResponse { status, body })
}

/// The repo's origin URL (credentials stripped) and the commit the remote's
/// default branch currently points at — what a run gets pinned to.
#[tauri::command]
pub fn coordinator_repo_head(repo_path: String) -> Result<RepoHead, String> {
    let path = Path::new(&repo_path);
    let remote_url = strip_credentials(git(path, &["remote", "get-url", "origin"])?.trim());
    let default_branch = git(path, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .map(|s| s.trim().trim_start_matches("origin/").to_string())
        .unwrap_or_else(|_| "main".to_string());
    let refspec = format!("refs/heads/{default_branch}");
    let out = git(path, &["ls-remote", "origin", &refspec])?;
    let commit_sha = out
        .split_whitespace()
        .next()
        .filter(|s| s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| format!("origin has no branch `{default_branch}` — push it before running a workflow"))?
        .to_lowercase();
    Ok(RepoHead { remote_url, commit_sha, default_branch })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_requires_https_except_loopback() {
        assert!(parse_base_url("https://coordinator.example.com").is_ok());
        assert!(parse_base_url("http://127.0.0.1:8787").is_ok());
        assert!(parse_base_url("http://localhost:8787").is_ok());
        assert!(parse_base_url("http://coordinator.example.com").is_err());
        assert!(parse_base_url("https://user:pw@example.com").is_err());
        assert!(parse_base_url("ftp://example.com").is_err());
        assert!(parse_base_url("not a url").is_err());
    }

    #[test]
    fn only_api_paths_are_reachable() {
        assert!(allowed_path("/health"));
        assert!(allowed_path("/v1/runs"));
        assert!(allowed_path("/v1/workflows/abc/runs"));
        assert!(!allowed_path("/v1/../admin"));
        assert!(!allowed_path("/v1/runs?x=1"));
        assert!(!allowed_path("/admin"));
        assert!(!allowed_path("health"));
    }

    #[test]
    fn credentials_are_stripped_from_remotes() {
        assert_eq!(
            strip_credentials("https://x-access-token:tok@github.com/a/b.git"),
            "https://github.com/a/b.git"
        );
        let clean = "https://github.com/a/b.git";
        assert_eq!(strip_credentials(clean), clean);
        let ssh = "git@github.com:a/b.git";
        assert_eq!(strip_credentials(ssh), ssh);
    }
}
