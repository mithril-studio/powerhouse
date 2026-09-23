//! On-demand workflow runner: executes an ordered list of shell commands in a
//! directory, streams their output, and stops at the first failure. It has no
//! Tauri dependency so the merge queue, a future Workflows page, and the unit
//! tests all share one executor.
//!
//! The lifecycle contracts below are ported from kunchenguid/no-mistakes
//! (`internal/shellenv/shell_command_unix.go` and the `internal/pipeline`
//! executor tests). Each is pinned by a test in this file:
//!
//! - every step runs as the leader of its own process group, so cancelling
//!   terminates the whole tree (a test runner's workers, a dev server) and
//!   not just the shell that spawned it;
//! - a grandchild that outlives a cleanly-exited leader is reaped on every
//!   exit path, so orphan pools cannot accumulate across runs;
//! - survivors get SIGTERM first and SIGKILL only after a grace period, so a
//!   worker that handles SIGTERM can flush and clean up;
//! - a grandchild that inherited the step's stdout pipe cannot wedge the
//!   step: the group is terminated before the pipes are drained, and the
//!   drain itself is bounded;
//! - the first failing step fails the run and every later step is skipped;
//! - a cancelled run reports `Canceled`, never `Failed`;
//! - observers see state changes and log chunks on one thread, in order.

use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Per-step log retention. Older output is dropped from the front.
pub const LOG_CAP: usize = 256 * 1024;

/// How long a process group may take to exit after SIGTERM before SIGKILL.
pub const TERMINATE_GRACE: Duration = Duration::from_secs(3);

/// Ceiling on waiting for inherited pipes to close after the leader exited
/// and the group was terminated. Only reached by a pipe holder that escaped
/// the process group (setsid); a clean exit closes the pipes immediately.
const PIPE_DRAIN_BACKSTOP: Duration = Duration::from_secs(5);

const POLL: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct StepState {
    pub name: String,
    pub command: String,
    pub status: StepStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
}

impl StepState {
    pub fn pending(name: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            command: command.into(),
            status: StepStatus::Pending,
            exit_code: None,
            duration_ms: None,
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum StepResult {
    Passed,
    Failed(i32),
    Canceled,
    SpawnError(String),
}

#[derive(Debug, PartialEq)]
pub enum RunOutcome {
    Passed,
    Failed {
        step: usize,
        exit_code: Option<i32>,
        /// User-facing reason, e.g. `step “tests” failed (exit 1)`.
        error: String,
    },
    Canceled,
}

/// Observer of a run. Callbacks fire on the runner's thread, in order.
pub trait Sink {
    /// The step list changed (a step started, finished, or was skipped).
    fn steps_changed(&mut self, steps: &[StepState]);
    /// Raw output chunk from step `idx` (stdout and stderr interleaved).
    fn log(&mut self, idx: usize, chunk: &str);
}

/// Configuration for running steps. `Default` is the production shape: the
/// user's login shell so `PATH` matches their terminal (nvm, cargo, ...).
pub struct Runner {
    /// Shell program and the arguments that precede the command string.
    pub shell: (String, Vec<String>),
    /// SIGTERM → SIGKILL escalation window for surviving group members.
    pub grace: Duration,
}

impl Default for Runner {
    fn default() -> Self {
        Self {
            shell: ("/bin/zsh".into(), vec!["-lc".into()]),
            grace: TERMINATE_GRACE,
        }
    }
}

impl Runner {
    /// Run `steps` (name, command) in order inside `cwd`. `child_slot` exposes
    /// the live child to whoever wants to request a stop from another thread;
    /// `cancel` is polled between output chunks.
    pub fn run_steps(
        &self,
        steps: &[(String, String)],
        cwd: &Path,
        cancel: &AtomicBool,
        child_slot: &Mutex<Option<Child>>,
        sink: &mut dyn Sink,
    ) -> (RunOutcome, Vec<StepState>) {
        let mut states: Vec<StepState> = steps
            .iter()
            .map(|(n, c)| StepState::pending(n.clone(), c.clone()))
            .collect();

        for idx in 0..states.len() {
            if cancel.load(Ordering::Relaxed) {
                return (RunOutcome::Canceled, states);
            }
            states[idx].status = StepStatus::Running;
            sink.steps_changed(&states);

            let start = Instant::now();
            let res = self.run_step(idx, &states[idx].command, cwd, cancel, child_slot, sink);
            let dur = start.elapsed().as_millis() as u64;
            let name = states[idx].name.clone();

            match res {
                StepResult::Passed => {
                    states[idx].status = StepStatus::Passed;
                    states[idx].exit_code = Some(0);
                    states[idx].duration_ms = Some(dur);
                    sink.steps_changed(&states);
                }
                StepResult::Failed(code) => {
                    states[idx].status = StepStatus::Failed;
                    states[idx].exit_code = Some(code);
                    states[idx].duration_ms = Some(dur);
                    skip_rest(&mut states, idx + 1);
                    sink.steps_changed(&states);
                    return (
                        RunOutcome::Failed {
                            step: idx,
                            exit_code: Some(code),
                            error: format!("step “{name}” failed (exit {code})"),
                        },
                        states,
                    );
                }
                StepResult::Canceled => return (RunOutcome::Canceled, states),
                StepResult::SpawnError(err) => {
                    states[idx].status = StepStatus::Failed;
                    states[idx].duration_ms = Some(dur);
                    skip_rest(&mut states, idx + 1);
                    sink.steps_changed(&states);
                    return (
                        RunOutcome::Failed {
                            step: idx,
                            exit_code: None,
                            error: format!("could not run step “{name}”: {err}"),
                        },
                        states,
                    );
                }
            }
        }
        (RunOutcome::Passed, states)
    }

    /// Run one command to completion, streaming output to `sink.log(idx, _)`.
    pub fn run_step(
        &self,
        idx: usize,
        cmd: &str,
        cwd: &Path,
        cancel: &AtomicBool,
        child_slot: &Mutex<Option<Child>>,
        sink: &mut dyn Sink,
    ) -> StepResult {
        let mut command = Command::new(&self.shell.0);
        command
            .args(&self.shell.1)
            .arg(cmd)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        group::isolate(&mut command);
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) => return StepResult::SpawnError(e.to_string()),
        };
        let pgid = child.id() as i32;

        enum Msg {
            Chunk(String),
            Eof,
        }
        let (tx, rx) = mpsc::channel::<Msg>();
        let mut open_pipes = 0usize;
        let pipes: Vec<Box<dyn Read + Send>> = [
            child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
            child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .collect();
        for mut pipe in pipes {
            open_pipes += 1;
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match pipe.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                            if tx.send(Msg::Chunk(chunk)).is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = tx.send(Msg::Eof);
            });
        }
        drop(tx);
        *child_slot.lock().unwrap() = Some(child);

        let mut term_sent_at: Option<Instant> = None;
        fn forward(msg: Msg, idx: usize, open: &mut usize, sink: &mut dyn Sink) {
            match msg {
                Msg::Chunk(c) => sink.log(idx, &c),
                Msg::Eof => *open -= 1,
            }
        }

        // Poll for exit while forwarding output; escalate on cancel.
        let status = loop {
            while let Ok(msg) = rx.try_recv() {
                forward(msg, idx, &mut open_pipes, sink);
            }
            if cancel.load(Ordering::Relaxed) {
                match term_sent_at {
                    None => {
                        group::signal(pgid, group::TERM);
                        term_sent_at = Some(Instant::now());
                    }
                    Some(t) if t.elapsed() >= self.grace => {
                        group::signal(pgid, group::KILL);
                    }
                    Some(_) => {}
                }
            }
            let done = {
                let mut guard = child_slot.lock().unwrap();
                match guard.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(s)) => Some(Ok(s)),
                        Ok(None) => None,
                        Err(e) => Some(Err(e.to_string())),
                    },
                    None => Some(Err("check process vanished".to_string())),
                }
            };
            if let Some(res) = done {
                break res;
            }
            match rx.recv_timeout(POLL) {
                Ok(msg) => forward(msg, idx, &mut open_pipes, sink),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => std::thread::sleep(POLL),
            }
        };
        *child_slot.lock().unwrap() = None;

        // The leader is gone; nothing it left behind may outlive the step.
        group::reap(pgid, self.grace);

        // Drain whatever the readers still hold. Bounded: a holder that
        // escaped the group could otherwise pin this thread forever.
        let deadline = Instant::now() + PIPE_DRAIN_BACKSTOP;
        while open_pipes > 0 {
            let left = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(left) {
                Ok(msg) => forward(msg, idx, &mut open_pipes, sink),
                Err(_) => break,
            }
        }

        if cancel.load(Ordering::Relaxed) {
            return StepResult::Canceled;
        }
        match status {
            Ok(s) => match s.code().unwrap_or(-1) {
                0 => StepResult::Passed,
                code => StepResult::Failed(code),
            },
            Err(e) => StepResult::SpawnError(e),
        }
    }
}

fn skip_rest(states: &mut [StepState], from: usize) {
    for s in states.iter_mut().skip(from) {
        s.status = StepStatus::Skipped;
    }
}

/// Ask a running step to stop: SIGTERM to its whole process group. The runner
/// loop escalates to SIGKILL after the grace period once `cancel` is set.
pub fn request_stop(child: &Child) {
    group::signal(child.id() as i32, group::TERM);
}

/// Stop a running step now, waiting at most `grace` for the group to exit
/// cleanly before SIGKILL. For app-exit hygiene, where nobody is polling.
pub fn stop_now(child: &Child, grace: Duration) {
    group::reap(child.id() as i32, grace);
}

/// Append `chunk` to a per-step log, dropping the oldest bytes past `cap`
/// without ever splitting a UTF-8 character.
pub fn append_capped(buf: &mut String, chunk: &str, cap: usize) {
    buf.push_str(chunk);
    if buf.len() > cap {
        let mut cut = buf.len() - cap;
        while cut < buf.len() && !buf.is_char_boundary(cut) {
            cut += 1;
        }
        buf.drain(..cut);
    }
}

/// Process-group primitives. The leader's pid is its group id.
#[cfg(unix)]
mod group {
    use std::process::Command;
    use std::time::{Duration, Instant};

    pub const TERM: libc::c_int = libc::SIGTERM;
    pub const KILL: libc::c_int = libc::SIGKILL;

    pub fn isolate(cmd: &mut Command) {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    /// Signal every member of the group. `false` when the group is gone.
    pub fn signal(pgid: i32, sig: libc::c_int) -> bool {
        // SAFETY: killpg has no memory-safety preconditions.
        unsafe { libc::killpg(pgid, sig) == 0 }
    }

    pub fn alive(pgid: i32) -> bool {
        signal(pgid, 0)
    }

    /// SIGTERM the group, wait up to `grace` for it to empty, then SIGKILL.
    /// Returns immediately when nobody is left (the common case).
    pub fn reap(pgid: i32, grace: Duration) {
        if !signal(pgid, TERM) {
            return;
        }
        let deadline = Instant::now() + grace;
        while alive(pgid) {
            if Instant::now() >= deadline {
                signal(pgid, KILL);
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

#[cfg(not(unix))]
mod group {
    use std::process::Command;
    use std::time::Duration;
    pub const TERM: i32 = 15;
    pub const KILL: i32 = 9;
    pub fn isolate(_cmd: &mut Command) {}
    pub fn signal(_pgid: i32, _sig: i32) -> bool {
        false
    }
    pub fn reap(_pgid: i32, _grace: Duration) {}
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// Records every callback in arrival order.
    #[derive(Default)]
    struct Recorder {
        snapshots: Vec<Vec<StepState>>,
        logs: Vec<(usize, String)>,
    }
    impl Sink for Recorder {
        fn steps_changed(&mut self, steps: &[StepState]) {
            self.snapshots.push(steps.to_vec());
        }
        fn log(&mut self, idx: usize, chunk: &str) {
            self.logs.push((idx, chunk.to_string()));
        }
    }
    impl Recorder {
        fn log_for(&self, idx: usize) -> String {
            self.logs.iter().filter(|(i, _)| *i == idx).map(|(_, c)| c.as_str()).collect()
        }
    }

    /// Hermetic runner: POSIX sh (no login-profile side effects) and a short
    /// grace so escalation tests stay fast.
    fn runner() -> Runner {
        Runner {
            shell: ("/bin/sh".into(), vec!["-c".into()]),
            grace: Duration::from_millis(300),
        }
    }

    fn steps(cmds: &[&str]) -> Vec<(String, String)> {
        cmds.iter()
            .enumerate()
            .map(|(i, c)| (format!("step{i}"), c.to_string()))
            .collect()
    }

    fn run(cmds: &[&str]) -> (RunOutcome, Vec<StepState>, Recorder) {
        let mut rec = Recorder::default();
        let cancel = AtomicBool::new(false);
        let slot = Mutex::new(None);
        let (out, states) =
            runner().run_steps(&steps(cmds), Path::new("/tmp"), &cancel, &slot, &mut rec);
        (out, states, rec)
    }

    fn read_pid(path: &Path, timeout: Duration) -> i32 {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(s) = std::fs::read_to_string(path) {
                if let Ok(pid) = s.trim().parse::<i32>() {
                    return pid;
                }
            }
            assert!(Instant::now() < deadline, "pid file {} never appeared", path.display());
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn pid_alive(pid: i32) -> bool {
        // SAFETY: kill with signal 0 only probes.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn pid_gone_within(pid: i32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while pid_alive(pid) {
            if Instant::now() >= deadline {
                unsafe { libc::kill(pid, libc::SIGKILL) };
                return false;
            }
            thread::sleep(Duration::from_millis(25));
        }
        true
    }

    // --- executor contracts (no-mistakes internal/pipeline executor_test.go) ---

    #[test]
    fn passes_on_exit_zero_and_streams_stdout_and_stderr() {
        let (out, states, rec) = run(&["echo out; echo err 1>&2"]);
        assert_eq!(out, RunOutcome::Passed);
        assert_eq!(states[0].status, StepStatus::Passed);
        assert_eq!(states[0].exit_code, Some(0));
        assert!(states[0].duration_ms.is_some());
        let log = rec.log_for(0);
        assert!(log.contains("out\n") && log.contains("err\n"), "log = {log:?}");
    }

    #[test]
    fn first_failure_fails_the_run_and_skips_the_rest() {
        let (out, states, rec) = run(&["echo one", "exit 3", "echo three"]);
        assert_eq!(
            out,
            RunOutcome::Failed {
                step: 1,
                exit_code: Some(3),
                error: "step “step1” failed (exit 3)".into()
            }
        );
        let statuses: Vec<_> = states.iter().map(|s| s.status).collect();
        assert_eq!(statuses, [StepStatus::Passed, StepStatus::Failed, StepStatus::Skipped]);
        assert_eq!(states[1].exit_code, Some(3));
        assert!(states[1].duration_ms.is_some());
        assert_eq!(states[2].duration_ms, None);
        assert_eq!(rec.log_for(0), "one\n");
        assert_eq!(rec.log_for(2), "", "a skipped step must not run");
    }

    #[test]
    fn state_events_arrive_in_lifecycle_order() {
        let (_, _, rec) = run(&["true", "false"]);
        let seq: Vec<Vec<StepStatus>> = rec
            .snapshots
            .iter()
            .map(|snap| snap.iter().map(|s| s.status).collect())
            .collect();
        use StepStatus::*;
        assert_eq!(
            seq,
            vec![
                vec![Running, Pending],
                vec![Passed, Pending],
                vec![Passed, Running],
                vec![Passed, Failed],
            ]
        );
    }

    #[test]
    fn empty_step_list_passes() {
        let (out, states, rec) = run(&[]);
        assert_eq!(out, RunOutcome::Passed);
        assert!(states.is_empty());
        assert!(rec.snapshots.is_empty());
    }

    #[test]
    fn spawn_error_fails_without_an_exit_code() {
        let mut rec = Recorder::default();
        let cancel = AtomicBool::new(false);
        let slot = Mutex::new(None);
        let (out, states) = runner().run_steps(
            &steps(&["true"]),
            Path::new("/nonexistent/powerhouse-cwd"),
            &cancel,
            &slot,
            &mut rec,
        );
        match out {
            RunOutcome::Failed { step: 0, exit_code: None, error } => {
                assert!(error.starts_with("could not run step “step0”: "), "{error}")
            }
            other => panic!("unexpected outcome {other:?}"),
        }
        assert_eq!(states[0].status, StepStatus::Failed);
    }

    #[test]
    fn cancel_requested_before_start_reports_canceled_not_failed() {
        let mut rec = Recorder::default();
        let cancel = AtomicBool::new(true);
        let slot = Mutex::new(None);
        let (out, states) =
            runner().run_steps(&steps(&["true"]), Path::new("/tmp"), &cancel, &slot, &mut rec);
        assert_eq!(out, RunOutcome::Canceled);
        assert_eq!(states[0].status, StepStatus::Pending);
        assert!(rec.snapshots.is_empty(), "nothing ran");
    }

    // --- process-group contracts (no-mistakes shell_command_unix_test.go) ---

    #[test]
    fn cancel_terminates_the_whole_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("grandchild.pid");
        // Leader backgrounds a detached grandchild, records its pid, then
        // blocks in the foreground.
        let script = format!(
            "( sleep 120 >/dev/null 2>&1 ) & echo $! > {}; sleep 120",
            pid_file.display()
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let slot = Arc::new(Mutex::new(None));
        let worker = {
            let (cancel, slot, cwd) = (cancel.clone(), slot.clone(), dir.path().to_path_buf());
            thread::spawn(move || {
                let mut rec = Recorder::default();
                runner().run_steps(&steps(&[&script]), &cwd, &cancel, &slot, &mut rec)
            })
        };
        let grandchild = read_pid(&pid_file, Duration::from_secs(5));
        assert!(pid_alive(grandchild), "precondition: grandchild alive");

        cancel.store(true, Ordering::Relaxed);
        if let Some(c) = slot.lock().unwrap().as_ref() {
            request_stop(c);
        }

        let (out, states) = worker.join().unwrap();
        assert_eq!(out, RunOutcome::Canceled);
        assert_eq!(states[0].status, StepStatus::Running, "cancel leaves no verdict");
        assert!(
            pid_gone_within(grandchild, Duration::from_secs(5)),
            "grandchild {grandchild} survived cancel; group leaked"
        );
    }

    #[test]
    fn clean_exit_reaps_a_surviving_grandchild() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("grandchild.pid");
        let script = format!(
            "( sleep 120 >/dev/null 2>&1 ) & echo $! > {}; exit 0",
            pid_file.display()
        );
        let mut rec = Recorder::default();
        let cancel = AtomicBool::new(false);
        let slot = Mutex::new(None);
        let (out, _) = runner().run_steps(&steps(&[&script]), dir.path(), &cancel, &slot, &mut rec);
        assert_eq!(out, RunOutcome::Passed);
        let grandchild = read_pid(&pid_file, Duration::from_secs(5));
        assert!(
            pid_gone_within(grandchild, Duration::from_secs(5)),
            "grandchild {grandchild} outlived its step; orphan leaked"
        );
    }

    #[test]
    fn escalates_to_sigkill_when_sigterm_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("grandchild.pid");
        let script = format!(
            "( trap '' TERM; while :; do sleep 0.1; done ) >/dev/null 2>&1 & echo $! > {}; exit 0",
            pid_file.display()
        );
        let mut rec = Recorder::default();
        let cancel = AtomicBool::new(false);
        let slot = Mutex::new(None);
        let started = Instant::now();
        let (out, _) = runner().run_steps(&steps(&[&script]), dir.path(), &cancel, &slot, &mut rec);
        assert_eq!(out, RunOutcome::Passed);
        let grandchild = read_pid(&pid_file, Duration::from_secs(5));
        assert!(
            pid_gone_within(grandchild, Duration::from_secs(5)),
            "grandchild {grandchild} ignored SIGTERM and was never SIGKILLed"
        );
        assert!(started.elapsed() < Duration::from_secs(5), "escalation must land within grace");
    }

    #[test]
    fn grandchild_holding_stdout_does_not_wedge_the_step() {
        // `sleep` inherits the leader's stdout pipe and would keep it open for
        // two minutes; without group termination the reader never sees EOF.
        let started = Instant::now();
        let (out, _, rec) = run(&["echo before; sleep 120 & exit 0"]);
        assert_eq!(out, RunOutcome::Passed);
        assert_eq!(rec.log_for(0), "before\n");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "step took {:?}; an inherited pipe wedged it",
            started.elapsed()
        );
    }

    #[test]
    fn steps_run_in_the_given_directory() {
        let dir = tempfile::tempdir().unwrap();
        let mut rec = Recorder::default();
        let cancel = AtomicBool::new(false);
        let slot = Mutex::new(None);
        let (out, _) = runner().run_steps(&steps(&["pwd"]), dir.path(), &cancel, &slot, &mut rec);
        assert_eq!(out, RunOutcome::Passed);
        let want = dir.path().canonicalize().unwrap();
        assert_eq!(Path::new(rec.log_for(0).trim()).canonicalize().unwrap(), want);
    }

    // --- log retention ---

    #[test]
    fn append_capped_keeps_the_newest_bytes_on_a_char_boundary() {
        let cap = 10;
        let mut buf = String::new();
        // "é" is two bytes; 7 of them are 14 bytes, forcing a cut that would
        // land mid-character if the cap were applied byte-wise.
        append_capped(&mut buf, "ééééééé", cap);
        assert!(buf.len() <= cap, "len {} > cap {cap}", buf.len());
        assert!(buf.chars().all(|c| c == 'é'));
        append_capped(&mut buf, "END", cap);
        assert!(buf.ends_with("END"));
        assert!(buf.len() <= cap);
    }

    #[test]
    fn append_capped_is_a_plain_append_under_the_cap() {
        let mut buf = String::from("abc");
        append_capped(&mut buf, "def", 100);
        assert_eq!(buf, "abcdef");
    }
}
