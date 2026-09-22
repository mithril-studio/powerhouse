import { useAppStore } from "../store/appStore";
import { pickAndAddRepo } from "../lib/actions";
import { RepoItem } from "./RepoItem";

const NAV_ITEMS = [
  { label: "Home" },
  { label: "Workflows" },
  { label: "Memory" },
  { label: "Telemetry" },
] as const;

export function Sidebar() {
  const repos = useAppStore((s) => s.repos);
  const openSettings = useAppStore((s) => s.openSettings);
  const openTelemetry = useAppStore((s) => s.openTelemetry);

  const navAction: Partial<Record<(typeof NAV_ITEMS)[number]["label"], () => void>> = {
    Telemetry: openTelemetry,
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-background">
      {/* Traffic-light strip (titleBarStyle: Overlay) — draggable. */}
      <div data-tauri-drag-region className="h-11 shrink-0" />
      <nav className="flex flex-col gap-0.5 px-2 pb-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={navAction[item.label]}
            className="flex items-center rounded-md px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="mx-2 mb-1 border-t border-border" />
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </span>
        <button
          onClick={() => void pickAndAddRepo()}
          title="Add project"
          aria-label="Add project"
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
      {/* Bottom-left corner: settings entry point. */}
      <div className="mt-auto border-t border-border p-2">
        <button
          onClick={() => openSettings()}
          title="Settings"
          aria-label="Settings"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
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
        </button>
      </div>
    </aside>
  );
}
