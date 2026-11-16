import { useEffect, useState } from "react";
import { useAppStore, type WorkflowStep } from "../store/appStore";
import { RepoEnvEditor } from "./RepoEnvEditor";
import { VmBuildsSection } from "./VmBuildsSection";
import { Section } from "./SettingsPage";
import { ChevronDownIcon, CloseIcon, PlusIcon } from "./ui/icons";
import { normalizeWorkflowSteps, validateWorkflowSteps } from "../lib/workflowSteps";

const newStep = (): WorkflowStep => ({
  id: crypto.randomUUID(),
  name: "",
  command: "",
  type: "command",
});

const iconButton = "ph-icon-btn shrink-0 disabled:pointer-events-none disabled:opacity-30";

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
        <button type="button" onClick={close} title="Close (Esc)" aria-label="Close project settings" className="ph-icon-btn">
          <CloseIcon className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-8 pb-16 pt-2">
          <header className="ph-page-header mx-0 pt-0">
            <h1 className="ph-page-title">
              {repo.name} <span className="font-normal text-muted-foreground">· Project settings</span>
            </h1>
          </header>

          <Section title="Target branch" description="New worktrees branch from it, diffs compare against it, and merges land on it.">
            <input
              value={target}
              onChange={(e) => edit(() => setTarget(e.target.value))}
              placeholder="test"
              spellCheck={false}
              aria-label="Target branch"
              className="ph-input h-8 w-56 font-mono"
            />
            <label className="ph-toggle">
              <input
                type="checkbox"
                className="ph-switch"
                checked={pushOnMerge}
                onChange={(e) => edit(() => setPushOnMerge(e.target.checked))}
              />
              <span>
                Push to origin after merge
                <span>Does nothing when the project has no remote.</span>
              </span>
            </label>
          </Section>

          <Section
            title="Merge workflow"
            description={`Checks run in a throwaway worktree. All green → the tested commit lands on ${target.trim() || repo.defaultBranch}.`}
          >
            {steps.length === 0 && (
              <p className="ph-hint">No steps: the queue only checks that the branch merges cleanly.</p>
            )}
            {steps.length > 0 && (
              <div className="flex flex-col gap-2">
                {steps.map((step, idx) => (
                  <div key={step.id} className="flex items-center gap-2">
                    <input
                      value={step.name}
                      onChange={(e) => patch(step.id, { name: e.target.value })}
                      placeholder="Name"
                      aria-label={`Step ${idx + 1} name`}
                      spellCheck={false}
                      className="ph-input h-8 w-32 shrink-0"
                    />
                    <input
                      value={step.command}
                      onChange={(e) => patch(step.id, { command: e.target.value })}
                      placeholder="Command"
                      aria-label={`Step ${idx + 1} command`}
                      spellCheck={false}
                      className="ph-input h-8 min-w-0 flex-1 font-mono"
                    />
                    <button type="button" onClick={() => move(idx, -1)} disabled={idx === 0} title="Move up" aria-label="Move up" className={iconButton}>
                      <ChevronDownIcon className="size-3.5 rotate-180" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(idx, 1)}
                      disabled={idx === steps.length - 1}
                      title="Move down"
                      aria-label="Move down"
                      className={iconButton}
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(step.id)}
                      title="Remove step"
                      aria-label="Remove step"
                      className={`${iconButton} hover:!text-destructive`}
                    >
                      <CloseIcon className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => edit(() => setSteps((prev) => [...prev, newStep()]))}
                className="ph-btn ph-btn-ghost -ml-2.5"
              >
                <PlusIcon className="size-3.5" />
                Add step
              </button>
              <span className="flex-1" />
              {saved && !error && <span className="ph-hint">Saved</span>}
              <button type="button" onClick={save} className="ph-btn ph-btn-primary">
                Save
              </button>
            </div>
            {error && (
              <p role="alert" className="ph-error">
                {error}
              </p>
            )}
          </Section>

          <Section
            title="Cloud VM"
            description="The image every new cloud chat starts from: the target branch with its tools and dependencies installed."
          >
            <VmBuildsSection repo={repo} />
          </Section>

          <Section
            title="Cloud env vars"
            description="Exported to this project's cloud chats. Values stay in your Keychain and save as you go."
          >
            <RepoEnvEditor repo={repo} />
            <label className="ph-toggle">
              <input
                type="checkbox"
                className="ph-switch"
                checked={repo.cloudWriteEnvFile ?? false}
                onChange={(e) => setRepoWriteEnvFile(repo.id, e.target.checked)}
              />
              <span>
                Also write .env in the repo on the VM
                <span>Only when git ignores it.</span>
              </span>
            </label>
          </Section>
        </div>
      </div>
    </div>
  );
}
