use crate::telemetry::{Direction, RunSpec, Tap, Telemetry};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// Grace given to an agent's process group to exit on SIGTERM before SIGKILL.
const STOP_GRACE: Duration = Duration::from_millis(500);

struct AcpProcess {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    end_reason: Mutex<&'static str>,
    /// Signals the stdout/stderr readers to stop even if their pipe never sees
    /// EOF (e.g. a descendant that escaped the process group holds it open).
    stop: Arc<AtomicBool>,
}

/// Tears an agent down: releases its readers, then reaps its whole process
/// group. Killing only the tracked pid would orphan the `npx`/`node`/agent
/// grandchildren, which keep the stdout/stderr pipes open and wedge the reader
/// threads (and any `join()` on them) forever.
///
/// Deliberately does *not* join the monitor thread: callers on the app-exit
/// path run on the main thread, and the monitor may still be draining pipes.
/// The monitor reaps the leader zombie via `try_wait`, and `Telemetry::end_all`
/// closes the runs.
fn terminate(process: &AcpProcess) {
    process.stop.store(true, Ordering::Relaxed);
    let child = process.child.lock().unwrap();
    crate::workflow::stop_now(&child, STOP_GRACE);
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
            terminate(&process);
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

/// Appends `chunk` to `carry` and returns each completed line (newline
/// included). Any trailing partial line stays in `carry` for the next chunk.
fn drain_lines(carry: &mut Vec<u8>, chunk: &[u8]) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    for &b in chunk {
        carry.push(b);
        if b == b'\n' {
            lines.push(std::mem::take(carry));
        }
    }
    lines
}

fn emit_line(app: &AppHandle, event: &str, tap: &Tap, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes).to_string();
    // Telemetry capture never blocks: overflow is counted, not waited out.
    tap.record_line(&line);
    let _ = app.emit(event, line);
}

/// Returns a reader's raw fd on Unix (so it can be made non-blocking); -1
/// elsewhere, which disables the non-blocking escape hatch.
#[cfg(unix)]
fn fd_of<T: std::os::unix::io::AsRawFd>(reader: &T) -> i32 {
    reader.as_raw_fd()
}
#[cfg(not(unix))]
fn fd_of<T>(_reader: &T) -> i32 {
    -1
}

/// Puts a pipe into non-blocking mode so a blocked `read` returns `WouldBlock`
/// instead of wedging when the writer end is held open by an escaped grandchild.
#[cfg(unix)]
fn set_nonblocking(fd: i32) {
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags >= 0 {
            let _ = libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
    }
}

fn emit_reader(
    app: AppHandle,
    event: String,
    mut reader: impl Read + Send + 'static,
    raw_fd: i32,
    tap: Tap,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        #[cfg(unix)]
        set_nonblocking(raw_fd);
        let mut chunk = [0u8; 8192];
        let mut line = Vec::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break, // EOF: every writer closed the pipe.
                Ok(n) => {
                    for complete in drain_lines(&mut line, &chunk[..n]) {
                        emit_line(&app, &event, &tap, &complete);
                    }
                }
                Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => {
                    if !line.is_empty() {
                        emit_line(&app, &event, &tap, &line);
                        line.clear();
                    }
                    emit_line(&app, &event, &tap, format!("ACP stream error: {error}\n").as_bytes());
                    break;
                }
            }
        }
        // A trailing partial line (EOF or stop mid-line) is still evidence.
        if !line.is_empty() {
            emit_line(&app, &event, &tap, &line);
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
    let mut spawn_cmd = Command::new("/bin/zsh");
    spawn_cmd
        .args(["-lc", "exec \"$@\"", "powerhouse-acp"])
        .args(&parts)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Own process group so the whole `npx`->`node`->agent tree can be reaped
    // together, rather than orphaning grandchildren that hold the pipes open.
    crate::workflow::isolate(&mut spawn_cmd);
    let mut child = spawn_cmd
        .spawn()
        .map_err(|e| format!("failed to start ACP agent: {e}"))?;

    let stdin = child.stdin.take().ok_or("ACP agent stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("ACP agent stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("ACP agent stderr unavailable")?;
    let stdout_fd = fd_of(&stdout);
    let stderr_fd = fd_of(&stderr);
    let stop = Arc::new(AtomicBool::new(false));
    let process = Arc::new(AcpProcess {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        end_reason: Mutex::new("exit"),
        stop: stop.clone(),
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
        stdout_fd,
        telemetry.tap(&run_id, Direction::In),
        stop.clone(),
    );
    let stderr_reader = emit_reader(
        app.clone(),
        format!("acp-stderr-{chat_id}"),
        stderr,
        stderr_fd,
        telemetry.tap(&run_id, Direction::Err),
        stop.clone(),
    );

    // Detached: it finalises telemetry and cleans up the map on exit. We never
    // join it — `terminate` sets `stop` and reaps the group so its readers
    // always drain, and the exit path must not block the main thread on it.
    let monitor_process = process.clone();
    std::thread::spawn(move || loop {
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
            // The tracked child is gone; release the readers in case a lingering
            // grandchild still holds a pipe open, so these joins can't wedge.
            monitor_process.stop.store(true, Ordering::Relaxed);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let requested = *monitor_process.end_reason.lock().unwrap();
            app.state::<Telemetry>().run_end(&run_id, code, final_reason(requested, code));
            app.state::<AcpManager>().0.lock().unwrap().remove(&chat_id);
            let _ = app.emit(&format!("acp-exit-{chat_id}"), code);
            break;
        }
    });

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
        terminate(&process);
        // The monitor thread finalises telemetry and emits `acp-exit` once its
        // readers drain; it self-terminates now that the group is reaped, so
        // there is no need to block the caller joining it.
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
    use super::{drain_lines, final_reason, parse_command, write_and_record};
    use std::cell::Cell;
    use std::io::{self, Write};

    #[test]
    fn splits_lines_across_chunk_boundaries_and_keeps_the_partial() {
        let mut carry = Vec::new();

        // A line split across two reads emerges only once its newline arrives.
        assert!(drain_lines(&mut carry, b"{\"a\":1}").is_empty());
        let lines = drain_lines(&mut carry, b"\n{\"b\":");
        assert_eq!(lines, vec![b"{\"a\":1}\n".to_vec()]);

        // The still-open line is retained, not emitted.
        assert_eq!(carry, b"{\"b\":");

        // Multiple lines in one chunk all come out; a trailing partial stays.
        let lines = drain_lines(&mut carry, b"2}\nnext\ntail");
        assert_eq!(lines, vec![b"{\"b\":2}\n".to_vec(), b"next\n".to_vec()]);
        assert_eq!(carry, b"tail");
    }

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
