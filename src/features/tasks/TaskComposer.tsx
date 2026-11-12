import { useEffect, useRef, useState } from "react";
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
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, textarea, select:not(:disabled)",
        ) ?? [],
      );
      const first = elements[0],
        last = elements[elements.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => {
      document.removeEventListener("keydown", trap, true);
      if (before?.isConnected) before.focus();
    };
  }, []);
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
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) {
          e.stopPropagation();
          onClose();
        }
        if (e.metaKey && e.key === "Enter") {
          e.preventDefault();
          void submit(e.shiftKey ? "open" : "background");
        }
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-composer-title"
        className="w-full max-w-xl rounded-xl border border-border bg-card p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="task-composer-title" className="font-semibold">
            New task
          </h2>
          <button
            className="pi-btn"
            onClick={onClose}
            disabled={pending}
            aria-label="Close task composer"
          >
            ×
          </button>
        </div>
        <label className="task-label">
          Project
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            disabled={!!seed?.source}
            className="task-input"
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="task-label">
          Title <span className="text-muted-foreground">optional</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="A short name for this work"
            className="task-input"
          />
        </label>
        <label className="task-label">
          What do you want to do?
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={6}
            placeholder="Describe the outcome and what good looks like…"
            className="task-input resize-y"
          />
        </label>
        <label className="task-label">
          Agent
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="task-input"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <p className="my-3 text-xs text-muted-foreground">
          Local workspace · ⌘Enter starts in background · ⇧⌘Enter opens the task
        </p>
        {error && (
          <p role="alert" className="my-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            className="pi-btn"
            disabled={
              pending || !(title.trim() || description.trim()) || !project
            }
            onClick={() => void submit("save")}
          >
            Save to backlog
          </button>
          <button
            className="pi-btn"
            disabled={
              pending ||
              !(title.trim() || description.trim()) ||
              !agentId ||
              !project
            }
            onClick={() => void submit("open")}
          >
            Start and open
          </button>
          <button
            className="pi-btn pi-btn-primary"
            disabled={
              pending ||
              !(title.trim() || description.trim()) ||
              !agentId ||
              !project
            }
            onClick={() => void submit("background")}
          >
            Start in background
          </button>
        </div>
      </section>
    </div>
  );
}
