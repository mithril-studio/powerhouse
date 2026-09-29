//! Cloud workspaces: a worktree branch continued by Claude on a boxd VM.
//!
//! The VM holds one clone at `~/repo` on the workspace branch. Each prompt is
//! a *turn*: `~/.ph/run.sh <turn>` runs `claude -p` detached, writing
//! stream-json to `~/.ph/turn-<n>.jsonl` and the exit code to
//! `~/.ph/turn-<n>.exit`. The desktop reads the log from a byte offset, so a
//! closed laptop or a restarted app loses nothing. The branch is the source of
//! truth: the agent commits and pushes to it, and the desktop fetches it.
//!
//! Everything here is pure (no boxd, no git) and unit-tested.

use std::path::PathBuf;

use super::transport::OWNED_PREFIX;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Provisioning: checkpoint, push, VM, clone. `stage` says which.
    Creating,
    /// VM and clone ready, no turn yet (the chat had nothing to hand off).
    Ready,
    /// A turn is running on the VM.
    Running,
    /// The last turn exited cleanly.
    Done,
    /// Provisioning or the last turn failed; `last_error` says why.
    Failed,
    /// The user stopped the last turn.
    Stopped,
}

impl Status {
    /// Whether a new turn may start.
    pub fn accepts_prompt(self) -> bool {
        matches!(self, Status::Ready | Status::Done | Status::Failed | Status::Stopped)
    }
}

/// How the local worktree stands against what the cloud pushed.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResult {
    pub turn: u32,
    pub ok: bool,
    /// The agent's final message (stream-json `result`), or the failure.
    pub summary: String,
    /// `HEAD` of the VM clone when the turn ended.
    pub head: Option<String>,
    /// Commits on the VM that never reached the remote.
    pub unpushed_commits: u32,
    /// Uncommitted paths left on the VM.
    pub dirty_files: u32,
    /// What happened to the local worktree: pulled, already current, or why not.
    pub local: String,
    pub cost_usd: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspace {
    pub id: String,
    pub repo_id: String,
    pub branch_id: String,
    pub branch_name: String,
    pub worktree_path: String,
    /// https remote the VM clones from and pushes to.
    pub remote_url: String,
    pub vm_name: String,
    pub status: Status,
    /// Progress label while creating or running, e.g. "Pushing branch".
    pub stage: Option<String>,
    pub agent: String,
    pub model: Option<String>,
    pub chat_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_error: Option<String>,
    /// Current turn number; 0 before the first.
    pub turn: u32,
    /// Bytes of the current turn's log already delivered to the chat.
    pub log_offset: u64,
    /// Claude session on the VM; follow-up turns resume it.
    pub session_id: Option<String>,
    pub last_result: Option<TurnResult>,
}

// --- store -----------------------------------------------------------------------

pub struct Store {
    path: PathBuf,
    pub items: Vec<CloudWorkspace>,
}

impl Store {
    pub fn default_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".powerhouse")
            .join("cloud-workspaces.json")
    }

    /// A missing or unreadable file is an empty store: nothing here is worth
    /// refusing to start over.
    pub fn open(path: PathBuf) -> Self {
        let items = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self { path, items }
    }

    pub fn get(&self, id: &str) -> Option<&CloudWorkspace> {
        self.items.iter().find(|w| w.id == id)
    }

    pub fn for_branch(&self, branch_id: &str) -> Option<&CloudWorkspace> {
        self.items.iter().find(|w| w.branch_id == branch_id)
    }

    pub fn put(&mut self, ws: CloudWorkspace) -> Result<(), String> {
        match self.items.iter_mut().find(|w| w.id == ws.id) {
            Some(slot) => *slot = ws,
            None => self.items.push(ws),
        }
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        self.items.retain(|w| w.id != id);
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.items).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

// --- naming ----------------------------------------------------------------------

const SLUG_MAX: usize = 32;

/// `ph-<branch-slug>`: `boxd machine list` reads as "which branches are in the
/// cloud", and the name is recomputable, so a VM is reused across sends.
pub fn vm_name(branch: &str) -> String {
    format!("{OWNED_PREFIX}{}", branch_slug(branch))
}

/// Lowercased `[a-z0-9-]`, dashes collapsed, capped. A lossy slug (case,
/// collapsed or trimmed characters, truncation) gets a hash of the full name so
/// two branches never share a VM.
fn branch_slug(branch: &str) -> String {
    let lower = branch.to_lowercase();
    let mapped: String = lower
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '-' })
        .collect();
    let mut cleaned = String::with_capacity(mapped.len());
    for c in mapped.chars() {
        if c == '-' && (cleaned.is_empty() || cleaned.ends_with('-')) {
            continue;
        }
        cleaned.push(c);
    }
    let cleaned = cleaned.trim_end_matches('-').to_string();
    let mut lossy = lower != branch || cleaned != mapped;
    let mut slug = cleaned;
    if slug.len() > SLUG_MAX {
        slug.truncate(SLUG_MAX);
        slug = slug.trim_end_matches('-').to_string();
        lossy = true;
    }
    if slug.is_empty() {
        return hash6(branch);
    }
    if lossy {
        format!("{slug}-{}", hash6(branch))
    } else {
        slug
    }
}

/// First 6 hex chars of FNV-1a 64: stable, so the same branch always maps to
/// the same VM.
fn hash6(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")[..6].to_string()
}

/// The https form of a remote, credentials stripped: the VM authenticates with
/// a token, so SSH remotes are rewritten. `None` for anything else.
pub fn https_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let https = if let Some(rest) = url.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        format!("https://{host}/{path}")
    } else if let Some(rest) = url.strip_prefix("ssh://git@") {
        let (host, path) = rest.split_once('/')?;
        format!("https://{}/{path}", host.split(':').next()?)
    } else if let Some(rest) = url.strip_prefix("https://") {
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        format!("https://{rest}")
    } else {
        return None;
    };
    Some(https)
}

// --- VM scripts ------------------------------------------------------------------

/// Prepares the clone. Idempotent: a reused VM fetches and resets the branch to
/// the remote, which the desktop just pushed. No secrets in here; git reads the
/// token from `~/.ph/env` through the credential helper.
pub fn setup_script(remote_url: &str, branch: &str, user_name: &str, user_email: &str) -> String {
    let q = |s: &str| shell_words::quote(s).into_owned();
    let helper = r#"!f() { test "$1" = get || exit 0; . "$HOME/.ph/env"; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f"#;
    let origin_branch = format!("origin/{branch}");
    format!(
        r#"set -euo pipefail
mkdir -p "$HOME/.ph" && chmod 700 "$HOME/.ph"
git config --global credential.helper {helper}
git config --global user.name {name}
git config --global user.email {email}
if [ ! -d "$HOME/repo/.git" ]; then git clone --quiet {remote} "$HOME/repo"; fi
cd "$HOME/repo"
git remote set-url origin {remote}
git fetch --quiet origin
git checkout --quiet -B {branch} {origin_branch}
git branch --quiet --set-upstream-to={origin_branch}
echo ready
"#,
        helper = q(helper),
        name = q(user_name),
        email = q(user_email),
        remote = q(remote_url),
        branch = q(branch),
        origin_branch = q(&origin_branch),
    )
}

/// Runs one turn; started detached with `setsid nohup`, so it outlives the
/// `boxd exec` that launched it. Extra arguments go to `claude`.
pub const RUN_SCRIPT: &str = r#"#!/bin/bash
turn="$1"; shift
dir="$HOME/.ph"
echo $$ > "$dir/turn-$turn.pid"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
set -a; . "$dir/env"; set +a
cd "$HOME/repo"
git pull --ff-only --quiet >/dev/null 2>&1 || true
claude -p --output-format stream-json --verbose --dangerously-skip-permissions "$@" \
  < "$dir/turn-$turn.prompt" > "$dir/turn-$turn.jsonl" 2> "$dir/turn-$turn.err"
echo $? > "$dir/turn-$turn.exit"
"#;

/// Starts turn `turn` in the background and returns at once.
pub fn launch_command(turn: u32, model: Option<&str>, resume: Option<&str>) -> String {
    let mut args = vec![turn.to_string()];
    if let Some(m) = model.filter(|m| !m.trim().is_empty() && *m != "default") {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if let Some(sid) = resume {
        args.push("--resume".into());
        args.push(sid.to_string());
    }
    format!(
        "setsid nohup bash \"$HOME/.ph/run.sh\" {} >/dev/null 2>&1 < /dev/null & echo started",
        shell_words::join(&args)
    )
}

/// Kills the turn's process group (the agent and everything it spawned) and
/// marks it stopped, since `run.sh` dies before writing its exit file.
pub fn stop_command(turn: u32) -> String {
    format!(
        r#"d="$HOME/.ph"; p=$(cat "$d/turn-{turn}.pid" 2>/dev/null) && kill -TERM -- -"$p" 2>/dev/null; sleep 1; [ -n "$p" ] && kill -KILL -- -"$p" 2>/dev/null; [ -f "$d/turn-{turn}.exit" ] || echo stopped > "$d/turn-{turn}.exit"; echo ok"#
    )
}

/// Largest log slice read per poll.
pub const CHUNK_BYTES: u64 = 1 << 20;

/// Ends [`poll_command`]'s output. `boxd exec` trims trailing whitespace, which
/// would turn the log's final newline into a "partial" line; the marker keeps
/// the log bytes exact.
const END: &str = "~ph-end";

/// Prints the exit marker (`-` while running) on the first line, then the log
/// from `offset`, then [`END`]. The exit marker is read first, so once it is
/// set the log that follows is complete.
pub fn poll_command(turn: u32, offset: u64) -> String {
    format!(
        r#"d="$HOME/.ph"; printf '%s\n' "$(cat "$d/turn-{turn}.exit" 2>/dev/null || echo -)"; tail -c +{start} "$d/turn-{turn}.jsonl" 2>/dev/null | head -c {CHUNK_BYTES}; printf '{END}'"#,
        start = offset + 1
    )
}

/// Byte length of the line starting at `offset`, newline included: lets a poll
/// step past a line longer than [`CHUNK_BYTES`].
pub fn line_length_command(turn: u32, offset: u64) -> String {
    format!(r#"tail -c +{} "$HOME/.ph/turn-{turn}.jsonl" | head -n 1 | wc -c"#, offset + 1)
}

/// What the VM clone looks like after a turn: `HEAD`, commits not on the
/// remote, uncommitted paths. One per line.
pub const INSPECT_COMMAND: &str = r#"cd "$HOME/repo" && git rev-parse HEAD && (git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0) && git status --porcelain | wc -l"#;

pub fn err_tail_command(turn: u32) -> String {
    format!(r#"tail -c 2000 "$HOME/.ph/turn-{turn}.err" 2>/dev/null"#)
}

/// The prompt for a turn. The first carries the handoff; every turn restates
/// how to finish, because the branch is the only way work comes back.
pub fn turn_prompt(first: bool, branch: &str, text: &str) -> String {
    let finish = format!(
        "When you are done: commit your changes, push them with `git push origin {branch}`, and end with a short summary of what you changed."
    );
    if first {
        format!(
            "You are continuing work from a local Powerhouse session, now on a cloud machine. The repository is checked out at the branch `{branch}`. Work autonomously: nobody can answer questions until you finish.\n\n{text}\n\n{finish}"
        )
    } else {
        format!("{text}\n\n({finish})")
    }
}

// --- polling ---------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Exit {
    Running,
    Code(i32),
    Stopped,
}

#[derive(Debug, PartialEq)]
pub struct Chunk {
    pub exit: Exit,
    /// Complete lines; a trailing partial line waits for the next poll.
    pub lines: Vec<String>,
    /// Bytes consumed from the log.
    pub consumed: u64,
    /// The slice was full: more log is waiting.
    pub full: bool,
}

/// Parses [`poll_command`]'s output.
pub fn parse_poll(output: &str) -> Chunk {
    let output = output.strip_suffix(END).unwrap_or(output);
    let (marker, data) = output.split_once('\n').unwrap_or((output, ""));
    let exit = match marker.trim() {
        "-" | "" => Exit::Running,
        "stopped" => Exit::Stopped,
        code => code.parse().map(Exit::Code).unwrap_or(Exit::Code(-1)),
    };
    let complete = match data.rfind('\n') {
        Some(i) => &data[..=i],
        None => "",
    };
    Chunk {
        exit,
        lines: complete.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect(),
        consumed: complete.len() as u64,
        full: data.len() as u64 >= CHUNK_BYTES,
    }
}

/// What a turn's log tells about the session and its outcome.
#[derive(Debug, Default, PartialEq)]
pub struct LogFacts {
    pub session_id: Option<String>,
    /// The `result` event: final text and whether Claude reported an error.
    pub result: Option<(String, bool)>,
    pub cost_usd: Option<f64>,
}

pub fn scan_lines(lines: &[String]) -> LogFacts {
    let mut facts = LogFacts::default();
    for line in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
            facts.session_id = Some(sid.to_string());
        }
        if v.get("type").and_then(|t| t.as_str()) == Some("result") {
            let text = v.get("result").and_then(|r| r.as_str()).unwrap_or("").to_string();
            let is_error = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
            facts.result = Some((text, is_error));
            facts.cost_usd = v.get("total_cost_usd").and_then(|c| c.as_f64());
        }
    }
    facts
}

/// `HEAD`, unpushed commits and dirty paths from [`INSPECT_COMMAND`].
pub fn parse_inspect(output: &str) -> (Option<String>, u32, u32) {
    let mut lines = output.lines().map(str::trim).filter(|l| !l.is_empty());
    let head = lines.next().filter(|h| h.len() >= 7 && h.chars().all(|c| c.is_ascii_hexdigit())).map(str::to_string);
    let unpushed = lines.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let dirty = lines.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    (head, unpushed, dirty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_names_are_owned_stable_and_distinct() {
        assert_eq!(vm_name("fix-cloud"), "ph-fix-cloud");
        assert_eq!(vm_name("feat/foo"), "ph-feat-foo");
        assert_ne!(vm_name("Feat"), vm_name("feat"));
        assert_eq!(vm_name("feat/foo"), vm_name("feat/foo"));
        assert!(vm_name(&"x".repeat(80)).len() <= 3 + SLUG_MAX + 7);
        assert!(super::super::transport::ensure_owned(&vm_name("feat/Ünïcode")).is_ok());
    }

    #[test]
    fn remotes_become_token_friendly_https() {
        assert_eq!(https_remote("git@github.com:a/b.git").as_deref(), Some("https://github.com/a/b.git"));
        assert_eq!(https_remote("ssh://git@github.com:22/a/b.git").as_deref(), Some("https://github.com/a/b.git"));
        assert_eq!(https_remote("https://tok@github.com/a/b").as_deref(), Some("https://github.com/a/b"));
        assert_eq!(https_remote("https://github.com/a/b.git").as_deref(), Some("https://github.com/a/b.git"));
        assert_eq!(https_remote("/local/path"), None);
    }

    #[test]
    fn setup_quotes_everything_it_interpolates() {
        let s = setup_script("https://github.com/a/b.git", "feat/x", "Joost D", "j@x.com");
        assert!(s.contains("git checkout --quiet -B feat/x origin/feat/x"), "{s}");
        assert!(s.contains("user.name 'Joost D'"), "{s}");
        assert!(s.contains(r#"credential.helper '!f() {"#), "{s}");
        assert!(!s.contains("GH_TOKEN=")); // the token never lands in the script
    }

    #[test]
    fn launch_passes_model_and_resume_but_not_default() {
        assert_eq!(
            launch_command(2, Some("opus"), Some("abc")),
            r#"setsid nohup bash "$HOME/.ph/run.sh" 2 --model opus --resume abc >/dev/null 2>&1 < /dev/null & echo started"#
        );
        assert!(!launch_command(1, Some("default"), None).contains("--model"));
        assert!(!launch_command(1, None, None).contains("--resume"));
    }

    #[test]
    fn poll_output_keeps_only_complete_lines() {
        let c = parse_poll("-\n{\"a\":1}\n{\"b\":2}\n{\"c\"~ph-end");
        assert_eq!(c.exit, Exit::Running);
        assert_eq!(c.lines, vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(c.consumed, 16);
        assert!(!c.full);
        assert_eq!(parse_poll("0\n").exit, Exit::Code(0));
        assert_eq!(parse_poll("1\n").exit, Exit::Code(1));
        assert_eq!(parse_poll("stopped\n{}\n").exit, Exit::Stopped);
        assert_eq!(parse_poll("-\n").lines, Vec::<String>::new());
        // Multi-byte text counts bytes, not chars.
        assert_eq!(parse_poll("-\n\"é\"\n").consumed, 5);
        // The end marker keeps a final newline that boxd would trim.
        assert_eq!(parse_poll("0\n{}\n~ph-end").lines, vec!["{}"]);
        assert!(poll_command(3, 10).ends_with("printf '~ph-end'"));
    }

    #[test]
    fn scan_finds_session_and_result() {
        let lines = vec![
            r#"{"type":"system","subtype":"init","session_id":"s1"}"#.to_string(),
            "not json".to_string(),
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Fixed it","session_id":"s1","total_cost_usd":0.42}"#.to_string(),
        ];
        let f = scan_lines(&lines);
        assert_eq!(f.session_id.as_deref(), Some("s1"));
        assert_eq!(f.result, Some(("Fixed it".into(), false)));
        assert_eq!(f.cost_usd, Some(0.42));
    }

    #[test]
    fn inspect_parses_head_unpushed_and_dirty() {
        assert_eq!(parse_inspect("abcdef1234\n2\n  3\n"), (Some("abcdef1234".into()), 2, 3));
        assert_eq!(parse_inspect("fatal: not a git repo\n"), (None, 0, 0));
    }

    #[test]
    fn only_settled_workspaces_take_prompts() {
        assert!(Status::Done.accepts_prompt());
        assert!(Status::Ready.accepts_prompt());
        assert!(!Status::Running.accepts_prompt());
        assert!(!Status::Creating.accepts_prompt());
    }

    #[test]
    fn store_round_trips_and_tolerates_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ws.json");
        std::fs::write(&path, "garbage").unwrap();
        let mut store = Store::open(path.clone());
        assert!(store.items.is_empty());
        let ws = CloudWorkspace {
            id: "w1".into(),
            repo_id: "r".into(),
            branch_id: "b".into(),
            branch_name: "fix-cloud".into(),
            worktree_path: "/tmp/x".into(),
            remote_url: "https://github.com/a/b.git".into(),
            vm_name: "ph-fix-cloud".into(),
            status: Status::Running,
            stage: None,
            agent: "claude".into(),
            model: None,
            chat_id: Some("c".into()),
            created_at_ms: 1,
            updated_at_ms: 1,
            last_error: None,
            turn: 1,
            log_offset: 10,
            session_id: None,
            last_result: None,
        };
        store.put(ws.clone()).unwrap();
        assert_eq!(Store::open(path.clone()).items, vec![ws]);
        store.remove("w1").unwrap();
        assert!(Store::open(path).items.is_empty());
    }
}
