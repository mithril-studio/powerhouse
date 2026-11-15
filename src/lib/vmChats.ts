// Cloud chats: typed IPC for `src-tauri/src/vm/chats.rs`, plus the rules the
// chat pane follows for them. Each cloud chat has its own branch and boxd VM;
// its agent runs there under ph-agentd, so it keeps working while the app is
// closed. See docs/vm-chats-plan.md.
import { invoke } from "@tauri-apps/api/core";
import type { Branch } from "../store/appStore";

export interface VmChatCreateRequest {
  repoId: string;
  repoPath: string;
  branch: string;
  base: string;
  envNames: string[];
}

export const vmChatCreate = (req: VmChatCreateRequest) => invoke<string>("vm_chat_create", { req });
export const vmChatEnsureRunning = (vm: string) => invoke<void>("vm_chat_ensure_running", { vm });
export const vmChatRemove = (vm: string) => invoke<void>("vm_chat_remove", { vm });
export const vmAgentCommand = (vm: string, chatId: string, env?: Record<string, string>) =>
  invoke<string>("vm_agent_command", { vm, chatId, env });

/** Where the repo lives on every chat VM; the ACP session's cwd. */
export const VM_REPO_DIR = "/home/boxd/repo";

export const isCloudBranch = (b: Pick<Branch, "location"> | null | undefined) => b?.location === "cloud";

/** Session `_meta` for a cloud chat's resume: replay updates after `seq`. */
export const resumeMeta = (seq: number | undefined) => ({ "ph/fromSeq": seq ?? 0 });

/** Delay before reconnect attempt `n` (0-based): 1 s, 2 s, 5 s, 10 s, then 30 s. */
export function reconnectDelayMs(n: number): number {
  return [1_000, 2_000, 5_000, 10_000][n] ?? 30_000;
}

/** Give up after this many failed reconnects in a row; the user can retry. */
export const MAX_RECONNECTS = 8;
