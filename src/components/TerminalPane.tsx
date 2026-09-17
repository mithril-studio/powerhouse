import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  isSessionCapable,
  renderResume,
  renderStart,
  renderTemplate,
  resolveAgent,
  useAppStore,
  type Branch,
  type Chat,
} from "../store/appStore";
import {
  consumeAutoSpawn,
  disposeTerminal,
  fitTerminal,
  focusTerminal,
  replayTranscript,
  spawnTerminal,
} from "../lib/terminalRegistry";
import { handoffWatchStart } from "../lib/ipc";

interface Props {
  repoId: string;
  branch: Branch;
  chat: Chat;
  active: boolean;
}

const primaryBtn =
  "h-8 rounded-lg bg-primary px-4 font-medium text-primary-foreground transition-all active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50";
const secondaryBtn =
  "h-8 rounded-lg border border-border px-4 font-medium text-muted-foreground transition-all hover:text-foreground active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50";

// Stays mounted for every chat; inactive panes are display:none so the xterm
// buffer (and a running htop) survives tab and branch switches.
export function TerminalPane({ repoId, branch, chat, active }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const status = useAppStore((s) => s.chatStatus[chat.id] ?? "idle");
  const setChatStatus = useAppStore((s) => s.setChatStatus);
  const setChatAgentSession = useAppStore((s) => s.setChatAgentSession);
  const settings = useAppStore((s) => s.settings);
  const [hasTranscript, setHasTranscript] = useState(false);
  const replayedRef = useRef(false);

  const start = useCallback(
    (resume: boolean) => {
      const container = containerRef.current;
      if (!container) return;
      const profile = resolveAgent(settings, chat.agentId);
      const capable = isSessionCapable(profile);

      let agentCmd: string;
      let resetTranscript: boolean;

      if (resume && capable && chat.agentSessionId) {
        // Resume the pinned session; the agent redraws its own prior context,
        // so we truncate the replayed history rather than stack on top of it.
        agentCmd = renderResume(profile, chat.agentSessionId) ?? profile.command;
        resetTranscript = true;
      } else if (capable) {
        // Fresh start: pin a deterministic session id. Reuse chat.id the first
        // time; mint a new id when restarting an already-started chat (avoids a
        // `--session-id` collision with the prior session).
        const sessionId = chat.agentSessionId ? crypto.randomUUID() : chat.id;
        agentCmd = chat.initialPrompt
          ? renderStart(profile, sessionId, chat.initialPrompt)
          : renderStart(profile, sessionId);
        setChatAgentSession(repoId, branch.id, chat.id, sessionId);
        resetTranscript = hasTranscript;
      } else {
        // Non-session agent: no resume, plain launch.
        agentCmd = chat.initialPrompt
          ? renderTemplate(profile, chat.initialPrompt)
          : profile.command;
        resetTranscript = hasTranscript;
      }

      disposeTerminal(chat.id); // drop the replay view / any dead instance
      setChatStatus(chat.id, "running");
      // Idempotent on the backend; every running chat keeps the branch watched.
      void handoffWatchStart(branch.id, branch.worktreePath).catch(() => {});
      void spawnTerminal({
        chatId: chat.id,
        cwd: branch.worktreePath,
        agentCmd,
        container,
        resetTranscript,
        onExit: () => setChatStatus(chat.id, "exited"),
      });
    },
    [
      repoId,
      chat.id,
      chat.agentId,
      chat.initialPrompt,
      chat.agentSessionId,
      branch.id,
      branch.worktreePath,
      settings,
      hasTranscript,
      setChatStatus,
      setChatAgentSession,
    ],
  );

  // Chats created this session start immediately; restored ones replay their
  // recorded history (read-only) and wait for Start/Resume.
  useEffect(() => {
    if (!active || status !== "idle") return;
    if (consumeAutoSpawn(chat.id)) {
      start(false);
      return;
    }
    if (replayedRef.current) return;
    replayedRef.current = true;
    const container = containerRef.current;
    if (container) void replayTranscript(chat.id, container).then(setHasTranscript);
  }, [active, status, chat.id, start]);

  // Never fit() a hidden terminal — fit on un-hide, after layout.
  useLayoutEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      fitTerminal(chat.id);
      focusTerminal(chat.id);
    });
    return () => cancelAnimationFrame(raf);
  }, [active, chat.id, status]);

  // Refit (debounced) while this pane is the visible one.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!active || !wrapper) return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fitTerminal(chat.id), 50);
    });
    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [active, chat.id]);

  const profile = resolveAgent(settings, chat.agentId);
  const canResume = isSessionCapable(profile) && !!chat.agentSessionId;
  const showOverlay = status === "idle" || status === "exited";
  // Keep history visible behind the overlay when there's something to show.
  const translucent = status === "exited" || hasTranscript;

  return (
    <div ref={wrapperRef} className={`absolute inset-0 ${active ? "" : "hidden"}`}>
      <div ref={containerRef} className="absolute inset-0" />
      {showOverlay && (
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center gap-3 ${
            translucent ? "bg-background/80" : "bg-background"
          }`}
        >
          <p className="text-muted-foreground">
            {status === "exited" ? (
              "Session ended"
            ) : (
              <>
                {chat.title} · <span className="font-mono">{branch.name}</span>
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            {canResume ? (
              <>
                <button onClick={() => start(true)} className={primaryBtn}>
                  Resume
                </button>
                <button onClick={() => start(false)} className={secondaryBtn}>
                  Start fresh
                </button>
              </>
            ) : (
              <button onClick={() => start(false)} className={primaryBtn}>
                {status === "exited" ? "Restart" : "Start"}
              </button>
            )}
          </div>
          {hasTranscript && !canResume && (
            <p className="text-xs text-muted-foreground">
              Resume unavailable for this agent — history is read-only.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
