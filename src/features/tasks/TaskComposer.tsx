import { useState } from "react";
import { Dialog, Kbd } from "../../components/ui/dialog";
import { ChevronDownIcon } from "../../components/ui/icons";
import { useAppStore, resolveChatTransport } from "../../store/appStore";
import { createTask } from "./taskStore";
import { startTask } from "./taskActions";
import type { Task } from "./types";
export function TaskComposer({
  repoId,
  seed,
  onClose,
  onCreated,
  onError,
}: {
  repoId: string;
  seed?: { title: string; description: string; source?: Task["source"] };
  onClose: () => void;
  onCreated: (id: string) => void;
  onError: (message: string) => void;
}) {
  const { repos, settings } = useAppStore();
  const [project, setProject] = useState(repoId || repos[0]?.id || "");
  const [title, setTitle] = useState(seed?.title ?? "");
  const [description, setDescription] = useState(seed?.description ?? "");
  const agents = settings.agents.filter(
    (a) => resolveChatTransport(settings, { agentId: a.id }) === "acp",
  );
  const [agentId, setAgentId] = useState(
    agents.find((a) => a.id === settings.defaultAgentId)?.id ??
      agents[0]?.id ??
      "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(mode: "save" | "background" | "open") {
    if (
      pending ||
      !project ||
      !(title.trim() || description.trim()) ||
      (mode !== "save" && !agentId)
    )
      return;
    setPending(true);
    setError(null);
    try {
      const task = createTask({
        repoId: project,
        title: title.trim() || description.trim().slice(0, 80),
        description: description.trim(),
        agentId,
        source: seed?.source,
      });
      onCreated(task.id);
      onClose();
      if (mode !== "save") {
        void startTask(task.id, mode === "open").catch((cause) =>
          onError(String(cause)),
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }
  const canSave = !pending && !!project && !!(title.trim() || description.trim());
  const canStart = canSave && !!agentId;
  return (
    <Dialog
      title="New task"
      onClose={onClose}
      busy={pending}
      width="36rem"
      onKeyDown={(e) => {
        if (e.metaKey && e.key === "Enter") {
          e.preventDefault();
          void submit(e.shiftKey ? "open" : "background");
        }
      }}
    >
      <div className="ph-dialog-body pt-3">
        <input
          autoFocus
          aria-label="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title (optional)"
          className="ph-compose-title"
        />
        <textarea
          aria-label="What do you want to do?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
          placeholder="What do you want to do? Describe the outcome and what good looks like…"
          className="ph-compose-body"
        />
        <div className="ph-pills">
          <label className="ph-pill">
            Project
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              disabled={!!seed?.source}
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="size-3" />
          </label>
          <label className="ph-pill">
            Agent
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="size-3" />
          </label>
          <span className="ph-pill ph-pill-static">Local workspace</span>
        </div>
        {error && (
          <p role="alert" className="ph-dialog-error">
            {error}
          </p>
        )}
      </div>
      <footer className="ph-dialog-foot">
        <button
          className="ph-btn ph-btn-ghost -ml-3 mr-auto"
          disabled={!canSave}
          onClick={() => void submit("save")}
        >
          Save to backlog
        </button>
        <button
          className="ph-btn"
          disabled={!canStart}
          onClick={() => void submit("open")}
          title="Start the agent and open the task (⇧⌘↵)"
        >
          Start and open <Kbd>⇧⌘↵</Kbd>
        </button>
        <button
          className="ph-btn ph-btn-primary"
          disabled={!canStart}
          onClick={() => void submit("background")}
          title="Start the agent in the background (⌘↵)"
        >
          Start <Kbd>⌘↵</Kbd>
        </button>
      </footer>
    </Dialog>
  );
}
