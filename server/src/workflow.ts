import { DBOS } from "@dbos-inc/dbos-sdk";

import {
  ManifestConflictError,
  isTerminalJobState,
  type ExecutionAdapter,
  type JobSnapshot,
} from "./adapters/types.js";
import type { Db } from "./db.js";
import { buildScriptManifest, manifestDigest } from "./manifest.js";
import {
  ensureNodeRun,
  getRunById,
  isCancelRequested,
  setRunStatus,
  updateNodeRun,
  type NodeRunRow,
  type RunRow,
} from "./runs.js";

export interface WorkflowDeps {
  db: Db;
  adapter: ExecutionAdapter;
  pollIntervalMs: number;
}

/**
 * Runtime dependencies live in a swappable container because the workflow
 * function is registered with DBOS once per process, while tests start and
 * stop several coordinators. DBOS checkpoints step results, not this
 * object; recovery re-reads all state through steps.
 */
let currentDeps: WorkflowDeps | null = null;

export function setWorkflowDeps(deps: WorkflowDeps): void {
  currentDeps = deps;
}

function deps(): WorkflowDeps {
  if (!currentDeps) throw new Error("workflow dependencies not initialized");
  return currentDeps;
}

/** Retry transient transport faults; every adapter action reconciles, so re-running is safe. */
const TRANSPORT_RETRIES = {
  retriesAllowed: true,
  maxAttempts: 5,
  intervalSeconds: 1,
  backoffRate: 2,
  shouldRetry: (err: unknown) => !(err instanceof ManifestConflictError),
} as const;

type NodeOutcome = "succeeded" | "failed" | "canceled" | "interrupted";

async function runNode(run: RunRow, nodeIndex: number): Promise<NodeOutcome> {
  const { db, adapter, pollIntervalMs } = deps();
  const command = run.nodes[nodeIndex - 1]!.command;

  // Stable identities (job UUID, machine name, manifest timestamp) are
  // durable before any external action; replays adopt them.
  const node = await DBOS.runStep(
    () => ensureNodeRun(db, run.id, nodeIndex, Date.now()),
    { name: "ensureNodeRun" },
  );

  await DBOS.runStep(
    () =>
      updateNodeRun(db, node.id, { state: "provisioning" }, {
        kind: "node.provisioning",
        payload: { nodeIndex, machineName: node.machine_name },
      }),
    { name: "markProvisioning" },
  );

  const machine = await DBOS.runStep(
    () =>
      adapter.ensureMachine({
        name: node.machine_name,
        snapshotName: run.snapshot_name,
        snapshotVersion: run.snapshot_version,
      }),
    { name: "ensureMachine", ...TRANSPORT_RETRIES },
  );

  await DBOS.runStep(
    () =>
      updateNodeRun(db, node.id, { machine_id: machine.machineId, state: "submitting" }, {
        kind: "node.machine_ready",
        payload: { nodeIndex, machineId: machine.machineId },
      }),
    { name: "recordMachine" },
  );

  const manifest = buildManifestForNode(run, node, command);
  const digest = manifestDigest(manifest);

  await DBOS.runStep(
    () => updateNodeRun(db, node.id, { manifest_digest: digest }),
    { name: "recordManifestDigest" },
  );

  await DBOS.runStep(
    () =>
      adapter.submitJob({
        jobId: node.id,
        machineName: node.machine_name,
        manifest,
      }),
    { name: "submitJob", ...TRANSPORT_RETRIES },
  );

  await DBOS.runStep(
    () =>
      updateNodeRun(db, node.id, { state: "running" }, {
        kind: "node.running",
        payload: { nodeIndex, jobId: node.id },
      }),
    { name: "markNodeRunning" },
  );

  // Poll with short steps separated by durable sleep. Cancellation is a
  // durable flag: deliver runner cancellation once, then keep polling until
  // the job is terminal AND its unit is inactive before touching the VM.
  let cancelDelivered = false;
  let snapshot: JobSnapshot;
  for (;;) {
    snapshot = await DBOS.runStep(() => adapter.inspectJob(node.id), {
      name: "inspectJob",
      ...TRANSPORT_RETRIES,
    });
    const cancelRequested = await DBOS.runStep(() => isCancelRequested(db, run.id), {
      name: "checkCancel",
    });
    if (cancelRequested && !cancelDelivered && !isTerminalJobState(snapshot.state)) {
      await DBOS.runStep(() => adapter.cancelJob(node.id), {
        name: "cancelJob",
        ...TRANSPORT_RETRIES,
      });
      cancelDelivered = true;
    }
    // unitActive === null means no supervising unit was ever launched (the
    // run died before spawn); there is no process left to wait for.
    if (isTerminalJobState(snapshot.state) && snapshot.unitActive !== true) break;
    await DBOS.sleep(pollIntervalMs);
  }

  const outcome: NodeOutcome =
    snapshot.state === "completed"
      ? "succeeded"
      : snapshot.state === "cancelled"
        ? "canceled"
        : snapshot.state === "interrupted"
          ? "interrupted"
          : "failed";

  await DBOS.runStep(
    () =>
      updateNodeRun(
        db,
        node.id,
        {
          state: outcome,
          exit_code: snapshot.exitCode,
          output_tail: snapshot.outputTail.slice(-16 * 1024),
          ...(snapshot.error ? { error: snapshot.error } : {}),
        },
        { kind: "node.finished", payload: { nodeIndex, outcome, exitCode: snapshot.exitCode } },
      ),
    { name: "recordNodeResult" },
  );

  // The job is terminal and its unit is confirmed inactive: the VM may go.
  await DBOS.runStep(() => adapter.releaseMachine(machine.machineId), {
    name: "releaseMachine",
    ...TRANSPORT_RETRIES,
  });
  await DBOS.runStep(
    () => updateNodeRun(db, node.id, { machine_released: true }, {
      kind: "node.machine_released",
      payload: { nodeIndex },
    }),
    { name: "recordMachineReleased" },
  );

  return outcome;
}

function buildManifestForNode(run: RunRow, node: NodeRunRow, command: string) {
  const name = run.nodes[node.node_index - 1]?.name ?? `script-${node.node_index}`;
  return buildScriptManifest({
    runId: node.id,
    taskText: `Workflow ${run.id} node ${node.node_index} (${name})`,
    repoName: run.repo_name,
    remoteUrl: run.remote_url,
    commitSha: run.commit_sha,
    snapshotName: run.snapshot_name,
    snapshotVersion: run.snapshot_version,
    command,
    deadlineSeconds: Number(run.deadline_seconds),
    createdAtMs: Number(node.created_at_ms),
  });
}

async function markSkipped(runId: string, nodeIndex: number): Promise<void> {
  const { db } = deps();
  const node = await DBOS.runStep(
    () => ensureNodeRun(db, runId, nodeIndex, Date.now()),
    { name: "ensureSkippedNodeRun" },
  );
  await DBOS.runStep(
    () =>
      updateNodeRun(db, node.id, { state: "skipped" }, {
        kind: "node.skipped",
        payload: { nodeIndex },
      }),
    { name: "markNodeSkipped" },
  );
}

/**
 * The sequence interpreter: run each script node in order, and a node runs
 * only when every predecessor succeeded (fail-fast). The node list comes
 * from the admitted run row, which pinned it (and any published workflow
 * version) at admission — publishing a later version never changes an
 * active run. DBOS is the execution authority; the application tables
 * written through steps are projections.
 */
async function sequenceWorkflowImpl(runId: string): Promise<{ status: string }> {
  const { db } = deps();
  const run = await DBOS.runStep(() => getRunById(db, runId), { name: "loadRun" });
  if (!run) return { status: "missing" };
  const nodeCount = run.nodes.length;

  const skipFrom = async (firstSkipped: number): Promise<void> => {
    for (let i = firstSkipped; i <= nodeCount; i += 1) await markSkipped(runId, i);
  };

  const preCanceled = await DBOS.runStep(() => isCancelRequested(db, run.id), {
    name: "checkCancelAtStart",
  });
  if (preCanceled) {
    await skipFrom(1);
    await DBOS.runStep(() => setRunStatus(db, runId, "canceled"), { name: "finalizeCanceled" });
    return { status: "canceled" };
  }

  await DBOS.runStep(() => setRunStatus(db, runId, "running"), { name: "markRunRunning" });

  let final: { status: "succeeded" | "failed" | "canceled"; error?: string } = {
    status: "succeeded",
  };
  try {
    for (let nodeIndex = 1; nodeIndex <= nodeCount; nodeIndex += 1) {
      if (nodeIndex > 1) {
        const midCancel = await DBOS.runStep(() => isCancelRequested(db, run.id), {
          name: "checkCancelBetweenNodes",
        });
        if (midCancel) {
          await skipFrom(nodeIndex);
          final = { status: "canceled" };
          break;
        }
      }
      const outcome = await runNode(run, nodeIndex);
      if (outcome !== "succeeded") {
        // Fail-fast: nothing downstream of a failed node is ever submitted.
        await skipFrom(nodeIndex + 1);
        final =
          outcome === "canceled"
            ? { status: "canceled" }
            : { status: "failed", error: `node ${nodeIndex} ${outcome}` };
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await DBOS.runStep(() => setRunStatus(db, runId, "failed", message), {
      name: "finalizeError",
    });
    throw err;
  }

  await DBOS.runStep(() => setRunStatus(db, runId, final.status, final.error), {
    name: "finalizeRun",
  });
  return { status: final.status };
}

/** Registered once per process; DBOS keys recovery to this workflow name. */
export const sequenceWorkflow = DBOS.registerWorkflow(sequenceWorkflowImpl, {
  name: "sequenceWorkflow",
});
