import { describe, expect, it } from "vitest";
import { useAppStore, type Repo } from "../store/appStore";
import { isCloudBranch, MAX_RECONNECTS, reconnectDelayMs, resumeMeta } from "./vmChats";

const repo = (location?: "cloud" | "local"): Repo => ({
  id: "r",
  name: "app",
  path: "/tmp/app",
  defaultBranch: "test",
  workflow: [],
  pushOnMerge: true,
  branches: [
    {
      id: "b",
      name: "swift-comet",
      worktreePath: "/tmp/wt",
      chats: [{ id: "c", title: "Chat 1" }],
      activeChatId: "c",
      ...(location ? { location } : {}),
    },
  ],
});

const branch = () => useAppStore.getState().repos[0].branches[0];

describe("cloud chats", () => {
  it("treats only branches marked cloud as cloud; older branches are local", () => {
    expect(isCloudBranch({ location: "cloud" })).toBe(true);
    expect(isCloudBranch({ location: "local" })).toBe(false);
    expect(isCloudBranch({})).toBe(false);
    expect(isCloudBranch(null)).toBe(false);
  });

  it("resumes from the last seen seq, or replays everything", () => {
    expect(resumeMeta(41)).toEqual({ "ph/fromSeq": 41 });
    expect(resumeMeta(undefined)).toEqual({ "ph/fromSeq": 0 });
  });

  it("backs off reconnects and caps the delay", () => {
    expect([0, 1, 2, 3, 4, 20].map(reconnectDelayMs)).toEqual([1000, 2000, 5000, 10000, 30000, 30000]);
    expect(MAX_RECONNECTS).toBeGreaterThan(3);
  });

  it("records the VM or the failure, never both", () => {
    useAppStore.setState({ repos: [repo("cloud")] });
    const s = useAppStore.getState();
    s.setBranchVm("r", "b", null, "boom");
    expect(branch()).toMatchObject({ vmError: "boom" });
    expect(branch().vm).toBeUndefined();
    s.setBranchVm("r", "b", "ph-c-x");
    expect(branch().vm).toBe("ph-c-x");
    expect(branch().vmError).toBeUndefined();
  });

  it("only moves the seen seq forward", () => {
    useAppStore.setState({ repos: [repo("cloud")] });
    const s = useAppStore.getState();
    s.setChatAgentSeq("r", "b", "c", 10);
    s.setChatAgentSeq("r", "b", "c", 7); // a replayed update after a reconnect
    expect(branch().chats[0].agentSeq).toBe(10);
  });

  it("does not open the new-chat picker on a cloud branch", () => {
    for (const [location, expected] of [["cloud", false], ["local", true]] as const) {
      useAppStore.setState({ repos: [repo(location)], selection: { repoId: "r", branchId: "b" }, chatPickerOpen: false });
      useAppStore.getState().openChatPicker();
      expect(useAppStore.getState().chatPickerOpen).toBe(expected);
    }
  });

  it("tracks VM creation per branch without persisting it", () => {
    const s = useAppStore.getState();
    s.setVmCreating("b", true);
    expect(useAppStore.getState().vmCreating).toEqual({ b: true });
    s.setVmCreating("b", false);
    expect(useAppStore.getState().vmCreating).toEqual({});
  });
});
