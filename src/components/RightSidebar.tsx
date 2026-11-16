import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useAppStore,
  type Branch,
  type Repo,
  type RightTab,
} from "../store/appStore";
import {
  gitChangedFiles,
  gitFileDiff,
  gitListFiles,
  type ChangedFile,
} from "../lib/ipc";
import { DiffView } from "./DiffView";
import { mirrorCloudBranch } from "../lib/actions";
import { QueuePane } from "./QueuePane";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, RefreshIcon } from "./ui/icons";

const TABS: { id: RightTab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "merge", label: "Merge" },
  { id: "files", label: "Files" },
];

function statusColor(status: string) {
  const letter = status[0];
  if (letter === "A") return "text-success";
  if (letter === "D") return "text-destructive";
  return "text-accent-brand";
}

// --- file tree ------------------------------------------------------------

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="shrink-0 text-accent-brand"
      aria-hidden
    >
      {open ? (
        <path d="M2 3.5c0-.55.45-1 1-1h3.1c.27 0 .53.11.72.3l.98.98h5.2c.55 0 1 .45 1 1v.72H5.4c-.44 0-.83.29-.96.71L2.6 12.2A1 1 0 0 1 2 11.3V3.5zm1.9 3.5h10.3a.6.6 0 0 1 .57.78l-1.3 4.2a1 1 0 0 1-.96.72H2.9a.6.6 0 0 1-.57-.78l1.3-4.2a1 1 0 0 1 .96-.74z" />
      ) : (
        <path d="M2 4c0-.55.45-1 1-1h3.1c.27 0 .53.11.72.3l.98.98H13c.55 0 1 .45 1 1V12c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V4z" />
      )}
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
      className="shrink-0 text-muted-foreground/70"
      aria-hidden
    >
      <path d="M4 2.5h5l3 3V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13V3a.5.5 0 0 1 .5-.5z" />
      <path d="M8.8 2.6v3h3" />
    </svg>
  );
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const p of paths) {
    let node = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          children: new Map(),
        };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function TreeRows({
  node,
  depth,
  expanded,
  toggle,
  activePath,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  // Folders first, then files, each alphabetical.
  const entries = [...node.children.values()].sort((a, b) => {
    const af = a.children.size > 0 ? 0 : 1;
    const bf = b.children.size > 0 ? 0 : 1;
    return af - bf || a.name.localeCompare(b.name);
  });

  return (
    <>
      {entries.map((child) => {
        const isDir = child.children.size > 0;
        const open = expanded.has(child.path);
        return (
          <div key={child.path}>
            <button
              type="button"
              onClick={() => (isDir ? toggle(child.path) : onOpenFile(child.path))}
              aria-expanded={isDir ? open : undefined}
              aria-current={child.path === activePath}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
              className="ph-row gap-1.5"
            >
              <span className="flex w-3 shrink-0 justify-center text-muted-foreground">
                {isDir && (open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />)}
              </span>
              {isDir ? <FolderIcon open={open} /> : <FileIcon />}
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{child.name}</span>
            </button>
            {isDir && open && (
              <TreeRows
                node={child}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                activePath={activePath}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function FilesTab({ repo, branch }: { repo: Repo; branch: Branch }) {
  const openFile = useAppStore((s) => s.openFile);
  const [files, setFiles] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // A cloud branch's worktree changes when it mirrors its VM.
  const mirroredAt = useAppStore((s) => s.vmMirror[branch.id]?.at);
  useEffect(() => {
    setError(null);
    void gitListFiles(branch.worktreePath)
      .then(setFiles)
      .catch((e) => setError(String(e)));
  }, [branch.worktreePath, mirroredAt]);

  const tree = useMemo(() => buildTree(files), [files]);
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  return (
    <div className="h-full overflow-y-auto px-1.5 py-2">
      {error && <p className="ph-panel-error">{error}</p>}
      {!error && files.length === 0 && <p className="ph-panel-note px-1.5 pt-1">No files.</p>}
      <TreeRows
        node={tree}
        depth={0}
        expanded={expanded}
        toggle={toggle}
        activePath={branch.activeFile ?? null}
        onOpenFile={(path) => openFile(repo.id, branch.id, path)}
      />
    </div>
  );
}

/** Changed files vs the target branch; picking one shows its diff in place. */
function ChangesTab({ repo, branch }: { repo: Repo; branch: Branch }) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const mirror = useAppStore((s) => s.vmMirror[branch.id]);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(() => {
    setError(null);
    return gitChangedFiles(branch.worktreePath, repo.defaultBranch)
      .then(setFiles)
      .catch((e) => setError(String(e)));
  }, [branch.worktreePath, repo.defaultBranch]);

  useEffect(() => void load(), [load, mirror?.at]);

  /** Cloud branches: refresh pulls the VM's latest state first. */
  const refresh = useCallback(() => {
    setRefreshing(true);
    void (branch.vm ? mirrorCloudBranch(repo.id, branch.id) : load()).finally(() => setRefreshing(false));
  }, [branch.vm, branch.id, repo.id, load]);

  if (selected) {
    return <FileDiff repo={repo} branch={branch} path={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="ph-panel-head">
        <span className="ph-section-label">
          {files.length} {files.length === 1 ? "file" : "files"} changed vs{" "}
          <span className="font-mono">{repo.defaultBranch}</span>
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          title={branch.vm ? "Refresh from the VM" : "Refresh"}
          aria-label={branch.vm ? "Refresh from the VM" : "Refresh changes"}
          className="ph-icon-btn"
        >
          <RefreshIcon className="size-3.5" />
        </button>
      </div>
      {branch.vm && !mirror?.error && (
        <p className="ph-panel-note">
          {mirror
            ? `From ${branch.vm}, as of ${new Date(mirror.at).toLocaleTimeString()}`
            : `From ${branch.vm} after the next turn`}
        </p>
      )}
      {mirror?.error && <p className="ph-panel-error">Could not mirror the VM: {mirror.error}</p>}
      {error && <p className="ph-panel-error">{error}</p>}
      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {!error && files.length === 0 && (
          <p className="ph-panel-note px-1.5 pt-1">No changes vs {repo.defaultBranch}.</p>
        )}
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            onClick={() => setSelected(f.path)}
            title={f.path}
            className="ph-row"
          >
            <span className={`w-3 shrink-0 font-mono text-xs ${statusColor(f.status)}`}>{f.status}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" dir="rtl">
              {f.path}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FileDiff({
  repo,
  branch,
  path,
  onBack,
}: {
  repo: Repo;
  branch: Branch;
  path: string;
  onBack: () => void;
}) {
  const openFile = useAppStore((s) => s.openFile);
  const [diff, setDiff] = useState("");

  useEffect(() => {
    let cancelled = false;
    void gitFileDiff(branch.worktreePath, repo.defaultBranch, path)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setDiff(String(e)));
    return () => {
      cancelled = true;
    };
  }, [path, branch.worktreePath, repo.defaultBranch]);

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape") onBack();
      }}
    >
      <div className="ph-panel-head gap-1 border-b border-border pl-1.5">
        <button
          type="button"
          onClick={onBack}
          title="Back to changes · esc"
          aria-label="Back to changes"
          className="ph-icon-btn flex-none"
          autoFocus
        >
          <ArrowLeftIcon className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" dir="rtl" title={path}>
          {path}
        </span>
        <button
          type="button"
          onClick={() => openFile(repo.id, branch.id, path)}
          title="Open the whole file as a tab"
          className="ph-btn ph-btn-ghost h-7 flex-none px-2 text-xs"
        >
          Open file
        </button>
      </div>
      <div className="flex-1 overflow-auto py-1.5">
        <DiffView diff={diff} />
      </div>
    </div>
  );
}

// --- shell ----------------------------------------------------------------

const DEFAULT_WIDTH = 360;
const MIN_WIDTH = 260;
/** Room always left for the main sidebar and the chat. */
const MIN_MAIN = 480;

/** Drag the left edge to resize; double-click resets. The width is saved on
 *  release, not on every move, so a drag doesn't rewrite the store file. */
function useSidebarWidth() {
  const saved = useAppStore((s) => s.settings.rightSidebarWidth) ?? DEFAULT_WIDTH;
  const save = useAppStore((s) => s.setRightSidebarWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    let width = saved;
    const move = (ev: PointerEvent) => {
      width = Math.max(MIN_WIDTH, window.innerWidth - ev.clientX);
      setDragWidth(width);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      save(width);
      setDragWidth(null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return {
    width: dragWidth ?? saved,
    dragging: dragWidth !== null,
    onPointerDown,
    reset: () => save(DEFAULT_WIDTH),
  };
}

export function RightSidebar({
  repo,
  branch,
}: {
  repo: Repo | null;
  branch: Branch | null;
}) {
  const rightTab = useAppStore((s) => s.rightTab);
  const setRightTab = useAppStore((s) => s.setRightTab);
  const resize = useSidebarWidth();

  return (
    <aside
      // maxWidth keeps the chat usable on a narrow window, whatever was saved.
      style={{ width: resize.width, minWidth: MIN_WIDTH, maxWidth: `calc(100vw - ${MIN_MAIN}px)` }}
      className="relative flex shrink-0 flex-col border-l border-border bg-background"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize · double-click to reset"
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.reset}
        className={`absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-accent-brand/40 ${
          resize.dragging ? "bg-accent-brand/40" : ""
        }`}
      />
      <nav aria-label="Branch panel" className="ph-panel-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setRightTab(t.id)}
            data-active={rightTab === t.id}
            aria-current={rightTab === t.id ? "page" : undefined}
            className="ph-tab"
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1">
        {rightTab === "merge" ? (
          repo ? (
            <QueuePane repo={repo} branch={branch} />
          ) : (
            <Empty>Select a project.</Empty>
          )
        ) : !branch || !repo ? (
          <Empty>Select a branch.</Empty>
        ) : rightTab === "files" ? (
          <FilesTab key={branch.id} repo={repo} branch={branch} />
        ) : (
          <ChangesTab key={branch.id} repo={repo} branch={branch} />
        )}
      </div>
    </aside>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
