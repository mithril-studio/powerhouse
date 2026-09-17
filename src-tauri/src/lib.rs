mod git;
mod handoff;
mod pty;

use handoff::HandoffWatchers;
use pty::PtyManager;
use tauri::Manager;

/// Dev aid: surfaces webview console errors in the `tauri dev` terminal.
#[tauri::command]
fn js_log(level: String, msg: String) {
    eprintln!("[webview:{level}] {msg}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(PtyManager::default())
        .manage(HandoffWatchers::default())
        .invoke_handler(tauri::generate_handler![
            js_log,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            git::git_validate_repo,
            git::git_create_worktree,
            git::git_remove_worktree,
            handoff::handoff_ensure_commands,
            handoff::handoff_watch_start,
            handoff::handoff_watch_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<PtyManager>().kill_all();
            }
        });
}
