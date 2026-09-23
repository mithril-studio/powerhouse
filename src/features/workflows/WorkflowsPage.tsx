import { useRef, useState, useEffect } from "react";
import { useAppStore } from "../../store/appStore";
import { newScriptDraft, newWorkflowDraft, type WorkflowDraft } from "./workflowDrafts";

const field = "w-full border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";
const button = "pi-btn px-3 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-ring";

export function WorkflowsPage() {
  const repos = useAppStore((s) => s.repos);
  const hydrated = useAppStore((s) => s.hydrated);
  const drafts = useAppStore((s) => s.workflowDrafts);
  const save = useAppStore((s) => s.saveWorkflowDraft);
  const selectedRepoId = useAppStore((s) => s.selection.repoId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stepId, setStepId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const draft = drafts.find((d) => d.id === selectedId) ?? drafts[0];
  const step = draft?.steps.find((s) => s.id === stepId) ?? draft?.steps[0];
  const stepIndex = draft?.steps.findIndex((s) => s.id === step?.id) ?? -1;

  useEffect(() => { heading.current?.focus(); }, []);

  const patch = (fields: Partial<WorkflowDraft>) => { if (draft) save({ ...draft, ...fields }); };
  const patchStep = (fields: { name?: string; command?: string }) => {
    if (draft && step) patch({ steps: draft.steps.map((s) => s.id === step.id ? { ...s, ...fields } : s) });
  };
  const create = () => {
    const repoId = repos.find((r) => r.id === selectedRepoId)?.id ?? repos[0]?.id;
    if (!hydrated || !repoId) return;
    const created = newWorkflowDraft(repoId);
    save(created);
    setSelectedId(created.id);
    setStepId(created.steps[0].id);
  };
  const addStep = () => {
    if (!draft) return;
    const added = newScriptDraft();
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

  return (
    <main aria-labelledby="workflows-title" className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div data-tauri-drag-region className="h-11 shrink-0 border-b border-border" />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h1 ref={heading} tabIndex={-1} id="workflows-title" className="text-base font-semibold outline-none">Workflows</h1>
          <p className="mt-1 text-xs text-muted-foreground">Build a script sequence for your project.</p>
        </div>
        <button type="button" className={`${button} pi-btn-primary`} disabled={!hydrated || repos.length === 0} onClick={create}>+ New workflow</button>
      </header>
      <p className="border-b border-border bg-card px-5 py-3 text-xs text-muted-foreground">
        <span className="text-foreground">Local drafts only.</span> Cloud workflow execution is not connected yet. Nothing runs or publishes from this page. Keep secrets out of commands.
      </p>
      {!hydrated ? <p role="status" className="p-5 text-muted-foreground">Loading workflows…</p> : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row">
          <section aria-label="Workflow drafts" className="shrink-0 border-b border-border p-4 lg:w-52 lg:overflow-y-auto lg:border-r lg:border-b-0">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Drafts · {drafts.length}</h2>
            {drafts.length === 0 && <p className="text-xs text-muted-foreground">Your workflows will appear here.</p>}
            <div className="space-y-1">
              {drafts.map((item) => (
                <button key={item.id} type="button" aria-pressed={draft?.id === item.id} onClick={() => { setSelectedId(item.id); setStepId(null); }}
                  className={`w-full border p-2 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring ${draft?.id === item.id ? "border-accent-brand bg-card" : "border-transparent hover:bg-muted"}`}>
                  <span className="block truncate">{item.name.trim() || "Untitled workflow"}</span>
                  <span className="mt-1 block truncate text-muted-foreground">{repos.find((r) => r.id === item.repoId)?.name ?? "Project unavailable"}</span>
                </button>
              ))}
            </div>
          </section>
          {!draft ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
              <h2 className="text-sm font-medium">No workflows yet</h2>
              <p className="max-w-sm text-xs text-muted-foreground">{repos.length === 0 ? "Add a project using the left sidebar, then create your first workflow." : "Start with a script, then add the steps that should follow it. Drafts are stored on this Mac."}</p>
              {repos.length > 0 && <button type="button" className={button} onClick={create}>Create first workflow</button>}
            </div>
          ) : <>
            <section aria-label="Script sequence" className="flex min-w-0 flex-1 flex-col p-5 lg:overflow-y-auto">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">Sequence <span className="text-xs text-muted-foreground">/ draft</span></h2>
                <button type="button" className={button} disabled aria-describedby="workflow-run-unavailable">Run</button>
              </div>
              <p id="workflow-run-unavailable" className="mb-5 text-xs text-muted-foreground">Running requires the always-on DBOS service on boxd.</p>
              <ol className="space-y-2">
                {draft.steps.map((item, index) => <li key={item.id}>
                  {index > 0 && <div aria-hidden="true" className="mb-2 text-center text-muted-foreground">↓</div>}
                  <button type="button" aria-pressed={step?.id === item.id} onClick={() => setStepId(item.id)}
                    className={`w-full border bg-card p-3 text-left focus-visible:ring-2 focus-visible:ring-ring ${step?.id === item.id ? "border-accent-brand" : "border-border hover:border-input"}`}>
                    <span className="text-[11px] text-muted-foreground">{index + 1} · SCRIPT</span>
                    <span className="mt-1 block text-sm">{item.name.trim() || "Untitled script"}</span>
                    <span className="mt-2 block truncate font-mono text-xs text-muted-foreground">{item.command.trim() || "Select to add a command"}</span>
                  </button>
                </li>)}
              </ol>
              <button type="button" onClick={addStep} className={`${button} mt-3 w-full`}>+ Add script</button>
              <div className="mt-8 border-t border-border pt-4">
                <h2 className="text-xs font-medium">Run history</h2>
                <p className="mt-2 text-xs text-muted-foreground">No runs. This draft has not been published or executed.</p>
              </div>
            </section>
            <section aria-label="Workflow configuration" className="shrink-0 border-t border-border bg-card p-4 lg:w-64 lg:overflow-y-auto lg:border-t-0 lg:border-l">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Configuration</h2>
              <label className="mb-4 block text-xs">Workflow name<input className={`${field} mt-1`} value={draft.name} maxLength={200} onChange={(e) => patch({ name: e.target.value })} /></label>
              <label className="mb-5 block text-xs">Project<select className={`${field} mt-1`} value={draft.repoId} onChange={(e) => patch({ repoId: e.target.value })}>
                {!repos.some((r) => r.id === draft.repoId) && <option value={draft.repoId}>Project unavailable</option>}
                {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></label>
              {step ? <div className="border-t border-border pt-4">
                <h3 className="mb-3 text-xs font-medium">Script {stepIndex + 1}</h3>
                <label className="mb-4 block text-xs">Step name<input className={`${field} mt-1`} maxLength={200} value={step.name} onChange={(e) => patchStep({ name: e.target.value })} /></label>
                <label className="block text-xs">Command<textarea className={`${field} mt-1 min-h-36 resize-y font-mono`} spellCheck={false} maxLength={65536} placeholder="e.g. pnpm test" value={step.command} onChange={(e) => patchStep({ command: e.target.value })} /></label>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={button} onClick={() => move(-1)} disabled={stepIndex === 0} aria-label="Move script up">↑</button>
                  <button type="button" className={button} onClick={() => move(1)} disabled={stepIndex === draft.steps.length - 1} aria-label="Move script down">↓</button>
                  <button type="button" className={button} onClick={() => { patch({ steps: draft.steps.filter((s) => s.id !== step.id) }); setStepId(null); }}>Remove step</button>
                </div>
              </div> : <p className="text-xs text-muted-foreground">Add a script to configure it.</p>}
              <p className="mt-5 text-[11px] text-muted-foreground">Draft changes are saved automatically on this Mac. They do not change your project’s merge checks.</p>
            </section>
          </>}
        </div>
      )}
    </main>
  );
}
