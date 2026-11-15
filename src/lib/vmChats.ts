// Cloud chats: typed IPC for `src-tauri/src/vm/chats.rs`, plus the rules the
// chat pane follows for them. Each cloud chat has its own branch and boxd VM;
// its agent runs there under ph-agentd, so it keeps working while the app is
// closed. See docs/vm-chats-plan.md.
import { invoke } from "@tauri-apps/api/core";
import type { Branch, Chat } from "../store/appStore";

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

export const vmChatMirror = (vm: string, worktree: string, branch: string) =>
  invoke<string>("vm_chat_mirror", { vm, worktree, branch });
export const vmChatCommitPush = (vm: string, worktree: string, branch: string, message: string) =>
  invoke<string>("vm_chat_commit_push", { vm, worktree, branch, message });
export const vmChatDropMirror = (repoPath: string, branch: string) =>
  invoke<void>("vm_chat_drop_mirror", { repoPath, branch });

/** The branch shell of a cloud branch: a login shell in the repo on its VM. */
export const vmShellCommand = (vm: string) =>
  `boxd machine exec --tty ${vm} -- bash -lc 'cd ~/repo && exec bash -l'`;

/**
 * The commit message for the work a cloud chat leaves uncommitted when it is
 * merged: the chat's title if it was renamed, else the first line of its first
 * prompt, else the branch name.
 */
export function mergeCommitMessage(branchName: string, chat: Chat | undefined): string {
  if (chat && !/^Chat \d+$/.test(chat.title)) return chat.title;
  const first = chat?.acpTranscript?.find((i) => i.type === "message" && i.role === "user");
  const line = first && "text" in first ? String(first.text).split("\n")[0].trim() : "";
  if (line) return line.length > 72 ? `${line.slice(0, 71)}…` : line;
  return branchName;
}

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
