//! Bounded script output and process supervision, independent of DBOS or a client.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{kill_group, Stop};
use powerhouse_cloud_protocol::ScriptResult;

const MAX_LOG_BYTES: usize = 1024 * 1024;
const TAIL_BYTES: usize = 16 * 1024;

pub trait Observer {
    fn stop_reason(&self) -> Option<Stop>;
    fn started(&mut self, pid: u32) -> Result<(), String>;
    fn output(&mut self, offset: u64, text: &str) -> Result<(), String>;
}

impl Observer for super::Ctx {
    fn stop_reason(&self) -> Option<Stop> {
        self.stop_reason()
    }

    fn started(&mut self, pid: u32) -> Result<(), String> {
        self.store
            .append_event(
                &self.row.run_id,
                "script.started",
                &serde_json::json!({ "pid": pid }),
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn output(&mut self, offset: u64, text: &str) -> Result<(), String> {
        self.store
            .append_event(
                &self.row.run_id,
                "script.output",
                &serde_json::json!({
                    "offset": offset, "text": text,
                }),
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Lossy decoding only replaces invalid bytes, not a valid character split
/// across pipe reads. At most three undecoded bytes survive a call.
#[derive(Default)]
struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    fn push(&mut self, bytes: &[u8], eof: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    self.pending.drain(..valid);
                    match err.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            self.pending.drain(..n);
                        }
                        None => {
                            if eof {
                                out.push('\u{fffd}');
                                self.pending.clear();
                            }
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

pub fn build_command(
    command: &str,
    workspace: &Path,
    home: &Path,
    run_id: &str,
    env: &[(String, String)],
) -> Command {
    let mut cmd = Command::new("/bin/bash");
    cmd.arg("-c")
        .arg(command)
        .env_clear()
        .envs(env.iter().cloned());
    cmd.env(
        "PATH",
        format!(
            "{}:/usr/local/bin:/usr/bin:/bin",
            crate::paths::AGENT_TOOLS_BIN
        ),
    )
    .env("HOME", home)
    .env("USER", crate::paths::AGENT_USER)
    .env("LANG", "C.UTF-8")
    .env("CI", "1")
    .env("TERM", "dumb")
    .env("POWERHOUSE_RUN_ID", run_id)
    .current_dir(workspace)
    .stdin(Stdio::null());
    cmd
}

/// Read fixed-size chunks, retaining a small overlap so secrets split across
/// reads are redacted before anything reaches disk or an event consumer.
struct Redactor {
    secrets: Vec<Vec<u8>>,
    pending: Vec<u8>,
    overlap: usize,
}

impl Redactor {
    fn new(env: &[(String, String)]) -> Self {
        let mut secrets: Vec<_> = env
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(_, v)| v.as_bytes().to_vec())
            .collect();
        secrets.sort_by_key(|v| std::cmp::Reverse(v.len()));
        secrets.dedup();
        let overlap = secrets.first().map_or(0, |s| s.len() - 1);
        Self {
            secrets,
            pending: vec![],
            overlap,
        }
    }

    fn push(&mut self, bytes: &[u8], eof: bool) -> Vec<u8> {
        self.pending.extend_from_slice(bytes);
        let limit = if eof {
            self.pending.len()
        } else {
            self.pending.len().saturating_sub(self.overlap)
        };
        let mut out = vec![];
        let mut pos = 0;
        while pos < limit {
            if let Some(secret) = self
                .secrets
                .iter()
                .find(|s| self.pending[pos..].starts_with(s))
            {
                out.extend_from_slice(b"[REDACTED]");
                pos += secret.len();
            } else {
                out.push(self.pending[pos]);
                pos += 1;
            }
        }
        self.pending.drain(..pos);
        out
    }
}

fn nonblocking(fd: std::os::fd::RawFd) -> Result<(), String> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

pub fn run(
    cmd: &mut Command,
    log_path: &Path,
    secrets: &[(String, String)],
    observer: &mut impl Observer,
) -> Result<(ScriptResult, Option<Stop>), String> {
    let mut result = ScriptResult {
        exit_code: None,
        output_tail: String::new(),
        output_truncated: false,
        log_bytes: 0,
    };
    if let Some(stop) = observer.stop_reason() {
        return Ok((result, Some(stop)));
    }
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(log_path)
        .map_err(|e| e.to_string())?;
    cmd.process_group(0)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start script: {e}"))?;
    let mut group_terminated = false;
    // Every path after spawn, including an event/log write failure, terminates
    // the process group before returning to the durable executor.
    let outcome = (|| {
        observer.started(child.id())?;
        let stdout = child.stdout.take().ok_or("script stdout missing")?;
        let stderr = child.stderr.take().ok_or("script stderr missing")?;
        nonblocking(stdout.as_raw_fd())?;
        nonblocking(stderr.as_raw_fd())?;
        let mut readers: [Box<dyn Read>; 2] = [Box::new(stdout), Box::new(stderr)];
        let mut redactors = [Redactor::new(secrets), Redactor::new(secrets)];
        let mut decoders = [Decoder::default(), Decoder::default()];
        let mut eof = [false, false];
        let mut exit = None;
        let mut stop = None;
        let mut exited_at = None;
        let mut buf = [0u8; 8192];
        loop {
            if exit.is_none() {
                if let Some(reason) = observer.stop_reason() {
                    stop = Some(reason);
                    kill_group(&mut child);
                    group_terminated = true;
                }
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                    exit = Some(status.code());
                    exited_at = Some(Instant::now());
                    if !group_terminated {
                        kill_group(&mut child);
                        group_terminated = true;
                    }
                }
            }
            for idx in 0..2 {
                for _ in 0..8 {
                    if eof[idx] {
                        break;
                    }
                    let chunk = match readers[idx].read(&mut buf) {
                        Ok(0) => {
                            eof[idx] = true;
                            redactors[idx].push(&[], true)
                        }
                        Ok(n) => redactors[idx].push(&buf[..n], false),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) => return Err(e.to_string()),
                    };
                    let text = decoders[idx].push(&chunk, eof[idx]);
                    let available = MAX_LOG_BYTES.saturating_sub(result.log_bytes as usize);
                    let (text, truncated) = crate::util::truncate_utf8(&text, available);
                    result.output_truncated |= truncated;
                    if !text.is_empty() {
                        log.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                        // Bound serialized event payloads even for control bytes
                        // (JSON escaping can expand each byte sixfold).
                        let mut remaining = text;
                        let mut offset = result.log_bytes;
                        while !remaining.is_empty() {
                            let (part, _) = crate::util::truncate_utf8(remaining, 8192);
                            observer.output(offset, part)?;
                            offset += part.len() as u64;
                            remaining = &remaining[part.len()..];
                        }
                        result.log_bytes += text.len() as u64;
                        result.output_tail.push_str(text);
                        let (tail, _) = crate::util::tail_utf8(&result.output_tail, TAIL_BYTES);
                        result.output_tail = tail.to_string();
                    }
                }
            }
            if exit.is_some() && eof.iter().all(|v| *v) {
                break;
            }
            if exited_at.is_some_and(|at| at.elapsed() > Duration::from_secs(3)) {
                if stop.is_some() {
                    // A daemonized descendant can leave the process group but
                    // retain a pipe. The executor's cgroup sweep reaps it;
                    // incomplete output must not replace a known stop reason.
                    result.output_truncated = true;
                    break;
                }
                return Err("script exited but a descendant kept an output pipe open".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        log.sync_all().map_err(|e| e.to_string())?;
        result.exit_code = exit.flatten();
        Ok((result, stop))
    })();
    if !group_terminated {
        kill_group(&mut child);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    struct RecordingObserver {
        output: String,
        stop_at: Option<(Instant, Stop)>,
    }

    impl Observer for RecordingObserver {
        fn started(&mut self, _pid: u32) -> Result<(), String> {
            Ok(())
        }
        fn stop_reason(&self) -> Option<Stop> {
            self.stop_at
                .filter(|(at, _)| Instant::now() >= *at)
                .map(|(_, stop)| stop)
        }
        fn output(&mut self, offset: u64, text: &str) -> Result<(), String> {
            assert_eq!(offset as usize, self.output.len());
            assert!(text.len() <= 8192);
            self.output.push_str(text);
            Ok(())
        }
    }

    fn execute(
        command: &str,
        env: &[(String, String)],
    ) -> (powerhouse_cloud_protocol::ScriptResult, String) {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = build_command(command, dir.path(), dir.path(), "test-run", env);
        let mut observer = RecordingObserver {
            output: String::new(),
            stop_at: None,
        };
        let (result, stop) =
            run(&mut cmd, &dir.path().join("script.log"), env, &mut observer).unwrap();
        assert_eq!(stop, None);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("script.log")).unwrap(),
            observer.output
        );
        (result, observer.output)
    }

    #[test]
    fn runs_in_workspace_with_closed_stdin_and_captures_both_streams() {
        let (result, output) = execute(
            "cat; printf '%s' \"$POWERHOUSE_RUN_ID\"; printf stderr >&2; touch produced",
            &[],
        );
        assert_eq!(result.exit_code, Some(0));
        assert!(output.contains("test-run"));
        assert!(output.contains("stderr"));
        assert!(!result.output_truncated);
        let (failed, _) = execute("exit 23", &[]);
        assert_eq!(failed.exit_code, Some(23));
    }

    #[test]
    fn redacts_project_secrets_from_events_log_and_result() {
        let env = vec![("APP_SECRET".into(), "a-secret-value".into())];
        let (result, output) = execute(
            "printf '%s' \"$APP_SECRET\"; printf '%s' \"$APP_SECRET\" >&2",
            &env,
        );
        assert!(!output.contains("a-secret-value"));
        assert!(!result.output_tail.contains("a-secret-value"));
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn output_is_bounded_even_without_newlines() {
        let (result, output) = execute("head -c 2000000 /dev/zero | tr '\\0' x", &[]);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.output_truncated);
        assert_eq!(output.len(), MAX_LOG_BYTES);
        assert!(result.output_tail.len() <= TAIL_BYTES);
    }

    #[test]
    fn stops_a_running_script_on_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = build_command("sleep 30 & wait", dir.path(), dir.path(), "test-run", &[]);
        let start = Instant::now();
        let mut observer = RecordingObserver {
            output: String::new(),
            stop_at: Some((start + Duration::from_millis(100), Stop::Cancelled)),
        };
        let (_, stop) = run(&mut cmd, &dir.path().join("script.log"), &[], &mut observer).unwrap();
        assert_eq!(stop, Some(super::super::Stop::Cancelled));
        assert!(start.elapsed() < Duration::from_secs(12));
    }

    #[test]
    fn redaction_handles_chunk_boundaries_and_overlapping_secrets() {
        let mut redactor = Redactor::new(&[
            ("ONE".into(), "secret".into()),
            ("TWO".into(), "secret-long".into()),
        ]);
        let mut output = redactor.push(b"before sec", false);
        output.extend(redactor.push(b"ret-long after secret!", true));
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "before [REDACTED] after [REDACTED]!"
        );
    }

    #[test]
    fn decoding_preserves_split_unicode_and_replaces_invalid_bytes() {
        let mut decoder = Decoder::default();
        assert_eq!(decoder.push(&[b'a', 0xf0, 0x9f], false), "a");
        assert_eq!(decoder.push(&[0x98, 0x80, 0xff, 0xe2], false), "😀�");
        assert_eq!(decoder.push(&[], true), "�");
    }

    #[test]
    fn deadline_stops_a_script_and_preexisting_cancel_never_launches() {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = build_command(
            "touch started; sleep 30",
            dir.path(),
            dir.path(),
            "test-run",
            &[],
        );
        let mut observer = RecordingObserver {
            output: String::new(),
            stop_at: Some((Instant::now(), Stop::Cancelled)),
        };
        let (_, stop) = run(&mut cmd, &dir.path().join("script.log"), &[], &mut observer).unwrap();
        assert_eq!(stop, Some(Stop::Cancelled));
        assert!(!dir.path().join("started").exists());
        observer.stop_at = Some((Instant::now() + Duration::from_millis(100), Stop::Deadline));
        let (_, stop) = run(&mut cmd, &dir.path().join("script.log"), &[], &mut observer).unwrap();
        assert_eq!(stop, Some(Stop::Deadline));
        assert!(dir.path().join("started").exists());
    }

    #[test]
    fn detached_output_pipe_does_not_replace_cancellation_with_failure() {
        let dir = tempfile::tempdir().unwrap();
        // Job control places the background child in a separate process group,
        // like a tool which daemonizes, while retaining our output pipes.
        let mut cmd = build_command(
            "set -m; sleep 30 & echo $! > child.pid; wait",
            dir.path(),
            dir.path(),
            "test-run",
            &[],
        );
        let mut observer = RecordingObserver {
            output: String::new(),
            stop_at: Some((Instant::now() + Duration::from_millis(150), Stop::Cancelled)),
        };
        let outcome = run(&mut cmd, &dir.path().join("script.log"), &[], &mut observer);
        // Production reaps such descendants with the surrounding systemd
        // cgroup sweep. The portable process test must clean up its own child.
        let child: i32 = std::fs::read_to_string(dir.path().join("child.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        unsafe {
            libc::kill(child, libc::SIGKILL);
        }
        assert_eq!(outcome.unwrap().1, Some(Stop::Cancelled));
    }

    #[test]
    fn script_outcome_logs_and_idempotency_survive_reopening_the_store() {
        use super::super::{Ctx, Secrets};
        use crate::store::Store;
        use powerhouse_cloud_protocol::{RunManifest, RunState};
        for (command, expected, code) in [
            ("printf durable", RunState::Completed, 0),
            ("exit 7", RunState::Failed, 7),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let db = dir.path().join("runs.db");
            let mut manifest: RunManifest =
                serde_json::from_str(include_str!("../../protocol/tests/fixtures/script-v3.json"))
                    .unwrap();
            manifest.run_id = uuid::Uuid::new_v4().to_string();
            manifest.script.as_mut().unwrap().command = command.into();
            let mut store = Store::open(&db).unwrap();
            assert!(!store.submit(&manifest).unwrap().duplicate);
            assert!(store
                .claim(&manifest.run_id, "test-owner", std::process::id())
                .unwrap());
            let row = store.get(&manifest.run_id).unwrap();
            let mut ctx = Ctx {
                store,
                row,
                owner: "test-owner".into(),
                self_bin: String::new(),
                deadline: Instant::now() + Duration::from_secs(10),
                terminating: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                results: dir.path().to_path_buf(),
                workspace: dir.path().to_path_buf(),
                trusted: dir.path().join("unused"),
                uid: unsafe { libc::getuid() },
                gid: unsafe { libc::getgid() },
                secrets: Secrets {
                    claude: vec![],
                    git_publish_token: None,
                    project_env: vec![],
                },
                agent_events: 0,
                agent_events_dropped: 0,
            };
            let result = super::super::empty_result(&ctx);
            super::super::run_script(&mut ctx, result).unwrap();
            drop(ctx);
            let mut reopened = Store::open(&db).unwrap();
            let row = reopened.get(&manifest.run_id).unwrap();
            assert_eq!(row.state, expected);
            let result = row.result.unwrap();
            assert_eq!(result.script.unwrap().exit_code, Some(code));
            assert!(!result.published);
            assert!(result.result_sha.is_none());
            assert!(reopened.submit(&manifest).unwrap().duplicate);
            assert!(!reopened.claim(&manifest.run_id, "other-owner", 42).unwrap());
            let events = reopened.events(&manifest.run_id, 0, 100).unwrap().events;
            assert_eq!(
                events.iter().filter(|e| e.kind == "script.started").count(),
                1
            );
            assert!(!events
                .iter()
                .any(|e| e.kind.starts_with("agent.") || e.kind.starts_with("publish.")));
            let output: String = events
                .iter()
                .filter(|e| e.kind == "script.output")
                .map(|e| e.payload["text"].as_str().unwrap())
                .collect();
            assert_eq!(output, if code == 0 { "durable" } else { "" });
            manifest.script.as_mut().unwrap().command.push_str("; true");
            assert!(reopened.submit(&manifest).is_err());
        }
    }
}
