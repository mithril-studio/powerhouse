import { beforeEach, expect, it, vi } from "vitest";
import {
  EMPTY_SESSION,
  cancelSession,
  publishSession,
  registerSession,
  startSession,
  useSessions,
  type SessionHandle,
} from "./agentSessionService";

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    acknowledgeError: vi.fn(),
    resolvePermission: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => useSessions.setState({ sessions: {} }));

it("waits for a new chat's session to mount, then resolves once it connects", async () => {
  // Never-ending start: the first prompt keeps running after the agent connects.
  const h = handle({
    start: vi.fn(() => {
      publishSession("chat", { ...EMPTY_SESSION, connection: "starting" });
      setTimeout(() => publishSession("chat", { ...EMPTY_SESSION, connection: "ready", busy: true }), 10);
      return new Promise<void>(() => {});
    }),
  });
  // A stale failure from an earlier run must not settle this start.
  publishSession("chat", { ...EMPTY_SESSION, connection: "error", error: "old failure" });
  const started = startSession("chat", false);
  setTimeout(() => registerSession("chat", h), 30);
  await expect(started).resolves.toBeUndefined();
  expect(h.start).toHaveBeenCalledWith(false);
});

it("rejects with the agent's error when it cannot start", async () => {
  const h = handle({
    start: vi.fn(async () => publishSession("broken", { ...EMPTY_SESSION, connection: "error", error: "no ACP command" })),
  });
  registerSession("broken", h);
  await expect(startSession("broken", false)).rejects.toThrow("no ACP command");
});

it("routes stop to the live session and forgets it on unmount", () => {
  const h = handle();
  const unregister = registerSession("c", h);
  publishSession("c", { ...EMPTY_SESSION, connection: "ready", busy: true });
  cancelSession("c");
  expect(h.cancel).toHaveBeenCalled();
  unregister();
  expect(useSessions.getState().sessions.c).toBeUndefined();
  cancelSession("c");
  expect(h.cancel).toHaveBeenCalledTimes(1);
});

it("rejects instead of hanging when the chat is removed mid-start", async () => {
  let unregister = () => {};
  const h = handle({
    start: vi.fn(() => {
      publishSession("gone", { ...EMPTY_SESSION, connection: "starting" });
      setTimeout(() => unregister(), 10);
      return new Promise<void>(() => {});
    }),
  });
  unregister = registerSession("gone", h);
  await expect(startSession("gone", false)).rejects.toThrow("closed before the agent started");
});
