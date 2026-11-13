import { useState } from "react";
import { useAppStore, type Repo } from "../store/appStore";
import { BranchItem } from "./BranchItem";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "./ui/icons";

export function RepoItem({ repo }: { repo: Repo }) {
  const select = useAppStore((s) => s.select);
  const openBranchModal = useAppStore((s) => s.openBranchModal);
  const [open, setOpen] = useState(true);
  const selected = useAppStore(
    (s) => s.workspaceView === "workspace" && s.selection.repoId === repo.id && s.selection.branchId === null,
  );
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="mb-1">
      <div
        onClick={() => select(repo.id, null)}
        className={`group flex h-8 items-center gap-1.5 rounded-md pl-1 pr-1.5 ${
          selected ? "bg-sidebar-selected" : "hover:bg-sidebar-hover"
        }`}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
          aria-label={`${open ? "Collapse" : "Expand"} ${repo.name}`}
          aria-expanded={open}
          className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          <Chevron className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{repo.name}</span>
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
    </div>
  );
}
