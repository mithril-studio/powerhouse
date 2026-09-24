mod acp;
mod cloud;
mod files;
mod git;
mod github;
mod handoff;
mod memory;
mod pty;
mod queue;
mod telemetry;
mod workflow;

use acp::AcpManager;
use cloud::commands::CloudManager;
use handoff::HandoffWatchers;
use memory::MemoryState;
use pty::PtyManager;
use queue::QueueManager;
use tauri::Manager;
use telemetry::Telemetry;

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
        .plugin(tauri_plugin_notification::init())
        .manage(AcpManager::default())
        .manage(PtyManager::default())
        .manage(QueueManager::default())
        .manage(HandoffWatchers::default())
        .manage(CloudManager::default())
        .manage(MemoryState::default())
        .setup(|app| {
            app.manage(Telemetry::init(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            js_log,
            acp::acp_spawn,
            acp::acp_write,
            acp::acp_kill,
            acp::acp_kill_all,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_read_transcript,
            pty::pty_delete_transcript,
            git::git_validate_repo,
            git::git_clone_repo,
            git::git_init_repo,
            git::git_create_worktree,
            git::git_list_branches,
            git::git_remove_worktree,
            git::git_target_commits,
            git::git_archive_branch,
            git::git_prune_archived_branches,
            git::git_changed_files,
            git::git_file_diff,
            git::git_list_files,
            git::git_file_content,
            files::read_image_file,
            queue::queue_enqueue,
            queue::queue_cancel,
            queue::queue_state,
            queue::queue_step_log,
            queue::queue_dismiss,
            handoff::handoff_ensure_commands,
            handoff::handoff_watch_start,
            handoff::handoff_watch_stop,
            github::github_device_start,
            github::github_poll,
            github::github_account,
            github::github_list_repos,
            github::github_disconnect,
            cloud::commands::cloud_list_runs,
            cloud::commands::cloud_inspect_source,
            cloud::commands::cloud_list_snapshots,
            cloud::commands::cloud_inventory,
            cloud::commands::cloud_release,
            cloud::commands::cloud_restore,
            cloud::commands::cloud_lifecycle_tick,
            cloud::commands::cloud_submit,
            cloud::commands::cloud_quick_submit,
            cloud::commands::cloud_sync,
            cloud::commands::cloud_cancel,
            cloud::commands::cloud_diff,
            cloud::commands::cloud_import,
            cloud::commands::cloud_forget,
            cloud::commands::cloud_secret_status,
            cloud::commands::cloud_set_secret,
            cloud::commands::cloud_project_env_status,
            cloud::commands::cloud_latest_handoff,
            telemetry::commands::telemetry_list_runs,
            telemetry::commands::telemetry_run_detail,
            telemetry::commands::telemetry_run_events,
            telemetry::commands::telemetry_stats,
            telemetry::commands::telemetry_rebuild,
            telemetry::commands::telemetry_annotate_run,
            telemetry::commands::telemetry_tasks,
            telemetry::commands::telemetry_digest,
            telemetry::commands::telemetry_proposal_create,
            telemetry::commands::telemetry_proposal_list,
            telemetry::commands::telemetry_proposal_adopt,
            telemetry::commands::telemetry_proposal_evaluate,
            telemetry::commands::telemetry_proposal_decide,
            telemetry::commands::telemetry_selfcheck,
            memory::memory_call,
            memory::memory_server_ensure,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<AcpManager>().kill_all_with_reason("app-shutdown");
                app.state::<Telemetry>().end_all("app-shutdown");
                // Local processes only. Cloud runs are owned by their VM runner
                // and deliberately untouched here.
                app.state::<PtyManager>().kill_all();
                app.state::<QueueManager>().kill_running();
                app.state::<MemoryState>().kill_server();
                if let Err(error) = app.state::<Telemetry>().shutdown() {
                    eprintln!("[telemetry] shutdown flush failed: {error}");
                }
            }
        });
}
