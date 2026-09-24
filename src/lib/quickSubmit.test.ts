import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ model: null as string | null, detached: [] as string[] }));
vi.mock("./acpRegistry", () => ({
  acpModel: () => registry.model,
  detachAcp: async (chatId: string) => {
    registry.detached.push(chatId);
  },
}));

import { buildQuickSubmitRequest, prepareChatHandoff } from "./quickSubmit";
import { applyReturnedSession, runHoldingChat, type CloudRunRecord } from "./cloud";
import {
  DEFAULT_CLOUD_SETTINGS,
  migrateSettings,
  useAppStore,
  type Chat,
  type Repo,
  type Settings,
} from "../store/appStore";

const repo: Repo = {
  id: "r1",
  name: "app",
  path: "/repos/app",
  defaultBranch: "main",
  branches: [],
  workflow: [
    { id: "w1", name: "tests", command: "npm test", type: "command" },
    { id: "w2", name: "empty", command: "   ", type: "command" },
  ],
  pushOnMerge: false,
};

const settings = {
  cloud: {
    ...DEFAULT_CLOUD_SETTINGS,
    baseSnapshot: " powerhouse-base ",
    allowedTools: "Read, Edit,,Bash ",
    deadlineMinutes: 45.4,
    model: "  ",
  },
} as Settings;

describe("buildQuickSubmitRequest", () => {
  it("carries the last-used settings and the repo workflow as checks", () => {
    const req = buildQuickSubmitRequest(repo, "/repos/app/.wt/feat", settings);
    expect(req.repoId).toBe("r1");
    expect(req.sourcePath).toBe("/repos/app/.wt/feat");
    expect(req.baseSnapshot).toBe("powerhouse-base");
    expect(req.checks).toEqual([{ name: "tests", command: "npm test" }]);
    expect(req.deadlineSeconds).toBe(45 * 60);
    expect(req.allowedTools).toEqual(["Read", "Edit", "Bash"]);
    expect(req.model).toBeNull();
    expect(req.provider).toBe("claude");
    expect(req.envNames).toEqual([]);
    expect(req.chatId).toBeNull();
  });

  it("remembers the originating chat so the result can return to it", () => {
    const req = buildQuickSubmitRequest(repo, repo.path, settings, "chat-7");
    expect(req.chatId).toBe("chat-7");
  });

  it("passes the repo's configured env names", () => {
    const req = buildQuickSubmitRequest({ ...repo, cloudEnvNames: ["FOO_API_KEY"] }, repo.path, settings);
    expect(req.envNames).toEqual(["FOO_API_KEY"]);
  });

  it("falls back to defaults when no cloud settings were ever saved", () => {
    const req = buildQuickSubmitRequest(repo, repo.path, { cloud: undefined } as Settings);
    expect(req.baseSnapshot).toBe(DEFAULT_CLOUD_SETTINGS.baseSnapshot);
    expect(req.machineCeiling).toBe(DEFAULT_CLOUD_SETTINGS.machineCeiling);
  });
});

describe("cloud quick stage mirror", () => {
  it("tracks and clears per-branch stages without leaking keys", () => {
    const s = () => useAppStore.getState();
    s().setCloudQuickStage("r1", "feat/x", "checkpointing");
    expect(s().cloudQuickStages["r1:feat/x"]).toBe("checkpointing");
    s().setCloudQuickStage("r1", "feat/x", "pushing");
    expect(s().cloudQuickStages["r1:feat/x"]).toBe("pushing");
    s().setCloudQuickStage("r1", "feat/x", null);
    expect(s().cloudQuickStages).toEqual({});
    // Clearing an unknown key is a no-op, not an error.
    s().setCloudQuickStage("r1", "never-started", null);
    expect(s().cloudQuickStages).toEqual({});
  });
});

describe("sending the chat itself", () => {
  const full = migrateSettings(null);
  const chat: Chat = { id: "c1", title: "t", agentId: "claude", agentSessionId: "s-1" };

  beforeEach(() => {
    registry.model = null;
    registry.detached = [];
  });

  it("detaches a Claude ACP chat and continues with its model", async () => {
    registry.model = "sonnet";
    const handoff = await prepareChatHandoff(full, chat);
    expect(handoff).toEqual({ agentSessionId: "s-1", model: "sonnet" });
    expect(registry.detached).toEqual(["c1"]);
    const req = buildQuickSubmitRequest(repo, repo.path, settings, "c1", handoff);
    expect(req.agentSessionId).toBe("s-1");
    expect(req.model).toBe("sonnet");
  });

  it("falls back to the agent's default model when the chat says default", async () => {
    registry.model = "default";
    const handoff = await prepareChatHandoff(full, chat);
    expect(handoff?.model).toBe("claude-opus-4-8");
  });

  it("sends only the branch for chats that cannot travel", async () => {
    expect(await prepareChatHandoff(full, undefined)).toBeNull();
    expect(await prepareChatHandoff(full, { ...chat, agentSessionId: undefined })).toBeNull();
    expect(await prepareChatHandoff(full, { ...chat, transport: "pty" })).toBeNull();
    expect(registry.detached).toEqual([]);
    const req = buildQuickSubmitRequest(repo, repo.path, settings, "c1", null);
    expect(req.agentSessionId).toBeNull();
  });
});

describe("runHoldingChat", () => {
  const run = (over: Partial<CloudRunRecord>): CloudRunRecord =>
    ({
      run_id: "r",
      origin_chat_id: "c1",
      phase: "accepted",
      session: { session_id: "s-1", cwd: "/w", returned: null },
      ...over,
    }) as CloudRunRecord;

  it("locks the chat only while its session is out", () => {
    expect(runHoldingChat({ r: run({}) }, "c1")?.run_id).toBe("r");
    expect(runHoldingChat({ r: run({}) }, "c2")).toBeNull();
    expect(runHoldingChat({ r: run({ session: null }) }, "c1")).toBeNull();
    expect(runHoldingChat({ r: run({ phase: "submit_failed" }) }, "c1")).toBeNull();
    expect(
      runHoldingChat(
        { r: run({ session: { session_id: "s-1", cwd: "/w", returned: { kind: "unchanged", reason: "x" } } }) },
        "c1",
      ),
    ).toBeNull();
  });
});

describe("applyReturnedSession", () => {
  it("points the chat at the returned session and replays it once", () => {
    const branch = {
      id: "b1",
      name: "feat",
      worktreePath: "/w",
      chats: [{ id: "c1", title: "t", agentSessionId: "s-1" }],
      activeChatId: "c1",
    };
    useAppStore.setState({ repos: [{ ...repo, branches: [branch] }] as Repo[] });
    const chat = () => useAppStore.getState().repos[0].branches[0].chats[0];
    const rec = {
      run_id: "run-1",
      origin_chat_id: "c1",
      phase: "accepted",
      session: { session_id: "s-2", cwd: "/w", returned: { kind: "restored", session_id: "s-2", files: 3 } },
    } as CloudRunRecord;
    applyReturnedSession(rec);
    expect(chat()).toMatchObject({ agentSessionId: "s-2", cloudSessionRunId: "run-1", replayOnResume: true });
    useAppStore.getState().setChatReplay("r1", "b1", "c1", false);
    applyReturnedSession(rec);
    expect(chat().replayOnResume).toBe(false);
    // Nothing came back: the chat keeps its own session.
    applyReturnedSession({ ...rec, run_id: "run-2", session: { ...rec.session!, returned: { kind: "unchanged", reason: "x" } } });
    expect(chat().cloudSessionRunId).toBe("run-1");
  });
});
