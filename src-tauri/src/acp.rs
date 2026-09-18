use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

struct AcpProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
}

#[derive(Default)]
pub struct AcpManager(Mutex<HashMap<String, Arc<AcpProcess>>>);

impl AcpManager {
    pub fn kill_all(&self) {
        let sessions: Vec<_> = self.0.lock().unwrap().drain().map(|(_, p)| p).collect();
        for process in sessions {
            let mut child = process.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn parse_command(command: &str) -> Result<Vec<String>, String> {
    let parts = shell_words::split(command).map_err(|e| format!("invalid ACP command: {e}"))?;
    if parts.is_empty() {
        return Err("ACP command is empty".into());
    }
    Ok(parts)
}

fn emit_reader(app: AppHandle, event: String, reader: impl std::io::Read + Send + 'static) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    let _ = app.emit(&event, String::from_utf8_lossy(&bytes).to_string());
                }
                Err(error) => {
                    let _ = app.emit(&event, format!("ACP stream error: {error}\n"));
                    break;
                }
            }
        }
    });
}

#[tauri::command]
pub fn acp_spawn(
    app: AppHandle,
    state: State<AcpManager>,
    chat_id: String,
    cwd: String,
    command: String,
) -> Result<(), String> {
    if !Path::new(&cwd).is_dir() {
        return Err(format!("ACP working directory does not exist: {cwd}"));
    }
    let parts = parse_command(&command)?;

    {
        let sessions = state.0.lock().unwrap();
        if sessions.contains_key(&chat_id) {
            return Err(format!("ACP chat {chat_id} is already running"));
        }
    }

    // A login shell supplies the PATH a Finder-launched Mac app normally lacks.
    // Arguments are passed through `$@`, not interpolated into the shell script.
    let mut child = Command::new("/bin/zsh")
        .args(["-lc", "exec \"$@\"", "powerhouse-acp"])
        .args(&parts)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start ACP agent: {e}"))?;

    let stdin = child.stdin.take().ok_or("ACP agent stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("ACP agent stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("ACP agent stderr unavailable")?;
    let process = Arc::new(AcpProcess {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
    });
    state
        .0
        .lock()
        .unwrap()
        .insert(chat_id.clone(), process.clone());

    emit_reader(app.clone(), format!("acp-out-{chat_id}"), stdout);
    emit_reader(app.clone(), format!("acp-stderr-{chat_id}"), stderr);

    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        let exit_code = process
            .child
            .lock()
            .unwrap()
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.code());
        if let Some(code) = exit_code {
            let _ = app.emit(&format!("acp-exit-{chat_id}"), code);
            break;
        }
    });

    Ok(())
}

#[tauri::command]
pub fn acp_write(state: State<AcpManager>, chat_id: String, data: String) -> Result<(), String> {
    let process = state
        .0
        .lock()
        .unwrap()
        .get(&chat_id)
        .cloned()
        .ok_or_else(|| format!("no ACP process for chat {chat_id}"))?;
    let mut stdin = process.stdin.lock().unwrap();
    stdin
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn acp_kill(state: State<AcpManager>, chat_id: String) -> Result<(), String> {
    if let Some(process) = state.0.lock().unwrap().remove(&chat_id) {
        let mut child = process.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn acp_kill_all(state: State<AcpManager>) -> Result<(), String> {
    state.kill_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_command;

    #[test]
    fn parses_quoted_acp_commands_without_using_a_shell() {
        let parts = parse_command("agent --label 'Powerhouse chat'").unwrap();

        assert_eq!(parts, vec!["agent", "--label", "Powerhouse chat"]);
    }

    #[test]
    fn rejects_an_empty_acp_command() {
        assert_eq!(parse_command("   ").unwrap_err(), "ACP command is empty");
    }
}
