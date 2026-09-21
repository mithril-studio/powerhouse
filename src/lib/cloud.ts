// Cloud runs: typed IPC wrappers + observation loop. Polling here is
// observation only; nothing in this file drives a run forward, and closing
// the app never cancels anything.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/appStore";

// --- protocol mirror (serialized from Rust, snake_case) ------------------------

export type RunState =
  | "accepted"
  | "preparing"
  | "running"
  | "validating"
  | "publishing"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "interrupted";

export type Phase =
  | "submitting"
  | "provisioning"
  | "submission_unknown"
  | "accepted"
  | "submit_failed";

export interface RunEvent {
  seq: number;
  ts_ms: number;
  kind: string;
  payload: unknown;
}

export interface RunSnapshot {
  run_id: string;
  state: RunState;
  stage: string | null;
  last_event_seq: number;
  accepted_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  error: { stage: string; message: string } | null;
  cancel_requested: boolean;
  result_available: boolean;
  unit_active: boolean | null;
}

export interface CheckResult {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped" | "not_run";
  exit_code: number | null;
  duration_ms: number | null;
  output_tail: string;
  output_truncated: boolean;
}

export interface ResultManifest {
  run_id: string;
  source_sha: string;
  result_sha: string | null;
  output_branch: string;
  published: boolean;
  publish_error: string | null;
  summary: string | null;
  concerns: string[];
  checks_configured: boolean;
  checks: CheckResult[];
  tree_changed_after_checks: boolean;
  changed_files: string[];
  diff_bytes: number;
  diff_truncated: boolean;
  provider_session_id: string | null;
  usage: unknown;
  agent_exit_code: number | null;
  partial_work_preserved: boolean;
}

export interface CloudRunRecord {
  run_id: string;
  repo_id: string;
  repo_path: string;
  repo_name: string;
  source_branch: string | null;
  manifest: {
    task: { text: string; acceptance_criteria: string[] };
    source: { commit_sha: string; source_branch: string | null; remote_url: string };
    output_branch: string;
    checks: { name: string; command: string }[];
    context?: { brief_markdown: string };
    deadline_seconds: number;
    agent: { provider: "claude" | "fake"; model: string | null; permission_mode: string };
  };
  manifest_digest: string;
  created_at_ms: number;
  phase: Phase;
  phase_detail: string | null;
  base_vm: { name: string; id: string | null } | null;
  task_vm: { name: string; id: string | null } | null;
  receipt: { state: RunState; accepted_at_ms: number; duplicate: boolean } | null;
  snapshot: RunSnapshot | null;
  result: ResultManifest | null;
  events: RunEvent[];
  event_cursor: number;
  last_sync_ms: number | null;
  last_sync_error: string | null;
  idle_policy_restored: boolean;
  imported_worktree: string | null;
}

export interface SourceInfo {
  sha: string;
  branch: string | null;
  remote_url: string | null;
  dirty: boolean;
  on_remote: boolean;
  problems: string[];
}

export interface ProbeInfo {
  protocol_version: number;
  runner_version: string;
  claude_version: string | null;
  agent_user_ready: boolean;
  store_ready: boolean;
  /** Names only. Non-empty means boxd injects org secrets into exec sessions. */
  ambient_secret_names: string[];
  pending_credentials: number;
}

export interface SecretStatus {
  claude: boolean;
  github: boolean;
}

export interface HandoffDoc {
  path: string;
  content: string;
}

export interface SubmitRequest {
  repoId: string;
  repoPath: string;
  repoName: string;
  sourcePath: string;
  task: string;
  acceptanceCriteria: string[];
  baseVm: string;
  checks: { name: string; command: string }[];
  deadlineSeconds: number;
  permissionMode: string;
  allowedTools: string[];
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  model: string | null;
  provider: "claude" | "fake";
  fakeScript?: string | null;
  /** Plan/context markdown handed to the agent as `.powerhouse/cloud-task.md`. */
  brief: string;
}

// --- ipc -----------------------------------------------------------------------

export const cloudListRuns = () => invoke<CloudRunRecord[]>("cloud_list_runs");
export const cloudInspectSource = (sourcePath: string) =>
  invoke<SourceInfo>("cloud_inspect_source", { sourcePath });
export const cloudProbeBase = (baseVm: string) => invoke<ProbeInfo>("cloud_probe_base", { baseVm });
export const cloudSubmit = (request: SubmitRequest) =>
  invoke<CloudRunRecord>("cloud_submit", { request });
export const cloudSync = (runId: string, forceEvents = false) =>
  invoke<CloudRunRecord>("cloud_sync", { runId, forceEvents });
export const cloudCancel = (runId: string) => invoke<CloudRunRecord>("cloud_cancel", { runId });
export const cloudDiff = (runId: string) =>
  invoke<{ patch: string; truncated: boolean; bytes: number }>("cloud_diff", { runId });
export const cloudImport = (runId: string) =>
  invoke<{ worktree_path: string; branch: string; result_sha: string }>("cloud_import", { runId });
export const cloudForget = (runId: string, force = false) =>
  invoke<void>("cloud_forget", { runId, force });
export const cloudSecretStatus = () => invoke<SecretStatus>("cloud_secret_status");
export const cloudSetSecret = (name: "claude_oauth_token" | "github_token", value: string) =>
  invoke<SecretStatus>("cloud_set_secret", { name, value });
export const cloudLatestHandoff = (sourcePath: string) =>
  invoke<HandoffDoc | null>("cloud_latest_handoff", { sourcePath });

// --- observation loop ------------------------------------------------------------

const ACTIVE_POLL_MS = 5000;
const RECONNECT_BACKOFF_MS = 30000;

export const isRunActive = (r: CloudRunRecord): boolean => {
  if (r.phase === "submit_failed") return false;
  if (r.phase !== "accepted") return true;
  const state = r.snapshot?.state ?? r.receipt?.state;
  return state === undefined || !isTerminal(state);
};

export const isTerminal = (s: RunState) =>
  s === "completed" || s === "blocked" || s === "failed" || s === "cancelled" || s === "interrupted";

let started = false;
const inFlight = new Set<string>();
const nextAllowed = new Map<string, number>();

async function syncOne(runId: string) {
  if (inFlight.has(runId)) return;
  inFlight.add(runId);
  try {
    const rec = await cloudSync(runId);
    useAppStore.getState().setCloudRun(rec);
    nextAllowed.set(runId, Date.now() + (rec.last_sync_error ? RECONNECT_BACKOFF_MS : ACTIVE_POLL_MS));
  } catch {
    nextAllowed.set(runId, Date.now() + RECONNECT_BACKOFF_MS);
  } finally {
    inFlight.delete(runId);
  }
}

/** Explicit refresh (button). Also used for completed runs, which are never polled. */
export async function refreshCloudRun(runId: string) {
  inFlight.delete(runId);
  nextAllowed.delete(runId);
  await syncOne(runId);
}

/**
 * Boot: render cached history immediately, then reconcile every run that may
 * still be active. Terminal runs are refreshed only on explicit user action so
 * completed VMs can go idle.
 */
export async function startCloudSync() {
  if (started) return;
  started = true;
  try {
    const runs = await cloudListRuns();
    useAppStore.getState().setCloudRuns(runs);
  } catch (err) {
    console.warn("cloud runs unavailable:", err);
  }
  await listen<CloudRunRecord>("cloud-run-update", (e) => {
    useAppStore.getState().setCloudRun(e.payload);
  });
  const tick = () => {
    const now = Date.now();
    for (const rec of Object.values(useAppStore.getState().cloudRuns)) {
      if (!isRunActive(rec)) continue;
      // Records mid-submission belong to the submitting call; only reconcile
      // them once the app has restarted (no in-flight submit will update them).
      if (rec.phase !== "accepted" && rec.phase !== "submission_unknown" && rec.phase !== "provisioning") continue;
      if ((nextAllowed.get(rec.run_id) ?? 0) > now) continue;
      void syncOne(rec.run_id);
    }
  };
  tick();
  window.setInterval(tick, 1000);
}
