import { beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../../store/appStore";
import { createTask } from "./taskStore";
import {
  startTask,
  archiveTask,
  completeTask,
  parkTask,
  enqueueTask,
} from "./taskActions";
const mocks = vi.hoisted(() => ({
  allocate: vi.fn(),
  start: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/ipc", () => ({
  gitEnsureTaskWorktree: mocks.allocate,
  gitWorktreeDirty: vi.fn(),
  queueEnqueue: vi.fn(),
}));
vi.mock("../../store/persist", () => ({ flushPersistence: mocks.flush }));
vi.mock("../../lib/agentSessionService", () => ({
  startSession: mocks.start,
  useSessions: { getState: () => ({ sessions: {} }) },
}));
vi.mock("../../lib/actions", () => ({ importCloudResult: vi.fn() }));
beforeEach(() => {
  useAppStore.getState().hydrate(null);
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
