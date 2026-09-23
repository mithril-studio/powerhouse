import type { ScriptManifest } from "../manifest.js";

/** The transport failed or timed out; the external action may or may not have happened. */
export class AdapterTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterTransportError";
  }
}

/** Same job UUID resubmitted with different manifest content. Fatal, never retried. */
export class ManifestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestConflictError";
  }
}

export interface MachineRequest {
  /** Intended machine name, persisted by the caller BEFORE this call. */
  name: string;
  snapshotName: string;
  snapshotVersion: string | null;
}

export interface MachineReceipt {
  machineId: string;
  name: string;
  /** False when an existing machine with this name was adopted. */
  created: boolean;
}

export interface JobRequest {
  /** Stable job UUID == manifest.run_id == workflow_node_runs.id. */
  jobId: string;
  machineName: string;
  manifest: ScriptManifest;
  /** KEY=VALUE credential lines; never logged, never part of the digest. */
  credentials?: Record<string, string>;
}

export interface JobReceipt {
  jobId: string;
  manifestDigest: string;
  state: JobState;
  /** True when the runner already owned an identical job. */
  duplicate: boolean;
}

/** Runner `RunState` collapsed to what the coordinator needs. */
export type JobState =
  | "accepted"
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export function isTerminalJobState(state: JobState): boolean {
  return (
    state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted"
  );
}

export interface JobSnapshot {
  jobId: string;
  state: JobState;
  /** Whether the supervising unit is still active; null when unknown. */
  unitActive: boolean | null;
  exitCode: number | null;
  outputTail: string;
  error: string | null;
}

/**
 * Everything the durable workflow needs from the outside world. All methods
 * must be safe to call again after an unknown outcome:
 *
 * - `ensureMachine` reconciles by name — absence of an acknowledgement is
 *   not absence of a machine.
 * - `submitJob` resolves a repeated (jobId, manifest) pair to the original
 *   receipt and throws {@link ManifestConflictError} when the content
 *   changed under the same jobId.
 * - `cancelJob` and `releaseMachine` are idempotent.
 */
export interface ExecutionAdapter {
  ensureMachine(input: MachineRequest): Promise<MachineReceipt>;
  submitJob(input: JobRequest): Promise<JobReceipt>;
  inspectJob(jobId: string): Promise<JobSnapshot>;
  cancelJob(jobId: string): Promise<void>;
  releaseMachine(machineId: string): Promise<void>;
}

/** Machine name for a node attempt; derivable from the job id everywhere. */
export function machineNameForJob(jobId: string): string {
  return `ph-wf-${jobId.slice(0, 8)}`;
}
