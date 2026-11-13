import { beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../../store/appStore";
import { createTask, updateTask, recordTaskTurn } from "./taskStore";
import {
  startTask,
  archiveTask,
  completeTask,
  parkTask,
  enqueueTask,
  retryTaskChecks,
} from "./taskActions";
const mocks = vi.hoisted(() => ({
  allocate: vi.fn(),
  start: vi.fn(),
  dirty: vi.fn(),
  enqueue: vi.fn(),
  dismiss: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/ipc", () => ({
  gitEnsureTaskWorktree: mocks.allocate,
  gitWorktreeDirty: mocks.dirty,
  queueEnqueue: mocks.enqueue,
  queueDismiss: mocks.dismiss,
}));
vi.mock("../../store/persist", () => ({ flushPersistence: mocks.flush }));
vi.mock("../../lib/agentSessionService", () => ({
  startSession: mocks.start,
  useSessions: { getState: () => ({ sessions: {} }) },
}));
vi.mock("../../lib/actions", () => ({ importCloudResult: vi.fn() }));
beforeEach(() => {
  useAppStore.getState().hydrate(null);
  mocks.dirty.mockReset().mockResolvedValue(false);
  mocks.enqueue.mockReset();
  mocks.dismiss.mockReset().mockResolvedValue(undefined);
  mocks.allocate.mockReset().mockResolvedValue("/task");
  mocks.start.mockReset().mockResolvedValue(undefined);
});
function seed() {
  const repo = useAppStore
    .getState()
    .addRepo({ name: "r", path: "/r", defaultBranch: "main" });
  return createTask({
    repoId: repo.id,
    title: "Build",
    description: "Build it",
    agentId: "claude",
  });
}
it("starts in background once without changing navigation", async () => {
  const t = seed();
  const selected = useAppStore.getState().selection;
  useAppStore.setState({ workspaceView: "board" });
  await Promise.all([startTask(t.id), startTask(t.id)]);
  expect(mocks.allocate).toHaveBeenCalledOnce();
  expect(mocks.start).toHaveBeenCalledOnce();
  expect(useAppStore.getState().selection).toEqual(selected);
  expect(useAppStore.getState().workspaceView).toBe("board");
  expect(useAppStore.getState().tasks[0].launch.stage).toBe("ready");
});
it("retains allocated work on startup failure and resumes the same chat", async () => {
  const t = seed();
  mocks.start.mockRejectedValueOnce(new Error("Agent missing"));
  await expect(startTask(t.id)).rejects.toThrow("Agent missing");
  const partial = useAppStore.getState().tasks[0];
  expect(partial.branchId).not.toBeNull();
  expect(partial.launch.stage).toBe("failed");
  await startTask(t.id);
  expect(mocks.allocate).toHaveBeenCalledOnce();
  expect(mocks.start).toHaveBeenLastCalledWith(partial.primaryChatId, true);
});

it("blocks archive, completion, backlog and checks while a legacy terminal is running", async () => {
  const task = seed();
  await startTask(task.id);
  const chatId = useAppStore.getState().tasks[0].primaryChatId!;
  useAppStore.setState({ chatStatus: { [chatId]: "running" } });
  expect(() => archiveTask(task.id, true)).toThrow("terminal agent");
  expect(() => completeTask(task.id)).toThrow("terminal agent");
  expect(() => parkTask(task.id)).toThrow("terminal agent");
  await expect(enqueueTask(task.id)).rejects.toThrow("terminal agent");
});

it("deleting the primary conversation clears ownership and starts a fresh chat", async () => {
  const task = seed();
  await startTask(task.id);
  const { branchId, primaryChatId } = useAppStore.getState().tasks[0];
  recordTaskTurn(primaryChatId!, "running");
  useAppStore.getState().removeChat(task.repoId, branchId!, primaryChatId!);
  expect(useAppStore.getState().tasks[0]).toMatchObject({ primaryChatId: null, turn: { outcome: "cancelled" } });
  await startTask(task.id);
  const replacement = useAppStore.getState().tasks[0].primaryChatId;
  expect(replacement).not.toBe(primaryChatId);
  expect(mocks.start).toHaveBeenLastCalledWith(replacement, false);
  expect(mocks.allocate).toHaveBeenCalledOnce();
});

it("recovers an already-persisted dangling chat reference as a fresh start", async () => {
  const task = seed();
  updateTask(task.id, { primaryChatId: "deleted-chat" });
  await startTask(task.id);
  expect(mocks.start).toHaveBeenLastCalledWith(useAppStore.getState().tasks[0].primaryChatId, false);
});

async function failedChecks() {
  const task = seed();
  await startTask(task.id);
  const branch = useAppStore.getState().repos[0].branches[0];
  const entry = { id: "failed-check", repo_id: task.repoId, branch: branch.name, state: "failed" as const, steps: [], error: "Checks failed", merge_commit: null, created_at: Date.now(), finished_at: Date.now() };
  useAppStore.getState().setQueueEntries(task.repoId, [entry]);
  updateTask(task.id, { queueId: entry.id });
  return { task, entry };
}

it("rejects dirty retry and preserves failed checks", async () => {
  const { task, entry } = await failedChecks();
  mocks.dirty.mockResolvedValue(true);
  await expect(retryTaskChecks(task.id, entry.id)).rejects.toThrow("Commit the task");
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.dismiss).not.toHaveBeenCalled();
  expect(useAppStore.getState().queues[task.repoId]).toEqual([entry]);
});

it("preserves failed checks if queue admission fails, then replaces them on success", async () => {
  const { task, entry } = await failedChecks();
  mocks.enqueue.mockRejectedValueOnce(new Error("Queue unavailable"));
  await expect(retryTaskChecks(task.id, entry.id)).rejects.toThrow("Queue unavailable");
  expect(mocks.dismiss).not.toHaveBeenCalled();
  const next = { ...entry, id: "retry", state: "queued", error: null, finished_at: null };
  mocks.enqueue.mockResolvedValueOnce(next);
  await retryTaskChecks(task.id, entry.id);
  expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith(task.repoId, entry.id);
  expect(useAppStore.getState().queues[task.repoId]).toEqual([next]);
  expect(useAppStore.getState().tasks[0].queueId).toBe(next.id);
});

it("rechecks activity after waiting for Git before admitting a retry", async () => {
  const { task, entry } = await failedChecks();
  let release!: (dirty: boolean) => void;
  mocks.dirty.mockReturnValueOnce(new Promise<boolean>((resolve) => { release = resolve; }));
  const retry = retryTaskChecks(task.id, entry.id);
  recordTaskTurn(useAppStore.getState().tasks[0].primaryChatId!, "running");
  release(false);
  await expect(retry).rejects.toThrow("Resolve attention");
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.dismiss).not.toHaveBeenCalled();
});
