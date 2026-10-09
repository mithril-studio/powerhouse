/** Local authoring model. Publishing and execution belong to the coordinator. */
export interface ScriptDraft {
  id: string;
  name: string;
  command: string;
}

export interface WorkflowDraft {
  id: string;
  repoId: string;
  name: string;
  steps: ScriptDraft[];
}

// Published script sequences use server/src/api.ts's 1–10-node contract, not
// the local merge queue's separate 16-step contract.
export const MAX_SCRIPT_STEPS = 10;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function availableName(proposed: string, used: string[]): string {
  const base = proposed.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "script";
  let name = base;
  for (let n = 2; used.includes(name); n++) {
    const suffix = `-${n}`;
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  return name;
}

export const newScriptDraft = (names: string[] = []): ScriptDraft => ({
  id: crypto.randomUUID(), name: availableName("script", names), command: "",
});

export const newWorkflowDraft = (repoId: string, names: string[] = []): WorkflowDraft => ({
  id: crypto.randomUUID(), repoId, name: availableName("new-workflow", names), steps: [newScriptDraft()],
});

export function copyWorkflowDraft(draft: WorkflowDraft, names: string[]): WorkflowDraft {
  return { ...draft, id: crypto.randomUUID(), name: availableName(`${draft.name.slice(0, 59)}-copy`, names), steps: draft.steps.map((step) => ({ ...step, id: crypto.randomUUID() })) };
}

/** An independent copy: never change merge checks or silently truncate them. */
export function draftFromChecks(repoId: string, checks: { name: string; command: string }[], names: string[] = []): WorkflowDraft {
  const steps: ScriptDraft[] = [];
  for (const check of checks) {
    steps.push({ id: crypto.randomUUID(), name: availableName(check.name, steps.map((s) => s.name)), command: check.command });
  }
  return { id: crypto.randomUUID(), repoId, name: availableName("verify-project", names), steps };
}

export interface DraftIssue {
  field: "name" | "repoId" | "steps" | "stepName" | "command";
  stepId?: string;
  message: string;
}

/** Non-mutating validation; invalid drafts can still be edited and saved. */
export function validateDraft(draft: WorkflowDraft, repoIds: string[]): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (!repoIds.includes(draft.repoId)) issues.push({ field: "repoId", message: "Choose an available project." });
  if (!NAME.test(draft.name)) issues.push({ field: "name", message: "Use a workflow name of 1–64 lowercase letters, numbers or hyphens, starting with a letter or number." });
  if (!draft.steps.length || draft.steps.length > MAX_SCRIPT_STEPS) issues.push({ field: "steps", message: `A workflow needs 1–${MAX_SCRIPT_STEPS} script steps.` });
  const names = new Set<string>();
  for (const step of draft.steps) {
    if (!NAME.test(step.name)) issues.push({ field: "stepName", stepId: step.id, message: "Use a step name of 1–64 lowercase letters, numbers or hyphens, starting with a letter or number." });
    else if (names.has(step.name)) issues.push({ field: "stepName", stepId: step.id, message: `The step name “${step.name}” is already used.` });
    names.add(step.name);
    if (!step.command.trim()) issues.push({ field: "command", stepId: step.id, message: "Add a command for this step." });
    else if (step.command.includes("\0") || new TextEncoder().encode(step.command).length > 65536) issues.push({ field: "command", stepId: step.id, message: "Commands must be at most 64 KiB of UTF-8 without NUL characters." });
  }
  return issues;
}
