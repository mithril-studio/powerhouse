//! Deterministic fake agent. Runs under the agent identity exactly like a real
//! provider and speaks the same stream-json shape, so the executor path under
//! test is the production path.

use std::io::Write;
use std::path::Path;

fn emit(v: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn text(s: &str) -> serde_json::Value {
    serde_json::json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":s}]}})
}

pub fn run(script: &str) -> i32 {
    let session = format!("fake-{}", uuid::Uuid::new_v4());
    emit(serde_json::json!({"type":"system","subtype":"init","session_id":session,"model":"fake","tools":[]}));

    // Isolation probe: the runner's store must be unreadable from here.
    let root = std::env::var("POWERHOUSE_RUNNER_ROOT").unwrap_or_else(|_| crate::paths::DEFAULT_ROOT.into());
    let db = Path::new(&root).join("runner.db");
    let readable = std::fs::File::open(&db).is_ok();
    let writable_root = std::fs::write(Path::new(&root).join("fake-agent-wrote-here"), b"x").is_ok();
    let brief_present = Path::new(".powerhouse/cloud-task.md").exists();
    let has_claude = std::env::var_os("CLAUDE_CODE_OAUTH_TOKEN").is_some() || std::env::var_os("ANTHROPIC_API_KEY").is_some();
    let has_git = std::env::var_os("GIT_PUBLISH_TOKEN").is_some() || std::env::var_os("GITHUB_PAT_TOKEN").is_some();
    emit(serde_json::json!({"type":"fake","subtype":"isolation","runner_state_readable":readable,"runner_root_writable":writable_root,"uid":unsafe{libc::geteuid()},"brief_present":brief_present,"has_model_token":has_claude,"has_git_token":has_git}));
    if readable || writable_root {
        emit(text("isolation failure: runner state reachable"));
        return 97;
    }

    // A child that outlives us unless the supervisor stops it.
    let child = std::process::Command::new("/bin/sleep").arg("900").spawn();
    let child_pid = child.as_ref().map(|c| c.id()).unwrap_or(0);
    emit(serde_json::json!({"type":"fake","subtype":"child","pid":child_pid}));

    match script {
        "complete" | "slow-complete" | "write-outside" => {
            if script == "slow-complete" {
                std::thread::sleep(std::time::Duration::from_secs(25));
            }
            if script == "write-outside" {
                let ok = std::fs::write("/etc/powerhouse-fake-escape", b"x").is_ok();
                emit(serde_json::json!({"type":"fake","subtype":"escape_attempt","succeeded":ok}));
                if ok {
                    return 97;
                }
            }
            emit(text("Writing CLOUD_RUN.md"));
            if let Err(e) = std::fs::write("CLOUD_RUN.md", format!("run session {session}\n")) {
                emit(text(&format!("write failed: {e}")));
                return 1;
            }
            emit(serde_json::json!({"type":"result","subtype":"success","is_error":false,"result":"Added CLOUD_RUN.md as requested.","session_id":session,"num_turns":1,"total_cost_usd":0.0,"usage":{"input_tokens":0,"output_tokens":0}}));
            0
        }
        "no-change" => {
            emit(text("Nothing to do."));
            emit(serde_json::json!({"type":"result","subtype":"success","is_error":false,"result":"No change was necessary.","session_id":session,"num_turns":1,"total_cost_usd":0.0}));
            0
        }
        "fail" => {
            let _ = std::fs::write("PARTIAL.md", "partial work\n");
            emit(text("Something went wrong."));
            23
        }
        "block" => {
            emit(text("I need permission to run the deploy script."));
            emit(serde_json::json!({"type":"result","subtype":"error_max_turns","is_error":true,"session_id":session,"num_turns":5}));
            0
        }
        "hang" => {
            let _ = std::fs::write("PARTIAL.md", "partial work before hang\n");
            emit(text("Working (CPU only, no network)…"));
            // Busy loop with no network and no sleep: never returns on its own.
            let mut x: u64 = 0;
            loop {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                std::hint::black_box(x);
            }
        }
        "huge-output" => {
            for i in 0..30_000u32 {
                emit(text(&format!("line {i} {}", "x".repeat(200))));
            }
            emit(serde_json::json!({"type":"result","subtype":"success","is_error":false,"result":"lots of output","session_id":session}));
            0
        }
        "lying" => {
            // Claims success in prose only, and writes a fake status file.
            let _ = std::fs::write("STATUS.json", r#"{"status":"completed","checks":"passed"}"#);
            emit(text("Task complete, all checks passed!"));
            0
        }
        other => {
            emit(text(&format!("unknown fake script {other}")));
            2
        }
    }
}
