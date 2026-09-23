import { createHash, randomUUID } from "node:crypto";

import type { Db } from "./db.js";
import type { SequenceNode } from "./runs.js";

/** Immutable content of one published workflow version. */
export interface WorkflowVersionContent {
  repoName: string;
  remoteUrl: string;
  snapshotName: string;
  nodes: SequenceNode[];
}

export interface WorkflowRow {
  id: string;
  owner: string;
  name: string;
  latest_version: number;
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowVersionRow {
  workflow_id: string;
  version: number;
  content: WorkflowVersionContent;
  content_hash: string;
  created_at: Date;
}

export class WorkflowNameTakenError extends Error {
  constructor(name: string) {
    super(`a workflow named ${name} already exists`);
    this.name = "WorkflowNameTakenError";
  }
}

function contentHash(content: WorkflowVersionContent): string {
  const canonical = JSON.stringify([
    content.repoName,
    content.remoteUrl,
    content.snapshotName,
    content.nodes.map((n) => [n.name, n.command]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Create a workflow and publish its version 1 atomically. Published versions
 * are append-only: editing means publishing the next version, and existing
 * runs keep executing the version they pinned at admission.
 */
export async function createWorkflow(
  db: Db,
  owner: string,
  name: string,
  content: WorkflowVersionContent,
): Promise<{ workflow: WorkflowRow; version: WorkflowVersionRow }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const id = randomUUID();
    const inserted = await client.query<WorkflowRow>(
      `INSERT INTO workflows (id, owner, name, latest_version)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (owner, name) DO NOTHING
       RETURNING *`,
      [id, owner, name],
    );
    if (!inserted.rows[0]) {
      await client.query("ROLLBACK");
      throw new WorkflowNameTakenError(name);
    }
    const version = await client.query<WorkflowVersionRow>(
      `INSERT INTO workflow_versions (workflow_id, version, content, content_hash)
       VALUES ($1, 1, $2::jsonb, $3)
       RETURNING *`,
      [id, JSON.stringify(content), contentHash(content)],
    );
    await client.query("COMMIT");
    return { workflow: inserted.rows[0], version: version.rows[0]! };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Publish the next version of an existing workflow. Owner-scoped. */
export async function publishVersion(
  db: Db,
  owner: string,
  workflowId: string,
  content: WorkflowVersionContent,
): Promise<WorkflowVersionRow | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const wf = await client.query<WorkflowRow>(
      "SELECT * FROM workflows WHERE id = $1 AND owner = $2 FOR UPDATE",
      [workflowId, owner],
    );
    if (!wf.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const next = wf.rows[0].latest_version + 1;
    const version = await client.query<WorkflowVersionRow>(
      `INSERT INTO workflow_versions (workflow_id, version, content, content_hash)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING *`,
      [workflowId, next, JSON.stringify(content), contentHash(content)],
    );
    await client.query(
      "UPDATE workflows SET latest_version = $2, updated_at = now() WHERE id = $1",
      [workflowId, next],
    );
    await client.query("COMMIT");
    return version.rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getWorkflow(
  db: Db,
  owner: string,
  workflowId: string,
): Promise<WorkflowRow | null> {
  const res = await db.query<WorkflowRow>(
    "SELECT * FROM workflows WHERE id = $1 AND owner = $2",
    [workflowId, owner],
  );
  return res.rows[0] ?? null;
}

export async function listWorkflows(db: Db, owner: string): Promise<WorkflowRow[]> {
  const res = await db.query<WorkflowRow>(
    "SELECT * FROM workflows WHERE owner = $1 ORDER BY created_at",
    [owner],
  );
  return res.rows;
}

export async function getVersion(
  db: Db,
  workflowId: string,
  version: number,
): Promise<WorkflowVersionRow | null> {
  const res = await db.query<WorkflowVersionRow>(
    "SELECT * FROM workflow_versions WHERE workflow_id = $1 AND version = $2",
    [workflowId, version],
  );
  return res.rows[0] ?? null;
}

export async function listVersions(db: Db, workflowId: string): Promise<WorkflowVersionRow[]> {
  const res = await db.query<WorkflowVersionRow>(
    "SELECT * FROM workflow_versions WHERE workflow_id = $1 ORDER BY version",
    [workflowId],
  );
  return res.rows;
}
