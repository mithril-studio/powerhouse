//! Git on a boxd VM: the clone script image builds run, the token-friendly
//! remote it clones, the opt-in `.env` writer, and Powerhouse's machine names.
//! Everything here is pure and unit-tested.

use super::transport::OWNED_PREFIX;

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

/// Printed by [`WRITE_DOTENV_COMMAND`] when git would not ignore `.env`.
pub const DOTENV_NOT_IGNORED: &str = "PH_DOTENV_NOT_IGNORED";

/// Moves the uploaded `~/.ph/dotenv` to `~/repo/.env` (mode 600), but only when
/// git ignores `.env` there: a tracked or unignored file could be committed.
/// The staged copy is removed either way.
pub const WRITE_DOTENV_COMMAND: &str = r#"cd "$HOME/repo" || exit 1
if ! git check-ignore -q .env; then rm -f "$HOME/.ph/dotenv"; echo PH_DOTENV_NOT_IGNORED; exit 3; fi
install -m 600 "$HOME/.ph/dotenv" .env && rm -f "$HOME/.ph/dotenv""#;

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
}
