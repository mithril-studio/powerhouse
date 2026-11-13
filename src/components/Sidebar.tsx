import { useAppStore } from "../store/appStore";
import { pickAndAddRepo } from "../lib/actions";
import { RepoItem } from "./RepoItem";
import { BoardIcon, BoltIcon, ClockIcon, GearIcon, PlusIcon } from "./ui/icons";

const VIEWS = [
  { id: "board", label: "Task board", Icon: BoardIcon },
  { id: "mission", label: "Mission Control", Icon: ClockIcon },
] as const;

export function Sidebar() {
  const repos = useAppStore((s) => s.repos);
  const view = useAppStore((s) => s.workspaceView);
  const openSettings = useAppStore((s) => s.openSettings);
  return (
    <aside aria-label="Main sidebar" className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      {/* Traffic-light strip (titleBarStyle: Overlay) — draggable. */}
      <div data-tauri-drag-region className="h-11 shrink-0" />
      <div data-tauri-drag-region className="flex items-center gap-2 px-5 pb-4">
        <BoltIcon className="size-[18px]" />
        <span className="text-[15px] font-semibold tracking-tight">Powerhouse</span>
      </div>
      <nav aria-label="Workspace views" className="space-y-0.5 px-3">
        {VIEWS.map(({ id, label, Icon }) => (
          <button
            key={id}
            aria-current={view === id ? "page" : undefined}
            onClick={() => useAppStore.setState({ workspaceView: id, settingsOpen: false })}
            className="ph-nav-row"
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>
      <div className="mt-6 flex items-center justify-between pb-1.5 pl-5 pr-3">
        <span className="text-xs font-medium text-muted-foreground">Projects</span>
        <button onClick={() => void pickAndAddRepo()} title="Add project" aria-label="Add project" className="ph-icon-btn size-6">
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {repos.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">Add a git repository to get started.</p>
        ) : (
          repos.map((repo) => <RepoItem key={repo.id} repo={repo} />)
        )}
      </div>
      <div className="p-3">
        <button onClick={() => openSettings()} title="Settings (⌘,)" aria-label="Settings" className="ph-nav-row">
          <GearIcon />
          Settings
        </button>
      </div>
    </aside>
  );
}
