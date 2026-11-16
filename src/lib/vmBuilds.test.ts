import { describe, expect, it } from "vitest";
import { buildDuration, mergeBuild, type VmBuild } from "./vmBuilds";

const b = (number: number, over: Partial<VmBuild> = {}): VmBuild => ({
  repoId: "r",
  number,
  snapshot: `ph-x-b${number}`,
  branch: "main",
  status: "ready",
  step: "Ready",
  commit: null,
  error: null,
  log: "",
  startedMs: 0,
  finishedMs: 1000,
  ...over,
});

describe("vmBuilds", () => {
  it("merges an update in place and keeps newest first", () => {
    const list = [b(2), b(1)];
    const merged = mergeBuild(list, b(1, { status: "failed" }));
    expect(merged.map((x) => [x.number, x.status])).toEqual([
      [2, "ready"],
      [1, "failed"],
    ]);
    expect(mergeBuild(list, b(3)).map((x) => x.number)).toEqual([3, 2, 1]);
  });

  it("formats durations, counting a running build up to now", () => {
    expect(buildDuration(b(1, { finishedMs: 42_000 }))).toBe("42 s");
    expect(buildDuration(b(1, { finishedMs: 180_000 }))).toBe("3 min");
    expect(buildDuration(b(1, { finishedMs: null }), 5_000)).toBe("5 s");
  });
});
