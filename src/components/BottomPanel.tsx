import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { homeDir } from "@tauri-apps/api/path";
import {
  resolveAgent,
  resolveHandoff,
  selectedBranch,
  useAppStore,
} from "../store/appStore";
import { connectCommand } from "../lib/machines";
import {
  disposeTerminal,
  fitTerminal,
  focusTerminal,
  spawnTerminal,
} from "../lib/terminalRegistry";

export const shellId = (branchId: string) => `shell-${branchId}`;
export const agentCliId = (branchId: string) => `agentcli-${branchId}`;
export const machineTerminalId = (vm: string) => `vm-${vm}`;

interface TerminalProps {
  sessionId: string;
  statusKey: string;
  /** Working directory; undefined = the home folder. */
  cwd?: string;
  active: boolean;
  /** Command to launch; undefined = plain login shell. */
  agentCmd?: string;
}

// A persistent terminal for one bottom-panel surface (branch shell, native agent
// CLI, or a VM). Kept mounted (hidden) so a running process survives
// tab/panel/branch switches.
function PanelTerminal({ sessionId, statusKey, cwd, active, agentCmd }: TerminalProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const status = useAppStore((s) => s.shellStatus[statusKey] ?? "idle");
  const setShellStatus = useAppStore((s) => s.setShellStatus);

  const start = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    disposeTerminal(sessionId); // clear a dead instance before respawning
    setShellStatus(statusKey, "running");
    void spawnTerminal({
      chatId: sessionId,
      cwd: cwd ?? (await homeDir().catch(() => "/")),
      agentCmd,
      container,
      onExit: () => setShellStatus(statusKey, "exited"),
    });
  }, [sessionId, statusKey, cwd, agentCmd, setShellStatus]);

  // Lazy spawn when first shown; a surface that exited respawns transparently.
  useEffect(() => {
    if (active && status !== "running") void start();
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
  const machineTerminals = useAppStore((s) => s.machineTerminals);
  const closeMachineTerminal = useAppStore((s) => s.closeMachineTerminal);
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
        {machineTerminals.map((vm) => (
          <span key={vm} className="flex items-center">
            <button
              className={`${tabClass(tab === `vm:${vm}`)} normal-case`}
              onClick={() => setBottomTab(`vm:${vm}`)}
              title={connectCommand(vm)}
            >
              ☁ {vm}
            </button>
            <button
              onClick={() => {
                disposeTerminal(machineTerminalId(vm));
                closeMachineTerminal(vm);
              }}
              aria-label={`Close ${vm}`}
              title="Close and disconnect"
              className="h-6 px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
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
            sessionId={shellId(b.id)}
            statusKey={`shell:${b.id}`}
            cwd={b.worktreePath}
            active={open && tab === "shell" && b.id === branch?.id}
          />
        ))}
        {branches.map((b) => (
          <PanelTerminal
            key={`agent-${b.id}`}
            sessionId={agentCliId(b.id)}
            statusKey={`agent:${b.id}`}
            cwd={b.worktreePath}
            active={
              open &&
              tab === "agent" &&
              b.id === branch?.id &&
              handoff !== "unsupported"
            }
            agentCmd={b.id === branch?.id ? agentCmd : undefined}
          />
        ))}
        {machineTerminals.map((vm) => (
          <PanelTerminal
            key={`vm-${vm}`}
            sessionId={machineTerminalId(vm)}
            statusKey={`vm:${vm}`}
            active={open && tab === `vm:${vm}`}
            agentCmd={connectCommand(vm)}
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
