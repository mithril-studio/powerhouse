// Cloud runs: typed IPC wrappers + observation loop. Polling here is
// observation only; nothing in this file drives a run forward, and closing
// the app never cancels anything. The lifecycle tick (release / park / lost
// acknowledgement reconciliation) runs in the backend once a minute while the
// app is open.
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

/** What boxd resources a run holds; independent of the run state. */
export type MachineState =
  | "provisioning"
  | "active"
  | "holding"
  | "parked"
  | "restoring"
  | "released"
  | "unmanaged";

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

export interface SnapshotRef {
  name: string;
  version: string | null;
}

export interface SnapshotHandle extends SnapshotRef {
  size: string | null;
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
    workspace?: { base_snapshot?: SnapshotRef | null; base_vm_name?: string };
    checks: { name: string; command: string }[];
    context?: { brief_markdown: string };
    deadline_seconds: number;
    agent: { provider: "claude" | "fake"; model: string | null; permission_mode: string };
  };
  manifest_digest: string;
  created_at_ms: number;
  phase: Phase;
  phase_detail: string | null;
  task_vm: { name: string; id: string | null } | null;
  receipt: { state: RunState; accepted_at_ms: number; duplicate: boolean } | null;
  snapshot: RunSnapshot | null;
  result: ResultManifest | null;
  events: RunEvent[];
  event_cursor: number;
  last_sync_ms: number | null;
  last_sync_error: string | null;
  imported_worktree: string | null;
  machine: MachineState;
  machine_changed_ms: number;
  park_snapshot: SnapshotHandle | null;
  vm_released: boolean;
  diff_cached: { bytes: number; truncated: boolean } | null;
  remote_verified: boolean;
  machine_error: string | null;
}

export interface SourceInfo {
  sha: string;
  branch: string | null;
  remote_url: string | null;
  dirty: boolean;
  on_remote: boolean;
  problems: string[];
}

/** One row of `boxd snapshots list`. */
export interface SnapshotInfo {
  name: string;
  version: string | null;
  status: string;
  size: string | null;
  id: string | null;
}

export interface MachineInfo {
  name: string;
  id: string | null;
  status: string;
  isolated: string | null;
  auto_suspend: string | null;
  auto_hibernate: string | null;
  source: string | null;
}

export interface Inventory {
  machines: MachineInfo[];
  snapshots: SnapshotInfo[];
  total_machines: number;
  ceiling: number;
  org_slots: number;
}

export interface SecretStatus {
  claude: boolean;
  github: boolean;
  /** Keychain entry that serves the queried remote, e.g. `github_token:mithril-studio`. */
  github_slot: string | null;
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
  /** Base snapshot name; the task VM is created from its current version. */
  baseSnapshot: string;
  /** Version shown in the form; submission refuses if it changed since. */
  baseSnapshotVersion: string | null;
  machineCeiling: number | null;
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

/** One-click submission: the brief is auto-picked, the task text is fixed. */
export interface QuickSubmitRequest {
  repoId: string;
  repoPath: string;
  repoName: string;
  sourcePath: string;
  baseSnapshot: string;
  machineCeiling: number | null;
  checks: { name: string; command: string }[];
  deadlineSeconds: number;
  permissionMode: string;
  allowedTools: string[];
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  model: string | null;
  provider: "claude" | "fake";
  fakeScript?: string | null;
}

export type QuickSubmitOutcome =
  | { kind: "accepted"; record: CloudRunRecord }
  /** Open the advanced form with this reason; never a dead-end. */
  | { kind: "needs_attention"; stage: string; reason: string };

/** Stage announcements while a one-click submit is in flight. */
export interface QuickSubmitStage {
  repoId: string;
  branch: string;
  stage: string;
}

// --- ipc -----------------------------------------------------------------------

export const cloudListRuns = () => invoke<CloudRunRecord[]>("cloud_list_runs");
export const cloudInspectSource = (sourcePath: string) =>
  invoke<SourceInfo>("cloud_inspect_source", { sourcePath });
export const cloudListSnapshots = () => invoke<SnapshotInfo[]>("cloud_list_snapshots");
export const cloudInventory = (baseSnapshot?: string | null, ceiling?: number | null) =>
  invoke<Inventory>("cloud_inventory", { baseSnapshot: baseSnapshot ?? null, ceiling: ceiling ?? null });
export const cloudSubmit = (request: SubmitRequest) =>
  invoke<CloudRunRecord>("cloud_submit", { request });
export const cloudQuickSubmit = (request: QuickSubmitRequest) =>
  invoke<QuickSubmitOutcome>("cloud_quick_submit", { request });
export const cloudSync = (runId: string, forceEvents = false) =>
  invoke<CloudRunRecord>("cloud_sync", { runId, forceEvents });
export const cloudCancel = (runId: string) => invoke<CloudRunRecord>("cloud_cancel", { runId });
/** Discard workspace: remove the run's VM and park snapshot. */
export const cloudRelease = (runId: string) => invoke<CloudRunRecord>("cloud_release", { runId });
/** Bring a parked run back on a fresh VM (held again for an hour). */
export const cloudRestore = (runId: string) => invoke<CloudRunRecord>("cloud_restore", { runId });
export const cloudLifecycleTick = () => invoke<string[]>("cloud_lifecycle_tick");
export const cloudDiff = (runId: string) =>
  invoke<{ patch: string; truncated: boolean; bytes: number }>("cloud_diff", { runId });
export const cloudImport = (runId: string) =>
  invoke<{ worktree_path: string; branch: string; result_sha: string }>("cloud_import", { runId });
export const cloudForget = (runId: string, force = false) =>
  invoke<void>("cloud_forget", { runId, force });
export const cloudSecretStatus = (remoteUrl?: string | null) =>
  invoke<SecretStatus>("cloud_secret_status", { remoteUrl: remoteUrl ?? null });
/** `name`: `claude_oauth_token`, `github_token`, or `github_token:<owner>[/<repo>]`. */
export const cloudSetSecret = (name: string, value: string, remoteUrl?: string | null) =>
  invoke<SecretStatus>("cloud_set_secret", { name, value, remoteUrl: remoteUrl ?? null });
/** Owner of an https GitHub-style remote, for scoped token slots. */
export const remoteOwner = (remoteUrl: string | null | undefined): string | null => {
  const m = /^https:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl ?? "");
  return m ? m[1] : null;
};
export const cloudLatestHandoff = (sourcePath: string) =>
  invoke<HandoffDoc | null>("cloud_latest_handoff", { sourcePath });

// --- observation loop ------------------------------------------------------------

const ACTIVE_POLL_MS = 5000;
const RECONNECT_BACKOFF_MS = 30000;
const LIFECYCLE_TICK_MS = 60000;

export const isRunActive = (r: CloudRunRecord): boolean => {
  if (r.phase === "submit_failed") return false;
  if (r.phase !== "accepted") return true;
  const state = r.snapshot?.state ?? r.receipt?.state;
  return state === undefined || !isTerminal(state);
};

export const isTerminal = (s: RunState) =>
  s === "completed" || s === "blocked" || s === "failed" || s === "cancelled" || s === "interrupted";

/** True while boxd still holds a VM or snapshot for the run. */
export const holdsResources = (r: CloudRunRecord): boolean => {
  if (r.machine === "unmanaged") return false;
  if (r.machine === "parked") return true;
  return !r.vm_released || !!r.park_snapshot;
};

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

let tickInFlight = false;
/** Run the backend lifecycle pass now (park due holds, finish pending releases). */
export async function runLifecycleTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await cloudLifecycleTick();
  } catch (err) {
    console.warn("cloud lifecycle tick failed:", err);
  } finally {
    tickInFlight = false;
  }
}

/**
 * Boot: render cached history immediately, then reconcile every run that may
 * still be active. Terminal runs are refreshed only on explicit user action;
 * their machines are handled by the lifecycle tick.
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
  await listen<QuickSubmitStage>("cloud-quick-submit", (e) => {
    useAppStore.getState().setCloudQuickStage(e.payload.repoId, e.payload.branch, e.payload.stage);
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
  void runLifecycleTick();
  window.setInterval(() => void runLifecycleTick(), LIFECYCLE_TICK_MS);
}
