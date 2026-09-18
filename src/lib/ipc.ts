import { invoke } from "@tauri-apps/api/core";
import type { QueueEntry, WorkflowStep } from "../store/appStore";

export interface RepoInfo {
  root: string;
  name: string;
  default_branch: string;
}

export interface ChangedFile {
  path: string;
  status: string;
}

export const ptySpawn = (
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
  agentCmd?: string,
  resetTranscript = false,
) =>
  invoke<void>("pty_spawn", {
    sessionId,
    cwd,
    cols,
    rows,
    agentCmd: agentCmd ?? null,
    resetTranscript,
  });

/** Recorded output for a chat, for read-only replay after a restart. */
export const ptyReadTranscript = (sessionId: string) =>
  invoke<string>("pty_read_transcript", { sessionId });

export const ptyDeleteTranscript = (sessionId: string) =>
  invoke<void>("pty_delete_transcript", { sessionId });

export const ptyWrite = (sessionId: string, data: string) =>
  invoke<void>("pty_write", { sessionId, data });

export const ptyResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { sessionId, cols, rows });

export const ptyKill = (sessionId: string) =>
  invoke<void>("pty_kill", { sessionId });

export const ptyKillAll = () => invoke<void>("pty_kill_all");

export const gitValidateRepo = (path: string) =>
  invoke<RepoInfo>("git_validate_repo", { path });

export const gitCreateWorktree = (repoPath: string, branch: string, base: string) =>
  invoke<string>("git_create_worktree", { repoPath, branch, base });

export const gitRemoveWorktree = (repoPath: string, worktreePath: string) =>
  invoke<void>("git_remove_worktree", { repoPath, worktreePath });

export const gitChangedFiles = (worktreePath: string, base: string) =>
  invoke<ChangedFile[]>("git_changed_files", { worktreePath, base });

export const gitFileDiff = (worktreePath: string, base: string, path: string) =>
  invoke<string>("git_file_diff", { worktreePath, base, path });

export const gitListFiles = (worktreePath: string) =>
  invoke<string[]>("git_list_files", { worktreePath });

export const gitFileContent = (worktreePath: string, path: string) =>
  invoke<string>("git_file_content", { worktreePath, path });

// --- merge queue ---
type StepInput = Pick<WorkflowStep, "name" | "command" | "type">;

export const queueEnqueue = (
  repoId: string,
  repoPath: string,
  defaultBranch: string,
  branch: string,
  workflow: StepInput[],
  push: boolean,
) =>
  invoke<QueueEntry>("queue_enqueue", {
    repoId,
    repoPath,
    defaultBranch,
    branch,
    workflow,
    push,
  });

export const queueCancel = (repoId: string, entryId: string) =>
  invoke<void>("queue_cancel", { repoId, entryId });

export const queueState = (repoId: string) =>
  invoke<QueueEntry[]>("queue_state", { repoId });

export const queueStepLog = (repoId: string, entryId: string, step: number) =>
  invoke<string>("queue_step_log", { repoId, entryId, step });

export const queueDismiss = (repoId: string, entryId: string) =>
  invoke<void>("queue_dismiss", { repoId, entryId });

export interface HandoffEvent {
  branchId: string;
  path: string;
  relPath: string;
}

export const handoffEnsureCommands = () =>
  invoke<void>("handoff_ensure_commands");

export const handoffWatchStart = (branchId: string, worktreePath: string) =>
  invoke<void>("handoff_watch_start", { branchId, worktreePath });

export const handoffWatchStop = (branchId: string) =>
  invoke<void>("handoff_watch_stop", { branchId });
