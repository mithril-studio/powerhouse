import { describe, expect, it } from "vitest";
import { activityFromStopReason, rollupActivity } from "./chatActivity";

describe("activityFromStopReason", () => {
  it("marks completed turns done, refusals as errors, and cancels as nothing", () => {
    expect(activityFromStopReason("end_turn")).toBe("done");
    expect(activityFromStopReason("max_tokens")).toBe("done");
    expect(activityFromStopReason("max_turn_requests")).toBe("done");
    expect(activityFromStopReason("refusal")).toBe("error");
    expect(activityFromStopReason("cancelled")).toBeNull();
  });
});

describe("rollupActivity", () => {
  it("shows the most urgent state across a worktree's chats", () => {
    expect(rollupActivity(["a", "b"], { a: "done", b: "working" })).toBe("working");
    expect(rollupActivity(["a", "b"], { a: "done", b: "error" })).toBe("error");
    expect(rollupActivity(["a", "b"], { a: "done" })).toBe("done");
  });

  it("ignores chats outside the set and is null when idle", () => {
    expect(rollupActivity(["a"], { b: "working" })).toBeNull();
    expect(rollupActivity([], {})).toBeNull();
  });
});
