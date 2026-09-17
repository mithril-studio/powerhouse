import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { selectedBranch, useAppStore, type Branch } from "../store/appStore";
import {
  disposeTerminal,
  fitTerminal,
  focusTerminal,
  spawnTerminal,
} from "../lib/terminalRegistry";

const shellId = (branchId: string) => `shell-${branchId}`;

// One plain login shell per branch, rooted at its worktree. Kept mounted (hidden)
// so a running `top` survives panel close/open and branch switches.
function ShellPane({ branch, active }: { branch: Branch; active: boolean }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const status = useAppStore((s) => s.shellStatus[branch.id] ?? "idle");
  const setShellStatus = useAppStore((s) => s.setShellStatus);
  const sessionId = shellId(branch.id);

  const start = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    disposeTerminal(sessionId); // clear a dead instance before respawning
    setShellStatus(branch.id, "running");
    void spawnTerminal({
      chatId: sessionId,
      cwd: branch.worktreePath,
      container,
      onExit: () => setShellStatus(branch.id, "exited"),
    });
  }, [sessionId, branch.id, branch.worktreePath, setShellStatus]);

  // Lazy spawn when first shown; a shell that exited respawns transparently.
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

// Global open/close; content is per-branch. Always mounted so shells persist;
// only its height collapses when closed.
export function BottomPanel() {
  const open = useAppStore((s) => s.bottomPanelOpen);
  const repos = useAppStore((s) => s.repos);
  const branch = useAppStore(selectedBranch);

  const branches = repos.flatMap((r) => r.branches);

  return (
    <div className={open ? "relative h-64 shrink-0 border-t border-border" : "hidden"}>
      {branches.map((b) => (
        <ShellPane key={b.id} branch={b} active={open && b.id === branch?.id} />
      ))}
    </div>
  );
}
