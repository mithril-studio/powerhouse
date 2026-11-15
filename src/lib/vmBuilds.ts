// VM image builds: typed IPC for `src-tauri/src/vm/commands.rs`. A build
// snapshots the target branch with tools and dependencies installed; every
// new cloud chat VM starts from the project's active build.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type BuildStatus = "running" | "ready" | "failed";

export interface VmBuild {
  repoId: string;
  number: number;
  snapshot: string;
  branch: string;
  status: BuildStatus;
  step: string;
  commit: string | null;
  error: string | null;
  log: string;
  startedMs: number;
  finishedMs: number | null;
}

export interface RepoBuilds {
  /** Newest first. */
  builds: VmBuild[];
  active: number | null;
}

export interface VmConfig {
  vcpu: number | null;
  install: string | null;
  setup: string | null;
  run: string | null;
  archive: string | null;
}

export interface BuildRequest {
  repoId: string;
  repoName: string;
  repoPath: string;
  branch: string;
  envNames: string[];
}

export const vmBuilds = (repoId: string) => invoke<RepoBuilds>("vm_builds", { repoId });
export const vmBuildStart = (req: BuildRequest) => invoke<VmBuild>("vm_build_start", { req });
export const vmBuildActivate = (repoId: string, number: number) =>
  invoke<RepoBuilds>("vm_build_activate", { repoId, number });
export const vmConfig = (repoPath: string, branch: string) =>
  invoke<VmConfig>("vm_config", { repoPath, branch });

export const onVmBuild = (handler: (build: VmBuild) => void): Promise<UnlistenFn> =>
  listen<VmBuild>("vm-build-update", (event) => handler(event.payload));

/** Replaces or inserts `build` and keeps newest-first order. */
export function mergeBuild(list: VmBuild[], build: VmBuild): VmBuild[] {
  const rest = list.filter((b) => b.number !== build.number);
  return [build, ...rest].sort((a, b) => b.number - a.number);
}

/** "42 s" / "3 min" for a build's duration. */
export function buildDuration(b: VmBuild, now = Date.now()): string {
  const ms = (b.finishedMs ?? now) - b.startedMs;
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}
