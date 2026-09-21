import { beforeEach, describe, expect, it } from "vitest";
import { cloudSettingsOf, useAppStore } from "./appStore";

// A store file written before cloud runs existed: repos, chats, queue history.
const LEGACY_TREE = {
  repos: [
    {
      id: "repo-1",
      name: "powerhouse",
      path: "/Users/x/powerhouse",
      defaultBranch: "main",
      branches: [
        {
          id: "b1",
          name: "feature",
          worktreePath: "/Users/x/.powerhouse/worktrees/powerhouse/feature",
          chats: [{ id: "c1", title: "Chat 1", agentSessionId: "c1" }],
          activeChatId: "c1",
        },
      ],
      workflow: [{ id: "w1", name: "build", command: "pnpm build", type: "command" }],
      pushOnMerge: true,
    },
  ],
  selection: { repoId: "repo-1", branchId: "b1" },
  settings: { agents: [{ id: "claude", name: "Claude", command: "claude", promptTemplate: 'claude "{prompt}"' }], defaultAgentId: "claude" },
  queues: {
    "repo-1": [
      { id: "q1", repo_id: "repo-1", branch: "feature", state: "validating", steps: [], error: null, merge_commit: null, created_at: 1, finished_at: null },
      { id: "q2", repo_id: "repo-1", branch: "old", state: "merged", steps: [], error: null, merge_commit: "abc", created_at: 0, finished_at: 1 },
    ],
  },
};

beforeEach(() => {
  useAppStore.setState({ cloudRuns: {}, cloudModal: null, hydrated: false });
});

describe("hydrate with a pre-cloud powerhouse.json", () => {
  it("keeps repos, branches, chats and merge history, and adds no cloud fields to the persisted tree", () => {
    useAppStore.getState().hydrate(structuredClone(LEGACY_TREE) as never);
    const s = useAppStore.getState();
    expect(s.repos).toHaveLength(1);
    expect(s.repos[0].branches[0].chats[0].agentSessionId).toBe("c1");
    expect(s.repos[0].workflow[0].command).toBe("pnpm build");
    expect(s.selection).toEqual({ repoId: "repo-1", branchId: "b1" });
    // Local queue rule still applies to local queue entries only.
    expect(s.queues["repo-1"].map((e) => e.state)).toEqual(["interrupted", "merged"]);
    expect(s.settings.cloud).toBeUndefined();
    expect(s.cloudRuns).toEqual({});
    // Defaults are derived, not written into settings.
    expect(cloudSettingsOf(s.settings).baseSnapshot).toBe("powerhouse-base");
    expect(cloudSettingsOf(s.settings).machineCeiling).toBe(18);
  });

  it("preserves and completes stored cloud settings", () => {
    const tree = structuredClone(LEGACY_TREE) as { settings: Record<string, unknown> };
    tree.settings.cloud = { baseSnapshot: "my-base", deadlineMinutes: 10 };
    useAppStore.getState().hydrate(tree as never);
    const cloud = cloudSettingsOf(useAppStore.getState().settings);
    expect(cloud.baseSnapshot).toBe("my-base");
    expect(cloud.deadlineMinutes).toBe(10);
    expect(cloud.machineCeiling).toBe(18);
  });

  it("drops the fork-era base VM setting in favour of the snapshot default", () => {
    const tree = structuredClone(LEGACY_TREE) as { settings: Record<string, unknown> };
    tree.settings.cloud = { baseVm: "powerhouse-cloud-base" };
    useAppStore.getState().hydrate(tree as never);
    const cloud = cloudSettingsOf(useAppStore.getState().settings);
    expect(cloud.baseSnapshot).toBe("powerhouse-base");
    expect("baseVm" in cloud).toBe(false);
  });
});

describe("cloud run mirror", () => {
  it("is runtime state separate from the queue hydration rule", () => {
    const rec = { run_id: "r1", phase: "accepted", snapshot: { state: "running" } } as never;
    useAppStore.getState().setCloudRun(rec);
    useAppStore.getState().hydrate(structuredClone(LEGACY_TREE) as never);
    // Hydration does not touch or "interrupt" cloud runs; the runner is asked instead.
    expect(useAppStore.getState().cloudRuns["r1"]).toBe(rec);
    useAppStore.getState().removeCloudRun("r1");
    expect(useAppStore.getState().cloudRuns).toEqual({});
  });
});
