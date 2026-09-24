import type { WorkflowStep } from "../store/appStore";

/**
 * Upper bound on steps per workflow. Mirrors no-mistakes' cap on repository
 * gates (16): enough for any real check list, small enough that a runaway
 * config cannot turn one run into a wall of processes.
 */
export const MAX_WORKFLOW_STEPS = 16;

/**
 * Trim every field and drop rows that are entirely blank — the modal's
 * untouched "+ Add step" placeholders. Ids and order are preserved.
 */
export function normalizeWorkflowSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps
    .map((s) => ({ ...s, name: s.name.trim(), command: s.command.trim() }))
    .filter((s) => s.name || s.command);
}

/**
 * Reasons a (normalized) step list cannot run. Empty means valid.
 *
 * Ported from no-mistakes' gate validation: every entry needs a command,
 * names are unique, and the list is bounded. A malformed list is rejected
 * before anything runs, so a run never fails halfway on a config mistake.
 */
export function validateWorkflowSteps(steps: WorkflowStep[]): string[] {
  const errors: string[] = [];
  if (steps.length > MAX_WORKFLOW_STEPS) {
    errors.push(`at most ${MAX_WORKFLOW_STEPS} steps (got ${steps.length})`);
  }
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    const label = s.name ? `“${s.name}”` : `step ${i + 1}`;
    if (!s.command) errors.push(`${label} has no command`);
    if (s.name) {
      if (seen.has(s.name)) errors.push(`duplicate step name “${s.name}”`);
      seen.add(s.name);
    }
  });
  return errors;
}
