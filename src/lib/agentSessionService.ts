import { create } from "zustand";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PendingPermission } from "../components/acp/AcpPermissionCard";
import type { SessionActivity } from "../features/tasks/types";

/**
 * Read-only mirror of every chat's ACP session plus a handle to drive it.
 *
 * `useAcpSession` (mounted once per chat, visible or not) owns the session and
 * publishes here. The task board and Mission Control read this to place work
 * and start, stop, or answer agents without the chat being on screen.
 */
export interface Permission extends PendingPermission {
  id: string;
}
export interface SessionSnapshot extends SessionActivity {
  permissions: Permission[];
}
export const EMPTY_SESSION: SessionSnapshot = {
  connection: "idle",
  busy: false,
  permissionCount: 0,
  error: null,
  permissions: [],
};

export interface SessionHandle {
  start: (resume: boolean) => Promise<void>;
  submit: (text: string) => Promise<void>;
  cancel: () => void;
  acknowledgeError: () => void;
  resolvePermission: (response: RequestPermissionResponse) => void;
}

export const useSessions = create<{ sessions: Record<string, SessionSnapshot> }>(
  () => ({ sessions: {} }),
);
const handles = new Map<string, SessionHandle>();

/** Called by `useAcpSession` whenever its observable state changes. */
export function publishSession(id: string, snapshot: SessionSnapshot) {
  useSessions.setState((s) => ({ sessions: { ...s.sessions, [id]: snapshot } }));
}
export function registerSession(id: string, handle: SessionHandle) {
  handles.set(id, handle);
  return () => {
    if (handles.get(id) === handle) handles.delete(id);
    useSessions.setState((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return { sessions };
    });
  };
}

/** A chat added to the store mounts its session hook on the next render. */
function handleFor(id: string, timeoutMs = 5000): Promise<SessionHandle> {
  const ready = handles.get(id);
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const handle = handles.get(id);
      if (handle) return resolve(handle);
      if (Date.now() - started > timeoutMs)
        return reject(new Error("The conversation did not open. Open the workspace to continue."));
      setTimeout(poll, 25);
    };
    poll();
  });
}

/** Agents can take a while to boot (first run may install), but never this long. */
const START_TIMEOUT_MS = 180_000;

/** Resolves once the agent is connected (its first prompt keeps running) or failed. */
export async function startSession(id: string, resume: boolean): Promise<void> {
  const handle = await handleFor(id);
  // Ignore whatever state the chat was left in until this start has begun.
  let begun = false;
  let check: (s?: SessionSnapshot) => void = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      unsubscribe();
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    check = (s) => {
      // The chat (or its branch/project) was removed: its hook unmounted.
      if (!s && !handles.has(id))
        return finish(new Error("The conversation was closed before the agent started."));
      if (s?.connection === "starting") begun = true;
      if (!begun || !s || s.connection === "starting") return;
      if (s.connection === "idle")
        return finish(new Error("The conversation was detached before the agent started."));
      if (s.connection === "ready") finish();
      else finish(new Error(s.error ?? "The agent could not start."));
    };
    unsubscribe = useSessions.subscribe((state) => check(state.sessions[id]));
    timer = setTimeout(
      () => finish(new Error("The agent took too long to start. Open the workspace to check on it.")),
      START_TIMEOUT_MS,
    );
  });
  // `start` also runs the first prompt to completion, so don't wait on it alone.
  void handle
    .start(resume)
    .then(() =>
      setTimeout(() => {
        begun = true;
        check(useSessions.getState().sessions[id]);
      }, 0),
    )
    .catch(() => {
      begun = true;
      check({ ...EMPTY_SESSION, connection: "error", error: "The agent could not start." });
    });
  await settled;
}

export async function sendSessionPrompt(id: string, text: string) {
  await (await handleFor(id)).submit(text);
}
export function cancelSession(id: string) {
  handles.get(id)?.cancel();
}
export function acknowledgeSessionError(id: string) {
  handles.get(id)?.acknowledgeError();
}
