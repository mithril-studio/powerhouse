import { create } from "zustand";
import type {
  AvailableCommand,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import {
  resolveAgent,
  useAppStore,
  type Branch,
  type Chat,
} from "../store/appStore";
import { flushPersistence } from "../store/persist";
import { recordTaskTurn } from "../features/tasks/taskStore";
import type { SessionActivity } from "../features/tasks/types";
import {
  appendSystemMessage,
  appendUserMessage,
  applyAcpUpdate,
} from "./acpTranscript";
import {
  cancelAcpPrompt,
  disposeAcp,
  sendAcpPrompt,
  setAcpConfigOption,
  setAcpMode,
  startAcp,
} from "./acpRegistry";
import { handoffWatchStart, telemetryAnnotateRun } from "./ipc";
import type { ApplyOp } from "./agentControls";

export interface Permission {
  id: string;
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
}
export interface SessionSnapshot extends SessionActivity {
  diagnostics: string;
  permissions: Permission[];
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  commands: AvailableCommand[];
  agentLabel: string;
}
export const EMPTY_SESSION: SessionSnapshot = {
  connection: "idle",
  busy: false,
  permissionCount: 0,
  error: null,
  diagnostics: "",
  permissions: [],
  modes: null,
  configOptions: [],
  commands: [],
  agentLabel: "Agent",
};
export const useSessions = create<{
  sessions: Record<string, SessionSnapshot>;
}>(() => ({ sessions: {} }));
const controllers = new Map<
  string,
  { generation: number; start?: Promise<void>; closed: boolean; prompt?: { dispatched: boolean; cancelled: boolean } }
>();
function snapshot(id: string) {
  return useSessions.getState().sessions[id] ?? EMPTY_SESSION;
}
function patch(id: string, change: Partial<SessionSnapshot>) {
  useSessions.setState((s) => ({
    sessions: { ...s.sessions, [id]: { ...snapshot(id), ...change } },
  }));
}
function context(id: string): { repoId: string; branch: Branch; chat: Chat } {
  for (const r of useAppStore.getState().repos)
    for (const b of r.branches) {
      const c = b.chats.find((c) => c.id === id);
      if (c) return { repoId: r.id, branch: b, chat: c };
    }
  throw new Error("Chat no longer exists");
}
function transcript(
  id: string,
  update: Parameters<
    ReturnType<typeof useAppStore.getState>["updateChatAcpTranscript"]
  >[3],
) {
  const c = context(id);
  useAppStore
    .getState()
    .updateChatAcpTranscript(c.repoId, c.branch.id, id, update);
}
export function noteSession(id: string, text: string, error = false) {
  transcript(id, (items) =>
    appendSystemMessage(items, text, error ? "error" : "normal"),
  );
}
function initialState(id: string, state: "sending" | "sent") {
  useAppStore.setState((s) => ({
    repos: s.repos.map((r) => ({
      ...r,
      branches: r.branches.map((b) => ({
        ...b,
        chats: b.chats.map((c) =>
          c.id === id ? { ...c, initialPromptState: state } : c,
        ),
      })),
    })),
  }));
}
function settlePermissions(id: string) {
  for (const p of snapshot(id).permissions)
    p.resolve({ outcome: { outcome: "cancelled" } });
  patch(id, { permissions: [], permissionCount: 0 });
}
export function resolveSessionPermission(
  id: string,
  permissionId: string,
  response: RequestPermissionResponse,
) {
  snapshot(id)
    .permissions.find((p) => p.id === permissionId)
    ?.resolve(response);
}
export async function startSession(id: string, resume: boolean): Promise<void> {
  let owner = controllers.get(id);
  if (owner?.start) return owner.start;
  if (snapshot(id).connection === "ready") return;
  if (!owner) {
    owner = { generation: 0, closed: false };
    controllers.set(id, owner);
  }
  owner.closed = false;
  owner.prompt = undefined;
  const generation = ++owner.generation;
  const valid = () =>
    controllers.get(id) === owner &&
    owner.generation === generation &&
    !owner.closed;
  const write = (change: Partial<SessionSnapshot>) => {
    if (valid()) patch(id, change);
  };
  const { repoId, branch, chat } = context(id);
  const profile = resolveAgent(useAppStore.getState().settings, chat.agentId);
  write({ ...EMPTY_SESSION, connection: "starting", agentLabel: profile.name });
  const work = (async () => {
    try {
      if (!profile.acpCommand)
        throw new Error(`${profile.name} has no ACP command configured.`);
      settlePermissions(id);
      let replaying = false;
      if (!resume) transcript(id, () => []);
      const result = await startAcp({
        chatId: id,
        cwd: branch.worktreePath,
        command: profile.acpCommand,
        resumeSessionId: resume ? chat.agentSessionId : undefined,
        callbacks: {
          onUpdate: (update) => {
            if (valid())
              transcript(id, (items) =>
                applyAcpUpdate(items, update, {
                  acceptUserMessageChunks: replaying,
                }),
              );
          },
          onPermission: (request) =>
            new Promise<RequestPermissionResponse>((resolve) => {
              if (!valid()) {
                resolve({ outcome: { outcome: "cancelled" } });
                return;
              }
              const permissionId = crypto.randomUUID();
              let settled = false;
              const permission: Permission = {
                id: permissionId,
                request,
                resolve: (response) => {
                  if (settled) return;
                  // An answer from an old UI snapshot cannot resolve a newer request.
                  const outcome = response.outcome;
                  if (
                    outcome.outcome === "selected" &&
                    !request.options.some(
                      (o) => o.optionId === outcome.optionId,
                    )
                  )
                    return;
                  settled = true;
                  resolve(
                    valid() ? response : { outcome: { outcome: "cancelled" } },
                  );
                  const remaining = snapshot(id).permissions.filter(
                    (p) => p.id !== permissionId,
                  );
                  patch(id, {
                    permissions: remaining,
                    permissionCount: remaining.length,
                  });
                },
              };
              const permissions = [...snapshot(id).permissions, permission];
              write({ permissions, permissionCount: permissions.length });
            }),
          onModeChange: (modeId) => {
            const modes = snapshot(id).modes;
            if (modes) write({ modes: { ...modes, currentModeId: modeId } });
          },
          onConfigOptionsChange: (configOptions) => write({ configOptions }),
          onAvailableCommandsChange: (commands) => write({ commands }),
          onSessionReplayChange: (value) => {
            if (valid()) {
              replaying = value;
              if (value) transcript(id, () => []);
            }
          },
          onBusyChange: (busy) => write({ busy: busy || !!owner.prompt }),
          onStderr: (chunk) =>
            write({
              diagnostics: `${snapshot(id).diagnostics}${chunk}`.slice(-4000),
            }),
          onExit: (code) => {
            if (!valid()) return;
            const interrupted =
              snapshot(id).busy || snapshot(id).connection === "starting";
            settlePermissions(id);
            write({
              connection: "exited",
              busy: false,
              canceling: false,
              error:
                interrupted || code !== 0
                  ? `Agent exited${code == null ? "" : ` (${code})`}. Resume to inspect.`
                  : null,
            });
            useAppStore.getState().setChatStatus(id, "exited");
            if (interrupted || code !== 0)
              recordTaskTurn(id, "interrupted", "Agent process exited");
            owner.generation++;
          },
        },
      });
      if (!valid()) {
        await disposeAcp(id);
        return;
      }
      useAppStore
        .getState()
        .setChatAgentSession(repoId, branch.id, id, result.sessionId);
      if (!result.resumed) transcript(id, () => []);
      write({
        connection: "ready",
        modes: result.modes ?? null,
        configOptions: result.configOptions ?? [],
        agentLabel: result.agentInfo?.name ?? profile.name,
      });
      useAppStore.getState().setChatStatus(id, "running");
      void handoffWatchStart(branch.id, branch.worktreePath).catch(() => {});
      const model = result.configOptions?.find((o) => o.category === "model");
      void telemetryAnnotateRun(id, {
        agentName: result.agentInfo?.name,
        agentVersion: result.agentInfo?.version,
        repoId,
        repoLabel: useAppStore.getState().repos.find((r) => r.id === repoId)
          ?.name,
        branchLabel: branch.name,
        model:
          typeof model?.currentValue === "string"
            ? model.currentValue
            : undefined,
      }).catch(() => {});
      await flushPersistence();
      if (!valid()) return;
      // A resume fallback is a fresh conversation, never permission to resend old work.
      if (resume && !result.resumed)
        noteSession(
          id,
          "The previous session could not be resumed. This is a fresh conversation; the original prompt was not resent.",
        );
      if (
        !resume &&
        !result.resumed &&
        chat.initialPrompt &&
        !chat.initialPromptState
      ) {
        initialState(id, "sending");
        await flushPersistence();
        if (valid())
          void sendSessionPrompt(id, chat.initialPrompt)
            .then(() => {
              if (valid()) initialState(id, "sent");
            })
            .catch(() => {});
      }
    } catch (cause) {
      if (valid()) {
        write({ connection: "error", busy: false, error: String(cause) });
        useAppStore.getState().setChatStatus(id, "exited");
        recordTaskTurn(id, "failed", String(cause));
        settlePermissions(id);
        owner.generation++;
        await disposeAcp(id);
      }
      throw cause;
    }
  })();
  owner.start = work;
  try {
    await work;
  } finally {
    owner.start = undefined;
  }
}
export async function sendSessionPrompt(id: string, text: string) {
  const prompt = text.trim();
  if (!prompt) return;
  if (snapshot(id).busy || snapshot(id).connection !== "ready") return;
  const owner = controllers.get(id);
  if (!owner || owner.prompt) return;
  const turn = { dispatched: false, cancelled: false };
  owner.prompt = turn;
  const generation = owner?.generation;
  const valid = () =>
    controllers.get(id) === owner &&
    owner?.generation === generation &&
    !owner?.closed && owner.prompt === turn;
  patch(id, { busy: true, canceling: false, error: null });
  transcript(id, (items) => appendUserMessage(items, prompt));
  recordTaskTurn(id, "running");
  try {
    await flushPersistence();
    if (!valid()) return;
    if (turn.cancelled) {
      recordTaskTurn(id, "cancelled");
      noteSession(id, "Stopped before the prompt was sent.");
      return;
    }
    turn.dispatched = true;
    const result = await sendAcpPrompt(id, prompt);
    if (!valid()) return;
    const outcome =
      snapshot(id).canceling || result.stopReason === "cancelled"
        ? "cancelled"
        : result.stopReason === "end_turn"
          ? "completed"
          : "failed";
    recordTaskTurn(
      id,
      outcome,
      outcome === "failed" ? `Agent stopped: ${result.stopReason}` : undefined,
    );
    if (outcome === "failed")
      patch(id, { error: `Agent stopped: ${result.stopReason}` });
  } catch (cause) {
    if (valid()) {
      patch(id, { error: String(cause) });
      noteSession(id, `Prompt failed: ${String(cause)}`, true);
      recordTaskTurn(id, "failed", String(cause));
    }
    throw cause;
  } finally {
    if (valid()) {
      settlePermissions(id);
      owner.prompt = undefined;
      patch(id, { busy: false, canceling: false });
    }
  }
}
export function cancelSession(id: string) {
  if (!snapshot(id).busy) return;
  const owner = controllers.get(id);
  const turn = owner?.prompt;
  if (turn) turn.cancelled = true;
  patch(id, { canceling: true });
  settlePermissions(id);
  // A protocol cancel sent before session/prompt cannot cancel that future prompt.
  if (turn && !turn.dispatched) return;
  void Promise.resolve()
    .then(() => {
      if (controllers.get(id) === owner && owner?.prompt === turn && !owner?.closed)
        return cancelAcpPrompt(id);
    })
    .catch((e) => {
      if (controllers.get(id) === owner && owner?.prompt === turn && !owner?.closed)
        patch(id, { canceling: false, error: String(e) });
    });
}
export async function closeSession(id: string) {
  const owner = controllers.get(id);
  if (owner) {
    owner.closed = true;
    owner.generation++;
  }
  settlePermissions(id);
  await disposeAcp(id);
  await owner?.start?.catch(() => {});
  controllers.delete(id);
  useSessions.setState((s) => {
    const sessions = { ...s.sessions };
    delete sessions[id];
    return { sessions };
  });
}
export async function applySessionControl(id: string, op: ApplyOp) {
  try {
    if (op.kind === "mode") {
      await setAcpMode(id, op.modeId);
      const modes = snapshot(id).modes;
      if (modes) patch(id, { modes: { ...modes, currentModeId: op.modeId } });
    } else
      patch(id, {
        configOptions: await setAcpConfigOption(id, op.configId, op.value),
      });
  } catch (cause) {
    noteSession(id, `Control change failed: ${String(cause)}`, true);
  }
}

export function acknowledgeSessionError(id: string) {
  if (!snapshot(id).busy && !snapshot(id).permissionCount)
    patch(id, { error: null });
}
export async function restartSession(id: string) {
  await closeSession(id);
  await startSession(id, Boolean(context(id).chat.agentSessionId));
}
