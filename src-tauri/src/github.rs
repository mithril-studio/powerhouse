//! Real GitHub authentication via OAuth **Device Flow**.
//!
//! Device Flow is the only secretless path for a distributed desktop app:
//! GitHub's auth-code flow needs a `client_secret` (no PKCE support) and this
//! app has no backend to proxy the exchange. Device Flow needs only the public
//! Client ID — safe to embed. It is exactly what the `gh` CLI uses.
//!
//! All HTTP + token handling lives here in Rust (not the webview): it avoids
//! CORS against github.com and keeps the access token out of JS memory. The
//! token is stored at rest in the OS keychain (`keyring`) and **never** written
//! to `powerhouse.json`; only the non-sensitive profile (`login`, `avatar_url`)
//! is returned for display.

use serde::{Deserialize, Serialize};

/// Public OAuth App Client ID (Device Flow enabled). Safe to embed — there is
/// no client secret in this design.
const CLIENT_ID: &str = "Ov23liCBnelLBQxxb1Er";

/// Minimal scopes for this app's git/PR ambitions. Add `workflow` only if
/// GitHub Actions files are ever touched.
const SCOPE: &str = "repo read:user";

/// GitHub rejects API requests without a `User-Agent`.
const USER_AGENT: &str = "Powerhouse";

/// Keychain coordinates for the token at rest.
const KEYRING_SERVICE: &str = "com.powerhouse.github";
const KEYRING_ACCOUNT: &str = "oauth-token";

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";

// --- wire types -------------------------------------------------------------

/// Returned to the frontend so it can show the code and open the browser.
#[derive(Serialize)]
pub struct DeviceStart {
    user_code: String,
    verification_uri: String,
    device_code: String,
    interval: u64,
    expires_in: u64,
}

#[derive(Deserialize)]
struct DeviceCodeResp {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: Option<String>,
    error: Option<String>,
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct UserResp {
    login: String,
    avatar_url: String,
}

/// The non-sensitive display profile. Never carries the token.
#[derive(Serialize)]
pub struct Account {
    login: String,
    avatar_url: String,
}

/// Result of a single poll tick. The frontend drives the loop (so it can cancel
/// simply by stopping) while the token stays in Rust.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PollResult {
    /// Still waiting for the user to authorize.
    Pending,
    /// GitHub asked us to back off; poll again no sooner than `interval` secs.
    SlowDown { interval: u64 },
    /// Authorized — token is now in the keychain; here is the display profile.
    Connected { login: String, avatar_url: String },
}

// --- keychain helpers -------------------------------------------------------

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())
}

fn store_token(token: &str) -> Result<(), String> {
    entry()?.set_password(token).map_err(|e| e.to_string())
}

fn read_token() -> Option<String> {
    entry().ok()?.get_password().ok()
}

fn delete_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// --- HTTP -------------------------------------------------------------------

/// Fetches the display profile for a token. Errors on any non-2xx (e.g. the
/// token was revoked), which callers use to treat the token as invalid.
async fn fetch_account(token: &str) -> Result<Account, String> {
    let resp = reqwest::Client::new()
        .get(USER_URL)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub /user returned {}", resp.status()));
    }
    let user: UserResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(Account {
        login: user.login,
        avatar_url: user.avatar_url,
    })
}

// --- commands ---------------------------------------------------------------

/// Starts the device flow: requests a user code + verification URL.
#[tauri::command]
pub async fn github_device_start() -> Result<DeviceStart, String> {
    let resp = reqwest::Client::new()
        .post(DEVICE_CODE_URL)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", SCOPE)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("device/code returned {}", resp.status()));
    }
    let data: DeviceCodeResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(DeviceStart {
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        device_code: data.device_code,
        interval: data.interval,
        expires_in: data.expires_in,
    })
}

/// One poll tick against the token endpoint. On success, writes the token to
/// the keychain and returns the display profile; otherwise reports whether to
/// keep waiting, back off, or that the flow failed (expired / denied).
#[tauri::command]
pub async fn github_poll(device_code: String) -> Result<PollResult, String> {
    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let data: TokenResp = resp.json().await.map_err(|e| e.to_string())?;

    if let Some(token) = data.access_token {
        store_token(&token)?;
        let account = fetch_account(&token).await?;
        return Ok(PollResult::Connected {
            login: account.login,
            avatar_url: account.avatar_url,
        });
    }

    match data.error.as_deref() {
        Some("authorization_pending") => Ok(PollResult::Pending),
        Some("slow_down") => Ok(PollResult::SlowDown {
            interval: data.interval.unwrap_or(10),
        }),
        Some("expired_token") => Err("The device code expired. Please try again.".into()),
        Some("access_denied") => Err("Authorization was denied.".into()),
        Some(other) => Err(other.to_string()),
        None => Err("Unexpected response from GitHub.".into()),
    }
}

/// Reads the stored token and validates it against `/user`. Returns the profile
/// if valid, `None` if there is no token or it no longer works (also clearing a
/// dead token so the UI settles on disconnected).
#[tauri::command]
pub async fn github_account() -> Result<Option<Account>, String> {
    let token = match read_token() {
        Some(t) => t,
        None => return Ok(None),
    };
    match fetch_account(&token).await {
        Ok(account) => Ok(Some(account)),
        Err(_) => {
            let _ = delete_token();
            Ok(None)
        }
    }
}

/// Deletes the local keychain token. Note: this is local-only — server-side
/// revocation needs the client secret (Basic auth) this design lacks; the UI
/// surfaces a link to github.com/settings/applications for full revocation.
#[tauri::command]
pub fn github_disconnect() -> Result<(), String> {
    delete_token()
}
