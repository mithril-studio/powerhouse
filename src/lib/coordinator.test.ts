import { describe, expect, it } from "vitest";
import { draftContentKey, draftToNodes, isTerminal, slugify } from "./coordinator";
import type { WorkflowDraft } from "../features/workflows/workflowDrafts";

const draft = (steps: { name: string; command: string }[]): WorkflowDraft => ({
  id: "d1",
  repoId: "r1",
  name: "My workflow",
  steps: steps.map((s, i) => ({ id: `s${i}`, ...s })),
});

describe("slugify", () => {
  it("kebab-cases free-form names into the server charset", () => {
    expect(slugify("Run the tests!", "x")).toBe("run-the-tests");
    expect(slugify("  Build & Verify  ", "x")).toBe("build-verify");
    expect(slugify("étape", "fallback-1")).toBe("tape");
  });

  it("falls back when nothing usable remains", () => {
    expect(slugify("", "script-1")).toBe("script-1");
    expect(slugify("!!!", "script-2")).toBe("script-2");
    expect(slugify("---", "script-3")).toBe("script-3");
  });

  it("caps length at the server's 64-char limit", () => {
    const long = slugify("x".repeat(100), "f");
    expect(long.length).toBeLessThanOrEqual(64);
  });
});

describe("draftToNodes", () => {
  it("maps steps to named nodes and dedupes colliding names", () => {
    const nodes = draftToNodes(draft([
      { name: "Test", command: "pnpm test" },
      { name: "Test", command: "pnpm test -- --shard 2" },
      { name: "", command: "echo done" },
    ]));
    expect(nodes).toEqual([
      { name: "test", command: "pnpm test" },
      { name: "test-2", command: "pnpm test -- --shard 2" },
      { name: "script-3", command: "echo done" },
    ]);
  });

  it("refuses empty commands with a pointed message", () => {
    const err = draftToNodes(draft([{ name: "Build", command: "  " }]));
    expect(err).toContain("script 1");
    expect(err).toContain("Build");
  });

  it("refuses an empty sequence", () => {
    expect(draftToNodes(draft([]))).toContain("at least one script");
  });
});

describe("draftContentKey", () => {
  it("changes only when step content changes", () => {
    const a = draft([{ name: "Test", command: "pnpm test" }]);
    const same = { ...a, name: "Renamed workflow", runIds: ["r1"] };
    expect(draftContentKey(same)).toBe(draftContentKey(a));
    const edited = draft([{ name: "Test", command: "pnpm test --run" }]);
    expect(draftContentKey(edited)).not.toBe(draftContentKey(a));
  });
});

describe("isTerminal", () => {
  it("treats only settled statuses as terminal", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("canceled")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("canceling")).toBe(false);
    expect(isTerminal("pending_dispatch")).toBe(false);
  });
});
