import { useEffect, useState } from "react";
import { useAppStore, type Repo } from "../store/appStore";
import { deleteRepo } from "../lib/actions";
import { BranchItem } from "./BranchItem";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "./ui/icons";

export function RepoItem({ repo }: { repo: Repo }) {
  const select = useAppStore((s) => s.select);
  const openBranchModal = useAppStore((s) => s.openBranchModal);
  const setRepoHidden = useAppStore((s) => s.setRepoHidden);
  const openProjectSettings = useAppStore((s) => s.openProjectSettings);
  const selected = useAppStore(
    (s) => s.workspaceView === "home" && s.selection.repoId === repo.id && s.selection.branchId === null,
  );
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

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
        className={`group flex h-8 items-center gap-1.5 rounded-md pl-1 pr-1.5 ${
          selected ? "bg-sidebar-selected" : "hover:bg-sidebar-hover"
        } ${repo.hidden ? "opacity-50" : ""}`}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
          aria-label={`${open ? "Collapse" : "Expand"} ${repo.name}`}
          aria-expanded={open}
          className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          <Chevron className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{repo.name}</span>
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
          className="hidden size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground group-hover:grid"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      {open && repo.branches.length > 0 && (
        <div className="ml-[13px] border-l border-input/70 pl-1.5">
          {repo.branches.map((branch) => (
            <BranchItem key={branch.id} repo={repo} branch={branch} />
          ))}
        </div>
      )}

      {menu && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-40 overflow-hidden rounded-lg border border-border bg-background py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <ContextRow
              label="Project settings"
              onClick={() => {
                setMenu(null);
                openProjectSettings(repo.id);
              }}
            />
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
