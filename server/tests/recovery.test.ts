import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FakeExecutionAdapter } from "../src/adapters/fake.js";
import {
  postRun,
  runBody,
  startStack,
  waitForNodeState,
  waitForStatus,
} from "./helpers/coordinator.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("coordinator recovery", () => {
  it("lost responses after machine creation and job submission recover the originals", async () => {
    const fake = new FakeExecutionAdapter();
    const stack = await startStack(fake);
    try {
      // Both faults hit node 1: the actions happen, the responses are lost,
      // and the retried steps must adopt the existing machine and job.
      fake.failNext("ensureMachine");
      fake.failNext("submitJob");
      const res = await postRun(stack.app, runBody());
      const view = await waitForStatus(stack.app, res.body.runId!, ["succeeded", "failed"]);
      expect(view.run.status).toBe("succeeded");
      expect(fake.machinesCreated).toBe(2);
      expect(fake.jobsExecuted).toBe(2);
    } finally {
      await stack.stop();
    }
  });

  it("restart after machine creation recovers the same machine and never reruns script 1", async () => {
    const fake = new FakeExecutionAdapter();
    const stack = await startStack(fake);
    const res = await postRun(stack.app, runBody());
    const runId = res.body.runId!;

    // Let node 1 finish provisioning+submission, then trap node 2's
    // machine-creation right after its side effect — the classic
    // "action done, response never recorded" crash point.
    await waitForNodeState(stack.app, runId, 1, ["running", "succeeded"]);
    const gate = fake.gate("ensureMachine");
    await gate.entered;

    const stopping = stack.stop();
    await sleep(50);
    gate.release();
    await stopping;

    await stack.restart();
    try {
      const view = await waitForStatus(stack.app, runId, ["succeeded", "failed"]);
      expect(view.run.status).toBe("succeeded");
      // One machine per node and one execution per script — recovery
      // adopted the machine created before the restart and script 1 was
      // not rerun.
      expect(fake.machinesCreated).toBe(2);
      expect(fake.jobsExecuted).toBe(2);
    } finally {
      await stack.stop();
    }
  });

  it("restart after runner acceptance recovers the same job", async () => {
    const fake = new FakeExecutionAdapter();
    const stack = await startStack(fake);
    const res = await postRun(stack.app, runBody());
    const runId = res.body.runId!;

    await waitForNodeState(stack.app, runId, 1, ["running", "succeeded"]);
    const gate = fake.gate("submitJob");
    await gate.entered;

    const stopping = stack.stop();
    await sleep(50);
    gate.release();
    await stopping;

    await stack.restart();
    try {
      const view = await waitForStatus(stack.app, runId, ["succeeded", "failed"]);
      expect(view.run.status).toBe("succeeded");
      expect(fake.jobsExecuted).toBe(2);
      expect(fake.machinesCreated).toBe(2);
    } finally {
      await stack.stop();
    }
  });

  it("completed node results survive a coordinator restart", async () => {
    const fake = new FakeExecutionAdapter();
    const stack = await startStack(fake);
    const res = await postRun(stack.app, runBody());
    const runId = res.body.runId!;
    const before = await waitForStatus(stack.app, runId, ["succeeded"]);

    await stack.stop();
    await stack.restart();
    try {
      const after = await waitForStatus(stack.app, runId, ["succeeded"]);
      expect(after.run.status).toBe("succeeded");
      expect(after.nodes).toHaveLength(2);
      expect(after.nodes.map((n: any) => n.state)).toEqual(["succeeded", "succeeded"]);
      expect(after.nodes[0].exitCode).toBe(0);
      expect(after.nodes[0].outputTail).toBe(before.nodes[0].outputTail);
      // No new external activity happened to serve the read.
      expect(fake.jobsExecuted).toBe(2);
    } finally {
      await stack.stop();
    }
  });

  it("re-dispatches a run that committed before its DBOS dispatch", async () => {
    const fake = new FakeExecutionAdapter();
    const stack = await startStack(fake);
    // Simulate a crash between admission commit and DBOS dispatch: a
    // pending_dispatch row no workflow knows about.
    const id = randomUUID();
    await stack.db.query(
      `INSERT INTO workflow_runs
         (id, owner, idempotency_key, request_digest, dbos_workflow_id,
          repo_name, remote_url, commit_sha, snapshot_name, snapshot_version,
          script_1, script_2, deadline_seconds, status)
       VALUES ($1,'owner-a','crashed-key','digest',$2,
               'powerhouse','https://github.com/mithril-studio/powerhouse.git',
               $3,'powerhouse-base','v1',
               'printf one','printf two',300,'pending_dispatch')`,
      [id, `two-script-${id}`, "db2b7c51b4cb9f64816e15675f2453fdb86a977f"],
    );
    await stack.stop();
    await stack.restart();
    try {
      const view = await waitForStatus(stack.app, id, ["succeeded"]);
      expect(view.run.status).toBe("succeeded");
    } finally {
      await stack.stop();
    }
  });
});
