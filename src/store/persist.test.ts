import { expect, it, vi } from "vitest";
import { useAppStore } from "./appStore";
import { startPersistence } from "./persist";
import { createTask } from "../features/tasks/taskStore";

const disk = vi.hoisted(() => ({ set: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn().mockResolvedValue(disk) }));

it("persists tasks but not workspace navigation", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  try {
    useAppStore.getState().hydrate(null);
    startPersistence();
    useAppStore.getState().setWorkspaceView("board");
    await vi.advanceTimersByTimeAsync(400);
    expect(disk.set).not.toHaveBeenCalled();
    const repo = useAppStore.getState().addRepo({ name: "repo", path: "/repo", defaultBranch: "main" });
    await vi.advanceTimersByTimeAsync(400);
    disk.set.mockClear();
    disk.save.mockClear();
    const task = createTask({ repoId: repo.id, title: "Write tests", description: "", agentId: "claude" });
    await vi.advanceTimersByTimeAsync(400);
    expect(disk.set).toHaveBeenCalledWith("tree", expect.objectContaining({ schemaVersion: 1, tasks: [task] }));
    expect(disk.set.mock.calls[0][1]).not.toHaveProperty("workspaceView");
    expect(disk.save).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
