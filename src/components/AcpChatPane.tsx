import { useCallback, useEffect, useRef, useState } from "react";
import type {
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
import { AcpSessionControls } from "./acp/AcpSessionControls";
import { AcpComposer } from "./acp/AcpComposer";
import {
  AcpConnectionPanel,
  type AcpConnectionState,
} from "./acp/AcpConnectionPanel";

interface Props {
  repoId: string;
  branch: Branch;
  chat: Chat;
  active: boolean;
}

const buttonClass =
  "h-8 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40";

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
  const [agentLabel, setAgentLabel] = useState(profile.name);
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

  return (
    <section className={`absolute inset-0 flex flex-col ${active ? "" : "hidden"}`}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span
          className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-muted-foreground/50"}`}
          aria-hidden
        />
        <span className="truncate text-xs text-muted-foreground">{agentLabel}</span>
        <span className="font-mono text-[10px] uppercase text-muted-foreground/60">ACP</span>
        <span className="flex-1" />
        <AcpSessionControls
          modes={modes}
          configOptions={configOptions}
          disabled={!connected || busy}
          onModeChange={(modeId) => {
            void setAcpMode(chat.id, modeId)
              .then(() =>
                setModes((current) =>
                  current ? { ...current, currentModeId: modeId } : current,
                ),
              )
              .catch((cause) => setError(String(cause)));
          }}
          onConfigChange={(configId, value) => {
            void setAcpConfigOption(chat.id, configId, value)
              .then(setConfigOptions)
              .catch((cause) => setError(String(cause)));
          }}
        />
        <button onClick={() => void switchToTerminal()} className={buttonClass}>
          Terminal
        </button>
      </header>

      <AcpTranscript items={transcript} busy={busy} />

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
      ) : (
        <AcpComposer
          active={active}
          busy={busy}
          agentName={profile.name}
          onSubmit={(prompt) => void submitPrompt(prompt)}
          onCancel={() => void cancelAcpPrompt(chat.id)}
        />
      )}
    </section>
  );
}
