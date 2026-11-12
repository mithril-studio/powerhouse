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
    useAppStore.getState().openSettings("telemetry");
    await vi.advanceTimersByTimeAsync(400);
    expect(disk.set).not.toHaveBeenCalled();
    const draft = newWorkflowDraft("repo");
    useAppStore.getState().saveWorkflowDraft(draft);
    await vi.advanceTimersByTimeAsync(400);
    expect(disk.set).toHaveBeenCalledWith("tree", expect.objectContaining({ workflowDrafts: [draft] }));
    expect(disk.set.mock.calls[0][1]).not.toHaveProperty("settingsSection");
    expect(disk.save).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("serializes launch-boundary saves so an older write cannot overtake a newer one", async () => {
  const { flushPersistence } = await import("./persist");
  vi.useFakeTimers();
  let release!: () => void;
  disk.set.mockClear(); disk.save.mockClear();
  disk.save.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  try {
    useAppStore.getState().hydrate(null);
    const first = newWorkflowDraft("repo");
    useAppStore.getState().saveWorkflowDraft(first);
    const a = flushPersistence();
    await vi.advanceTimersByTimeAsync(0);
    const second = { ...first, name: "Newer draft" };
    useAppStore.getState().saveWorkflowDraft(second);
    const b = flushPersistence();
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.set).toHaveBeenCalledTimes(1);
    release(); await Promise.all([a, b]);
    expect(disk.set).toHaveBeenLastCalledWith("tree", expect.objectContaining({ workflowDrafts: [second] }));
  } finally { vi.useRealTimers(); }
});
