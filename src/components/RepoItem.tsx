import { useEffect, useState } from "react";
import { useAppStore, type Repo } from "../store/appStore";
import { deleteRepo } from "../lib/actions";
import { BranchItem } from "./BranchItem";

export function RepoItem({ repo }: { repo: Repo }) {
  const select = useAppStore((s) => s.select);
  const openBranchModal = useAppStore((s) => s.openBranchModal);
  const setRepoHidden = useAppStore((s) => s.setRepoHidden);
  const selected = useAppStore(
    (s) => s.selection.repoId === repo.id && s.selection.branchId === null,
  );

  // Anchor for the right-click context menu (viewport coords), or null when closed.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  return (
    <div className="mb-1">
      <div
        onClick={() => select(repo.id, null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={`group flex h-7 items-center gap-1.5 rounded-md px-1.5 ${
          selected ? "bg-muted" : "hover:bg-muted/50"
        } ${repo.hidden ? "opacity-50" : ""}`}
      >
        <span className="min-w-0 flex-1 truncate font-medium">{repo.name}</span>
        <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground group-hover:inline">
          {repo.defaultBranch}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            openBranchModal(repo.id);
          }}
          title="New branch (⌘D)"
          aria-label={`New branch in ${repo.name}`}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground"
        >
          +
        </button>
      </div>
      {repo.branches.map((branch) => (
        <BranchItem key={branch.id} repo={repo} branch={branch} />
      ))}

      {menu && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-40 overflow-hidden rounded-lg border border-border bg-background py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <ContextRow
              label={repo.hidden ? "Unhide" : "Hide"}
              onClick={() => {
                setRepoHidden(repo.id, !repo.hidden);
                setMenu(null);
              }}
            />
            <ContextRow
              label="Remove"
              danger
              onClick={() => {
                setMenu(null);
                void deleteRepo(repo.id);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ContextRow({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-muted ${
        danger ? "text-destructive" : "text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
