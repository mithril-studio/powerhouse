// Settings → Cloud and project env vars: typed IPC for
// `src-tauri/src/vm/settings.rs`. Tokens and values live in the Keychain;
// image builds and chat VMs read them. Values never reach the webview.
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";
import { ptyWrite } from "./ipc";

export interface SecretStatus {
  claude: boolean;
  github: boolean;
  github_slot: string | null;
}

export interface EnvVarStatus {
  name: string;
  set: boolean;
}

export interface EnvImport {
  imported: string[];
  /** `NAME: reason`, never a value. */
  skipped: string[];
  invalid: number;
}

export const cloudSecretStatus = (remoteUrl?: string | null) =>
  invoke<SecretStatus>("cloud_secret_status", { remoteUrl: remoteUrl ?? null });
export const cloudSetSecret = (name: string, value: string, remoteUrl?: string | null) =>
  invoke<SecretStatus>("cloud_set_secret", { name, value, remoteUrl: remoteUrl ?? null });
export const cloudProjectEnvStatus = (repoId: string, names: string[]) =>
  invoke<EnvVarStatus[]>("cloud_project_env_status", { repoId, names });
export const cloudImportEnvFile = (repoId: string, worktreePath: string, file: string) =>
  invoke<EnvImport>("cloud_import_env_file", { repoId, worktreePath, file });

/** Opens the branch's shell in the bottom panel and runs `command` in it. */
export function runInShell(branchId: string, command: string) {
  useAppStore.getState().openBottomPanel("shell");
  // The panel spawns its shell on first show; give it a moment.
  window.setTimeout(() => void ptyWrite(`shell-${branchId}`, `${command}\r`).catch(() => {}), 600);
}
