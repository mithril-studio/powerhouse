import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import { focusTerminal } from "../lib/terminalRegistry";
import { deleteBranch, deleteChat } from "../lib/actions";

/**
 * Cmd+D → new branch modal, Cmd+T → agent picker, Ctrl+` → bottom shell,
 * Cmd+W → close active chat, Cmd+Shift+Backspace → delete worktree.
 * Capture phase so xterm never wins.
 */
export function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      // Workflow editing must not close or manipulate a hidden chat/worktree.
      if (s.workspaceView !== "home") return;

      // Ctrl+` toggles the bottom terminal (layout-independent via e.code).
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "Backquote") {
        if (!s.selection.branchId) return;
        e.preventDefault();
        e.stopPropagation();
        s.toggleBottomPanel();
        // On close, hand focus back to the active chat terminal.
        if (s.bottomPanelOpen) {
          const branch = s.repos
            .find((r) => r.id === s.selection.repoId)
            ?.branches.find((b) => b.id === s.selection.branchId);
          if (branch?.activeChatId) focusTerminal(branch.activeChatId);
        }
        return;
      }

      if (!e.metaKey || e.ctrlKey || e.altKey) return;

      // Cmd+Shift+Backspace → delete the selected worktree (confirms first).
      if (e.shiftKey) {
        if (e.key === "Backspace") {
          const { repoId, branchId } = s.selection;
          if (repoId && branchId) {
            e.preventDefault();
            e.stopPropagation();
            void deleteBranch(repoId, branchId);
          }
        }
        return;
      }

      const key = e.key.toLowerCase();

      if (key === "d") {
        const repoId = s.selection.repoId ?? s.repos[0]?.id;
        if (repoId) {
          e.preventDefault();
          e.stopPropagation();
          s.openBranchModal(repoId);
        }
      } else if (key === "t") {
        const { repoId, branchId } = s.selection;
        if (repoId && branchId) {
          e.preventDefault();
          e.stopPropagation();
          s.openChatPicker();
        }
      } else if (key === "w") {
        const { repoId, branchId } = s.selection;
        const branch = s.repos
          .find((r) => r.id === repoId)
          ?.branches.find((b) => b.id === branchId);
        if (repoId && branchId && branch?.activeChatId) {
          e.preventDefault();
          e.stopPropagation();
          deleteChat(repoId, branchId, branch.activeChatId);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
