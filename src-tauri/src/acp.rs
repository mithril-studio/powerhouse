use crate::telemetry::{Direction, RunSpec, Tap, Telemetry};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

struct AcpProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    end_reason: Mutex<&'static str>,
    monitor: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
pub struct AcpManager(Mutex<HashMap<String, Arc<AcpProcess>>>);

impl AcpManager {
    pub fn kill_all(&self) {
        self.kill_all_with_reason("killed");
    }

    pub fn kill_all_with_reason(&self, reason: &'static str) {
        let sessions: Vec<_> = self.0.lock().unwrap().drain().map(|(_, p)| p).collect();
        for process in sessions {
            *process.end_reason.lock().unwrap() = reason;
            let mut child = process.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
            drop(child);
            if let Some(monitor) = process.monitor.lock().unwrap().take() {
                let _ = monitor.join();
            }
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

fn emit_reader(
    app: AppHandle,
    event: String,
    reader: impl std::io::Read + Send + 'static,
    tap: Tap,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    // Telemetry capture never blocks: overflow is counted,
                    // not waited out.
                    tap.record_line(&line);
                    let _ = app.emit(&event, line);
                }
                Err(error) => {
                    let line = format!("ACP stream error: {error}\n");
                    tap.record_line(&line);
                    let _ = app.emit(&event, line);
                    break;
                }
            }
        }
    })
}

fn final_reason(requested: &'static str, exit_code: Option<i32>) -> &'static str {
    if requested == "exit" && exit_code.is_none() {
        "killed"
    } else {
        requested
    }
}

fn write_and_record(
    writer: &mut impl Write,
    data: &str,
    record: impl FnOnce(),
) -> Result<(), String> {
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    record();
    Ok(())
}

#[tauri::command]
pub fn acp_spawn(
    app: AppHandle,
    state: State<AcpManager>,
    telemetry: State<Telemetry>,
    chat_id: String,
    cwd: String,
    command: String,
    env: Option<HashMap<String, String>>,
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
        .envs(env.unwrap_or_default())
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
        end_reason: Mutex::new("exit"),
        monitor: Mutex::new(None),
    });
    state
        .0
        .lock()
        .unwrap()
        .insert(chat_id.clone(), process.clone());

    let run_id = telemetry.run_start(RunSpec {
        source: "acp",
        coverage: "instrumented",
        chat_id: Some(chat_id.clone()),
        agent_command: Some(command),
        source_sha: crate::telemetry::head_sha(&cwd),
        cwd: Some(cwd),
        repo_id: None, // supplied by the renderer's annotate call
        repo_label: None,
        branch_label: None,
    });

    let stdout_reader = emit_reader(
        app.clone(),
        format!("acp-out-{chat_id}"),
        stdout,
        telemetry.tap(&run_id, Direction::In),
    );
    let stderr_reader = emit_reader(
        app.clone(),
        format!("acp-stderr-{chat_id}"),
        stderr,
        telemetry.tap(&run_id, Direction::Err),
    );

    let monitor_process = process.clone();
    let monitor = std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        let status = monitor_process
            .child
            .lock()
            .unwrap()
            .try_wait()
            .ok()
            .flatten();
        if let Some(status) = status {
            let code = status.code();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let requested = *monitor_process.end_reason.lock().unwrap();
            app.state::<Telemetry>().run_end(&run_id, code, final_reason(requested, code));
            app.state::<AcpManager>().0.lock().unwrap().remove(&chat_id);
            let _ = app.emit(&format!("acp-exit-{chat_id}"), code);
            break;
        }
    });
    *process.monitor.lock().unwrap() = Some(monitor);

    Ok(())
}

#[tauri::command]
pub fn acp_write(
    state: State<AcpManager>,
    telemetry: State<Telemetry>,
    chat_id: String,
    data: String,
) -> Result<(), String> {
    let process = state
        .0
        .lock()
        .unwrap()
        .get(&chat_id)
        .cloned()
        .ok_or_else(|| format!("no ACP process for chat {chat_id}"))?;
    let mut stdin = process.stdin.lock().unwrap();
    write_and_record(&mut *stdin, &data, || telemetry.record_out_chunk(&chat_id, &data))
}

#[tauri::command]
pub fn acp_kill(
    state: State<AcpManager>,
    chat_id: String,
) -> Result<(), String> {
    if let Some(process) = state.0.lock().unwrap().remove(&chat_id) {
        *process.end_reason.lock().unwrap() = "killed";
        let mut child = process.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        drop(child);
        if let Some(monitor) = process.monitor.lock().unwrap().take() {
            let _ = monitor.join();
        }
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
    use super::{final_reason, parse_command, write_and_record};
    use std::cell::Cell;
    use std::io::{self, Write};

    #[test]
    fn parses_quoted_acp_commands_without_using_a_shell() {
        let parts = parse_command("agent --label 'Powerhouse chat'").unwrap();

        assert_eq!(parts, vec!["agent", "--label", "Powerhouse chat"]);
    }

    #[test]
    fn rejects_an_empty_acp_command() {
        assert_eq!(parse_command("   ").unwrap_err(), "ACP command is empty");
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn failed_writes_are_not_recorded_as_sent() {
        let recorded = Cell::new(false);
        let error = write_and_record(&mut FailingWriter, "prompt\n", || recorded.set(true));

        assert!(error.is_err());
        assert!(!recorded.get());
    }

    #[test]
    fn successful_writes_are_recorded_after_delivery() {
        let recorded = Cell::new(false);
        let mut writer = Vec::new();

        write_and_record(&mut writer, "prompt\n", || recorded.set(true)).unwrap();

        assert_eq!(writer, b"prompt\n");
        assert!(recorded.get());
    }

    #[test]
    fn signal_exit_is_not_reported_as_success() {
        assert_eq!(final_reason("exit", None), "killed");
        assert_eq!(final_reason("exit", Some(0)), "exit");
        assert_eq!(final_reason("app-shutdown", None), "app-shutdown");
    }
}
