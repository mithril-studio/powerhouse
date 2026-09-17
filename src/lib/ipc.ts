import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  root: string;
  name: string;
  default_branch: string;
}

export const ptySpawn = (
  sessionId: string,
  cwd: string,
  cols: number,
  rows: number,
  agentCmd?: string,
) => invoke<void>("pty_spawn", { sessionId, cwd, cols, rows, agentCmd: agentCmd ?? null });

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
