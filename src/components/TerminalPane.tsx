import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useAppStore, type Branch, type Chat } from "../store/appStore";
import {
  consumeAutoSpawn,
  disposeTerminal,
  fitTerminal,
  focusTerminal,
  spawnTerminal,
} from "../lib/terminalRegistry";

interface Props {
  branch: Branch;
  chat: Chat;
  active: boolean;
}

// Stays mounted for every chat; inactive panes are display:none so the xterm
// buffer (and a running htop) survives tab and branch switches.
export function TerminalPane({ branch, chat, active }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const status = useAppStore((s) => s.chatStatus[chat.id] ?? "idle");
  const setChatStatus = useAppStore((s) => s.setChatStatus);
  const agentCmd = useAppStore((s) => s.agentCmd);

  const start = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    disposeTerminal(chat.id); // clear a dead instance before respawning
    setChatStatus(chat.id, "running");
    void spawnTerminal({
      chatId: chat.id,
      cwd: branch.worktreePath,
      agentCmd,
      container,
      onExit: () => setChatStatus(chat.id, "exited"),
    });
  }, [chat.id, branch.worktreePath, agentCmd, setChatStatus]);

  // Chats created this session start immediately; restored ones wait for Start.
  useEffect(() => {
    if (active && status === "idle" && consumeAutoSpawn(chat.id)) start();
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

  return (
    <div ref={wrapperRef} className={`absolute inset-0 ${active ? "" : "hidden"}`}>
      <div ref={containerRef} className="absolute inset-0" />
      {status === "idle" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background">
          <p className="text-muted-foreground">
            {chat.title} · <span className="font-mono">{branch.name}</span>
          </p>
          <button
            onClick={start}
            className="h-8 rounded-lg bg-primary px-4 font-medium text-primary-foreground transition-all active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Start
          </button>
        </div>
      )}
      {status === "exited" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80">
          <p className="text-muted-foreground">Session ended</p>
          <button
            onClick={start}
            className="h-8 rounded-lg bg-primary px-4 font-medium text-primary-foreground transition-all active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
