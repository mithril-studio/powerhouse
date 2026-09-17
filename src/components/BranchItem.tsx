import { useAppStore, type Branch, type Repo } from "../store/appStore";
import { deleteBranch } from "../lib/actions";

interface Props {
  repo: Repo;
  branch: Branch;
}

export function BranchItem({ repo, branch }: Props) {
  const select = useAppStore((s) => s.select);
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  const selected = useAppStore(
    (s) => s.selection.repoId === repo.id && s.selection.branchId === branch.id,
  );

  const onSelect = () => {
    select(repo.id, branch.id);
    if (!branch.activeChatId && branch.chats.length > 0) {
      setActiveChat(repo.id, branch.id, branch.chats[0].id);
    }
  };

  return (
    <div
      onClick={onSelect}
      className={`group flex h-7 cursor-default items-center gap-2 rounded-md pl-6 pr-1.5 ${
        selected
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      }`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          selected ? "bg-accent-brand" : "bg-muted-foreground/40"
        }`}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{branch.name}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void deleteBranch(repo.id, branch.id);
        }}
        title="Delete branch"
        className="hidden size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-destructive group-hover:flex"
      >
        ×
      </button>
    </div>
  );
}
