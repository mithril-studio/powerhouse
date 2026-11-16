//! Git on a boxd VM: the clone script image builds run, the token-friendly
//! remote it clones, and the opt-in `.env` writer.
//! Everything here is pure and unit-tested.

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
