import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AcpCallbacks } from "./acpRegistry";
import { useAppStore } from "../store/appStore";
import { adoptBranch } from "../features/tasks/taskStore";
import {
  closeSession,
  cancelSession,
  sendSessionPrompt,
  startSession,
  useSessions,
} from "./agentSessionService";
const mock = vi.hoisted(() => ({
  start: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined),
  flush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./acpRegistry", () => ({
  startAcp: mock.start,
  sendAcpPrompt: mock.send,
  disposeAcp: vi.fn().mockResolvedValue(undefined),
  cancelAcpPrompt: mock.cancel,
  setAcpMode: vi.fn(),
  setAcpConfigOption: vi.fn(),
}));
vi.mock("../store/persist", () => ({ flushPersistence: mock.flush }));
vi.mock("./ipc", () => ({
  handoffWatchStart: vi.fn().mockResolvedValue(undefined),
  telemetryAnnotateRun: vi.fn().mockResolvedValue(undefined),
}));
let callbacks: AcpCallbacks;
let repoId: string;
beforeEach(() => {
  useAppStore.getState().hydrate(null);
  mock.start.mockReset();
  mock.send.mockReset();
  mock.cancel.mockReset().mockResolvedValue(undefined);
  mock.flush.mockReset().mockResolvedValue(undefined);
  const r = useAppStore
    .getState()
    .addRepo({ name: "r", path: "/r", defaultBranch: "main" });
  repoId = r.id;
  useAppStore
    .getState()
    .addBranch(r.id, {
      id: "branch",
      name: "f",
      worktreePath: "/f",
      chats: [{ id: "chat", title: "Chat" }],
      activeChatId: "chat",
    });
  adoptBranch(r.id, "branch");
  mock.start.mockImplementation(async (input) => {
    callbacks = input.callbacks;
    return { sessionId: "s", resumed: false, capabilities: {} };
  });
  mock.send.mockResolvedValue({ stopReason: "end_turn" });
});
afterEach(async () => {
  await closeSession("chat");
});
it("coalesces simultaneous starts from two views", async () => {
  await Promise.all([startSession("chat", false), startSession("chat", false)]);
  expect(mock.start).toHaveBeenCalledOnce();
  expect(useSessions.getState().sessions.chat.connection).toBe("ready");
});
it("keeps concurrent permissions and ignores a stale answer", async () => {
  await startSession("chat", false);
  const req = {
    sessionId: "s",
    toolCall: { toolCallId: "tool", title: "Write file" },
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" as const }],
  };
  const a = callbacks.onPermission(req);
  const b = callbacks.onPermission(req);
  const old = useSessions.getState().sessions.chat.permissions[0];
  old.resolve({ outcome: { outcome: "selected", optionId: "yes" } });
  await a;
  expect(useSessions.getState().sessions.chat.permissions).toHaveLength(1);
  old.resolve({ outcome: { outcome: "selected", optionId: "yes" } });
  expect(useSessions.getState().sessions.chat.permissions).toHaveLength(1);
  await closeSession("chat");
  expect(await b).toEqual({ outcome: { outcome: "cancelled" } });
});
it("failed and cancelled prompts never become successful review turns", async () => {
  await startSession("chat", false);
  mock.send.mockRejectedValueOnce(new Error("transport lost"));
  await expect(sendSessionPrompt("chat", "Build it")).rejects.toThrow(
    "transport lost",
  );
  expect(useAppStore.getState().tasks[0].turn?.outcome).toBe("failed");
  mock.send.mockResolvedValueOnce({ stopReason: "cancelled" });
  await sendSessionPrompt("chat", "Try again");
  expect(useAppStore.getState().tasks[0].turn?.outcome).toBe("cancelled");
});
it("resume fallback never resends the initial prompt", async () => {
  useAppStore.setState((s) => ({
    repos: s.repos.map((r) => ({
      ...r,
      branches: r.branches.map((b) => ({
        ...b,
        chats: [
          {
            id: "chat",
            title: "Chat",
            initialPrompt: "Original",
            agentSessionId: "old",
          },
        ],
      })),
    })),
  }));
  await startSession("chat", true);
  expect(mock.send).not.toHaveBeenCalled();
  expect(
    useAppStore.getState().repos.find((r) => r.id === repoId)?.branches[0]
      .chats[0].agentSessionId,
  ).toBe("s");
});
it("callbacks from a closed generation cannot mutate a new session", async () => {
  await startSession("chat", false);
  const old = callbacks;
  await closeSession("chat");
  await startSession("chat", true);
  old.onExit(1);
  old.onBusyChange?.(true);
  expect(useSessions.getState().sessions.chat).toMatchObject({
    connection: "ready",
    busy: false,
    error: null,
  });
});

it("Stop during persistence prevents prompt dispatch", async () => {
  await startSession("chat", false);
  let release!: () => void;
  mock.flush.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
  const pending = sendSessionPrompt("chat", "Build it");
  cancelSession("chat");
  release();
  await pending;
  expect(mock.send).not.toHaveBeenCalled();
  expect(mock.cancel).not.toHaveBeenCalled();
  expect(useAppStore.getState().tasks[0].turn?.outcome).toBe("cancelled");
  expect(useSessions.getState().sessions.chat).toMatchObject({ busy: false, canceling: false });
  await sendSessionPrompt("chat", "Continue explicitly");
  expect(mock.send).toHaveBeenCalledExactlyOnceWith("chat", "Continue explicitly");
});

it("Stop cancels an already dispatched prompt and records cancellation", async () => {
  await startSession("chat", false);
  let finish!: (result: { stopReason: string }) => void;
  mock.send.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const pending = sendSessionPrompt("chat", "Build it");
  await vi.waitFor(() => expect(mock.send).toHaveBeenCalledOnce());
  cancelSession("chat");
  await vi.waitFor(() => expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("chat"));
  finish({ stopReason: "end_turn" });
  await pending;
  expect(useAppStore.getState().tasks[0].turn?.outcome).toBe("cancelled");
});
