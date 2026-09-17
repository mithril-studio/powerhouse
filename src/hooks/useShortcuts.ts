import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import { createChat } from "../lib/actions";

/** Cmd+D → new branch modal, Cmd+T → new chat. Capture phase so xterm never wins. */
export function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      const s = useAppStore.getState();

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
          createChat(repoId, branchId);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
