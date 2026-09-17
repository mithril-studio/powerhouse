use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

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
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    agent_cmd: Option<String>,
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

    // Signals the agent launcher once the shell has produced its first output.
    let (first_out_tx, first_out_rx) = mpsc::channel::<()>();

    {
        let app = app.clone();
        let id = session_id.clone();
        std::thread::spawn(move || {
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
                        let _ = app.emit(&format!("pty-out-{id}"), chunk);
                    }
                }
            }
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
pub fn pty_kill(state: State<PtyManager>, session_id: String) -> Result<(), String> {
    if let Some(mut session) = state.0.lock().unwrap().remove(&session_id) {
        kill_session(&mut session);
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill_all(state: State<PtyManager>) -> Result<(), String> {
    state.kill_all();
    Ok(())
}
