import { useMemo, useState } from "react";
import {
  resolveHandoff,
  useAppStore,
  type Branch,
  type Chat,
} from "../store/appStore";
import { cycleMode, resolveModels, resolveReasoning } from "../lib/agentControls";
import { buildPalette } from "../lib/acpCommandPalette";
import { latestUsage } from "../lib/acpTranscript";
import { useAcpSession } from "../hooks/useAcpSession";
import { useAgentShortcuts } from "../hooks/useAgentShortcuts";
import { usePromptAttachments } from "../hooks/usePromptAttachments";
import { AcpTranscript } from "./acp/AcpTranscript";
import { AcpPermissionCard } from "./acp/AcpPermissionCard";
import { AcpComposer } from "./acp/AcpComposer";
import { AcpConnectionPanel } from "./acp/AcpConnectionPanel";
import { AcpCommandPalette } from "./acp/AcpCommandPalette";
import { ChatContextBar } from "./acp/ChatContextBar";

interface Props {
  repoId: string;
  branch: Branch;
  chat: Chat;
  active: boolean;
}

/** Composition only: the session, shortcuts, and controls live in their own
 *  modules so agent differences never leak into this visual layer. */
export function AcpChatPane({ repoId, branch, chat, active }: Props) {
  const session = useAcpSession({ repoId, branch, chat, active });
  const openBottomPanel = useAppStore((state) => state.openBottomPanel);
  const projectName = useAppStore(
    (state) => state.repos.find((repo) => repo.id === repoId)?.name,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const { profile } = session;
  const connected = session.connection === "ready";
  const attachments = usePromptAttachments({
    active: active && connected,
    supportsImages: session.supportsImages,
    agentName: session.agentLabel,
    note: session.note,
  });
  const paletteView = useMemo(
    () => buildPalette(session.controlState),
    [session.controlState],
  );
  const models = useMemo(() => resolveModels(session.controlState), [session.controlState]);
  const reasoning = useMemo(
    () => resolveReasoning(session.controlState),
    [session.controlState],
  );
  const usage = useMemo(
    () => latestUsage(chat.acpTranscript ?? []),
    [chat.acpTranscript],
  );

  const onCycleMode = () => {
    const next = cycleMode(session.controlState);
    if (next.supported) {
      session.applyOp(next.apply);
      session.note(`Mode → ${next.label}`);
    } else {
      session.note(next.reason);
    }
  };

  const openNativeCli = () => {
    const mode = resolveHandoff(profile);
    if (mode === "unsupported") {
      session.note(`${profile.name} does not offer a native CLI handoff.`);
      return;
    }
    openBottomPanel("agent");
    session.note(
      mode === "resumable"
        ? `Opened ${profile.name}'s native CLI in the bottom panel (same session).`
        : `Opened ${profile.name}'s native CLI in the bottom panel — a separate conversation sharing this worktree.`,
    );
  };

  useAgentShortcuts({
    active,
    ready: connected,
    busy: session.busy,
    paletteOpen,
    onTogglePalette: () => setPaletteOpen((open) => !open),
    onCancel: session.cancel,
    onCycleMode,
  });

  return (
    <section
      className={`agent-chat absolute inset-0 flex flex-col bg-background ${active ? "" : "hidden"}`}
    >
      <AcpTranscript
        items={chat.acpTranscript ?? []}
        busy={session.busy}
        agentName={session.agentLabel}
        commandCount={session.commands.length}
      />

      {session.permission && (
        <div className="shrink-0 px-6 pb-2">
          <div className="chat-column">
            <AcpPermissionCard
              permission={session.permission}
              onResolve={session.resolvePermission}
            />
          </div>
        </div>
      )}

      {!connected ? (
        <AcpConnectionPanel
          state={session.connection}
          agentName={profile.name}
          resumable={Boolean(chat.agentSessionId)}
          error={session.error}
          diagnostics={session.diagnostics}
          onResume={() => void session.start(true)}
          onStartFresh={() => void session.start(false)}
        />
      ) : paletteOpen ? (
        <AcpCommandPalette
          view={paletteView}
          onApply={session.applyOp}
          onInsert={(prompt) => setDraft(prompt)}
          onNativeCli={openNativeCli}
          onRestart={session.restart}
          onClose={() => setPaletteOpen(false)}
        />
      ) : (
        <AcpComposer
          active={active}
          busy={session.busy}
          agentName={profile.name}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={(prompt) => {
            const files = attachments.attachments;
            setDraft("");
            attachments.clear();
            void session.submitPrompt(prompt, files);
          }}
          onOpenCommands={() => setPaletteOpen(true)}
          onCancel={session.cancel}
          models={models}
          reasoning={reasoning}
          onApply={session.applyOp}
          attachments={attachments.attachments}
          supportsImages={session.supportsImages}
          dragging={attachments.dragging}
          onPasteFiles={(files) => void attachments.addFiles(files)}
          onPickFiles={() => void attachments.pick()}
          onRemoveAttachment={attachments.remove}
        />
      )}
      <ChatContextBar
        projectName={projectName}
        branchName={branch.name}
        vm={branch.vm}
        usage={usage}
      />
    </section>
  );
}
