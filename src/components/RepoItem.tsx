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
        className={`group flex h-7 items-center gap-1.5 rounded-md px-1.5 ${
          selected ? "bg-muted" : "hover:bg-muted/50"
        }`}
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
