import { expect, it, vi } from "vitest";
import { useAppStore } from "./appStore";
import { startPersistence } from "./persist";
import { newWorkflowDraft } from "../features/workflows/workflowDrafts";

const disk = vi.hoisted(() => ({ set: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn().mockResolvedValue(disk) }));

it("persists workflow edits but not workspace navigation", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  try {
    useAppStore.getState().hydrate(null);
    startPersistence();
    useAppStore.getState().setWorkspaceView("workflows");
    await vi.advanceTimersByTimeAsync(400);
    expect(disk.set).not.toHaveBeenCalled();
    const draft = newWorkflowDraft("repo");
    useAppStore.getState().saveWorkflowDraft(draft);
    await vi.advanceTimersByTimeAsync(400);
    expect(disk.set).toHaveBeenCalledWith("tree", expect.objectContaining({ workflowDrafts: [draft] }));
    expect(disk.set.mock.calls[0][1]).not.toHaveProperty("workspaceView");
    expect(disk.save).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
