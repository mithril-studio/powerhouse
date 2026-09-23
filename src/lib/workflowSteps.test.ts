import { describe, expect, it } from "vitest";
import {
  MAX_WORKFLOW_STEPS,
  normalizeWorkflowSteps,
  validateWorkflowSteps,
} from "./workflowSteps";
import type { WorkflowStep } from "../store/appStore";

const step = (id: string, name: string, command: string): WorkflowStep => ({
  id,
  name,
  command,
  type: "command",
});

describe("normalizeWorkflowSteps", () => {
  it("trims fields, drops blank rows, and keeps ids and order", () => {
    const out = normalizeWorkflowSteps([
      step("a", "  tests ", " npm test "),
      step("b", "   ", ""),
      step("c", "", " pnpm build"),
    ]);
    expect(out).toEqual([step("a", "tests", "npm test"), step("c", "", "pnpm build")]);
  });

  it("keeps a row that only has a name so validation can name the problem", () => {
    expect(normalizeWorkflowSteps([step("a", "lint", "  ")])).toEqual([step("a", "lint", "")]);
  });
});

describe("validateWorkflowSteps", () => {
  it("accepts an empty list and a well-formed list", () => {
    expect(validateWorkflowSteps([])).toEqual([]);
    expect(
      validateWorkflowSteps([step("a", "tests", "npm test"), step("b", "", "pnpm build")]),
    ).toEqual([]);
  });

  it("requires a command on every step, naming the step when it can", () => {
    expect(validateWorkflowSteps([step("a", "lint", ""), step("b", "", "")])).toEqual([
      "“lint” has no command",
      "step 2 has no command",
    ]);
  });

  it("rejects duplicate names", () => {
    expect(
      validateWorkflowSteps([step("a", "tests", "npm test"), step("b", "tests", "vitest")]),
    ).toEqual(["duplicate step name “tests”"]);
  });

  it("does not treat several unnamed steps as duplicates", () => {
    expect(validateWorkflowSteps([step("a", "", "true"), step("b", "", "true")])).toEqual([]);
  });

  it("bounds the number of steps", () => {
    const many = Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, (_, i) =>
      step(`s${i}`, `s${i}`, "true"),
    );
    expect(validateWorkflowSteps(many)).toEqual([
      `at most ${MAX_WORKFLOW_STEPS} steps (got ${MAX_WORKFLOW_STEPS + 1})`,
    ]);
    expect(validateWorkflowSteps(many.slice(0, MAX_WORKFLOW_STEPS))).toEqual([]);
  });

  it("reports every problem at once", () => {
    const errors = validateWorkflowSteps([
      step("a", "tests", ""),
      step("b", "tests", "vitest"),
    ]);
    expect(errors).toEqual(["“tests” has no command", "duplicate step name “tests”"]);
  });

  it("catches names that only differ by whitespace once normalized", () => {
    const cleaned = normalizeWorkflowSteps([
      step("a", "tests", "npm test"),
      step("b", " tests ", "vitest"),
    ]);
    expect(validateWorkflowSteps(cleaned)).toEqual(["duplicate step name “tests”"]);
  });
});
