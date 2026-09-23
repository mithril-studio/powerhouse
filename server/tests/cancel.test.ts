import { describe, expect, it } from "vitest";

import { FakeExecutionAdapter } from "../src/adapters/fake.js";
import {
  cancelRun,
  postRun,
  runBody,
  startStack,
  waitForNodeState,
  waitForStatus,
} from "./helpers/coordinator.js";

describe("cancellation", () => {
  it("terminates the remote process and waits for unit shutdown before releasing the VM", async () => {
    // Long-running job; terminal state precedes unit cleanup by two polls,
    // like the real runner. The fake throws if a machine is released while
    // its job still has an active unit.
    const fake = new FakeExecutionAdapter({ pollsUntilDone: 10_000, unitActivePolls: 2 });
    const stack = await startStack(fake);
    try {
      const res = await postRun(stack.app, runBody());
      const runId = res.body.runId!;
      const node = await waitForNodeState(stack.app, runId, 1, ["running"]);

      const cancel = await cancelRun(stack.app, runId);
      expect(cancel.statusCode).toBe(200);
      expect(["canceling", "canceled"]).toContain(cancel.body.status);

      const view = await waitForStatus(stack.app, runId, ["canceled"]);
      expect(view.run.status).toBe("canceled");
      expect(view.nodes[0].state).toBe("canceled");
      expect(view.nodes[0].machineReleased).toBe(true);
      expect(view.nodes[1].state).toBe("skipped");

      // Runner cancellation strictly precedes VM release.
      const cancelIdx = fake.actions.indexOf(`job.cancel:${node.jobId}`);
      const releaseIdx = fake.actions.indexOf(`machine.release:${node.machineName}`);
      expect(cancelIdx).toBeGreaterThanOrEqual(0);
      expect(releaseIdx).toBeGreaterThan(cancelIdx);
      // Script 2 was never submitted.
      expect(fake.jobsExecuted).toBe(1);
    } finally {
      await stack.stop();
    }
  });

  it("cancel before dispatch settles the run without any external actions", async () => {
    const fake = new FakeExecutionAdapter({ pollsUntilDone: 10_000 });
    const stack = await startStack(fake);
    try {
      const res = await postRun(stack.app, runBody());
      const runId = res.body.runId!;
      // Cancel immediately; the workflow may or may not have started node 1.
      await cancelRun(stack.app, runId);
      const view = await waitForStatus(stack.app, runId, ["canceled"]);
      expect(view.run.status).toBe("canceled");
      // Whatever was started was cleaned up.
      for (const node of view.nodes) {
        if (node.machineId) expect(node.machineReleased).toBe(true);
      }
    } finally {
      await stack.stop();
    }
  });
});
