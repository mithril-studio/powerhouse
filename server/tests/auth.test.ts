import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeExecutionAdapter } from "../src/adapters/fake.js";
import {
  OWNER_B_TOKEN,
  cancelRun,
  getRunView,
  postRun,
  runBody,
  startStack,
  waitForStatus,
  type TestStack,
} from "./helpers/coordinator.js";

describe("authentication and authorization", () => {
  let stack: TestStack;
  let runId: string;

  beforeAll(async () => {
    stack = await startStack(new FakeExecutionAdapter());
    const res = await postRun(stack.app, runBody());
    runId = res.body.runId!;
    await waitForStatus(stack.app, runId, ["succeeded"]);
  });

  afterAll(async () => {
    await stack.stop();
  });

  it("health is reachable without a token", async () => {
    const res = await stack.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("requests without or with an invalid token are rejected", async () => {
    const none = await stack.app.inject({ method: "GET", url: `/v1/runs/${runId}` });
    expect(none.statusCode).toBe(401);
    const bad = await stack.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: { authorization: "Bearer wrong-token-wrong-token" },
    });
    expect(bad.statusCode).toBe(401);
    const post = await stack.app.inject({ method: "POST", url: "/v1/runs", payload: runBody() });
    expect(post.statusCode).toBe(401);
  });

  it("another owner cannot inspect or control this owner's run", async () => {
    const view = await getRunView(stack.app, runId, OWNER_B_TOKEN);
    expect(view.statusCode).toBe(404);
    const cancel = await cancelRun(stack.app, runId, OWNER_B_TOKEN);
    expect(cancel.statusCode).toBe(404);
    // The run is untouched.
    const mine = await getRunView(stack.app, runId);
    expect(mine.statusCode).toBe(200);
    expect(mine.body.run.status).toBe("succeeded");
  });

  it("owners are isolated per idempotency key namespace", async () => {
    const body = runBody({ idempotencyKey: "shared-key" });
    const a = await postRun(stack.app, body);
    const b = await postRun(stack.app, body, OWNER_B_TOKEN);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.body.runId).not.toBe(b.body.runId);
    await waitForStatus(stack.app, a.body.runId!, ["succeeded"]);
    await waitForStatus(stack.app, b.body.runId!, ["succeeded"], 30_000, OWNER_B_TOKEN);
  });
});
