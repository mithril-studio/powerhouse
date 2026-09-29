import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendSystemMessage } from "../lib/acpTranscript";
import {
  agentModelEnv,
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

    const codex: AgentProfile = {
      id: "codex",
      name: "Codex",
      command: "codex",
      promptTemplate: 'codex "{prompt}"',
    };

    const settings = migrateSettings({
      settings: {
        agents: [claude, opencode, codex],
        defaultAgentId: "opencode",
        theme: "dark",
        connections: { github: { status: "disconnected" } },
      },
    });

    expect(settings.agents.find((agent) => agent.id === "claude")).toEqual(
      expect.objectContaining({ command: "claude-custom", transport: "acp" }),
    );
    expect(settings.agents.find((agent) => agent.id === "opencode")).toBeUndefined();
    expect(settings.agents.find((agent) => agent.id === "codex")).toBeUndefined();
    expect(settings.defaultAgentId).toBe("claude");
    expect(settings.agents.map((agent) => agent.id)).toEqual(["claude", "pi"]);
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
    const pi = migrateSettings(null).agents.find((a) => a.id === "pi")!;
    expect(agentModelEnv({ ...pi, defaultModel: "gpt-6" })).toBeUndefined();
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
  useAppStore.setState({ cloudWorkspaces: {}, hydrated: false });
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
    expect(s.cloudWorkspaces).toEqual({});
  });

  it("drops the old cloud run cards from saved chats", () => {
    const tree = structuredClone(LEGACY_TREE) as never as { repos: { branches: { chats: { acpTranscript?: unknown[] }[] }[] }[] };
    tree.repos[0].branches[0].chats[0].acpTranscript = [
      { id: "m", type: "message", role: "user", text: "hi" },
      { id: "cloud-result-r1", type: "cloud-result", runId: "r1", late: false },
    ];
    useAppStore.getState().hydrate(tree as never);
    expect(useAppStore.getState().repos[0].branches[0].chats[0].acpTranscript?.map((i) => i.id)).toEqual(["m"]);
  });

  it("drops the old cloud run settings", () => {
    const tree = structuredClone(LEGACY_TREE) as { settings: Record<string, unknown> };
    tree.settings.cloud = { baseSnapshot: "my-base", deadlineMinutes: 10 };
    useAppStore.getState().hydrate(tree as never);
    expect("cloud" in useAppStore.getState().settings).toBe(false);
  });
});

describe("cloud workspace mirror", () => {
  it("is runtime state that hydration leaves alone", () => {
    const w = { id: "w1", chatId: "c1", status: "running" } as never;
    useAppStore.getState().setCloudWorkspace(w);
    useAppStore.getState().hydrate(structuredClone(LEGACY_TREE) as never);
    expect(useAppStore.getState().cloudWorkspaces["w1"]).toBe(w);
    useAppStore.getState().removeCloudWorkspace("w1");
    expect(useAppStore.getState().cloudWorkspaces).toEqual({});
  });
});

describe("page navigation overlays", () => {
  it("keeps settings, telemetry, memory and workflows mutually reachable", () => {
    useAppStore.setState({
      workspaceView: "home",
      settingsOpen: false,
      telemetryOpen: false,
      memoryOpen: false,
    });

    useAppStore.getState().openSettings();
    expect(useAppStore.getState()).toEqual(
      expect.objectContaining({ settingsOpen: true, memoryOpen: false, telemetryOpen: false }),
    );

    useAppStore.getState().openMemory();
    expect(useAppStore.getState()).toEqual(
      expect.objectContaining({ settingsOpen: false, memoryOpen: true, telemetryOpen: false }),
    );

    useAppStore.getState().openTelemetry();
    expect(useAppStore.getState()).toEqual(
      expect.objectContaining({ settingsOpen: false, memoryOpen: false, telemetryOpen: true }),
    );

    useAppStore.getState().openMemory();
    useAppStore.getState().setWorkspaceView("workflows");
    expect(useAppStore.getState()).toEqual(
      expect.objectContaining({
        workspaceView: "workflows",
        settingsOpen: false,
        memoryOpen: false,
        telemetryOpen: false,
      }),
    );
  });

  it("leaves the memory page when a worktree or chat is selected", () => {
    useAppStore.getState().openMemory();
    expect(useAppStore.getState().memoryOpen).toBe(true);

    useAppStore.getState().select("repo-1", "b1");
    expect(useAppStore.getState()).toEqual(
      expect.objectContaining({
        selection: { repoId: "repo-1", branchId: "b1" },
        memoryOpen: false,
        settingsOpen: false,
        telemetryOpen: false,
        workspaceView: "home",
      }),
    );
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

describe("file tabs", () => {
  const seed = () =>
    useAppStore.setState({
      repos: [
        {
          id: "r",
          name: "r",
          path: "/r",
          defaultBranch: "main",
          workflow: [],
          pushOnMerge: false,
          branches: [{ id: "b", name: "b", worktreePath: "/r", chats: [], activeChatId: "c1" }],
        },
      ],
    });
  const branch = () => useAppStore.getState().repos[0].branches[0];

  it("opens a file once and focuses it", () => {
    seed();
    const { openFile } = useAppStore.getState();
    openFile("r", "b", "a.md");
    openFile("r", "b", "b.ts");
    openFile("r", "b", "a.md");
    expect(branch().files).toEqual(["a.md", "b.ts"]);
    expect(branch().activeFile).toBe("a.md");
  });

  it("closing the active file focuses its neighbour, then falls back to the chat", () => {
    seed();
    const { openFile, closeFile } = useAppStore.getState();
    openFile("r", "b", "a.md");
    openFile("r", "b", "b.ts");
    closeFile("r", "b", "b.ts");
    expect(branch().activeFile).toBe("a.md");
    closeFile("r", "b", "a.md");
    expect(branch().activeFile).toBeNull();
    expect(branch().activeChatId).toBe("c1");
  });

  it("selecting a chat hides the file but keeps it open", () => {
    seed();
    useAppStore.getState().openFile("r", "b", "a.md");
    useAppStore.getState().setActiveChat("r", "b", "c1");
    expect(branch().activeFile).toBeNull();
    expect(branch().files).toEqual(["a.md"]);
  });
});

describe("right sidebar width", () => {
  it("survives a reload", () => {
    useAppStore.getState().hydrate(structuredClone(LEGACY_TREE) as never);
    useAppStore.getState().setRightSidebarWidth(512.4);
    const settings = migrateSettings({ settings: useAppStore.getState().settings });
    expect(settings.rightSidebarWidth).toBe(512);
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

describe("chat updates", () => {
  beforeEach(() => {
    useAppStore.getState().hydrate(structuredClone(LEGACY_TREE) as never);
    const repo = useAppStore.getState().repos[0];
    const branch = repo.branches[0];
    useAppStore.setState({ repos: [
      { ...repo, branches: [
        { ...branch, chats: [...branch.chats, { id: "c2", title: "Chat 2" }] },
        { ...branch, id: "b2" },
      ] },
      { ...repo, id: "repo-2" },
    ] });
  });

  it("changes the addressed chat while preserving other chats, branches and repos", () => {
    const before = useAppStore.getState().repos;
    const s = useAppStore.getState();
    s.setChatCloudRecap("repo-1", "b1", "c1", "Cloud turn 1: fixed X");
    s.setChatAgentSession("repo-1", "b1", "c1", "local-session");
    s.setChatTransport("repo-1", "b1", "c1", "pty");
    s.updateChatAcpTranscript("repo-1", "b1", "c1", (items) =>
      appendSystemMessage(items, "Resumed"),
    );
    s.updateChatAcpTranscript("repo-1", "b1", "c1", (items) =>
      appendSystemMessage(items, "Ready"),
    );

    const after = useAppStore.getState().repos;
    const chat = after[0].branches[0].chats[0];
    expect(chat).toMatchObject({
      id: "c1", title: "Chat 1", cloudRecap: "Cloud turn 1: fixed X",
      agentSessionId: "local-session", transport: "pty",
    });
    s.setChatCloudRecap("repo-1", "b1", "c1", null);
    expect("cloudRecap" in useAppStore.getState().repos[0].branches[0].chats[0]).toBe(false);
    expect(chat.acpTranscript).toHaveLength(2);
    expect(after[0].branches[0].chats[1]).toBe(before[0].branches[0].chats[1]);
    expect(after[0].branches[1]).toBe(before[0].branches[1]);
    expect(after[1]).toBe(before[1]);
    expect(before[0].branches[0].chats[0]).toEqual(LEGACY_TREE.repos[0].branches[0].chats[0]);
  });

  it("ignores transcript updates for missing repos, branches or chats", () => {
    const before = useAppStore.getState().repos;
    const update = vi.fn((items) => items);
    const s = useAppStore.getState();
    s.updateChatAcpTranscript("missing", "b1", "c1", update);
    s.updateChatAcpTranscript("repo-1", "missing", "c1", update);
    s.updateChatAcpTranscript("repo-1", "b1", "missing", update);
    expect(update).not.toHaveBeenCalled();
    expect(useAppStore.getState().repos).toEqual(before);
  });
});
