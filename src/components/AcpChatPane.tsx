import { useMemo, useState } from "react";
import {
  resolveHandoff,
  useAppStore,
  type Branch,
  type Chat,
} from "../store/appStore";
import { cycleMode } from "../lib/agentControls";
import { buildPalette } from "../lib/acpCommandPalette";
import { latestUsage } from "../lib/acpTranscript";
import { useAcpSession } from "../hooks/useAcpSession";
import { useAgentShortcuts } from "../hooks/useAgentShortcuts";
import { AcpTranscript } from "./acp/AcpTranscript";
import { AcpPermissionCard } from "./acp/AcpPermissionCard";
import { AcpComposer } from "./acp/AcpComposer";
import { AcpConnectionPanel } from "./acp/AcpConnectionPanel";
import { AcpCommandPalette } from "./acp/AcpCommandPalette";
import { AcpFooter } from "./acp/AcpFooter";

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
  const nativeCliOpen = useAppStore(
    (state) => state.bottomPanelOpen && state.bottomTab === "agent",
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const { profile } = session;
  const connected = session.connection === "ready";
  const paletteView = useMemo(
    () => buildPalette(session.controlState),
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
      className={`acp-pi absolute inset-0 flex flex-col bg-background font-mono ${active ? "" : "hidden"}`}
    >
      <AcpTranscript
        items={chat.acpTranscript ?? []}
        busy={session.busy}
        agentName={session.agentLabel}
        branchName={branch.name}
        commandCount={session.commands.length}
      />

      {session.permission && (
        <AcpPermissionCard
          permission={session.permission}
          onResolve={session.resolvePermission}
        />
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
            setDraft("");
            void session.submitPrompt(prompt);
          }}
          onOpenCommands={() => setPaletteOpen(true)}
          thinkingLevel={session.thinkingLevel}
        />
      )}
      {connected && (
        <AcpFooter
          agentName={session.agentLabel}
          branchName={branch.name}
          busy={session.busy}
          modes={session.modes}
          configOptions={session.configOptions}
          commandCount={session.commands.length}
          nativeCliOpen={nativeCliOpen}
          usage={usage}
        />
      )}
    </section>
  );
}
