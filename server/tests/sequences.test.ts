import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { FakeExecutionAdapter } from "../src/adapters/fake.js";
import {
  OWNER_A_TOKEN,
  OWNER_B_TOKEN,
  startStack,
  waitForStatus,
  type TestStack,
} from "./helpers/coordinator.js";

const SHA = "db2b7c51b4cb9f64816e15675f2453fdb86a977f";

function workflowBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `seq-${randomBytes(3).toString("hex")}`,
    remoteUrl: "https://github.com/mithril-studio/powerhouse.git",
    snapshot: { name: "powerhouse-base" },
    nodes: [
      { name: "prepare", command: "printf 'prepare\\n'" },
      { name: "build", command: "printf 'build\\n'" },
      { name: "check", command: "printf 'check\\n'" },
    ],
    ...overrides,
  };
}

async function api(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
  token = OWNER_A_TOKEN,
): Promise<{ statusCode: number; body: any }> {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe("published workflow sequences (increment 1)", () => {
  let fake: FakeExecutionAdapter;
  let stack: TestStack;

  beforeAll(async () => {
    fake = new FakeExecutionAdapter();
    stack = await startStack(fake);
  });

  afterAll(async () => {
    await stack.stop();
  });

  it("publishes a workflow and runs its three nodes in order", async () => {
    const created = await api(stack.app, "POST", "/v1/workflows", workflowBody());
    expect(created.statusCode).toBe(201);
    expect(created.body.version).toBe(1);
    const workflowId = created.body.workflowId;

    const run = await api(stack.app, "POST", `/v1/workflows/${workflowId}/runs`, {
      commitSha: SHA,
      idempotencyKey: "seed-run-1",
    });
    expect(run.statusCode).toBe(202);
    expect(run.body.workflowVersion).toBe(1);

    const view = await waitForStatus(stack.app, run.body.runId, ["succeeded", "failed"]);
    expect(view.run.status).toBe("succeeded");
    expect(view.run.workflowId).toBe(workflowId);
    expect(view.run.workflowVersion).toBe(1);
    expect(view.nodes).toHaveLength(3);
    expect(view.nodes.map((n: any) => n.state)).toEqual(["succeeded", "succeeded", "succeeded"]);

    // Node jobs executed strictly in sequence.
    const order = view.nodes.map((n: any) => fake.actions.indexOf(`job.execute:${n.jobId}`));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]);
    expect(order[2]).toBeGreaterThan(order[1]);
  });

  it("duplicate run submissions against a version produce one run", async () => {
    const created = await api(stack.app, "POST", "/v1/workflows", workflowBody());
    const workflowId = created.body.workflowId;
    const payload = { commitSha: SHA, idempotencyKey: "dup-key" };
    const first = await api(stack.app, "POST", `/v1/workflows/${workflowId}/runs`, payload);
    const second = await api(stack.app, "POST", `/v1/workflows/${workflowId}/runs`, payload);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.runId).toBe(first.body.runId);
    await waitForStatus(stack.app, first.body.runId, ["succeeded"]);
  });

  it("a failed node blocks every downstream node", async () => {
    const created = await api(
      stack.app,
      "POST",
      "/v1/workflows",
      workflowBody({
        nodes: [
          { name: "ok", command: "printf 'ok\\n'" },
          { name: "boom", command: "exit 1" },
          { name: "never", command: "printf 'never\\n'" },
        ],
      }),
    );
    const workflowId = created.body.workflowId;
    const jobsBefore = fake.jobsExecuted;
    const run = await api(stack.app, "POST", `/v1/workflows/${workflowId}/runs`, {
      commitSha: SHA,
      idempotencyKey: "fail-fast",
    });
    const view = await waitForStatus(stack.app, run.body.runId, ["failed", "succeeded"]);
    expect(view.run.status).toBe("failed");
    expect(view.nodes.map((n: any) => n.state)).toEqual(["succeeded", "failed", "skipped"]);
    // Only the two nodes before the cut ever reached the runner.
    expect(fake.jobsExecuted).toBe(jobsBefore + 2);
  });

  it("published versions are immutable: a pinned run keeps executing v1 after v2 is published", async () => {
    const created = await api(stack.app, "POST", "/v1/workflows", workflowBody());
    const workflowId = created.body.workflowId;

    const run = await api(stack.app, "POST", `/v1/workflows/${workflowId}/runs`, {
      commitSha: SHA,
      idempotencyKey: "pin-v1",
      version: 1,
    });
    expect(run.statusCode).toBe(202);

    // Publish v2 with different nodes while (or after) the v1 run executes.
    const v2 = await api(stack.app, "POST", `/v1/workflows/${workflowId}/versions`, {
      remoteUrl: "https://github.com/mithril-studio/powerhouse.git",
      snapshot: { name: "powerhouse-base" },
      nodes: [{ name: "only", command: "printf 'v2\\n'" }],
    });
    expect(v2.statusCode).toBe(201);
    expect(v2.body.version).toBe(2);

    const view = await waitForStatus(stack.app, run.body.runId, ["succeeded"]);
    expect(view.run.workflowVersion).toBe(1);
    expect(view.nodes).toHaveLength(3);
    expect(view.run.nodes.map((n: any) => n.name)).toEqual(["prepare", "build", "check"]);

    // v1's stored content is untouched.
    const detail = await api(stack.app, "GET", `/v1/workflows/${workflowId}`);
    const v1 = detail.body.versions.find((v: any) => v.version === 1);
    expect(v1.content.nodes).toHaveLength(3);
    expect(detail.body.latestVersion).toBe(2);

    // A new run without a pinned version uses v2.
    const runV2 = await api(stack.app, "POST", `/v1/workflows/${workflowId}/runs`, {
      commitSha: SHA,
      idempotencyKey: "latest-v2",
    });
    expect(runV2.body.workflowVersion).toBe(2);
    const viewV2 = await waitForStatus(stack.app, runV2.body.runId, ["succeeded"]);
    expect(viewV2.nodes).toHaveLength(1);
  });

  it("rejects invalid definitions and enforces ownership", async () => {
    const empty = await api(stack.app, "POST", "/v1/workflows", workflowBody({ nodes: [] }));
    expect(empty.statusCode).toBe(400);
    const dupNames = await api(
      stack.app,
      "POST",
      "/v1/workflows",
      workflowBody({ nodes: [{ name: "a", command: "x" }, { name: "a", command: "y" }] }),
    );
    expect(dupNames.statusCode).toBe(400);
    const tooMany = await api(
      stack.app,
      "POST",
      "/v1/workflows",
      workflowBody({
        nodes: Array.from({ length: 11 }, (_, i) => ({ name: `n-${i}`, command: "x" })),
      }),
    );
    expect(tooMany.statusCode).toBe(400);
    const badName = await api(stack.app, "POST", "/v1/workflows", workflowBody({ name: "Bad Name!" }));
    expect(badName.statusCode).toBe(400);

    // Owner B cannot see or run owner A's workflow.
    const created = await api(stack.app, "POST", "/v1/workflows", workflowBody());
    const workflowId = created.body.workflowId;
    const foreignGet = await api(stack.app, "GET", `/v1/workflows/${workflowId}`, undefined, OWNER_B_TOKEN);
    expect(foreignGet.statusCode).toBe(404);
    const foreignRun = await api(
      stack.app,
      "POST",
      `/v1/workflows/${workflowId}/runs`,
      { commitSha: SHA, idempotencyKey: "foreign" },
      OWNER_B_TOKEN,
    );
    expect(foreignRun.statusCode).toBe(404);

    // Duplicate workflow names per owner are rejected.
    const name = created.body.name ?? undefined;
    const again = await api(stack.app, "POST", "/v1/workflows", { ...workflowBody(), name: (await api(stack.app, "GET", `/v1/workflows/${workflowId}`)).body.name });
    expect(again.statusCode).toBe(409);
  });

  it("a mid-sequence restart keeps completed nodes and never reruns them", async () => {
    const created = await api(stack.app, "POST", "/v1/workflows", workflowBody());
    const workflowId = created.body.workflowId;
    const run = await api(stack.app, "POST", `/v1/workflows/${workflowId}/runs`, {
      commitSha: SHA,
      idempotencyKey: "restart-seq",
    });
    const runId = run.body.runId;

    // Trap node 2's machine creation, then restart the coordinator there.
    const jobsBefore = fake.jobsExecuted;
    const machinesBefore = fake.machinesCreated;
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 30_000;
      const tick = () => {
        if (fake.jobsExecuted > jobsBefore) return resolve();
        if (Date.now() > deadline) return reject(new Error("node 1 never submitted"));
        setTimeout(tick, 20);
      };
      tick();
    });
    const gate = fake.gate("ensureMachine");
    await gate.entered;
    const stopping = stack.stop();
    await new Promise((r) => setTimeout(r, 50));
    gate.release();
    await stopping;
    await stack.restart();

    const view = await waitForStatus(stack.app, runId, ["succeeded", "failed"]);
    expect(view.run.status).toBe("succeeded");
    expect(view.nodes.map((n: any) => n.state)).toEqual(["succeeded", "succeeded", "succeeded"]);
    // Three executions and three machines total: nothing was duplicated by
    // the restart.
    expect(fake.jobsExecuted).toBe(jobsBefore + 3);
    expect(fake.machinesCreated).toBe(machinesBefore + 3);
  });
});
