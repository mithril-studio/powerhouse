import { randomBytes } from "node:crypto";

import pg from "pg";
import type { FastifyInstance } from "fastify";

import type { ExecutionAdapter } from "../../src/adapters/types.js";
import type { ServerConfig } from "../../src/config.js";
import { createCoordinator, type Coordinator } from "../../src/coordinator.js";
import type { Db } from "../../src/db.js";

export const OWNER_A_TOKEN = "owner-a-secret-token-0001";
export const OWNER_B_TOKEN = "owner-b-secret-token-0002";

export interface TestStack {
  coordinator: Coordinator;
  app: FastifyInstance;
  db: Db;
  config: ServerConfig;
  /** Stop this coordinator; the databases (and any fake adapter) survive. */
  stop(): Promise<void>;
  /** Start a fresh coordinator against the same databases and adapter. */
  restart(): Promise<void>;
}

/** Create app + DBOS system databases unique to this test file run. */
export async function createTestDatabases(): Promise<{ appUrl: string; systemUrl: string }> {
  const base = process.env.PH_TEST_PG_URL;
  if (!base) throw new Error("PH_TEST_PG_URL missing — global setup did not run");
  const suffix = randomBytes(5).toString("hex");
  const appName = `ph_app_${suffix}`;
  const sysName = `ph_dbos_${suffix}`;
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${appName}`);
  await admin.query(`CREATE DATABASE ${sysName}`);
  await admin.end();
  return { appUrl: `${base}/${appName}`, systemUrl: `${base}/${sysName}` };
}

export async function startStack(
  adapter: ExecutionAdapter,
  options: { pollIntervalMs?: number; urls?: { appUrl: string; systemUrl: string } } = {},
): Promise<TestStack> {
  const urls = options.urls ?? (await createTestDatabases());
  const config: ServerConfig = {
    databaseUrl: urls.appUrl,
    systemDatabaseUrl: urls.systemUrl,
    port: 0,
    host: "127.0.0.1",
    tokens: [
      { owner: "owner-a", token: OWNER_A_TOKEN },
      { owner: "owner-b", token: OWNER_B_TOKEN },
    ],
    pollIntervalMs: options.pollIntervalMs ?? 25,
    scriptDeadlineSeconds: 300,
  };

  let coordinator = await createCoordinator(config, adapter);

  const stack: TestStack = {
    coordinator,
    app: coordinator.app,
    db: coordinator.db,
    config,
    async stop() {
      await coordinator.stop();
    },
    async restart() {
      coordinator = await createCoordinator(config, adapter);
      stack.coordinator = coordinator;
      stack.app = coordinator.app;
      stack.db = coordinator.db;
    },
  };
  return stack;
}

export interface RunRequestBody {
  remoteUrl?: string;
  commitSha?: string;
  snapshot?: { name: string; version?: string | null };
  scripts?: unknown;
  idempotencyKey?: string;
  deadlineSeconds?: number;
}

export function runBody(overrides: Partial<RunRequestBody> = {}): RunRequestBody {
  return {
    remoteUrl: "https://github.com/mithril-studio/powerhouse.git",
    commitSha: "db2b7c51b4cb9f64816e15675f2453fdb86a977f",
    snapshot: { name: "powerhouse-base", version: "v1" },
    scripts: ["printf 'one\\n'", "printf 'two\\n'"],
    idempotencyKey: `key-${randomBytes(4).toString("hex")}`,
    ...overrides,
  };
}

export async function postRun(
  app: FastifyInstance,
  body: RunRequestBody,
  token = OWNER_A_TOKEN,
): Promise<{ statusCode: number; body: { runId?: string; status?: string; duplicate?: boolean; error?: string } }> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: body,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

export async function getRunView(
  app: FastifyInstance,
  runId: string,
  token = OWNER_A_TOKEN,
): Promise<{ statusCode: number; body: any }> {
  const res = await app.inject({
    method: "GET",
    url: `/v1/runs/${runId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { statusCode: res.statusCode, body: res.statusCode === 200 ? res.json() : res.json() };
}

export async function cancelRun(
  app: FastifyInstance,
  runId: string,
  token = OWNER_A_TOKEN,
): Promise<{ statusCode: number; body: any }> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/runs/${runId}/cancel`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

/** Poll the API until the run reaches one of `statuses` (or time out). */
export async function waitForStatus(
  app: FastifyInstance,
  runId: string,
  statuses: string[],
  timeoutMs = 30_000,
  token = OWNER_A_TOKEN,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await getRunView(app, runId, token);
    if (view.statusCode === 200 && statuses.includes(view.body.run.status)) return view.body;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} did not reach ${statuses.join("/")} (last: ${JSON.stringify(view.body?.run ?? view.body)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Poll until a node reaches a given state. */
export async function waitForNodeState(
  app: FastifyInstance,
  runId: string,
  nodeIndex: number,
  states: string[],
  timeoutMs = 30_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await getRunView(app, runId);
    const node = view.body?.nodes?.find((n: any) => n.nodeIndex === nodeIndex);
    if (node && states.includes(node.state)) return node;
    if (Date.now() > deadline) {
      throw new Error(`node ${nodeIndex} of ${runId} did not reach ${states.join("/")}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
