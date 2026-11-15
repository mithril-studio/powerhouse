//! `powerhouse.toml`: how a repo's cloud VM is set up. Committed at the repo
//! root so the agent on the VM can fix it like any other file.
//!
//! ```toml
//! [vm]
//! vcpu = 2                            # 1, 2 or 4 (4, 8, 16 GB); omit for the org default
//! install = "scripts/vm-install.sh"   # once per build, from ~/repo: system tools
//! setup = "pnpm install"              # every new chat VM, from ~/repo (deps are warm)
//! run = "pnpm dev"                    # optional Run button
//! archive = ""                        # optional, before a chat VM is destroyed
//! ```

pub const FILE: &str = "powerhouse.toml";

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VmConfig {
    pub vcpu: Option<u8>,
    pub install: Option<String>,
    pub setup: Option<String>,
    pub run: Option<String>,
    pub archive: Option<String>,
}

#[derive(serde::Deserialize)]
struct File {
    vm: Option<VmConfig>,
}

/// Parses `powerhouse.toml`. Blank scripts count as absent.
pub fn parse(text: &str) -> Result<VmConfig, String> {
    let file: File = toml::from_str(text).map_err(|e| format!("{FILE}: {}", e.message()))?;
    let mut vm = file.vm.unwrap_or_default();
    if let Some(v) = vm.vcpu {
        if ![1, 2, 4].contains(&v) {
            return Err(format!("{FILE}: vm.vcpu must be 1, 2 or 4, not {v}"));
        }
    }
    for script in [&mut vm.install, &mut vm.setup, &mut vm.run, &mut vm.archive] {
        if script.as_deref().is_some_and(|s| s.trim().is_empty()) {
            *script = None;
        }
    }
    Ok(vm)
}

/// Without a `setup` script, install dependencies from whichever lockfile the
/// repo has. `files` are the names at the repo root.
pub fn detected_setup(files: &[&str]) -> Option<&'static str> {
    let has = |f: &str| files.contains(&f);
    if has("pnpm-lock.yaml") {
        Some("corepack enable >/dev/null 2>&1 || npm i -g pnpm >/dev/null; pnpm install --frozen-lockfile")
    } else if has("package-lock.json") {
        Some("npm ci")
    } else if has("yarn.lock") {
        Some("corepack enable >/dev/null 2>&1; yarn install --frozen-lockfile")
    } else if has("bun.lockb") || has("bun.lock") {
        Some("command -v bun >/dev/null || (curl -fsSL https://bun.sh/install | bash); ~/.bun/bin/bun install")
    } else {
        None
    }
}

/// The setup script a VM runs: the configured one, else the detected one.
pub fn effective_setup(config: &VmConfig, files: &[&str]) -> Option<String> {
    config.setup.clone().or_else(|| detected_setup(files).map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_field() {
        let c = parse("[vm]\nvcpu = 4\ninstall = \"./i.sh\"\nsetup = \"pnpm i\"\nrun = \"pnpm dev\"\narchive = \"./a.sh\"\n").unwrap();
        assert_eq!(
            c,
            VmConfig {
                vcpu: Some(4),
                install: Some("./i.sh".into()),
                setup: Some("pnpm i".into()),
                run: Some("pnpm dev".into()),
                archive: Some("./a.sh".into()),
            }
        );
    }

    #[test]
    fn empty_file_and_blank_scripts_mean_defaults() {
        assert_eq!(parse("").unwrap(), VmConfig::default());
        assert_eq!(parse("[vm]\nsetup = \"  \"\n").unwrap().setup, None);
    }

    #[test]
    fn rejects_bad_vcpu_unknown_keys_and_bad_toml() {
        assert!(parse("[vm]\nvcpu = 3\n").unwrap_err().contains("1, 2 or 4"));
        assert!(parse("[vm]\ninstal = \"x\"\n").unwrap_err().contains("unknown field"));
        assert!(parse("[vm\n").is_err());
    }

    #[test]
    fn setup_falls_back_to_the_lockfile() {
        let none = VmConfig::default();
        assert!(effective_setup(&none, &["pnpm-lock.yaml", "package.json"]).unwrap().contains("pnpm install"));
        assert_eq!(effective_setup(&none, &["package-lock.json"]).as_deref(), Some("npm ci"));
        assert_eq!(effective_setup(&none, &["Cargo.toml"]), None);
        let custom = VmConfig { setup: Some("make deps".into()), ..Default::default() };
        assert_eq!(effective_setup(&custom, &["pnpm-lock.yaml"]).as_deref(), Some("make deps"));
    }
}
