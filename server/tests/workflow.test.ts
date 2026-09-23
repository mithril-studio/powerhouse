import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeExecutionAdapter } from "../src/adapters/fake.js";
import {
  postRun,
  runBody,
  startStack,
  waitForStatus,
  type TestStack,
} from "./helpers/coordinator.js";

describe("two-script workflow (fake adapter)", () => {
  let fake: FakeExecutionAdapter;
  let stack: TestStack;

  beforeAll(async () => {
    fake = new FakeExecutionAdapter();
    stack = await startStack(fake);
  });

  afterAll(async () => {
    await stack.stop();
  });

  it("runs script 2 only after script 1 succeeds, then cleans up", async () => {
    const res = await postRun(stack.app, runBody());
    expect(res.statusCode).toBe(202);
    const runId = res.body.runId!;

    const view = await waitForStatus(stack.app, runId, ["succeeded", "failed"]);
    expect(view.run.status).toBe("succeeded");
    expect(view.nodes).toHaveLength(2);
    expect(view.nodes[0].state).toBe("succeeded");
    expect(view.nodes[0].exitCode).toBe(0);
    expect(view.nodes[1].state).toBe("succeeded");
    expect(view.nodes[0].machineReleased).toBe(true);
    expect(view.nodes[1].machineReleased).toBe(true);

    // Script 2's job executed after script 1's finished.
    const job1 = `job.execute:${view.nodes[0].jobId}`;
    const job2 = `job.execute:${view.nodes[1].jobId}`;
    expect(fake.actions.indexOf(job1)).toBeGreaterThanOrEqual(0);
    expect(fake.actions.indexOf(job2)).toBeGreaterThan(fake.actions.indexOf(job1));
    // One machine and one execution per node, no duplicates.
    expect(fake.jobsExecuted).toBe(2);
    expect(fake.machinesCreated).toBe(2);
  });

  it("duplicate start requests produce one workflow run", async () => {
    const body = runBody({ idempotencyKey: "dedupe-key-1" });
    const first = await postRun(stack.app, body);
    const second = await postRun(stack.app, body);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.runId).toBe(first.body.runId);

    await waitForStatus(stack.app, first.body.runId!, ["succeeded"]);
    const runs = await stack.db.query(
      "SELECT COUNT(*) AS n FROM workflow_runs WHERE idempotency_key = $1",
      ["dedupe-key-1"],
    );
    expect(Number(runs.rows[0].n)).toBe(1);
  });

  it("rejects the same idempotency key with a different payload", async () => {
    const body = runBody({ idempotencyKey: "conflict-key-1" });
    const first = await postRun(stack.app, body);
    const conflicting = await postRun(stack.app, {
      ...body,
      scripts: ["printf 'other\\n'", "printf 'two\\n'"],
    });
    expect(conflicting.statusCode).toBe(409);
    // Let the admitted run settle so later tests see a quiet adapter.
    await waitForStatus(stack.app, first.body.runId!, ["succeeded"]);
  });

  it("failed script 1 blocks script 2 entirely", async () => {
    const jobsBefore = fake.jobsExecuted;
    const res = await postRun(
      stack.app,
      runBody({ scripts: ["exit 1", "printf 'never\\n'"] }),
    );
    const runId = res.body.runId!;
    const view = await waitForStatus(stack.app, runId, ["failed", "succeeded"]);
    expect(view.run.status).toBe("failed");
    expect(view.nodes[0].state).toBe("failed");
    expect(view.nodes[0].exitCode).toBe(1);
    expect(view.nodes[1].state).toBe("skipped");
    expect(view.nodes[1].machineId).toBeNull();
    // Only script 1 ever reached the runner.
    expect(fake.jobsExecuted).toBe(jobsBefore + 1);
    // The failed node's machine was still cleaned up.
    expect(view.nodes[0].machineReleased).toBe(true);
  });

  it("rejects runs that are not exactly two scripts", async () => {
    const one = await postRun(stack.app, runBody({ scripts: ["printf 'one\\n'"] }));
    expect(one.statusCode).toBe(400);
    const three = await postRun(stack.app, runBody({ scripts: ["a", "b", "c"] }));
    expect(three.statusCode).toBe(400);
  });
});
