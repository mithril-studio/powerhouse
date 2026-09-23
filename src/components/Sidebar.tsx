import { useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../store/appStore";
import { openRecentRepo, pickAndAddRepo } from "../lib/actions";
import { RepoItem } from "./RepoItem";
import { AddProjectModal, type AddProjectMode } from "./AddProjectModal";

const NAV_ITEMS = [
  { label: "Home" },
  { label: "Workflows" },
  { label: "Memory" },
  { label: "Telemetry" },
] as const;

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const FolderIcon = () => (
  <svg {...iconProps} className="size-[18px] shrink-0" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.4.6L11 7h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
const GlobeIcon = () => (
  <svg {...iconProps} className="size-[18px] shrink-0" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
  </svg>
);
const PlusBoxIcon = ({ size = "size-[18px]" }: { size?: string }) => (
  <svg {...iconProps} className={`${size} shrink-0`} aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);
const FilterIcon = () => (
  <svg {...iconProps} className="size-4 shrink-0" aria-hidden>
    <path d="M3 5h18M6 12h12M9 19h6" />
  </svg>
);

export function Sidebar() {
  const repos = useAppStore((s) => s.repos);
  const recentRepos = useAppStore((s) => s.recentRepos);
  const openSettings = useAppStore((s) => s.openSettings);
  const openTelemetry = useAppStore((s) => s.openTelemetry);
  const closeTelemetry = useAppStore((s) => s.closeTelemetry);
  const telemetryOpen = useAppStore((s) => s.telemetryOpen);

  const [menuOpen, setMenuOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [modal, setModal] = useState<AddProjectMode | null>(null);

  // Close the add-project menu on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Every nav item is a navigation: the placeholders simply leave the telemetry
  // page, and Telemetry itself toggles it. Without this, an open telemetry page
  // could only be dismissed via its close button.
  const navAction: Record<(typeof NAV_ITEMS)[number]["label"], () => void> = {
    Home: closeTelemetry,
    Workflows: closeTelemetry,
    Memory: closeTelemetry,
    Telemetry: () => (telemetryOpen ? closeTelemetry() : openTelemetry()),
  };

  const openPaths = new Set(repos.map((r) => r.path));
  const recents = recentRepos.filter((r) => !openPaths.has(r.path));
  const q = filter.trim().toLowerCase();
  const shownRepos = q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : repos;

  const choose = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-background">
      {/* Traffic-light strip (titleBarStyle: Overlay) — draggable. */}
      <div data-tauri-drag-region className="h-11 shrink-0" />
      <nav className="flex flex-col gap-0.5 px-2 pb-2">
        {NAV_ITEMS.map((item) => {
          const active = item.label === "Telemetry" && telemetryOpen;
          return (
            <button
              key={item.label}
              type="button"
              onClick={navAction[item.label]}
              aria-current={active ? "page" : undefined}
              className={`flex items-center rounded-md px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider hover:bg-muted hover:text-foreground ${
                active ? "bg-muted text-foreground" : "text-muted-foreground"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="mx-2 mb-1 border-t border-border" />

      <div className="relative">
        <div className="flex items-center justify-between px-3 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Projects
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setFilterOpen((v) => !v)}
              title="Filter projects"
              aria-label="Filter projects"
              aria-pressed={filterOpen}
              className={`flex size-6 items-center justify-center rounded-md hover:bg-muted hover:text-foreground ${
                filterOpen ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              <FilterIcon />
            </button>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              title="Add project"
              aria-label="Add project"
              aria-expanded={menuOpen}
              className={`flex size-6 items-center justify-center rounded-md hover:bg-muted hover:text-foreground ${
                menuOpen ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              <PlusBoxIcon size="size-4" />
            </button>
          </div>
        </div>

        {filterOpen && (
          <div className="px-3 pb-1.5">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setFilter(""), setFilterOpen(false))}
              placeholder="Filter projects…"
              className="w-full rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground outline-none focus:border-accent-brand"
            />
          </div>
        )}

        {menuOpen && (
          <>
            {/* click-away backdrop */}
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute left-2 right-2 top-full z-50 mt-1 overflow-hidden rounded-lg border border-border bg-background py-1 shadow-xl">
              <MenuRow icon={<FolderIcon />} label="Open project" onClick={() => choose(() => void pickAndAddRepo())} />
              <MenuRow icon={<GlobeIcon />} label="Open GitHub project" onClick={() => choose(() => setModal("github"))} />
              <MenuRow icon={<PlusBoxIcon />} label="Quick start" onClick={() => choose(() => setModal("quickstart"))} />
              {recents.length > 0 && (
                <>
                  <div className="mx-3 my-1 border-t border-border" />
                  <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Recents
                  </p>
                  {recents.map((r) => (
                    <MenuRow
                      key={r.path}
                      icon={<FolderIcon />}
                      label={prettyPath(r.path)}
                      title={r.path}
                      small
                      onClick={() => choose(() => void openRecentRepo(r.path))}
                    />
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {repos.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            Add a git repository to get started.
          </p>
        ) : shownRepos.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">No projects match “{filter}”.</p>
        ) : (
          shownRepos.map((repo) => <RepoItem key={repo.id} repo={repo} />)
        )}
      </div>

      {/* Bottom-left corner: settings entry point. Fixed height so its bar
          lines up with the chat's status bar across the divider. */}
      <div className="mt-auto flex h-12 shrink-0 items-center border-t border-border px-2">
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

      {modal && <AddProjectModal mode={modal} onClose={() => setModal(null)} />}
    </aside>
  );
}

function MenuRow({
  icon,
  label,
  onClick,
  title,
  small,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title?: string;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-foreground hover:bg-muted"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className={`truncate ${small ? "text-xs text-muted-foreground" : "text-sm"}`}>{label}</span>
    </button>
  );
}

/** Collapse the home directory to `~` for compact display. */
function prettyPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
