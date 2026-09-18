import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  resolveAgent,
  resolveHandoff,
  selectedBranch,
  useAppStore,
  type Branch,
  type BottomTab,
} from "../store/appStore";
import {
  disposeTerminal,
  fitTerminal,
  focusTerminal,
  spawnTerminal,
} from "../lib/terminalRegistry";

export const shellId = (branchId: string) => `shell-${branchId}`;
export const agentCliId = (branchId: string) => `agentcli-${branchId}`;

interface TerminalProps {
  branch: Branch;
  kind: BottomTab;
  active: boolean;
  /** Command to launch; undefined = plain login shell. */
  agentCmd?: string;
}

// A persistent terminal for one branch surface (shell or native agent CLI). Kept
// mounted (hidden) so a running process survives tab/panel/branch switches.
function PanelTerminal({ branch, kind, active, agentCmd }: TerminalProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const statusKey = `${kind}:${branch.id}`;
  const status = useAppStore((s) => s.shellStatus[statusKey] ?? "idle");
  const setShellStatus = useAppStore((s) => s.setShellStatus);
  const sessionId = kind === "shell" ? shellId(branch.id) : agentCliId(branch.id);

  const start = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    disposeTerminal(sessionId); // clear a dead instance before respawning
    setShellStatus(statusKey, "running");
    void spawnTerminal({
      chatId: sessionId,
      cwd: branch.worktreePath,
      agentCmd,
      container,
      onExit: () => setShellStatus(statusKey, "exited"),
    });
  }, [sessionId, statusKey, branch.worktreePath, agentCmd, setShellStatus]);

  // Lazy spawn when first shown; a surface that exited respawns transparently.
  useEffect(() => {
    if (active && status !== "running") start();
  }, [active, status, start]);

  // Never fit() a hidden terminal — fit + focus on un-hide, after layout.
  useLayoutEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      fitTerminal(sessionId);
      focusTerminal(sessionId);
    });
    return () => cancelAnimationFrame(raf);
  }, [active, sessionId, status]);

  // Refit (debounced) while visible.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!active || !wrapper) return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fitTerminal(sessionId), 50);
    });
    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [active, sessionId]);

  return (
    <div ref={wrapperRef} className={`absolute inset-0 ${active ? "" : "hidden"}`}>
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}

function tabClass(active: boolean): string {
  return `h-6 px-3 text-[11px] font-mono uppercase tracking-wider ${
    active
      ? "border-b border-accent-brand text-foreground"
      : "text-muted-foreground hover:text-foreground"
  }`;
}

// Global open/close; content is per-branch. Always mounted so surfaces persist;
// only its height collapses when closed.
export function BottomPanel() {
  const open = useAppStore((s) => s.bottomPanelOpen);
  const tab = useAppStore((s) => s.bottomTab);
  const setBottomTab = useAppStore((s) => s.setBottomTab);
  const repos = useAppStore((s) => s.repos);
  const settings = useAppStore((s) => s.settings);
  const branch = useAppStore(selectedBranch);

  const branches = repos.flatMap((r) => r.branches);

  // Native CLI for the selected branch's active chat, launched in its worktree.
  const activeChat = branch?.chats.find((c) => c.id === branch.activeChatId);
  const agentProfile = activeChat && resolveAgent(settings, activeChat.agentId);
  const handoff = agentProfile ? resolveHandoff(agentProfile) : "unsupported";
  const agentCmd = handoff !== "unsupported" ? agentProfile?.command : undefined;

  return (
    <div className={open ? "flex h-64 shrink-0 flex-col border-t border-border" : "hidden"}>
      <div className="flex h-6 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
        <button className={tabClass(tab === "shell")} onClick={() => setBottomTab("shell")}>
          Shell
        </button>
        <button className={tabClass(tab === "agent")} onClick={() => setBottomTab("agent")}>
          Agent CLI
        </button>
        {tab === "agent" && agentProfile && handoff !== "unsupported" && (
          <span className="ml-2 truncate text-[10px] text-muted-foreground">
            {agentProfile.name}
            {handoff === "workspace-only"
              ? " · separate conversation, shared worktree"
              : " · same session"}
          </span>
        )}
      </div>
      <div className="relative flex-1">
        {branches.map((b) => (
          <PanelTerminal
            key={`shell-${b.id}`}
            branch={b}
            kind="shell"
            active={open && tab === "shell" && b.id === branch?.id}
          />
        ))}
        {branches.map((b) => (
          <PanelTerminal
            key={`agent-${b.id}`}
            branch={b}
            kind="agent"
            active={
              open &&
              tab === "agent" &&
              b.id === branch?.id &&
              handoff !== "unsupported"
            }
            agentCmd={b.id === branch?.id ? agentCmd : undefined}
          />
        ))}
        {tab === "agent" && (!agentProfile || handoff === "unsupported") && (
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <p className="text-xs text-muted-foreground">
              {activeChat
                ? `${agentProfile?.name ?? "This agent"} does not offer a native CLI.`
                : "Open a chat to launch its agent CLI."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
