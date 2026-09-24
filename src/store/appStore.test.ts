import { beforeEach, describe, expect, it } from "vitest";
import {
  agentModelEnv,
  cloudSettingsOf,
  migrateSettings,
  resolveChatTransport,
  useAppStore,
  type AgentProfile,
  type Settings,
} from "./appStore";

describe("agent transport migration", () => {
  it("backfills ACP settings and removes the retired OpenCode seed profile", () => {
    const claude: AgentProfile = {
      id: "claude",
      name: "Claude",
      command: "claude-custom",
      promptTemplate: 'claude-custom "{prompt}"',
    };

    const opencode: AgentProfile = {
      id: "opencode",
      name: "OpenCode",
      command: "opencode",
      promptTemplate: 'opencode "{prompt}"',
    };

    const settings = migrateSettings({
      settings: {
        agents: [claude, opencode],
        defaultAgentId: "opencode",
        theme: "dark",
        connections: { github: { status: "disconnected" } },
      },
    });

    expect(settings.agents.find((agent) => agent.id === "claude")).toEqual(
      expect.objectContaining({ command: "claude-custom", transport: "acp" }),
    );
    expect(settings.agents.find((agent) => agent.id === "opencode")).toBeUndefined();
    expect(settings.defaultAgentId).toBe("claude");
    expect(settings.agents.map((agent) => agent.id)).toEqual(["claude", "codex", "pi"]);
  });

  it("backfills Claude's default model without overriding a cleared one", () => {
    const base = { theme: "dark" as const, connections: { github: { status: "disconnected" as const } } };
    const claude: AgentProfile = { id: "claude", name: "Claude", command: "claude", promptTemplate: "" };

    const legacy = migrateSettings({ settings: { ...base, agents: [claude], defaultAgentId: "claude" } });
    const migrated = legacy.agents.find((a) => a.id === "claude")!;
    expect(agentModelEnv(migrated)).toEqual({ ANTHROPIC_MODEL: "claude-opus-4-8" });

    const cleared = migrateSettings({
      settings: { ...base, agents: [{ ...claude, defaultModel: "" }], defaultAgentId: "claude" },
    });
    expect(agentModelEnv(cleared.agents.find((a) => a.id === "claude")!)).toBeUndefined();
  });

  it("sets no model env for agents without a model env var", () => {
    const codex = migrateSettings(null).agents.find((a) => a.id === "codex")!;
    expect(agentModelEnv({ ...codex, defaultModel: "gpt-6" })).toBeUndefined();
  });

  it("keeps custom agents on the terminal transport", () => {
    const settings: Settings = {
      defaultAgentId: "custom",
      agents: [
        {
          id: "custom",
          name: "Custom",
          command: "my-agent",
          promptTemplate: 'my-agent "{prompt}"',
        },
      ],
      theme: "dark",
      connections: { github: { status: "disconnected" } },
    };

    expect(resolveChatTransport(settings, {})).toBe("pty");
  });

  it("lets a chat override its agent transport", () => {
    const settings = migrateSettings(null);

    expect(
      resolveChatTransport(settings, {
        agentId: "claude",
        transport: "pty",
      }),
    ).toBe("pty");
  });
});

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
  useAppStore.setState({ cloudRuns: {}, cloudQuickStages: {}, cloudQuickErrors: {}, hydrated: false });
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

  it("falls back to the default when a stored base snapshot is blank", () => {
    const tree = structuredClone(LEGACY_TREE) as { settings: Record<string, unknown> };
    tree.settings.cloud = { baseSnapshot: "", deadlineMinutes: 10 };
    useAppStore.getState().hydrate(tree as never);
    const cloud = cloudSettingsOf(useAppStore.getState().settings);
    expect(cloud.baseSnapshot).toBe("powerhouse-base");
    // Other stored values are still honoured.
    expect(cloud.deadlineMinutes).toBe(10);
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

describe("chat activity", () => {
  it("sets, replaces, and clears a chat's activity", () => {
    useAppStore.setState({ chatActivity: {} });
    const { setChatActivity } = useAppStore.getState();
    setChatActivity("c1", "working");
    setChatActivity("c1", "done");
    expect(useAppStore.getState().chatActivity).toEqual({ c1: "done" });
    setChatActivity("c1", null);
    expect(useAppStore.getState().chatActivity).toEqual({});
  });

  it("drops the activity of a removed chat", () => {
    useAppStore.setState({ repos: [], chatActivity: { c1: "done", c2: "working" } });
    useAppStore.getState().removeChat("r", "b", "c1");
    expect(useAppStore.getState().chatActivity).toEqual({ c2: "working" });
  });
});

describe("target branch", () => {
  it("retargets one repo's worktree base and merge-queue landing branch", () => {
    useAppStore.getState().hydrate(structuredClone(LEGACY_TREE) as never);
    useAppStore.getState().setDefaultBranch("repo-1", "test");
    expect(useAppStore.getState().repos[0].defaultBranch).toBe("test");
    // Everything else on the repo is untouched.
    expect(useAppStore.getState().repos[0].workflow[0].command).toBe("pnpm build");
    expect(useAppStore.getState().repos[0].branches).toHaveLength(1);
  });
});
