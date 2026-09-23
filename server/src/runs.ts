import { createHash, randomUUID } from "node:crypto";

import type pg from "pg";

import type { Db } from "./db.js";
import { machineNameForJob } from "./adapters/types.js";

export type RunStatus =
  | "pending_dispatch"
  | "dispatched"
  | "running"
  | "succeeded"
  | "failed"
  | "canceling"
  | "canceled";

export type NodeState =
  | "pending"
  | "provisioning"
  | "submitting"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted"
  | "skipped";

/** One script node of a sequence: ordered, named, fail-fast. */
export interface SequenceNode {
  name: string;
  command: string;
}

export interface RunRequest {
  owner: string;
  idempotencyKey: string;
  repoName: string;
  remoteUrl: string;
  commitSha: string;
  snapshotName: string;
  snapshotVersion: string | null;
  nodes: SequenceNode[];
  deadlineSeconds: number;
  /** Set when the run executes a published workflow version. */
  workflowId?: string;
  workflowVersion?: number;
}

export interface RunRow {
  id: string;
  owner: string;
  idempotency_key: string;
  request_digest: string;
  dbos_workflow_id: string;
  repo_name: string;
  remote_url: string;
  commit_sha: string;
  snapshot_name: string;
  snapshot_version: string | null;
  nodes: SequenceNode[];
  workflow_id: string | null;
  workflow_version: number | null;
  deadline_seconds: string | number;
  status: RunStatus;
  cancel_requested: boolean;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NodeRunRow {
  id: string;
  run_id: string;
  node_index: number;
  machine_name: string;
  machine_id: string | null;
  manifest_digest: string | null;
  created_at_ms: string | number;
  state: NodeState;
  exit_code: number | null;
  output_tail: string | null;
  error: string | null;
  machine_released: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key already used with a different request payload");
    this.name = "IdempotencyConflictError";
  }
}

function requestDigest(req: RunRequest): string {
  const canonical = JSON.stringify([
    req.repoName,
    req.remoteUrl,
    req.commitSha,
    req.snapshotName,
    req.snapshotVersion,
    req.nodes.map((n) => [n.name, n.command]),
    req.deadlineSeconds,
    req.workflowId ?? null,
    req.workflowVersion ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

const MAX_EVENT_PAYLOAD = 8 * 1024;

/**
 * Append a run event and bump the run's `updated_at` inside the caller's
 * transaction. Events and projection updates always commit together.
 */
export async function appendEvent(
  tx: pg.PoolClient,
  runId: string,
  kind: string,
  payload: Record<string, unknown>,
  nodeRunId?: string,
): Promise<void> {
  let body = JSON.stringify(payload);
  if (body.length > MAX_EVENT_PAYLOAD) {
    body = JSON.stringify({ truncated: true, kind });
  }
  await tx.query(
    `INSERT INTO workflow_run_events (run_id, seq, node_run_id, kind, payload)
     SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4::jsonb
     FROM workflow_run_events WHERE run_id = $1`,
    [runId, nodeRunId ?? null, kind, body],
  );
}

async function inTx<T>(db: Db, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Admit a run exactly once per (owner, idempotency key). The run commits as
 * `pending_dispatch` with its stable DBOS workflow ID before anyone talks to
 * DBOS; a crash between commit and dispatch is repaired by the boot
 * reconciler re-dispatching with that same ID.
 */
export async function admitRun(db: Db, req: RunRequest): Promise<{ run: RunRow; created: boolean }> {
  const digest = requestDigest(req);
  return inTx(db, async (tx) => {
    // Serialize concurrent submissions of the same key.
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`${req.owner}:${req.idempotencyKey}`],
    );
    const existing = await tx.query<RunRow>(
      "SELECT * FROM workflow_runs WHERE owner = $1 AND idempotency_key = $2",
      [req.owner, req.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_digest !== digest) throw new IdempotencyConflictError();
      return { run: existing.rows[0], created: false };
    }
    const id = randomUUID();
    const inserted = await tx.query<RunRow>(
      `INSERT INTO workflow_runs
         (id, owner, idempotency_key, request_digest, dbos_workflow_id,
          repo_name, remote_url, commit_sha, snapshot_name, snapshot_version,
          nodes, workflow_id, workflow_version, deadline_seconds, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,'pending_dispatch')
       RETURNING *`,
      [
        id,
        req.owner,
        req.idempotencyKey,
        digest,
        `run-${id}`,
        req.repoName,
        req.remoteUrl,
        req.commitSha,
        req.snapshotName,
        req.snapshotVersion,
        JSON.stringify(req.nodes),
        req.workflowId ?? null,
        req.workflowVersion ?? null,
        req.deadlineSeconds,
      ],
    );
    await appendEvent(tx, id, "run.admitted", {
      idempotencyKey: req.idempotencyKey,
      nodeCount: req.nodes.length,
      ...(req.workflowId ? { workflowId: req.workflowId, workflowVersion: req.workflowVersion } : {}),
    });
    return { run: inserted.rows[0]!, created: true };
  });
}

export async function markDispatched(db: Db, runId: string): Promise<void> {
  await db.query(
    `UPDATE workflow_runs SET status = 'dispatched', updated_at = now()
     WHERE id = $1 AND status = 'pending_dispatch'`,
    [runId],
  );
}

/** Runs whose DBOS dispatch may not have happened; re-dispatched at boot. */
export async function undispatchedRuns(db: Db): Promise<RunRow[]> {
  const res = await db.query<RunRow>(
    "SELECT * FROM workflow_runs WHERE status = 'pending_dispatch' ORDER BY created_at",
  );
  return res.rows;
}

export async function getRun(db: Db, owner: string, runId: string): Promise<RunRow | null> {
  const res = await db.query<RunRow>(
    "SELECT * FROM workflow_runs WHERE id = $1 AND owner = $2",
    [runId, owner],
  );
  return res.rows[0] ?? null;
}

export async function getRunById(db: Db, runId: string): Promise<RunRow | null> {
  const res = await db.query<RunRow>("SELECT * FROM workflow_runs WHERE id = $1", [runId]);
  return res.rows[0] ?? null;
}

export async function nodeRuns(db: Db, runId: string): Promise<NodeRunRow[]> {
  const res = await db.query<NodeRunRow>(
    "SELECT * FROM workflow_node_runs WHERE run_id = $1 ORDER BY node_index",
    [runId],
  );
  return res.rows;
}

export async function runEvents(
  db: Db,
  runId: string,
  afterSeq = 0,
  limit = 200,
): Promise<{ seq: string; kind: string; payload: unknown; created_at: Date }[]> {
  const res = await db.query(
    `SELECT seq, kind, payload, created_at FROM workflow_run_events
     WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [runId, afterSeq, limit],
  );
  return res.rows;
}

export async function setRunStatus(
  db: Db,
  runId: string,
  status: RunStatus,
  error?: string,
): Promise<void> {
  await inTx(db, async (tx) => {
    await tx.query(
      "UPDATE workflow_runs SET status = $2, error = COALESCE($3, error), updated_at = now() WHERE id = $1",
      [runId, status, error ?? null],
    );
    await appendEvent(tx, runId, "run.status", { status, ...(error ? { error } : {}) });
  });
}

/** Record durable cancel intent. Returns false when the run is already terminal. */
export async function requestCancel(db: Db, owner: string, runId: string): Promise<boolean> {
  return inTx(db, async (tx) => {
    const res = await tx.query<RunRow>(
      "SELECT * FROM workflow_runs WHERE id = $1 AND owner = $2 FOR UPDATE",
      [runId, owner],
    );
    const run = res.rows[0];
    if (!run) return false;
    if (["succeeded", "failed", "canceled"].includes(run.status)) return true;
    await tx.query(
      `UPDATE workflow_runs SET cancel_requested = TRUE, status = 'canceling', updated_at = now()
       WHERE id = $1`,
      [runId],
    );
    await appendEvent(tx, runId, "run.cancel_requested", {});
    return true;
  });
}

export async function isCancelRequested(db: Db, runId: string): Promise<boolean> {
  const res = await db.query<{ cancel_requested: boolean }>(
    "SELECT cancel_requested FROM workflow_runs WHERE id = $1",
    [runId],
  );
  return res.rows[0]?.cancel_requested ?? false;
}

/**
 * Create (or return the existing) node-run row. The stable job UUID and
 * machine name are durable BEFORE any external action uses them; recovery
 * re-reads this row instead of minting new identities.
 */
export async function ensureNodeRun(
  db: Db,
  runId: string,
  nodeIndex: number,
  nowMs: number,
): Promise<NodeRunRow> {
  return inTx(db, async (tx) => {
    const existing = await tx.query<NodeRunRow>(
      "SELECT * FROM workflow_node_runs WHERE run_id = $1 AND node_index = $2",
      [runId, nodeIndex],
    );
    if (existing.rows[0]) return existing.rows[0];
    const id = randomUUID();
    const inserted = await tx.query<NodeRunRow>(
      `INSERT INTO workflow_node_runs (id, run_id, node_index, machine_name, created_at_ms, state)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (run_id, node_index) DO NOTHING
       RETURNING *`,
      [id, runId, nodeIndex, machineNameForJob(id), nowMs],
    );
    if (inserted.rows[0]) {
      await appendEvent(tx, runId, "node.created", { nodeIndex, jobId: id }, id);
      return inserted.rows[0];
    }
    const raced = await tx.query<NodeRunRow>(
      "SELECT * FROM workflow_node_runs WHERE run_id = $1 AND node_index = $2",
      [runId, nodeIndex],
    );
    return raced.rows[0]!;
  });
}

export async function updateNodeRun(
  db: Db,
  nodeRunId: string,
  fields: Partial<{
    machine_id: string;
    manifest_digest: string;
    state: NodeState;
    exit_code: number | null;
    output_tail: string;
    error: string;
    machine_released: boolean;
  }>,
  event?: { kind: string; payload: Record<string, unknown> },
): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0 && !event) return;
  await inTx(db, async (tx) => {
    if (keys.length > 0) {
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
      await tx.query(
        `UPDATE workflow_node_runs SET ${sets}, updated_at = now() WHERE id = $1`,
        [nodeRunId, ...keys.map((k) => (fields as Record<string, unknown>)[k])],
      );
    }
    if (event) {
      const run = await tx.query<{ run_id: string }>(
        "SELECT run_id FROM workflow_node_runs WHERE id = $1",
        [nodeRunId],
      );
      if (run.rows[0]) {
        await appendEvent(tx, run.rows[0].run_id, event.kind, event.payload, nodeRunId);
      }
    }
  });
}
