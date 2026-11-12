import type { Repo } from "../../store/appStore";
import type { DraftIssue, ScriptDraft, WorkflowDraft } from "./workflowDrafts";

const field = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const button = "pi-btn px-3 py-1.5 text-xs";

export function WorkflowConfiguration({ draft, repos, step, issues, patch, patchStep, move, removeStep }: {
  draft: WorkflowDraft;
  repos: Repo[];
  step?: ScriptDraft;
  issues: DraftIssue[];
  patch: (fields: Partial<WorkflowDraft>) => void;
  patchStep: (fields: Partial<Pick<ScriptDraft, "name" | "command">>) => void;
  move: (direction: -1 | 1) => void;
  removeStep: () => void;
}) {
  const stepIndex = draft.steps.findIndex((s) => s.id === step?.id);
  const error = (field: DraftIssue["field"]) => issues.find((issue) => issue.field === field && (!issue.stepId || issue.stepId === step?.id))?.message;
  const feedback = (field: DraftIssue["field"]) => error(field) ? <p id={`workflow-${field}-error`} className="mt-1 text-xs text-destructive">{error(field)}</p> : null;
  return <section aria-label="Workflow configuration" className="shrink-0 border-t border-border bg-card p-5 lg:w-72 lg:overflow-y-auto lg:border-l lg:border-t-0">
    <h2 className="mb-4 text-sm font-semibold">Configuration</h2>
    <label className="mb-4 block text-sm" htmlFor="workflow-name">Workflow name
      <input id="workflow-name" className={field} value={draft.name} maxLength={64} aria-invalid={!!error("name")} aria-describedby={error("name") ? "workflow-name-error" : undefined} onChange={(e) => patch({ name: e.target.value })} />
    </label>
    {feedback("name")}
    <label className="mt-4 block text-sm" htmlFor="workflow-repoId">Project
      <select id="workflow-repoId" className={field} value={draft.repoId} aria-invalid={!!error("repoId")} aria-describedby={error("repoId") ? "workflow-repoId-error" : undefined} onChange={(e) => patch({ repoId: e.target.value })}>
        {!repos.some((r) => r.id === draft.repoId) && <option value={draft.repoId}>Project unavailable</option>}
        {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
    </label>
    {feedback("repoId")}
    {step ? <div className="mt-6 border-t border-border pt-4">
      <h3 className="mb-3 text-sm font-medium">Step {stepIndex + 1}</h3>
      <label className="block text-sm" htmlFor="workflow-stepName">Step name
        <input id="workflow-stepName" className={field} maxLength={64} value={step.name} aria-invalid={!!error("stepName")} aria-describedby={error("stepName") ? "workflow-stepName-error" : undefined} onChange={(e) => patchStep({ name: e.target.value })} />
      </label>
      {feedback("stepName")}
      <label className="mt-4 block text-sm" htmlFor="workflow-command">Command
        <textarea id="workflow-command" className={`${field} min-h-36 resize-y font-mono text-xs`} spellCheck={false} maxLength={65536} placeholder="e.g. pnpm test" value={step.command} aria-invalid={!!error("command")} aria-describedby={error("command") ? "workflow-command-error" : undefined} onChange={(e) => patchStep({ command: e.target.value })} />
      </label>
      {feedback("command")}
      <p className="mt-2 text-xs text-muted-foreground">Use secret references when execution is connected. Never paste credentials into a command.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => move(-1)} disabled={stepIndex === 0} aria-label="Move script up">↑</button>
        <button type="button" className={button} onClick={() => move(1)} disabled={stepIndex === draft.steps.length - 1} aria-label="Move script down">↓</button>
        <button type="button" className={button} onClick={removeStep}>Remove step</button>
      </div>
    </div> : <p className="mt-5 text-sm text-muted-foreground">Add a script to configure it.</p>}
    <p className="mt-6 text-xs text-muted-foreground">Draft changes are saved automatically on this Mac. Your project’s merge checks are unchanged.</p>
  </section>;
}
