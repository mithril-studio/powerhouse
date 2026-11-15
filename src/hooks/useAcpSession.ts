import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AvailableCommand,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  agentModelEnv,
  memorySettingsOf,
  resolveAgent,
  useAppStore,
  type Branch,
  type Chat,
} from "../store/appStore";
import {
  cancelAcpPrompt,
  disposeAcp,
  sendAcpPrompt,
  setAcpConfigOption,
  setAcpMode,
  startAcp,
} from "../lib/acpRegistry";
import {
  appendSystemMessage,
  appendUserMessage,
  applyAcpUpdate,
} from "../lib/acpTranscript";
import { notifyTurnFinished } from "../lib/attention";
import { workspaceForChat } from "../lib/cloud";
import { activityFromStopReason } from "../lib/chatActivity";
import { consumeAutoSpawn } from "../lib/terminalRegistry";
import { handoffWatchStart, telemetryAnnotateRun } from "../lib/ipc";
import {
  composeBriefedPrompt,
  fetchBrief,
  memoryMcpServers,
  memoryProjectSlug,
  memoryServerEnsure,
  memorySessionMeta,
} from "../lib/memory";
import { distillCheckpoint, writeCheckpoint } from "../lib/checkpoint";
import type { AgentControlState, ApplyOp } from "../lib/agentControls";
import type { AcpConnectionState } from "../components/acp/AcpConnectionPanel";
import type { PendingPermission } from "../components/acp/AcpPermissionCard";
import { promptBlocks, toRef, type Attachment } from "../lib/attachments";
import {
  isCloudBranch,
  MAX_RECONNECTS,
  reconnectDelayMs,
  resumeMeta,
  vmAgentCommand,
  vmChatEnsureRunning,
  VM_REPO_DIR,
} from "../lib/vmChats";
import { publishSession, registerSession, type SessionHandle } from "../lib/agentSessionService";
import { recordTaskTurn } from "../features/tasks/taskStore";
import type { TurnOutcome } from "../features/tasks/types";

interface Params {
  repoId: string;
  branch: Branch;
  chat: Chat;
  active: boolean;
}

/**
 * Owns the ACP connection and its lifecycle for a single chat: starting/
 * resuming, prompting, cancelling, applying semantic control changes, and
 * mirroring the agent's advertised state (modes, config, commands). It knows
 * nothing about the keyboard or the visual layout.
 */
export function useAcpSession({ repoId, branch, chat, active }: Params) {
  const settings = useAppStore((state) => state.settings);
  const setChatStatus = useAppStore((state) => state.setChatStatus);
  const setChatActivity = useAppStore((state) => state.setChatActivity);
  const activity = useAppStore((state) => state.chatActivity[chat.id]);
  const setChatAgentSession = useAppStore((state) => state.setChatAgentSession);
  const updateTranscript = useAppStore((state) => state.updateChatAcpTranscript);
  const setChatCloudRecap = useAppStore((state) => state.setChatCloudRecap);
  /** The cloud workspace that owns this conversation right now, if any. */
  const cloudWorkspace = useAppStore((state) => workspaceForChat(state.cloudWorkspaces, chat.id));
  const profile = resolveAgent(settings, chat.agentId);
  const memory = useMemo(() => memorySettingsOf(settings), [settings.memory]);

  const [connection, setConnection] = useState<AcpConnectionState>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState("");
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [modes, setModes] = useState<SessionModeState | null>(null);
  const [configOptions, setConfigOptions] = useState<SessionConfigOption[]>([]);
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [agentLabel, setAgentLabel] = useState(profile.name);
  const [supportsImages, setSupportsImages] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const closingRef = useRef(false);
  const replayingRef = useRef(false);
  const cloud = isCloudBranch(branch);
  const setChatAgentSeq = useAppStore((state) => state.setChatAgentSeq);
  /** Cloud chats: failed reconnects in a row, and the pending retry. */
  const reconnectsRef = useRef(0);
  const retryTimerRef = useRef<number | undefined>(undefined);
  const startRef = useRef<(resume: boolean) => Promise<void>>(async () => {});
  /** True while a connection is established; a failed start is handled by its catch. */
  const readyRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  /** Task board bookkeeping: only chats on a task's branch record turns. */
  const recordTurn = useCallback(
    (outcome: TurnOutcome, summary?: string) => {
      if (useAppStore.getState().tasks.some((t) => t.branchId === branch.id))
        recordTaskTurn(chat.id, outcome, summary);
    },
    [branch.id, chat.id],
  );

  /** Marks a finished turn unseen, unless the user is looking at this chat. */
  const finishTurn = useCallback(
    (outcome: ReturnType<typeof activityFromStopReason>) => {
      // A turn ends once: a crash mid-turn reaches here via both exit and the prompt.
      if (useAppStore.getState().chatActivity[chat.id] !== "working") return;
      const seen = activeRef.current && document.hasFocus();
      setChatActivity(chat.id, seen ? null : outcome);
      if (outcome && outcome !== "working") {
        void notifyTurnFinished(outcome, `${branch.name} · ${chat.title}`);
      }
    },
    [chat.id, chat.title, branch.name, setChatActivity],
  );

  /** True once this session has been briefed from memory (or must not be). */
  const briefedRef = useRef(false);
  /** `project/permalink` of the notes this session was briefed with, carried
   *  into the checkpoint so outcome labels can credit them later. */
  const briefedNotesRef = useRef<string[]>([]);

  /** Write one distilled note per session to the memory inbox. Overwrites the
   *  same note each turn (keyed by chat), so a session leaves exactly one
   *  checkpoint however many turns it ran. Non-fatal: memory being down never
   *  affects the run. */
  const checkpoint = useCallback(() => {
    if (!memory.enabled) return;
    const state = useAppStore.getState();
    const repo = state.repos.find((r) => r.id === repoId);
    const transcript =
      repo?.branches
        .find((b) => b.id === branch.id)
        ?.chats.find((c) => c.id === chat.id)?.acpTranscript ?? [];
    const note = distillCheckpoint({
      transcript,
      key: chat.id.slice(0, 8),
      branch: branch.name,
      agent: agentLabel,
      at: new Date(),
      briefed: briefedNotesRef.current,
    });
    if (!note) return;
    const project = memoryProjectSlug(repo?.name ?? "");
    void writeCheckpoint(memory, project, note).catch(() => {});
  }, [memory, repoId, branch.id, branch.name, chat.id, agentLabel]);

  const mutateTranscript = useCallback(
    (update: Parameters<typeof updateTranscript>[3]) =>
      updateTranscript(repoId, branch.id, chat.id, update),
    [repoId, branch.id, chat.id, updateTranscript],
  );

  const submitPrompt = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      const prompt = text.trim();
      if (!prompt && attachments.length === 0) return;
      mutateTranscript((items) =>
        appendUserMessage(items, prompt, attachments.map(toRef)),
      );
      let outbound = prompt;
      // Back from the cloud: the local session never saw those turns.
      const recap = useAppStore
        .getState()
        .repos.find((r) => r.id === repoId)
        ?.branches.find((b) => b.id === branch.id)
        ?.chats.find((c) => c.id === chat.id)?.cloudRecap;
      if (recap) {
        outbound = `[While this chat ran on a cloud machine, the agent there worked on this branch and pushed its commits:\n${recap}\nPull or inspect the branch as needed.]\n\n${outbound}`;
        setChatCloudRecap(repoId, branch.id, chat.id, null);
      }
      if (memory.enabled && !cloud && !briefedRef.current) {
        briefedRef.current = true;
        const repoName = useAppStore.getState().repos.find((r) => r.id === repoId)?.name ?? "";
        const project = memoryProjectSlug(repoName);
        try {
          const brief = await fetchBrief(memory, project, prompt);
          if (brief.count > 0) {
            briefedNotesRef.current = brief.briefed;
            outbound = composeBriefedPrompt(brief.text, prompt);
            mutateTranscript((items) =>
              appendSystemMessage(items, `memory: briefed ${brief.count} notes from global, ${project}`),
            );
          }
        } catch (cause) {
          mutateTranscript((items) =>
            appendSystemMessage(items, `memory: brief unavailable (${String(cause)})`),
          );
        }
      }
      recordTurn("running");
      try {
        const response = await sendAcpPrompt(chat.id, promptBlocks(outbound, attachments));
        finishTurn(activityFromStopReason(response.stopReason));
        recordTurn(
          response.stopReason === "cancelled" ? "cancelled" : response.stopReason === "end_turn" ? "completed" : "failed",
          response.stopReason === "end_turn" || response.stopReason === "cancelled" ? undefined : `Agent stopped: ${response.stopReason}`,
        );
        checkpoint();
      } catch (cause) {
        // A cloud agent keeps working when the connection drops; the reconnect
        // reports how the turn went (ph-agentd's `_ph/turn`).
        if (cloud && /connection closed/i.test(String(cause))) return;
        finishTurn("error");
        recordTurn("failed", String(cause));
        mutateTranscript((items) =>
          appendSystemMessage(items, `Prompt failed: ${String(cause)}`, "error"),
        );
      }
    },
    [chat.id, branch.id, cloud, mutateTranscript, finishTurn, recordTurn, checkpoint, memory, repoId, setChatCloudRecap],
  );

  const start = useCallback(
    async (resume: boolean) => {
      if (!profile.acpCommand) {
        setError(`${profile.name} has no ACP command configured.`);
        setConnection("error");
        return;
      }
      window.clearTimeout(retryTimerRef.current);
      if (cloud && profile.id !== "claude") {
        setError("Cloud chats run Claude for now. Start a local branch to use another agent.");
        setConnection("error");
        return;
      }
      if (cloud && !branch.vm) {
        setError("This chat's VM is not ready yet.");
        setConnection("error");
        return;
      }
      readyRef.current = false;
      closingRef.current = true;
      await disposeAcp(chat.id);
      closingRef.current = false;
      setPermission((pending) => {
        pending?.resolve({ outcome: { outcome: "cancelled" } });
        return null;
      });
      setConnection("starting");
      setBusy(false);
      setError(null);
      setDiagnostics("");
      setCommands([]);
      if (!resume) mutateTranscript(() => []);
      // A fresh session is briefed on its first prompt; a resumed one already
      // carries its context. Memory unavailable is not fatal: the agent still
      // runs, just without the brief and with a dead MCP entry it can ignore.
      briefedRef.current = resume;
      if (memory.enabled && !cloud) {
        await memoryServerEnsure(memory).catch((cause) =>
          mutateTranscript((items) =>
            appendSystemMessage(items, `memory: server unavailable (${String(cause)})`),
          ),
        );
      }

      try {
        // Only fresh chats: the env var outranks a resumed session's model.
        const modelEnv = resume ? undefined : agentModelEnv(profile);
        let command = profile.acpCommand;
        if (cloud && branch.vm) {
          await vmChatEnsureRunning(branch.vm);
          command = await vmAgentCommand(branch.vm, chat.id, modelEnv);
        }
        const result = await startAcp({
          chatId: chat.id,
          cwd: branch.worktreePath,
          sessionCwd: cloud ? VM_REPO_DIR : undefined,
          command,
          env: cloud ? undefined : modelEnv,
          resumeSessionId: resume ? chat.agentSessionId : undefined,
          // The memory server is on this Mac; a VM cannot reach it.
          mcpServers: cloud ? [] : memoryMcpServers(memory),
          meta: cloud ? resumeMeta(chat.agentSeq) : memorySessionMeta(memory),
          callbacks: {
            onSeq: cloud ? (seq) => setChatAgentSeq(repoId, branch.id, chat.id, seq) : undefined,
            onRemoteTurn: (turn) => {
              if (turn.running) {
                setChatActivity(chat.id, "working");
                return;
              }
              finishTurn(activityFromStopReason((turn.stopReason ?? "end_turn") as StopReason));
              recordTurn(turn.stopReason === "cancelled" ? "cancelled" : turn.stopReason === "end_turn" ? "completed" : "failed");
            },
            onUpdate: (update) =>
              mutateTranscript((items) =>
                applyAcpUpdate(items, update, {
                  acceptUserMessageChunks: replayingRef.current,
                }),
              ),
            onPermission: (request: RequestPermissionRequest) =>
              new Promise<RequestPermissionResponse>((resolve) => {
                setPermission((pending) => {
                  pending?.resolve({ outcome: { outcome: "cancelled" } });
                  return { request, resolve };
                });
              }),
            onModeChange: (modeId) =>
              setModes((current) =>
                current ? { ...current, currentModeId: modeId } : current,
              ),
            onConfigOptionsChange: setConfigOptions,
            onAvailableCommandsChange: setCommands,
            onSessionReplayChange: (replaying) => {
              replayingRef.current = replaying;
            },
            onDetached: () => {
              closingRef.current = true;
              setPermission((pending) => {
                pending?.resolve({ outcome: { outcome: "cancelled" } });
                return null;
              });
              setBusy(false);
              setConnection("idle");
              setChatStatus(chat.id, "exited");
            },
            onBusyChange: (working) => {
              setBusy(working);
              if (working) setChatActivity(chat.id, "working");
            },
            onStderr: (chunk) =>
              setDiagnostics((current) => `${current}${chunk}`.slice(-4_000)),
            onExit: (code) => {
              if (closingRef.current) return;
              if (cloud) {
                if (!readyRef.current) return; // start()'s catch retries
                readyRef.current = false;
                // The VM keeps the agent; only the link dropped. Reconnect.
                setPermission((pending) => {
                  pending?.resolve({ outcome: { outcome: "cancelled" } });
                  return null;
                });
                setConnection("starting");
                scheduleReconnect();
                return;
              }
              setPermission((pending) => {
                pending?.resolve({ outcome: { outcome: "cancelled" } });
                return null;
              });
              setBusy(false);
              finishTurn("error");
              if (code !== 0) recordTurn("interrupted", "Agent process exited");
              setConnection("exited");
              setChatStatus(chat.id, "exited");
              if (code !== 0) {
                mutateTranscript((items) =>
                  appendSystemMessage(
                    items,
                    `Agent process exited${code == null ? "" : ` with code ${code}`}.`,
                    "error",
                  ),
                );
              }
            },
          },
        });

        setChatAgentSession(repoId, branch.id, chat.id, result.sessionId);
        // Cosmetic run labels; losing this call loses labels, never evidence.
        const modelOption = (result.configOptions ?? []).find(
          (option) => option.category === "model",
        );
        void telemetryAnnotateRun(chat.id, {
          agentName: result.agentInfo?.name,
          agentVersion: result.agentInfo?.version,
          repoId,
          repoLabel: useAppStore.getState().repos.find((r) => r.id === repoId)?.name,
          branchLabel: branch.name,
          model:
            typeof modelOption?.currentValue === "string"
              ? modelOption.currentValue
              : undefined,
        }).catch(() => {});
        if (!result.resumed) mutateTranscript(() => []);
        let modes = result.modes ?? null;
        // The VM is the sandbox: a cloud agent must not stall on a permission
        // prompt while nobody is watching.
        if (cloud && !result.resumed && modes?.availableModes.some((m) => m.id === "bypassPermissions")) {
          await setAcpMode(chat.id, "bypassPermissions");
          modes = { ...modes, currentModeId: "bypassPermissions" };
        }
        reconnectsRef.current = 0;
        setModes(modes);
        setConfigOptions(result.configOptions ?? []);
        setAgentLabel(result.agentInfo?.name ?? profile.name);
        setSupportsImages(result.capabilities.promptCapabilities?.image === true);
        readyRef.current = true;
        setConnection("ready");
        setChatStatus(chat.id, "running");
        if (!cloud) void handoffWatchStart(branch.id, branch.worktreePath).catch(() => {});

        if (!result.resumed && chat.initialPrompt) {
          await submitPrompt(chat.initialPrompt);
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (cloud && resume && reconnectsRef.current > 0 && reconnectsRef.current < MAX_RECONNECTS) {
          scheduleReconnect();
          return;
        }
        setError(message);
        recordTurn("failed", message);
        setConnection("error");
        setChatStatus(chat.id, "exited");
      }
    },
    [
      profile,
      chat.id,
      chat.agentSessionId,
      chat.initialPrompt,
      branch.id,
      branch.worktreePath,
      branch.vm,
      cloud,
      chat.agentSeq,
      setChatAgentSeq,
      repoId,
      memory,
      mutateTranscript,
      setChatAgentSession,
      setChatStatus,
      setChatActivity,
      finishTurn,
      recordTurn,
      submitPrompt,
    ],
  );

  // A finished turn counts as seen once its chat is on screen and focused.
  useEffect(() => {
    if (!active || !activity || activity === "working") return;
    const clear = () => setChatActivity(chat.id, null);
    if (document.hasFocus()) {
      clear();
      return;
    }
    window.addEventListener("focus", clear, { once: true });
    return () => window.removeEventListener("focus", clear);
  }, [active, activity, chat.id, setChatActivity]);

  startRef.current = start;

  /** Cloud chats: try again with backoff; give up after MAX_RECONNECTS. */
  function scheduleReconnect() {
    const attempt = reconnectsRef.current++;
    if (attempt === 0) {
      mutateTranscript((items) =>
        appendSystemMessage(items, "Lost the connection to the VM; the agent keeps working there. Reconnecting…"),
      );
    }
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(
      () => void startRef.current(true),
      reconnectDelayMs(attempt),
    );
  }

  useEffect(() => () => window.clearTimeout(retryTimerRef.current), []);

  // Cloud chats attach as soon as they are mounted: their agent may be
  // mid-turn on the VM, and finishing should notify even when not on screen.
  useEffect(() => {
    if (cloud && branch.vm && chat.agentSessionId && connection === "idle") {
      void start(true);
    }
  }, [cloud, branch.vm, chat.agentSessionId, connection, start]);

  // Chats created this session auto-connect; restored ones wait for Resume/Start.
  useEffect(() => {
    if (active && connection === "idle" && consumeAutoSpawn(chat.id)) {
      void start(Boolean(chat.agentSessionId));
    }
  }, [active, chat.id, chat.agentSessionId, connection, start]);

  const cancel = useCallback(() => {
    setCanceling(true);
    void cancelAcpPrompt(chat.id).catch(() => setCanceling(false));
  }, [chat.id]);
  useEffect(() => {
    if (!busy) setCanceling(false);
  }, [busy]);

  /** Reconnect the agent, resuming the existing session when one exists. */
  const restart = useCallback(() => {
    void start(Boolean(chat.agentSessionId));
  }, [start, chat.agentSessionId]);

  /** Applies a resolved semantic control change (mode or config) via ACP. */
  const applyOp = useCallback(
    (op: ApplyOp) => {
      if (op.kind === "mode") {
        void setAcpMode(chat.id, op.modeId)
          .then(() =>
            setModes((current) =>
              current ? { ...current, currentModeId: op.modeId } : current,
            ),
          )
          .catch((cause) =>
            mutateTranscript((items) =>
              appendSystemMessage(items, `Mode change failed: ${String(cause)}`, "error"),
            ),
          );
        return;
      }
      void setAcpConfigOption(chat.id, op.configId, op.value)
        .then(setConfigOptions)
        .catch((cause) =>
          mutateTranscript((items) =>
            appendSystemMessage(items, `Config change failed: ${String(cause)}`, "error"),
          ),
        );
    },
    [chat.id, mutateTranscript],
  );

  const resolvePermission = useCallback((response: RequestPermissionResponse) => {
    setPermission((pending) => {
      pending?.resolve(response);
      return null;
    });
  }, []);

  const note = useCallback(
    (text: string) => mutateTranscript((items) => appendSystemMessage(items, text)),
    [mutateTranscript],
  );

  // Mirror this session for the task board and Mission Control.
  useEffect(() => {
    publishSession(chat.id, {
      connection,
      busy,
      canceling,
      error,
      permissionCount: permission ? 1 : 0,
      permissions: permission
        ? [{ id: `${chat.id}:permission`, request: permission.request, resolve: resolvePermission }]
        : [],
    });
  }, [chat.id, connection, busy, canceling, error, permission, resolvePermission]);

  const handleRef = useRef<SessionHandle | null>(null);
  handleRef.current = {
    start,
    submit: (text) => submitPrompt(text),
    cancel,
    acknowledgeError: () => setError(null),
    resolvePermission,
  };
  useEffect(
    () =>
      registerSession(chat.id, {
        start: (resume) => handleRef.current!.start(resume),
        submit: (text) => handleRef.current!.submit(text),
        cancel: () => handleRef.current!.cancel(),
        acknowledgeError: () => handleRef.current!.acknowledgeError(),
        resolvePermission: (response) => handleRef.current!.resolvePermission(response),
      }),
    [chat.id],
  );

  const controlState: AgentControlState = useMemo(
    () => ({ modes, configOptions, commands }),
    [modes, configOptions, commands],
  );

  const thinkingValue = configOptions.find(
    (option) => option.category === "thought_level" && option.type === "select",
  )?.currentValue;
  const thinkingLevel =
    typeof thinkingValue === "string" ? thinkingValue : undefined;

  return {
    profile,
    connection,
    busy,
    error,
    diagnostics,
    permission,
    modes,
    configOptions,
    commands,
    agentLabel,
    /** Whether the connected agent advertised `promptCapabilities.image`. */
    supportsImages,
    controlState,
    thinkingLevel,
    cloudWorkspace,
    start,
    submitPrompt,
    cancel,
    restart,
    applyOp,
    resolvePermission,
    note,
  };
}
