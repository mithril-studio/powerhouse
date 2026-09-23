import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { consumeAutoSpawn } from "../lib/terminalRegistry";
import { handoffWatchStart, telemetryAnnotateRun } from "../lib/ipc";
import type { AgentControlState, ApplyOp } from "../lib/agentControls";
import type { AcpConnectionState } from "../components/acp/AcpConnectionPanel";
import type { PendingPermission } from "../components/acp/AcpPermissionCard";
import { promptBlocks, toRef, type Attachment } from "../lib/attachments";

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
  const setChatAgentSession = useAppStore((state) => state.setChatAgentSession);
  const updateTranscript = useAppStore((state) => state.updateChatAcpTranscript);
  const profile = resolveAgent(settings, chat.agentId);

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
  const closingRef = useRef(false);
  const replayingRef = useRef(false);

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
      try {
        await sendAcpPrompt(chat.id, promptBlocks(prompt, attachments));
      } catch (cause) {
        mutateTranscript((items) =>
          appendSystemMessage(items, `Prompt failed: ${String(cause)}`, "error"),
        );
      }
    },
    [chat.id, mutateTranscript],
  );

  const start = useCallback(
    async (resume: boolean) => {
      if (!profile.acpCommand) {
        setError(`${profile.name} has no ACP command configured.`);
        setConnection("error");
        return;
      }
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

      try {
        const result = await startAcp({
          chatId: chat.id,
          cwd: branch.worktreePath,
          command: profile.acpCommand,
          resumeSessionId: resume ? chat.agentSessionId : undefined,
          callbacks: {
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
              if (replaying) mutateTranscript(() => []);
            },
            onBusyChange: (working) => setBusy(working),
            onStderr: (chunk) =>
              setDiagnostics((current) => `${current}${chunk}`.slice(-4_000)),
            onExit: (code) => {
              if (closingRef.current) return;
              setPermission((pending) => {
                pending?.resolve({ outcome: { outcome: "cancelled" } });
                return null;
              });
              setBusy(false);
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
        setModes(result.modes ?? null);
        setConfigOptions(result.configOptions ?? []);
        setAgentLabel(result.agentInfo?.name ?? profile.name);
        setSupportsImages(result.capabilities.promptCapabilities?.image === true);
        setConnection("ready");
        setChatStatus(chat.id, "running");
        void handoffWatchStart(branch.id, branch.worktreePath).catch(() => {});

        if (!result.resumed && chat.initialPrompt) {
          await submitPrompt(chat.initialPrompt);
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setConnection("error");
        setChatStatus(chat.id, "exited");
      }
    },
    [
      profile.acpCommand,
      profile.name,
      chat.id,
      chat.agentSessionId,
      chat.initialPrompt,
      branch.id,
      branch.worktreePath,
      repoId,
      mutateTranscript,
      setChatAgentSession,
      setChatStatus,
      submitPrompt,
    ],
  );

  // Chats created this session auto-connect; restored ones wait for Resume/Start.
  useEffect(() => {
    if (active && connection === "idle" && consumeAutoSpawn(chat.id)) {
      void start(Boolean(chat.agentSessionId));
    }
  }, [active, chat.id, chat.agentSessionId, connection, start]);

  const cancel = useCallback(() => {
    void cancelAcpPrompt(chat.id).catch(() => {});
  }, [chat.id]);

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
    start,
    submitPrompt,
    cancel,
    restart,
    applyOp,
    resolvePermission,
    note,
  };
}
