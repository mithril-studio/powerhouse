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
} from "./runs.js";

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_SCRIPT_BYTES = 64 * 1024;
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
  for (const s of scripts) {
    if (typeof s !== "string" || s.trim().length === 0 || s.length > MAX_SCRIPT_BYTES || s.includes("\0")) {
      return "each script must be a nonempty string of at most 64 KiB without NUL bytes";
    }
  }
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
    scripts: [scripts[0] as string, scripts[1] as string],
    deadlineSeconds,
  };
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
