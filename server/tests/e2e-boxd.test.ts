import { Boxd } from "@boxd-sh/sdk";
import { describe, expect, it } from "vitest";

import { BoxdExecutionAdapter } from "../src/adapters/boxd.js";
import {
  cancelRun,
  postRun,
  runBody,
  startStack,
  waitForNodeState,
  waitForStatus,
} from "./helpers/coordinator.js";

/**
 * Real-infrastructure acceptance gate (increment 0b) — runs the coordinator
 * against actual boxd microVMs and the published `powerhouse-base` runner
 * snapshot. Opt-in: RUN_BOXD_E2E=1 and BOXD_API_KEY must be set; each
 * scenario provisions and destroys real VMs and takes minutes.
 *
 * Uses a public repository so no credentials ever leave the laptop.
 */
const enabled = process.env.RUN_BOXD_E2E === "1" && !!process.env.BOXD_API_KEY;

const REPO = "https://github.com/octocat/Hello-World.git";
const SHA = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
const SNAPSHOT = { name: "powerhouse-base", version: "v2" };
const TIMEOUT = 20 * 60 * 1000;

function e2eBody(overrides: Parameters<typeof runBody>[0] = {}) {
  return runBody({
    remoteUrl: REPO,
    commitSha: SHA,
    snapshot: SNAPSHOT,
    deadlineSeconds: 600,
    ...overrides,
  });
}

async function leakedMachines(): Promise<string[]> {
  const boxd = new Boxd();
  const machines = await boxd.machines.list();
  return machines.map((m) => m.name).filter((name) => name.startsWith("ph-wf-"));
}

describe.runIf(enabled)("boxd real-infrastructure gate", () => {
  it(
    "runs both scripts on real VMs and recovers through a coordinator restart between nodes",
    { timeout: TIMEOUT },
    async () => {
      const adapter = new BoxdExecutionAdapter();
      const stack = await startStack(adapter, { pollIntervalMs: 3000 });
      const res = await postRun(
        stack.app,
        e2eBody({ scripts: ["printf 'node one\\n' && cat README", "ls -la && printf 'node two\\n'"] }),
      );
      expect(res.statusCode).toBe(202);
      const runId = res.body.runId!;

      // Restart the coordinator once script 1 has finished; recovery must
      // pick the run back up and drive script 2 on a fresh VM without
      // duplicating anything.
      await waitForNodeState(stack.app, runId, 1, ["succeeded"], TIMEOUT / 2);
      await stack.stop();
      await stack.restart();

      try {
        const view = await waitForStatus(stack.app, runId, ["succeeded", "failed"], TIMEOUT / 2);
        expect(view.run.status).toBe("succeeded");
        expect(view.nodes.map((n: any) => n.state)).toEqual(["succeeded", "succeeded"]);
        expect(view.nodes[0].exitCode).toBe(0);
        expect(view.nodes[0].outputTail).toContain("node one");
        expect(view.nodes[1].outputTail).toContain("node two");
        expect(view.nodes.every((n: any) => n.machineReleased)).toBe(true);
        expect(await leakedMachines()).toEqual([]);
      } finally {
        await stack.stop();
      }
    },
  );

  it(
    "a failing script blocks the second script and still cleans up its VM",
    { timeout: TIMEOUT },
    async () => {
      const adapter = new BoxdExecutionAdapter();
      const stack = await startStack(adapter, { pollIntervalMs: 3000 });
      try {
        const res = await postRun(stack.app, e2eBody({ scripts: ["exit 3", "printf 'never\\n'"] }));
        const view = await waitForStatus(stack.app, res.body.runId!, ["failed", "succeeded"], TIMEOUT);
        expect(view.run.status).toBe("failed");
        expect(view.nodes[0].state).toBe("failed");
        expect(view.nodes[0].exitCode).toBe(3);
        expect(view.nodes[1].state).toBe("skipped");
        expect(view.nodes[1].machineId).toBeNull();
        expect(view.nodes[0].machineReleased).toBe(true);
        expect(await leakedMachines()).toEqual([]);
      } finally {
        await stack.stop();
      }
    },
  );

  it(
    "cancellation terminates the remote process and releases the VM",
    { timeout: TIMEOUT },
    async () => {
      const adapter = new BoxdExecutionAdapter();
      const stack = await startStack(adapter, { pollIntervalMs: 3000 });
      try {
        const res = await postRun(stack.app, e2eBody({ scripts: ["sleep 600", "printf 'never\\n'"] }));
        const runId = res.body.runId!;
        await waitForNodeState(stack.app, runId, 1, ["running"], TIMEOUT / 2);
        const cancel = await cancelRun(stack.app, runId);
        expect(cancel.statusCode).toBe(200);
        const view = await waitForStatus(stack.app, runId, ["canceled"], TIMEOUT / 2);
        expect(view.run.status).toBe("canceled");
        expect(view.nodes[0].state).toBe("canceled");
        expect(view.nodes[0].machineReleased).toBe(true);
        expect(view.nodes[1].state).toBe("skipped");
        expect(await leakedMachines()).toEqual([]);
      } finally {
        await stack.stop();
      }
    },
  );
});

describe.skipIf(enabled)("boxd real-infrastructure gate (skipped)", () => {
  it("requires RUN_BOXD_E2E=1 and BOXD_API_KEY", () => {
    expect(enabled).toBe(false);
  });
});
