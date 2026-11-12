import { describe, expect, it } from "vitest";
import { copyWorkflowDraft, draftFromChecks, newScriptDraft, newWorkflowDraft, validateDraft, MAX_SCRIPT_STEPS } from "./workflowDrafts";

const valid = () => ({ ...newWorkflowDraft("repo"), name: "verify", steps: [{ ...newScriptDraft(), name: "tests", command: "pnpm test" }] });

describe("workflow authoring", () => {
  it("validates a complete sequence without changing it", () => {
    const draft = valid();
    const before = structuredClone(draft);
    expect(validateDraft(draft, ["repo"])).toEqual([]);
    expect(draft).toEqual(before);
  });
  it("points to invalid names, empty commands, duplicate steps and unavailable projects", () => {
    const draft = valid();
    draft.name = "My workflow";
    draft.steps.push({ ...newScriptDraft(), name: "tests", command: " " });
    const errors = validateDraft(draft, []);
    expect(errors.map((e) => e.field)).toEqual(expect.arrayContaining(["name", "repoId", "stepName", "command"]));
    expect(errors.find((e) => e.field === "command")?.stepId).toBe(draft.steps[1].id);
  });
  it("enforces the coordinator sequence limit and rejects NULs and oversized UTF-8 commands", () => {
    const draft = valid();
    expect(validateDraft({ ...draft, steps: [] }, ["repo"])[0].field).toBe("steps");
    expect(validateDraft({ ...draft, steps: Array.from({length: MAX_SCRIPT_STEPS + 1}, (_, i) => ({ ...newScriptDraft(), name: `step-${i}` })) }, ["repo"]).some((e) => e.field === "steps")).toBe(true);
    for (const command of ["echo\0bad", "é".repeat(32769)]) {
      expect(validateDraft({ ...draft, steps: [{ ...draft.steps[0], command }] }, ["repo"]).some((e) => e.field === "command")).toBe(true);
    }
  });
  it("copies merge checks without changing them or dropping excess steps", () => {
    const checks = Array.from({length: 11}, (_, i) => ({ name: "Run Tests", command: `echo ${i}` }));
    const before = structuredClone(checks);
    const draft = draftFromChecks("repo", checks);
    expect(checks).toEqual(before);
    expect(draft.steps).toHaveLength(11);
    expect(new Set(draft.steps.map((s) => s.name)).size).toBe(11);
    expect(draft.steps.map((s) => s.command)).toEqual(checks.map((s) => s.command));
    expect(validateDraft(draft, ["repo"])).toEqual([expect.objectContaining({field: "steps"})]);
  });
  it("duplicates with fresh identities and an available name", () => {
    const original = valid();
    const copy = copyWorkflowDraft(original, [original.name, "verify-copy"]);
    expect(copy.name).toBe("verify-copy-2");
    expect(copy.id).not.toBe(original.id);
    expect(copy.steps[0].id).not.toBe(original.steps[0].id);
    expect(copy.steps[0].command).toBe(original.steps[0].command);
    expect(copy.steps[0]).not.toBe(original.steps[0]);
  });
});
