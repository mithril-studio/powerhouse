import { useAppStore, type Repo } from "../store/appStore";
import { BranchItem } from "./BranchItem";

export function RepoItem({ repo }: { repo: Repo }) {
  const select = useAppStore((s) => s.select);
  const openBranchModal = useAppStore((s) => s.openBranchModal);
  const selected = useAppStore(
    (s) => s.selection.repoId === repo.id && s.selection.branchId === null,
  );

  return (
    <div className="mb-1">
      <div
        onClick={() => select(repo.id, null)}
        className={`group flex h-8 items-center gap-2 rounded-md px-2 ${
          selected ? "bg-sidebar-selected" : "hover:bg-sidebar-hover"
        }`}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" className="size-4 shrink-0 text-muted-foreground">
          <path d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h6a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15Z" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{repo.name}</span>
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
    </div>
  );
}
