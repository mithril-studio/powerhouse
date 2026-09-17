import { useAppStore } from "../store/appStore";
import { pickAndAddRepo } from "../lib/actions";
import { RepoItem } from "./RepoItem";

export function Sidebar() {
  const repos = useAppStore((s) => s.repos);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-background">
      {/* Traffic-light strip (titleBarStyle: Overlay) — draggable. */}
      <div data-tauri-drag-region className="h-11 shrink-0" />
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </span>
        <button
          onClick={() => void pickAndAddRepo()}
          title="Add project"
          className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          +
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {repos.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            Add a git repository to get started.
          </p>
        ) : (
          repos.map((repo) => <RepoItem key={repo.id} repo={repo} />)
        )}
      </div>
    </aside>
  );
}
