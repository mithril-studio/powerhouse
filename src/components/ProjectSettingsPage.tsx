import { useEffect, useState } from "react";
import { useAppStore, type WorkflowStep } from "../store/appStore";
import { RepoEnvEditor } from "./RepoEnvEditor";
import { Section } from "./SettingsPage";
import { normalizeWorkflowSteps, validateWorkflowSteps } from "../lib/workflowSteps";

const newStep = (): WorkflowStep => ({
  id: crypto.randomUUID(),
  name: "",
  command: "",
  type: "command",
});

const input =
  "h-8 rounded-lg border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const iconButton =
  "flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground disabled:opacity-30";

/**
 * Everything configured per project: target branch, merge workflow, and the
 * env vars its cloud workspaces get. Opened from the repo context menu or the
 * Merge tab's "Edit workflow".
 */
export function ProjectSettingsPage() {
  const repoId = useAppStore((s) => s.projectSettingsRepoId);
  const repo = useAppStore(
    (s) => s.repos.find((r) => r.id === s.projectSettingsRepoId) ?? null,
  );
  const close = useAppStore((s) => s.closeProjectSettings);
  const setWorkflow = useAppStore((s) => s.setWorkflow);
  const setDefaultBranch = useAppStore((s) => s.setDefaultBranch);
  const setRepoWriteEnvFile = useAppStore((s) => s.setRepoWriteEnvFile);

  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [pushOnMerge, setPushOnMerge] = useState(true);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (repo) {
      setSteps(repo.workflow.map((s) => ({ ...s })));
      setPushOnMerge(repo.pushOnMerge);
      setTarget(repo.defaultBranch);
      setError(null);
      setSaved(false);
    }
  }, [repoId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!repoId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [repoId, close]);

  if (!repoId || !repo) return null;

  const edit = (fn: () => void) => {
    fn();
    setSaved(false);
  };

  const patch = (id: string, fields: Partial<WorkflowStep>) =>
    edit(() => setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...fields } : s))));

  const move = (idx: number, dir: -1 | 1) =>
    edit(() =>
      setSteps((prev) => {
        const next = [...prev];
        const j = idx + dir;
        if (j < 0 || j >= next.length) return prev;
        [next[idx], next[j]] = [next[j], next[idx]];
        return next;
      }),
    );

  const remove = (id: string) => edit(() => setSteps((prev) => prev.filter((s) => s.id !== id)));

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
    setSteps(cleaned);
    setError(null);
    setSaved(true);
  };

  return (
    <div className="fixed inset-y-0 right-0 left-60 z-40 flex flex-col border-l border-border bg-background">
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-end px-3">
        <button
          onClick={close}
          title="Close (Esc)"
          aria-label="Close project settings"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-8 pb-16 pt-2">
          <h1 className="mb-6 text-lg font-semibold text-foreground">
            {repo.name} <span className="font-normal text-muted-foreground">· Project settings</span>
          </h1>

          <Section title="General" description="Where new worktrees branch from and where merges land.">
            <div className="space-y-3 text-xs">
              <label className="flex items-center gap-2 text-muted-foreground">
                <span className="w-24 shrink-0">Target branch</span>
                <input
                  value={target}
                  onChange={(e) => edit(() => setTarget(e.target.value))}
                  placeholder="test"
                  spellCheck={false}
                  aria-label="Target branch"
                  className={`${input} w-40 font-mono`}
                />
                <span className="min-w-0 truncate">new worktrees branch from it; the queue lands on it</span>
              </label>
              <label className="flex items-center gap-2 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={pushOnMerge}
                  onChange={(e) => edit(() => setPushOnMerge(e.target.checked))}
                  className="size-3.5 accent-accent-brand"
                />
                Push to origin after merge (no-op without a remote)
              </label>
            </div>
          </Section>

          <Section
            title="Merge workflow"
            description={`Check steps run in a throwaway worktree. All green → the tested commit lands on ${target.trim() || repo.defaultBranch}.`}
          >
            <div className="space-y-1.5 text-xs">
              {steps.length === 0 && (
                <p className="py-2 text-muted-foreground">
                  No steps — the queue will only check that the branch merges cleanly.
                </p>
              )}
              {steps.map((step, idx) => (
                <div key={step.id} className="flex items-center gap-1.5">
                  <input
                    value={step.name}
                    onChange={(e) => patch(step.id, { name: e.target.value })}
                    placeholder="name"
                    spellCheck={false}
                    className={`${input} w-28 shrink-0`}
                  />
                  <input
                    value={step.command}
                    onChange={(e) => patch(step.id, { command: e.target.value })}
                    placeholder="command"
                    spellCheck={false}
                    className={`${input} min-w-0 flex-1 font-mono`}
                  />
                  <button onClick={() => move(idx, -1)} disabled={idx === 0} title="Move up" className={iconButton}>
                    ↑
                  </button>
                  <button
                    onClick={() => move(idx, 1)}
                    disabled={idx === steps.length - 1}
                    title="Move down"
                    className={iconButton}
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => remove(step.id)}
                    title="Remove step"
                    className={`${iconButton} hover:text-destructive`}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                onClick={() => edit(() => setSteps((prev) => [...prev, newStep()]))}
                className="rounded-lg px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                + Add step
              </button>
            </div>
          </Section>

          <div className="mb-6 flex items-center justify-end gap-3 text-xs">
            {error && (
              <p role="alert" className="min-w-0 flex-1 text-destructive">
                {error}
              </p>
            )}
            {saved && !error && <span className="text-muted-foreground">Saved</span>}
            <button
              onClick={save}
              className="pi-btn pi-btn-primary h-8 px-4 font-medium focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Save
            </button>
          </div>

          <Section
            title="Cloud env vars"
            description="Exported to this project's cloud workspaces. Values stay in your Keychain; changes save immediately."
          >
            <RepoEnvEditor repo={repo} />
            <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={repo.cloudWriteEnvFile ?? false}
                onChange={(e) => setRepoWriteEnvFile(repo.id, e.target.checked)}
                className="size-3.5 accent-accent-brand"
              />
              <span>
                Also write <code>.env</code> in the repo on the VM (only if git ignores it).
              </span>
            </label>
          </Section>
        </div>
      </div>
    </div>
  );
}
