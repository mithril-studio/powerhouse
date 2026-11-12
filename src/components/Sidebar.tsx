import { useAppStore } from "../store/appStore";
import { pickAndAddRepo } from "../lib/actions";
import { RepoItem } from "./RepoItem";

export function Sidebar() {
  const repos = useAppStore((s) => s.repos);
  const view = useAppStore((s) => s.workspaceView);
  const openSettings = useAppStore((s) => s.openSettings);
  return (
    <aside aria-label="Main sidebar" className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      {/* Traffic-light strip (titleBarStyle: Overlay) — draggable. */}
      <div data-tauri-drag-region className="h-11 shrink-0" />
      <div className="flex items-center gap-2 px-4 pb-5 pt-2">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-5">
          <path strokeLinejoin="round" d="m13 2-9 12h7l-1 8 10-13h-8l1-7Z" />
        </svg>
        <span className="text-sm font-semibold tracking-tight">Powerhouse</span>
      </div>
      <nav aria-label="Workspace views" className="mb-5 space-y-1 px-2">
        {([ ["board", "Task board"], ["mission", "Mission Control"] ] as const).map(([id, label]) => <button key={id} aria-current={view === id ? "page" : undefined} onClick={() => useAppStore.setState({ workspaceView: id, settingsOpen: false })} className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm ${view === id ? "bg-sidebar-selected text-foreground" : "text-muted-foreground hover:bg-sidebar-hover"}`}>{label}</button>)}
      </nav>
      <div className="flex items-center justify-between px-4 pb-2">
        <span className="text-xs font-medium text-muted-foreground">
          Projects
        </span>
        <button
          onClick={() => void pickAndAddRepo()}
          title="Add project"
          aria-label="Add project"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
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
      {/* Bottom-left corner: settings entry point. */}
      <div className="mt-auto border-t border-sidebar-border p-3">
        <button
          onClick={() => openSettings()}
          title="Settings"
          aria-label="Settings"
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4 shrink-0"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings
          <kbd className="ml-auto text-[11px] text-muted-foreground/60">⌘,</kbd>
        </button>
      </div>
    </aside>
  );
}
