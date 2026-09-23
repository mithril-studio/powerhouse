import { useEffect, useState } from "react";
import { useAppStore, type WorkflowStep } from "../store/appStore";
import { RepoEnvEditor } from "./RepoEnvEditor";
import { normalizeWorkflowSteps, validateWorkflowSteps } from "../lib/workflowSteps";

const newStep = (): WorkflowStep => ({
  id: crypto.randomUUID(),
  name: "",
  command: "",
  type: "command",
});

export function WorkflowModal() {
  const repoId = useAppStore((s) => s.workflowModalRepoId);
  const repo = useAppStore(
    (s) => s.repos.find((r) => r.id === s.workflowModalRepoId) ?? null,
  );
  const closeWorkflowModal = useAppStore((s) => s.closeWorkflowModal);
  const setWorkflow = useAppStore((s) => s.setWorkflow);
  const setDefaultBranch = useAppStore((s) => s.setDefaultBranch);

  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [pushOnMerge, setPushOnMerge] = useState(true);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (repo) {
      setSteps(repo.workflow.map((s) => ({ ...s })));
      setPushOnMerge(repo.pushOnMerge);
      setTarget(repo.defaultBranch);
      setError(null);
    }
  }, [repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!repoId || !repo) return null;

  const patch = (id: string, fields: Partial<WorkflowStep>) =>
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...fields } : s)));

  const move = (idx: number, dir: -1 | 1) =>
    setSteps((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  const remove = (id: string) =>
    setSteps((prev) => prev.filter((s) => s.id !== id));

  const save = () => {
    const branch = target.trim();
    const cleaned = normalizeWorkflowSteps(steps);
    const problems = validateWorkflowSteps(cleaned);
    if (!branch) problems.unshift("target branch is required");
    if (problems.length > 0) {
      setError(problems.join(" · "));
      return;
    }
    if (branch !== repo.defaultBranch) setDefaultBranch(repoId, branch);
    setWorkflow(repoId, cleaned, pushOnMerge);
    closeWorkflowModal();
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-background/60 pt-24"
      onMouseDown={() => closeWorkflowModal()}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="pi-card flex max-h-[70vh] w-[32rem] flex-col p-4"
      >
        <p className="mb-1 font-medium">Merge workflow</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Check steps run in a throwaway worktree for {repo.name}. All green →
          the tested commit lands on{" "}
          <span className="font-mono">{target.trim() || repo.defaultBranch}</span>.
        </p>

        <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">Target branch</span>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="test"
            spellCheck={false}
            aria-label="Target branch"
            className="h-8 w-40 rounded-lg border border-input bg-background px-2.5 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <span className="min-w-0 truncate">new worktrees branch from it; the queue lands on it</span>
        </label>

        <div className="flex-1 space-y-1.5 overflow-y-auto">
          {steps.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">
              No steps — the queue will only check that the branch merges
              cleanly.
            </p>
          )}
          {steps.map((step, idx) => (
            <div key={step.id} className="flex items-center gap-1.5">
              <input
                value={step.name}
                onChange={(e) => patch(step.id, { name: e.target.value })}
                placeholder="name"
                spellCheck={false}
                className="h-8 w-28 shrink-0 rounded-lg border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <input
                value={step.command}
                onChange={(e) => patch(step.id, { command: e.target.value })}
                placeholder="command"
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 font-mono text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <button
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                title="Move up"
                className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground disabled:opacity-30"
              >
                ↑
              </button>
              <button
                onClick={() => move(idx, 1)}
                disabled={idx === steps.length - 1}
                title="Move down"
                className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground disabled:opacity-30"
              >
                ↓
              </button>
              <button
                onClick={() => remove(step.id)}
                title="Remove step"
                className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-destructive"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={() => setSteps((prev) => [...prev, newStep()])}
          className="mt-2 self-start rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          + Add step
        </button>

        <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={pushOnMerge}
            onChange={(e) => setPushOnMerge(e.target.checked)}
            className="size-3.5 accent-accent-brand"
          />
          Push to origin after merge (no-op without a remote)
        </label>

        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cloud env vars</p>
          <RepoEnvEditor repo={repo} />
        </div>

        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={() => closeWorkflowModal()}
            className="h-8 rounded-lg px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="pi-btn pi-btn-primary h-8 px-4 font-medium focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
