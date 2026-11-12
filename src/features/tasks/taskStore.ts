import { useAppStore } from "../../store/appStore";
import type { Task, TurnOutcome } from "./types";

export function updateTask(id: string, patch: Partial<Task>) {
  useAppStore.setState((s) => ({ tasks: s.tasks.map((t) => t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t) }));
}
export function createTask(input: Pick<Task, "repoId" | "title" | "description" | "agentId"> & Pick<Partial<Task>, "source">): Task {
  const s = useAppStore.getState();
  if (!s.repos.some((r) => r.id === input.repoId)) throw new Error("Select an existing project.");
  if (!input.title.trim()) throw new Error("A task title is required.");
  const existing = input.source && s.tasks.find((t) => t.repoId === input.repoId && t.source?.repository.toLowerCase() === input.source!.repository.toLowerCase() && t.source.number === input.source!.number);
  if (existing) { updateTask(existing.id, { archivedAt: null }); return { ...existing, archivedAt: null }; }
  const now = Date.now();
  const task: Task = { ...input, title: input.title.trim(), id: crypto.randomUUID(), branchId: null, primaryChatId: null, createdAt: now, updatedAt: now, lastActivityAt: now, lastWorkAt: 0, seenAt: now, archivedAt: null, launch: { stage: "not_started" } };
  useAppStore.setState({ tasks: [...s.tasks, task] });
  return task;
}
export function adoptBranch(repoId: string, branchId: string): Task {
  const s = useAppStore.getState();
  const existing = s.tasks.find((t) => t.repoId === repoId && t.branchId === branchId);
  if (existing) return existing;
  const branch = s.repos.find((r) => r.id === repoId)?.branches.find((b) => b.id === branchId);
  if (!branch) throw new Error("Branch no longer exists.");
  const t = createTask({ repoId, title: branch.name, description: "", agentId: branch.chats[0]?.agentId ?? s.settings.defaultAgentId });
  const task = { ...t, branchId, primaryChatId: branch.activeChatId, launch: { stage: "ready" as const } };
  updateTask(task.id, task);
  return task;
}
export function recordTaskTurn(chatId: string, outcome: TurnOutcome, summary?: string) {
  const s = useAppStore.getState();
  const branch = s.repos.flatMap((r) => r.branches).find((b) => b.chats.some((c) => c.id === chatId));
  const task = branch && s.tasks.find((t) => t.branchId === branch.id);
  if (!task) return;
  const now = Date.now();
  updateTask(task.id, { turn: { outcome, at: now, summary }, lastActivityAt: now, archivedAt: null,
    ...(outcome === "running" ? { lastWorkAt: now, completion: undefined, queueId: undefined, launch: { ...task.launch, stage: "ready" as const, error: undefined } } : {}) });
}
