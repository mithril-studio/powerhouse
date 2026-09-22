use crate::telemetry::{RunSpec, Telemetry};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// Raw PTY output is recorded here so a chat can show its prior conversation
/// after a restart. Keyed by chat/session id.
fn transcript_path(id: &str) -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".powerhouse")
            .join("transcripts")
            .join(format!("{id}.log")),
    )
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Cap how many trailing bytes we replay: xterm scrollback is 10k lines, so
/// replaying more than this is wasted work.
const TRANSCRIPT_TAIL_CAP: usize = 1024 * 1024;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager(pub Mutex<HashMap<String, PtySession>>);

impl PtyManager {
    pub fn kill_all(&self) {
        let mut map = self.0.lock().unwrap();
        for (_, mut session) in map.drain() {
            let _ = session.child.kill();
            // Dropping the master closes the pty and SIGHUPs the foreground
            // process group, taking down agent grandchildren too.
        }
    }
}

fn kill_session(session: &mut PtySession) {
    let _ = session.child.kill();
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyManager>,
    telemetry: State<Telemetry>,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    agent_cmd: Option<String>,
    reset_transcript: bool,
) -> Result<(), String> {
    {
        let map = state.0.lock().unwrap();
        if map.contains_key(&session_id) {
            return Err(format!("session {session_id} already exists"));
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.args(["-il"]);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    state.0.lock().unwrap().insert(
        session_id.clone(),
        PtySession {
            master: pair.master,
            writer,
            child,
        },
    );

    // PTY sessions are opaque display bytes: telemetry records the run's
    // existence as 'uninstrumented' so it shows as unmeasured, never as zero
    // usage. Raw bytes already land in the transcript file.
    telemetry.run_start(RunSpec {
        source: "pty",
        coverage: "uninstrumented",
        chat_id: Some(session_id.clone()),
        agent_command: agent_cmd.clone(),
        source_sha: crate::telemetry::head_sha(&cwd),
        cwd: Some(cwd.clone()),
        repo_id: None,
        repo_label: None,
        branch_label: None,
    });

    // Signals the agent launcher once the shell has produced its first output.
    let (first_out_tx, first_out_rx) = mpsc::channel::<()>();

    // Record raw output to disk so the chat can be replayed after a restart.
    // Resume/fresh sessions truncate so the agent's redraw isn't stacked on
    // stale bytes; otherwise we append across spawns.
    let transcript = transcript_path(&session_id).and_then(|path| {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let mut opts = OpenOptions::new();
        opts.create(true).write(true);
        if reset_transcript {
            opts.truncate(true);
        } else {
            opts.append(true);
        }
        opts.open(&path).ok()
    });

    {
        let app = app.clone();
        let id = session_id.clone();
        let mut transcript = transcript;
        std::thread::spawn(move || {
            if let Some(f) = transcript.as_mut() {
                let sep = format!("\r\n\x1b[2m── session {} ──\x1b[0m\r\n", now_ms());
                let _ = f.write_all(sep.as_bytes());
            }
            let mut buf = [0u8; 8192];
            let mut first = true;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if first {
                            first = false;
                            let _ = first_out_tx.send(());
                        }
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        // Emit first (never block the live stream), then record.
                        let _ = app.emit(&format!("pty-out-{id}"), chunk);
                        if let Some(f) = transcript.as_mut() {
                            let _ = f.write_all(&buf[..n]);
                        }
                    }
                }
            }
            app.state::<Telemetry>().run_end_by_chat(&id, None, "exit");
            let _ = app.emit(&format!("pty-exit-{id}"), ());
            let manager = app.state::<PtyManager>();
            let removed = manager.0.lock().unwrap().remove(&id);
            if let Some(mut session) = removed {
                kill_session(&mut session);
            }
        });
    }

    if let Some(agent) = agent_cmd.filter(|c| !c.trim().is_empty()) {
        let app = app.clone();
        let id = session_id.clone();
        std::thread::spawn(move || {
            // Wait for the first shell output (or give up after ~100ms), then a
            // short grace so zsh is at least reading stdin before we type.
            let _ = first_out_rx.recv_timeout(Duration::from_millis(100));
            std::thread::sleep(Duration::from_millis(50));
            let manager = app.state::<PtyManager>();
            let mut map = manager.0.lock().unwrap();
            if let Some(session) = map.get_mut(&id) {
                let _ = session.writer.write_all(format!("{agent}\r").as_bytes());
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<PtyManager>, session_id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    let session = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("no session {session_id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let session = map
        .get(&session_id)
        .ok_or_else(|| format!("no session {session_id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(
    state: State<PtyManager>,
    telemetry: State<Telemetry>,
    session_id: String,
) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().unwrap().remove(&session_id) {
        telemetry.run_end_by_chat(&session_id, None, "killed");
        kill_session(&mut session);
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill_all(state: State<PtyManager>, telemetry: State<Telemetry>) -> Result<(), String> {
    let session_ids: Vec<String> = state.0.lock().unwrap().keys().cloned().collect();
    for session_id in session_ids {
        telemetry.run_end_by_chat(&session_id, None, "killed");
    }
    state.kill_all();
    Ok(())
}

/// Reads a chat's recorded output for read-only replay. Missing file → empty.
/// Only the trailing `TRANSCRIPT_TAIL_CAP` bytes are returned (aligned to the
/// next newline so we don't slice mid escape-sequence).
#[tauri::command]
pub fn pty_read_transcript(session_id: String) -> Result<String, String> {
    let path = match transcript_path(&session_id) {
        Some(p) => p,
        None => return Ok(String::new()),
    };
    if !path.exists() {
        return Ok(String::new());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let slice: &[u8] = if bytes.len() > TRANSCRIPT_TAIL_CAP {
        let start = bytes.len() - TRANSCRIPT_TAIL_CAP;
        let adjusted = bytes[start..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| start + i + 1)
            .unwrap_or(start);
        &bytes[adjusted..]
    } else {
        &bytes[..]
    };
    Ok(String::from_utf8_lossy(slice).into_owned())
}

/// Best-effort removal of a chat's recorded output (on chat/branch delete).
#[tauri::command]
pub fn pty_delete_transcript(session_id: String) -> Result<(), String> {
    if let Some(path) = transcript_path(&session_id) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}
