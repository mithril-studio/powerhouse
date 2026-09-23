import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { authenticate } from "./auth.js";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db.js";
import {
  IdempotencyConflictError,
  admitRun,
  getRun,
  nodeRuns,
  requestCancel,
  runEvents,
  type RunRequest,
  type RunRow,
  type SequenceNode,
} from "./runs.js";
import {
  WorkflowNameTakenError,
  createWorkflow,
  getVersion,
  getWorkflow,
  listVersions,
  listWorkflows,
  publishVersion,
  type WorkflowVersionContent,
} from "./workflows-store.js";

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_NODES = 10;
const MIN_DEADLINE = 60;
const MAX_DEADLINE = 86_400;

export interface ApiDeps {
  db: Db;
  config: ServerConfig;
  /** Starts the durable workflow for an admitted run; must be idempotent per run. */
  dispatch: (run: RunRow) => Promise<void>;
}

interface CreateRunBody {
  repoName?: unknown;
  remoteUrl?: unknown;
  commitSha?: unknown;
  snapshot?: { name?: unknown; version?: unknown };
  scripts?: unknown;
  idempotencyKey?: unknown;
  deadlineSeconds?: unknown;
}

function parseCreateRun(owner: string, body: CreateRunBody, defaults: ServerConfig): RunRequest | string {
  const remoteUrl = body.remoteUrl;
  if (typeof remoteUrl !== "string" || !/^(https:\/\/|git@)/.test(remoteUrl)) {
    return "remoteUrl must be an https:// or git@ repository URL";
  }
  if (/:\/\/[^/]*@/.test(remoteUrl)) return "remoteUrl must not embed credentials";
  const commitSha = body.commitSha;
  if (typeof commitSha !== "string" || !SHA_RE.test(commitSha)) {
    return "commitSha must be a full 40-hex lowercase commit SHA";
  }
  const snapshotName = body.snapshot?.name;
  if (typeof snapshotName !== "string" || snapshotName.length === 0) {
    return "snapshot.name is required";
  }
  const snapshotVersion = body.snapshot?.version ?? null;
  if (snapshotVersion !== null && typeof snapshotVersion !== "string") {
    return "snapshot.version must be a string when present";
  }
  const scripts = body.scripts;
  if (!Array.isArray(scripts) || scripts.length !== 2) {
    return "scripts must be exactly two script commands";
  }
  const commandError = validateCommands(scripts);
  if (commandError) return commandError;
  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200) {
    return "idempotencyKey is required (at most 200 characters)";
  }
  let deadlineSeconds = defaults.scriptDeadlineSeconds;
  if (body.deadlineSeconds !== undefined) {
    if (
      typeof body.deadlineSeconds !== "number" ||
      !Number.isInteger(body.deadlineSeconds) ||
      body.deadlineSeconds < MIN_DEADLINE ||
      body.deadlineSeconds > MAX_DEADLINE
    ) {
      return `deadlineSeconds must be an integer between ${MIN_DEADLINE} and ${MAX_DEADLINE}`;
    }
    deadlineSeconds = body.deadlineSeconds;
  }
  const repoName =
    typeof body.repoName === "string" && body.repoName.length > 0
      ? body.repoName
      : (remoteUrl.split("/").pop() ?? "repository").replace(/\.git$/, "");
  return {
    owner,
    idempotencyKey,
    repoName,
    remoteUrl,
    commitSha,
    snapshotName,
    snapshotVersion,
    nodes: (scripts as string[]).map((command, i) => ({ name: `script-${i + 1}`, command })),
    deadlineSeconds,
  };
}

function validateCommands(commands: unknown[]): string | null {
  for (const s of commands) {
    if (typeof s !== "string" || s.trim().length === 0 || s.length > MAX_SCRIPT_BYTES || s.includes("\0")) {
      return "each script must be a nonempty string of at most 64 KiB without NUL bytes";
    }
  }
  return null;
}

const NODE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a user-supplied node list for a published workflow version. */
function parseNodes(raw: unknown): SequenceNode[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_NODES) {
    return `nodes must be a list of 1 to ${MAX_NODES} script nodes`;
  }
  const nodes: SequenceNode[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const name = (entry as { name?: unknown })?.name;
    const command = (entry as { command?: unknown })?.command;
    if (typeof name !== "string" || !NODE_NAME_RE.test(name)) {
      return "each node needs a kebab-case name (max 64 chars)";
    }
    if (seen.has(name)) return `duplicate node name ${name}`;
    seen.add(name);
    const commandError = validateCommands([command]);
    if (commandError) return commandError;
    nodes.push({ name, command: command as string });
  }
  return nodes;
}

/** Validate the body shared by workflow create and publish-version. */
function parseVersionContent(body: {
  remoteUrl?: unknown;
  repoName?: unknown;
  snapshot?: { name?: unknown };
  nodes?: unknown;
}): WorkflowVersionContent | string {
  const remoteUrl = body.remoteUrl;
  if (typeof remoteUrl !== "string" || !/^(https:\/\/|git@)/.test(remoteUrl)) {
    return "remoteUrl must be an https:// or git@ repository URL";
  }
  if (/:\/\/[^/]*@/.test(remoteUrl)) return "remoteUrl must not embed credentials";
  const snapshotName = body.snapshot?.name;
  if (typeof snapshotName !== "string" || snapshotName.length === 0) {
    return "snapshot.name is required";
  }
  const nodes = parseNodes(body.nodes);
  if (typeof nodes === "string") return nodes;
  const repoName =
    typeof body.repoName === "string" && body.repoName.length > 0
      ? body.repoName
      : (remoteUrl.split("/").pop() ?? "repository").replace(/\.git$/, "");
  return { repoName, remoteUrl, snapshotName, nodes };
}

function runView(run: RunRow) {
  return {
    id: run.id,
    status: run.status,
    cancelRequested: run.cancel_requested,
    repoName: run.repo_name,
    remoteUrl: run.remote_url,
    commitSha: run.commit_sha,
    snapshot: { name: run.snapshot_name, version: run.snapshot_version },
    workflowId: run.workflow_id,
    workflowVersion: run.workflow_version,
    nodes: run.nodes,
    error: run.error,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

export function buildApp(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 });
  const { db, config } = deps;

  const requireOwner = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const owner = authenticate(config.tokens, req.headers.authorization);
    if (!owner) {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return owner;
  };

  app.get("/health", async (_req, reply) => {
    try {
      await db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.post("/v1/runs", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const parsed = parseCreateRun(owner, (req.body ?? {}) as CreateRunBody, config);
    if (typeof parsed === "string") return reply.code(400).send({ error: parsed });
    let admitted;
    try {
      admitted = await admitRun(db, parsed);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
    // Dispatch after commit; a crash here is repaired by the boot reconciler.
    await deps.dispatch(admitted.run);
    return reply.code(admitted.created ? 202 : 200).send({
      runId: admitted.run.id,
      status: admitted.run.status,
      duplicate: !admitted.created,
    });
  });

  app.get("/v1/runs/:id", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    const run = await getRun(db, owner, id);
    if (!run) return reply.code(404).send({ error: "not found" });
    const nodes = await nodeRuns(db, run.id);
    const events = await runEvents(db, run.id);
    return {
      run: runView(run),
      nodes: nodes.map((n) => ({
        nodeIndex: n.node_index,
        jobId: n.id,
        state: n.state,
        machineName: n.machine_name,
        machineId: n.machine_id,
        machineReleased: n.machine_released,
        exitCode: n.exit_code,
        outputTail: n.output_tail,
        error: n.error,
      })),
      events: events.map((e) => ({
        seq: Number(e.seq),
        kind: e.kind,
        payload: e.payload,
        at: e.created_at,
      })),
    };
  });

  app.post("/v1/workflows", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const body = (req.body ?? {}) as { name?: unknown } & Parameters<typeof parseVersionContent>[0];
    if (typeof body.name !== "string" || !NODE_NAME_RE.test(body.name)) {
      return reply.code(400).send({ error: "name must be kebab-case (max 64 chars)" });
    }
    const content = parseVersionContent(body);
    if (typeof content === "string") return reply.code(400).send({ error: content });
    try {
      const { workflow, version } = await createWorkflow(db, owner, body.name, content);
      return reply.code(201).send({
        workflowId: workflow.id,
        name: workflow.name,
        version: version.version,
      });
    } catch (err) {
      if (err instanceof WorkflowNameTakenError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/v1/workflows", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const rows = await listWorkflows(db, owner);
    return {
      workflows: rows.map((w) => ({
        workflowId: w.id,
        name: w.name,
        latestVersion: w.latest_version,
        createdAt: w.created_at,
      })),
    };
  });

  app.get("/v1/workflows/:id", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    const workflow = await getWorkflow(db, owner, id);
    if (!workflow) return reply.code(404).send({ error: "not found" });
    const versions = await listVersions(db, id);
    return {
      workflowId: workflow.id,
      name: workflow.name,
      latestVersion: workflow.latest_version,
      versions: versions.map((v) => ({
        version: v.version,
        content: v.content,
        contentHash: v.content_hash,
        createdAt: v.created_at,
      })),
    };
  });

  app.post("/v1/workflows/:id/versions", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    const content = parseVersionContent((req.body ?? {}) as Parameters<typeof parseVersionContent>[0]);
    if (typeof content === "string") return reply.code(400).send({ error: content });
    const version = await publishVersion(db, owner, id, content);
    if (!version) return reply.code(404).send({ error: "not found" });
    return reply.code(201).send({ workflowId: id, version: version.version });
  });

  app.post("/v1/workflows/:id/runs", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    const workflow = await getWorkflow(db, owner, id);
    if (!workflow) return reply.code(404).send({ error: "not found" });
    const body = (req.body ?? {}) as {
      version?: unknown;
      commitSha?: unknown;
      snapshotVersion?: unknown;
      idempotencyKey?: unknown;
      deadlineSeconds?: unknown;
    };
    let versionNumber = workflow.latest_version;
    if (body.version !== undefined) {
      if (!Number.isInteger(body.version) || (body.version as number) < 1) {
        return reply.code(400).send({ error: "version must be a positive integer" });
      }
      versionNumber = body.version as number;
    }
    const version = await getVersion(db, id, versionNumber);
    if (!version) return reply.code(404).send({ error: `version ${versionNumber} not found` });
    if (typeof body.commitSha !== "string" || !SHA_RE.test(body.commitSha)) {
      return reply.code(400).send({ error: "commitSha must be a full 40-hex lowercase commit SHA" });
    }
    if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length === 0 || body.idempotencyKey.length > 200) {
      return reply.code(400).send({ error: "idempotencyKey is required (at most 200 characters)" });
    }
    const snapshotVersion = body.snapshotVersion ?? null;
    if (snapshotVersion !== null && typeof snapshotVersion !== "string") {
      return reply.code(400).send({ error: "snapshotVersion must be a string when present" });
    }
    let deadlineSeconds = config.scriptDeadlineSeconds;
    if (body.deadlineSeconds !== undefined) {
      if (
        typeof body.deadlineSeconds !== "number" ||
        !Number.isInteger(body.deadlineSeconds) ||
        body.deadlineSeconds < MIN_DEADLINE ||
        body.deadlineSeconds > MAX_DEADLINE
      ) {
        return reply
          .code(400)
          .send({ error: `deadlineSeconds must be an integer between ${MIN_DEADLINE} and ${MAX_DEADLINE}` });
      }
      deadlineSeconds = body.deadlineSeconds;
    }
    // The run pins the version's content at admission; later publishes
    // never touch it.
    const request: RunRequest = {
      owner,
      idempotencyKey: body.idempotencyKey,
      repoName: version.content.repoName,
      remoteUrl: version.content.remoteUrl,
      commitSha: body.commitSha,
      snapshotName: version.content.snapshotName,
      snapshotVersion,
      nodes: version.content.nodes,
      deadlineSeconds,
      workflowId: id,
      workflowVersion: versionNumber,
    };
    let admitted;
    try {
      admitted = await admitRun(db, request);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
    await deps.dispatch(admitted.run);
    return reply.code(admitted.created ? 202 : 200).send({
      runId: admitted.run.id,
      workflowId: id,
      workflowVersion: versionNumber,
      status: admitted.run.status,
      duplicate: !admitted.created,
    });
  });

  app.post("/v1/runs/:id/cancel", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const { id } = req.params as { id: string };
    const known = await requestCancel(db, owner, id);
    if (!known) return reply.code(404).send({ error: "not found" });
    const run = await getRun(db, owner, id);
    return { runId: id, status: run?.status };
  });

  return app;
}
