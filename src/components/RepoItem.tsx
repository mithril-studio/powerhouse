import { useAppStore, type Repo } from "../store/appStore";
import { BranchItem } from "./BranchItem";

function MergeQueueRow({ repo }: { repo: Repo }) {
  const selectQueue = useAppStore((s) => s.selectQueue);
  const selected = useAppStore(
    (s) => s.selection.repoId === repo.id && s.selection.view === "queue",
  );
  const entries = useAppStore((s) => s.queues[repo.id] ?? []);
  const pending = entries.filter((e) =>
    ["queued", "validating", "merging"].includes(e.state),
  );
  const validating = pending.some(
    (e) => e.state === "validating" || e.state === "merging",
  );

  return (
    <div
      onClick={() => selectQueue(repo.id)}
      className={`group flex h-7 cursor-default items-center gap-2 rounded-md pl-6 pr-1.5 ${
        selected
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      }`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          validating
            ? "animate-pulse bg-accent-brand"
            : selected
              ? "bg-accent-brand"
              : "bg-muted-foreground/40"
        }`}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-xs">Merge queue</span>
      {pending.length > 0 && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {pending.length}
        </span>
      )}
    </div>
  );
}

export function RepoItem({ repo }: { repo: Repo }) {
  const select = useAppStore((s) => s.select);
  const openBranchModal = useAppStore((s) => s.openBranchModal);
  const selected = useAppStore(
    (s) =>
      s.selection.repoId === repo.id &&
      s.selection.branchId === null &&
      s.selection.view !== "queue",
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
          aria-label={`New branch in ${repo.name}`}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground"
        >
          +
        </button>
      </div>
      <MergeQueueRow repo={repo} />
      {repo.branches.map((branch) => (
        <BranchItem key={branch.id} repo={repo} branch={branch} />
      ))}
    </div>
  );
}
