//! Shared agent memory.
//!
//! Every coding agent Powerhouse launches (Claude Code, Pi) gets the same
//! memory: a Basic Memory server reached over streamable-HTTP MCP. The agents
//! receive it as an MCP server on `session/new`; Powerhouse itself is an MCP
//! client here, for the session brief and for the Memory page. When the
//! configured URL is a loopback address, Powerhouse also supervises the
//! server process so "memory just works" on a laptop; on a VM the same URL
//! points at the always-on memory host and nothing is spawned.
//!
//! Only the small subset of MCP needed here is implemented: initialize,
//! initialized, tools/call, over a single HTTP session that is re-created
//! when the server forgets it.

use reqwest::Client;
use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

const PROTOCOL_VERSION: &str = "2025-06-18";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct MemoryState {
    /// Locally supervised `basic-memory mcp` process, when any.
    child: Mutex<Option<Child>>,
    /// The MCP session Powerhouse holds with the server: (url, session id).
    session: Mutex<Option<(String, String)>>,
}

impl MemoryState {
    pub fn kill_server(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn child_running(&self) -> bool {
        let mut guard = self.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                _ => {
                    *guard = None;
                    false
                }
            },
            None => false,
        }
    }
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// One JSON-RPC exchange. Returns the response body (if any) and the
/// `Mcp-Session-Id` the server assigned. Streamable HTTP answers either with
/// plain JSON or with an SSE stream whose `data:` lines carry JSON messages.
async fn rpc(
    client: &Client,
    url: &str,
    token: &str,
    session_id: Option<&str>,
    body: Value,
) -> Result<(Option<Value>, Option<String>), String> {
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&body);
    if !token.is_empty() {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    if let Some(id) = session_id {
        request = request.header("Mcp-Session-Id", id);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let assigned = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("memory server returned {status}: {}", text.trim()));
    }
    let want_id = body.get("id").cloned();
    let message = if content_type.starts_with("text/event-stream") {
        parse_sse(&text, want_id.as_ref())
    } else if text.trim().is_empty() {
        None
    } else {
        serde_json::from_str(&text).ok()
    };
    Ok((message, assigned))
}

/// Pick the JSON-RPC message answering `want_id` from an SSE body (or the
/// last message when no id is requested).
fn parse_sse(text: &str, want_id: Option<&Value>) -> Option<Value> {
    let mut last = None;
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        if want_id.is_some() && value.get("id") == want_id {
            return Some(value);
        }
        last = Some(value);
    }
    last
}

async fn open_session(client: &Client, url: &str, token: &str) -> Result<String, String> {
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "Powerhouse", "version": env!("CARGO_PKG_VERSION") }
        }
    });
    let (message, assigned) = rpc(client, url, token, None, init).await?;
    if let Some(error) = message.as_ref().and_then(|m| m.get("error")) {
        return Err(format!("memory initialize failed: {error}"));
    }
    let session_id = assigned.ok_or("memory server did not assign an MCP session id")?;
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    rpc(client, url, token, Some(&session_id), initialized).await?;
    Ok(session_id)
}

/// The tool result, unwrapped: `structuredContent.result` when the server
/// provides it, else the first text content block.
fn unwrap_tool_result(message: Value) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        return Err(format!("memory tool error: {error}"));
    }
    let result = message.get("result").cloned().unwrap_or(Value::Null);
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| blocks.iter().find_map(|b| b.get("text").and_then(Value::as_str)))
        .unwrap_or("")
        .to_owned();
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(if text.is_empty() { "memory tool failed".into() } else { text });
    }
    if let Some(structured) = result.get("structuredContent") {
        if let Some(inner) = structured.get("result") {
            return Ok(inner.clone());
        }
        return Ok(structured.clone());
    }
    Ok(Value::String(text))
}

/// Call one memory tool. Reuses the held MCP session and transparently
/// re-initializes once when the server no longer knows it.
#[tauri::command]
pub async fn memory_call(
    state: State<'_, MemoryState>,
    url: String,
    token: String,
    tool: String,
    args: Value,
) -> Result<Value, String> {
    let client = client()?;
    let held = {
        let guard = state.session.lock().unwrap();
        guard
            .as_ref()
            .filter(|(held_url, _)| *held_url == url)
            .map(|(_, id)| id.clone())
    };
    let session_id = match held {
        Some(id) => id,
        None => {
            let id = open_session(&client, &url, &token).await?;
            *state.session.lock().unwrap() = Some((url.clone(), id.clone()));
            id
        }
    };
    let call = json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": tool, "arguments": args }
    });
    let outcome = rpc(&client, &url, &token, Some(&session_id), call.clone()).await;
    let message = match outcome {
        Ok((message, _)) => message,
        Err(error) if error.contains("404") || error.contains("session") => {
            // The server restarted or expired the session: open a fresh one.
            let id = open_session(&client, &url, &token).await?;
            *state.session.lock().unwrap() = Some((url.clone(), id.clone()));
            rpc(&client, &url, &token, Some(&id), call).await?.0
        }
        Err(error) => return Err(error),
    };
    unwrap_tool_result(message.ok_or("memory server returned no response")?)
}

#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ServerStatus {
    /// Reachable and answering MCP; not a process Powerhouse owns.
    External,
    /// Reachable and supervised by this Powerhouse process.
    Supervised,
    /// Not reachable and not something Powerhouse can start (remote URL).
    Unreachable,
    /// Loopback URL, not reachable, and Powerhouse failed to start it.
    Failed,
}

async fn reachable(url: &str, token: &str) -> bool {
    let Ok(client) = Client::builder().timeout(Duration::from_secs(3)).build() else {
        return false;
    };
    open_session(&client, url, token).await.is_ok()
}

/// (host, port, path) of a loopback memory URL, or None when remote.
pub fn loopback_target(url: &str) -> Option<(String, u16, String)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_owned();
    if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
        return None;
    }
    let port = parsed.port_or_known_default()?;
    let path = match parsed.path() {
        "" | "/" => "/mcp".to_owned(),
        p => p.to_owned(),
    };
    Some((host, port, path))
}

/// PATH for the server process: the user's, with uv's tool directory in
/// front. A non-interactive login shell does not read `.zshrc`, so the
/// `uv tool update-shell` line never applies here; the explicit prefix does.
fn server_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    match dirs::home_dir() {
        Some(home) => format!("{}/.local/bin:{current}", home.display()),
        None => current,
    }
}

fn spawn_server(port: u16, path: &str) -> Result<Child, String> {
    // A login shell supplies the PATH a Finder-launched app lacks. Arguments
    // are passed through `$@`, never interpolated into the script.
    Command::new("/bin/zsh")
        .args(["-lc", "exec \"$@\"", "powerhouse-memory"])
        .env("PATH", server_path())
        .args([
            "basic-memory",
            "mcp",
            "--transport",
            "streamable-http",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--path",
            path,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to start basic-memory: {e}"))
}

/// Make sure a memory server answers at `url`, starting one when the URL is
/// loopback. Idempotent and cheap when the server is already up.
#[tauri::command]
pub async fn memory_server_ensure(
    state: State<'_, MemoryState>,
    url: String,
    token: String,
) -> Result<ServerStatus, String> {
    let supervised = state.child_running();
    if reachable(&url, &token).await {
        return Ok(if supervised { ServerStatus::Supervised } else { ServerStatus::External });
    }
    let Some((_, port, path)) = loopback_target(&url) else {
        return Ok(ServerStatus::Unreachable);
    };
    if !supervised {
        let child = spawn_server(port, &path)?;
        *state.child.lock().unwrap() = Some(child);
    }
    let started = Instant::now();
    while started.elapsed() < STARTUP_TIMEOUT {
        tokio_sleep(Duration::from_millis(500)).await;
        if reachable(&url, &token).await {
            return Ok(ServerStatus::Supervised);
        }
        if !state.child_running() {
            return Err(
                "basic-memory exited during startup. Install it with `uv tool install basic-memory` and check `basic-memory mcp --transport streamable-http --host 127.0.0.1 --port <port>` by hand."
                    .into(),
            );
        }
    }
    Ok(ServerStatus::Failed)
}

async fn tokio_sleep(duration: Duration) {
    // reqwest pulls in tokio; tauri's async runtime is tokio as well.
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_picks_the_message_with_the_requested_id() {
        let body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"a\":1}}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"b\":2}}\n";
        let picked = parse_sse(body, Some(&json!(2))).unwrap();
        assert_eq!(picked["result"]["b"], 2);
    }

    #[test]
    fn sse_falls_back_to_the_last_message_without_an_id() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"method\":\"x\"}\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"y\"}\n";
        let picked = parse_sse(body, None).unwrap();
        assert_eq!(picked["method"], "y");
    }

    #[test]
    fn tool_result_prefers_structured_content() {
        let message = json!({
            "jsonrpc": "2.0", "id": 2,
            "result": {
                "content": [{ "type": "text", "text": "# text form" }],
                "structuredContent": { "result": { "results": [] } },
                "isError": false
            }
        });
        assert_eq!(unwrap_tool_result(message).unwrap(), json!({ "results": [] }));
    }

    #[test]
    fn tool_result_falls_back_to_text_and_surfaces_errors() {
        let ok = json!({ "result": { "content": [{ "type": "text", "text": "plain" }] } });
        assert_eq!(unwrap_tool_result(ok).unwrap(), json!("plain"));
        let failed = json!({ "result": { "isError": true, "content": [{ "type": "text", "text": "boom" }] } });
        assert_eq!(unwrap_tool_result(failed).unwrap_err(), "boom");
        let rpc_error = json!({ "error": { "code": -32601, "message": "no such tool" } });
        assert!(unwrap_tool_result(rpc_error).unwrap_err().contains("no such tool"));
    }

    #[test]
    fn loopback_urls_are_recognised_with_port_and_path() {
        assert_eq!(
            loopback_target("http://127.0.0.1:8765/mcp"),
            Some(("127.0.0.1".into(), 8765, "/mcp".into()))
        );
        assert_eq!(
            loopback_target("http://localhost:9000"),
            Some(("localhost".into(), 9000, "/mcp".into()))
        );
        assert_eq!(loopback_target("https://memory.example.boxd.sh/mcp"), None);
        assert_eq!(loopback_target("not a url"), None);
    }
}
