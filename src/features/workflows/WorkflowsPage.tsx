import { useRef, useState, useEffect } from "react";
import { useAppStore } from "../../store/appStore";
import { copyWorkflowDraft, draftFromChecks, MAX_SCRIPT_STEPS, newScriptDraft, newWorkflowDraft, validateDraft, type DraftIssue, type WorkflowDraft } from "./workflowDrafts";
import { WorkflowConfiguration } from "./WorkflowConfiguration";

const button = "pi-btn px-3 py-2 text-xs focus-visible:ring-2 focus-visible:ring-ring";

export function WorkflowsPage() {
  const repos = useAppStore((s) => s.repos);
  const hydrated = useAppStore((s) => s.hydrated);
  const drafts = useAppStore((s) => s.workflowDrafts);
  const save = useAppStore((s) => s.saveWorkflowDraft);
  const remove = useAppStore((s) => s.deleteWorkflowDraft);
  const selectedRepoId = useAppStore((s) => s.selection.repoId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const [filterRepoId, setFilterRepoId] = useState("");
  const [deleted, setDeleted] = useState<WorkflowDraft | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const visible = drafts.filter((draft) => !filterRepoId || draft.repoId === filterRepoId);
  const draft = visible.find((d) => d.id === selectedId) ?? visible[0];
  const step = draft?.steps.find((s) => s.id === stepId) ?? draft?.steps[0];
  const stepIndex = draft?.steps.findIndex((s) => s.id === step?.id) ?? -1;
  const creationRepo = repos.find((r) => r.id === (filterRepoId || selectedRepoId)) ?? repos[0];
  const issues = draft ? validateDraft(draft, repos.map((r) => r.id)) : [];

  useEffect(() => { heading.current?.focus(); }, []);

  const selectDraft = (next: WorkflowDraft) => {
    setSelectedId(next.id);
    setStepId(next.steps[0]?.id ?? null);
  };
  const patch = (fields: Partial<WorkflowDraft>) => {
    if (!draft) return;
    save({ ...draft, ...fields });
    // Keep the edited workflow selected when it moves out of a project filter.
    if (fields.repoId) {
      setSelectedId(draft.id);
      if (filterRepoId) setFilterRepoId(fields.repoId);
    }
  };
  const patchStep = (fields: { name?: string; command?: string }) => {
    if (draft && step) patch({ steps: draft.steps.map((s) => s.id === step.id ? { ...s, ...fields } : s) });
  };
  const create = (fromChecks = false) => {
    if (!hydrated || !creationRepo) return;
    const names = drafts.map((d) => d.name);
    const created = fromChecks ? draftFromChecks(creationRepo.id, creationRepo.workflow, names) : newWorkflowDraft(creationRepo.id, names);
    save(created);
    selectDraft(created);
  };
  const addStep = () => {
    if (!draft || draft.steps.length >= MAX_SCRIPT_STEPS) return;
    const added = newScriptDraft(draft.steps.map((s) => s.name));
    patch({ steps: [...draft.steps, added] });
    setStepId(added.id);
  };
  const move = (direction: -1 | 1) => {
    if (!draft || stepIndex < 0) return;
    const nextIndex = stepIndex + direction;
    if (nextIndex < 0 || nextIndex >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[stepIndex], steps[nextIndex]] = [steps[nextIndex], steps[stepIndex]];
    patch({ steps });
  };
  const focusIssue = (issue: DraftIssue) => {
    if (issue.stepId) setStepId(issue.stepId);
    requestAnimationFrame(() => document.getElementById(`workflow-${issue.field}`)?.focus());
  };

  return (
    <main aria-labelledby="workflows-title" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div data-tauri-drag-region className="h-11 shrink-0 border-b border-border bg-card" />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-5">
        <div>
          <h1 ref={heading} tabIndex={-1} id="workflows-title" className="text-lg font-semibold outline-none">Workflows</h1>
          <p className="mt-1 text-sm text-muted-foreground">Reusable script sequences for your projects.</p>
        </div>
        <button type="button" className={`${button} pi-btn-primary`} disabled={!hydrated || !creationRepo} onClick={() => create()}>+ New workflow</button>
      </header>
      {deleted && <div role="status" className="flex items-center gap-3 border-b border-border bg-card px-6 py-3 text-sm">
        <span>Deleted draft “{deleted.name}”.</span>
        <button type="button" className={button} onClick={() => { save(deleted); setFilterRepoId(""); selectDraft(deleted); setDeleted(null); }}>Undo</button>
      </div>}
      {!hydrated ? <p role="status" className="p-6 text-muted-foreground">Loading workflows…</p> : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row">
          <section aria-label="Workflow drafts" className="shrink-0 border-b border-border p-4 lg:w-56 lg:overflow-y-auto lg:border-r lg:border-b-0">
            <label className="block text-xs text-muted-foreground">Filter by project
              <select className="mt-2 w-full rounded-md border border-input bg-card px-2 py-2 text-sm" value={filterRepoId} onChange={(e) => { setFilterRepoId(e.target.value); setSelectedId(null); setStepId(null); }}>
                <option value="">All projects</option>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <h2 className="mb-3 mt-5 text-xs font-semibold text-muted-foreground">Drafts · {visible.length}</h2>
            <div className="space-y-2">
              {visible.map((item) => (
                <button key={item.id} type="button" aria-pressed={draft?.id === item.id} onClick={() => selectDraft(item)}
                  className={`w-full rounded-md border p-3 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring ${draft?.id === item.id ? "border-accent-brand bg-card" : "border-transparent hover:bg-muted"}`}>
                  <span className="block truncate">{item.name.trim() || "Untitled workflow"}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">{repos.find((r) => r.id === item.repoId)?.name ?? "Project unavailable"} · {item.steps.length} steps</span>
                </button>
              ))}
            </div>
            {creationRepo && <button type="button" className={`${button} mt-5 w-full`} disabled={!creationRepo.workflow.length} title="Creates an independent draft; never changes or runs merge checks" onClick={() => create(true)}>Copy {creationRepo.name} merge checks</button>}
          </section>
          {!draft ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <h2 className="text-base font-medium">{filterRepoId ? "No workflows for this project" : "Create your first workflow"}</h2>
              <p className="max-w-sm text-sm text-muted-foreground">{repos.length === 0 ? "Add a project using the left sidebar to get started." : "Start with a script or copy your project’s merge checks. Nothing runs until you publish and start a run."}</p>
              {repos.length > 0 && <button type="button" className={`${button} pi-btn-primary`} onClick={() => create()}>Create workflow</button>}
            </div>
          ) : <>
            <section aria-label="Script sequence" className="flex min-w-0 flex-1 flex-col p-6 lg:overflow-y-auto">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="break-words text-base font-medium">{draft.name || "Untitled workflow"}</h2><p className="mt-1 text-xs text-muted-foreground">Local draft · Not published</p></div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={button} onClick={() => { const copy = copyWorkflowDraft(draft, drafts.map((d) => d.name)); save(copy); selectDraft(copy); }}>Duplicate</button>
                  <button type="button" className={button} onClick={() => { setDeleted(draft); remove(draft.id); setSelectedId(null); setStepId(null); }}>Delete draft</button>
                </div>
              </div>
              <div className="mb-5 rounded-md border border-border bg-card p-4">
                <p role="status" className={`text-sm ${issues.length ? "text-destructive" : "text-success"}`}>{issues.length ? `${issues.length} things to fix` : "✓ Draft checks passed"}</p>
                {issues.length > 0 && <ul className="mt-2 space-y-1 text-xs">{issues.map((issue, i) => <li key={i}>
                  <button type="button" className="text-left underline underline-offset-2" onClick={() => focusIssue(issue)}>{issue.stepId ? `Step ${draft.steps.findIndex((s) => s.id === issue.stepId) + 1}: ` : ""}{issue.message}</button>
                </li>)}</ul>}
              </div>
              <ol id="workflow-steps" tabIndex={-1} className="space-y-2">
                {draft.steps.map((item, index) => <li key={item.id}>
                  {index > 0 && <div aria-hidden="true" className="mb-2 text-center text-muted-foreground">↓</div>}
                  <button type="button" aria-pressed={step?.id === item.id} onClick={() => setStepId(item.id)}
                    className={`w-full rounded-md border bg-card p-4 text-left focus-visible:ring-2 focus-visible:ring-ring ${step?.id === item.id ? "border-accent-brand" : "border-border hover:border-input"}`}>
                    <span className="text-xs text-muted-foreground">{index + 1} · Script{issues.some((issue) => issue.stepId === item.id) && <span className="ml-2 text-destructive">· Needs attention</span>}</span>
                    <span className="mt-1 block text-sm font-medium">{item.name.trim() || "Untitled script"}</span>
                    <span className="mt-2 block truncate font-mono text-xs text-muted-foreground">{item.command.trim() || "Select to add a command"}</span>
                  </button>
                </li>)}
              </ol>
              <button type="button" onClick={addStep} disabled={draft.steps.length >= MAX_SCRIPT_STEPS} className={`${button} mt-3 w-full`}>+ Add script · {draft.steps.length}/{MAX_SCRIPT_STEPS}</button>
              <div className="mt-8 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">Execution not connected</h2><button type="button" className={button} disabled aria-describedby="workflow-run-unavailable">Run</button></div>
                <p id="workflow-run-unavailable" className="mt-2 text-xs text-muted-foreground">This editor saves local drafts only. Publishing, running and run history need a connection to the workflow coordinator.</p>
                <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">What is needed to run?</summary><p className="mt-2">Connect the coordinator securely, choose a runner snapshot and a pushed commit, then publish an immutable version. Each script runs in a separate checkout; files created by one step are not shared with the next. Closing Powerhouse will not stop a remote run.</p></details>
              </div>
            </section>
            <WorkflowConfiguration draft={draft} repos={repos} step={step} issues={issues} patch={patch} patchStep={patchStep} move={move} removeStep={() => { if (step) patch({ steps: draft.steps.filter((s) => s.id !== step.id) }); setStepId(null); }} />
          </>}
        </div>
      )}
    </main>
  );
}
