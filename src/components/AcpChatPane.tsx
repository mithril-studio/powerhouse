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
import { consumeAutoSpawn, markAutoSpawn } from "../lib/terminalRegistry";
import { handoffWatchStart } from "../lib/ipc";
import { AcpTranscript } from "./acp/AcpTranscript";
import {
  AcpPermissionCard,
  type PendingPermission,
} from "./acp/AcpPermissionCard";
import { AcpComposer } from "./acp/AcpComposer";
import {
  AcpConnectionPanel,
  type AcpConnectionState,
} from "./acp/AcpConnectionPanel";
import { AcpCommandPalette } from "./acp/AcpCommandPalette";
import { AcpFooter } from "./acp/AcpFooter";
import {
  buildAcpPaletteItems,
  type AcpPaletteItem,
} from "../lib/acpCommandPalette";

interface Props {
  repoId: string;
  branch: Branch;
  chat: Chat;
  active: boolean;
}

export function AcpChatPane({ repoId, branch, chat, active }: Props) {
  const settings = useAppStore((state) => state.settings);
  const setChatStatus = useAppStore((state) => state.setChatStatus);
  const setChatAgentSession = useAppStore((state) => state.setChatAgentSession);
  const setChatTransport = useAppStore((state) => state.setChatTransport);
  const updateTranscript = useAppStore((state) => state.updateChatAcpTranscript);
  const profile = resolveAgent(settings, chat.agentId);
  const transcript = chat.acpTranscript ?? [];

  const [connection, setConnection] = useState<AcpConnectionState>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState("");
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [modes, setModes] = useState<SessionModeState | null>(null);
  const [configOptions, setConfigOptions] = useState<SessionConfigOption[]>([]);
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [agentLabel, setAgentLabel] = useState(profile.name);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const closingRef = useRef(false);
  const replayingRef = useRef(false);

  const mutateTranscript = useCallback(
    (update: Parameters<typeof updateTranscript>[3]) =>
      updateTranscript(repoId, branch.id, chat.id, update),
    [repoId, branch.id, chat.id, updateTranscript],
  );

  const submitPrompt = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt) return;
      mutateTranscript((items) => appendUserMessage(items, prompt));
      try {
        await sendAcpPrompt(chat.id, prompt);
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
      setPaletteOpen(false);
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
        if (!result.resumed) mutateTranscript(() => []);
        setModes(result.modes ?? null);
        setConfigOptions(result.configOptions ?? []);
        setAgentLabel(result.agentInfo?.name ?? profile.name);
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

  useEffect(() => {
    if (active && connection === "idle" && consumeAutoSpawn(chat.id)) {
      void start(Boolean(chat.agentSessionId));
    }
  }, [active, chat.id, chat.agentSessionId, connection, start]);

  useEffect(() => {
    if (!active || connection !== "ready") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        event.stopPropagation();
        setPaletteOpen((open) => !open);
      } else if (event.key === "Escape") {
        if (paletteOpen) {
          event.preventDefault();
          setPaletteOpen(false);
        } else if (busy) {
          event.preventDefault();
          void cancelAcpPrompt(chat.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, busy, chat.id, connection, paletteOpen]);

  const switchToTerminal = async () => {
    closingRef.current = true;
    await disposeAcp(chat.id);
    markAutoSpawn(chat.id);
    setChatStatus(chat.id, "idle");
    setChatTransport(repoId, branch.id, chat.id, "pty");
  };

  const resolvePermission = (response: RequestPermissionResponse) => {
    setPermission((pending) => {
      pending?.resolve(response);
      return null;
    });
  };

  const connected = connection === "ready";
  const thinkingValue = configOptions.find(
    (option) => option.category === "thought_level" && option.type === "select",
  )?.currentValue;
  const thinkingLevel =
    typeof thinkingValue === "string" ? thinkingValue : undefined;
  const paletteItems = useMemo(
    () => buildAcpPaletteItems({ commands, modes, configOptions }),
    [commands, modes, configOptions],
  );

  const choosePaletteItem = (item: AcpPaletteItem) => {
    setPaletteOpen(false);
    const { action } = item;
    if (action.type === "insert_prompt") {
      setDraft(action.prompt);
    } else if (action.type === "mode") {
      void setAcpMode(chat.id, action.modeId)
        .then(() =>
          setModes((current) =>
            current ? { ...current, currentModeId: action.modeId } : current,
          ),
        )
        .catch((cause) =>
          mutateTranscript((items) =>
            appendSystemMessage(
              items,
              `Mode change failed: ${String(cause)}`,
              "error",
            ),
          ),
        );
    } else if (action.type === "config") {
      void setAcpConfigOption(chat.id, action.configId, action.value)
        .then(setConfigOptions)
        .catch((cause) =>
          mutateTranscript((items) =>
            appendSystemMessage(
              items,
              `Config change failed: ${String(cause)}`,
              "error",
            ),
          ),
        );
    } else {
      void switchToTerminal();
    }
  };

  return (
    <section
      className={`acp-pi absolute inset-0 flex flex-col bg-background font-mono ${active ? "" : "hidden"}`}
    >
      <AcpTranscript
        items={transcript}
        busy={busy}
        agentName={agentLabel}
        branchName={branch.name}
        commandCount={commands.length}
      />

      {permission && (
        <AcpPermissionCard permission={permission} onResolve={resolvePermission} />
      )}

      {!connected ? (
        <AcpConnectionPanel
          state={connection}
          agentName={profile.name}
          resumable={Boolean(chat.agentSessionId)}
          error={error}
          diagnostics={diagnostics}
          onResume={() => void start(true)}
          onStartFresh={() => void start(false)}
        />
      ) : paletteOpen ? (
        <AcpCommandPalette
          items={paletteItems}
          onChoose={choosePaletteItem}
          onClose={() => setPaletteOpen(false)}
        />
      ) : (
        <AcpComposer
          active={active}
          busy={busy}
          agentName={profile.name}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={(prompt) => {
            setDraft("");
            void submitPrompt(prompt);
          }}
          onOpenCommands={() => setPaletteOpen(true)}
          thinkingLevel={thinkingLevel}
        />
      )}
      {connected && (
        <AcpFooter
          agentName={agentLabel}
          branchName={branch.name}
          busy={busy}
          modes={modes}
          configOptions={configOptions}
          commandCount={commands.length}
        />
      )}
    </section>
  );
}
