mod git;
mod handoff;
mod pty;
mod queue;

use handoff::HandoffWatchers;
use pty::PtyManager;
use queue::QueueManager;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyManager::default())
        .manage(QueueManager::default())
        .manage(HandoffWatchers::default())
        .invoke_handler(tauri::generate_handler![
            js_log,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_read_transcript,
            pty::pty_delete_transcript,
            git::git_validate_repo,
            git::git_create_worktree,
            git::git_remove_worktree,
            git::git_changed_files,
            git::git_file_diff,
            git::git_list_files,
            git::git_file_content,
            queue::queue_enqueue,
            queue::queue_cancel,
            queue::queue_state,
            queue::queue_step_log,
            queue::queue_dismiss,
            handoff::handoff_ensure_commands,
            handoff::handoff_watch_start,
            handoff::handoff_watch_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<PtyManager>().kill_all();
                app.state::<QueueManager>().kill_running();
            }
        });
}
