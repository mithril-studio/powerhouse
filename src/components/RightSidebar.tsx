import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useAppStore,
  type Branch,
  type Repo,
  type RightTab,
} from "../store/appStore";
import {
  gitChangedFiles,
  gitFileContent,
  gitFileDiff,
  gitListFiles,
  type ChangedFile,
} from "../lib/ipc";
import { DiffView } from "./DiffView";
import { QueuePane } from "./QueuePane";
import { CloudPane } from "./CloudPane";

const TABS: { id: RightTab; label: string }[] = [
  { id: "files", label: "All files" },
  { id: "changes", label: "Changes" },
  { id: "diff", label: "Diff" },
  { id: "merge", label: "Merge" },
  { id: "cloud", label: "Cloud" },
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

function FileIcon() {
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
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
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
            <div
              onClick={() => (isDir ? toggle(child.path) : onOpenFile(child.path))}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              className="flex h-7 cursor-default items-center gap-1.5 rounded-md pr-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              <span className="w-3 shrink-0 text-center text-[9px] text-muted-foreground">
                {isDir ? (open ? "▾" : "▸") : ""}
              </span>
              {isDir ? <FolderIcon open={open} /> : <FileIcon />}
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{child.name}</span>
            </div>
            {isDir && open && (
              <TreeRows
                node={child}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function FilesTab({ branch }: { branch: Branch }) {
  const [files, setFiles] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    void gitListFiles(branch.worktreePath)
      .then(setFiles)
      .catch((e) => setError(String(e)));
  }, [branch.worktreePath]);

  useEffect(() => {
    if (!openFile) return;
    let cancelled = false;
    void gitFileContent(branch.worktreePath, openFile)
      .then((c) => !cancelled && setContent(c))
      .catch((e) => !cancelled && setContent(String(e)));
    return () => {
      cancelled = true;
    };
  }, [openFile, branch.worktreePath]);

  const tree = useMemo(() => buildTree(files), [files]);
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  if (openFile) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-2">
          <button
            onClick={() => setOpenFile(null)}
            title="Back to files"
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            ←
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs" dir="rtl">
            {openFile}
          </span>
        </div>
        <pre className="flex-1 select-text overflow-auto whitespace-pre px-3 py-1.5 font-mono text-xs leading-relaxed">
          {content}
        </pre>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-1.5 py-1.5">
      {error && (
        <p className="select-text px-1.5 py-2 font-mono text-xs text-destructive">{error}</p>
      )}
      {!error && files.length === 0 && (
        <p className="px-1.5 py-2 text-xs text-muted-foreground">No files.</p>
      )}
      <TreeRows
        node={tree}
        depth={0}
        expanded={expanded}
        toggle={toggle}
        onOpenFile={setOpenFile}
      />
    </div>
  );
}

function ChangesTab({
  repo,
  branch,
  onOpenDiff,
}: {
  repo: Repo;
  branch: Branch;
  onOpenDiff: (path: string) => void;
}) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    gitChangedFiles(branch.worktreePath, repo.defaultBranch)
      .then(setFiles)
      .catch((e) => setError(String(e)));
  }, [branch.worktreePath, repo.defaultBranch]);

  useEffect(() => load(), [load]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 px-2">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {files.length} changed
        </span>
        <button
          onClick={load}
          title="Refresh"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ↻
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {error && (
          <p className="select-text px-1.5 py-2 font-mono text-xs text-destructive">{error}</p>
        )}
        {!error && files.length === 0 && (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            No changes vs {repo.defaultBranch}.
          </p>
        )}
        {files.map((f) => (
          <div
            key={f.path}
            onClick={() => onOpenDiff(f.path)}
            title={f.path}
            className="flex h-7 cursor-default items-center gap-2 rounded-md px-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <span className={`shrink-0 font-mono text-[11px] ${statusColor(f.status)}`}>
              {f.status}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" dir="rtl">
              {f.path}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffTab({
  repo,
  branch,
  path,
}: {
  repo: Repo;
  branch: Branch;
  path: string | null;
}) {
  const [diff, setDiff] = useState("");

  useEffect(() => {
    if (!path) {
      setDiff("");
      return;
    }
    let cancelled = false;
    void gitFileDiff(branch.worktreePath, repo.defaultBranch, path)
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setDiff(String(e)));
    return () => {
      cancelled = true;
    };
  }, [path, branch.worktreePath, repo.defaultBranch]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="text-sm text-muted-foreground">
          Pick a file in Changes to see its diff.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" dir="rtl">
          {path}
        </span>
      </div>
      <div className="flex-1 overflow-auto py-1.5">
        <DiffView diff={diff} />
      </div>
    </div>
  );
}

// --- shell ----------------------------------------------------------------

export function RightSidebar({
  repo,
  branch,
}: {
  repo: Repo | null;
  branch: Branch | null;
}) {
  const rightTab = useAppStore((s) => s.rightTab);
  const setRightTab = useAppStore((s) => s.setRightTab);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const [diffPath, setDiffPath] = useState<string | null>(null);

  // Reset the selected diff file when the branch changes.
  useEffect(() => setDiffPath(null), [branch?.id]);

  const openDiff = (path: string) => {
    setDiffPath(path);
    setRightTab("diff");
  };

  return (
    <aside className="flex w-90 shrink-0 flex-col border-l border-border bg-background">
      <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setRightTab(t.id)}
            className={`h-7 flex-1 rounded-md px-1 text-xs ${
              rightTab === t.id
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={toggleRightSidebar}
          title="Close sidebar"
          aria-label="Close right sidebar"
          className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {rightTab === "merge" ? (
          repo ? (
            <QueuePane repo={repo} branch={branch} />
          ) : (
            <Empty>Select a project.</Empty>
          )
        ) : rightTab === "cloud" ? (
          repo ? (
            <CloudPane repo={repo} branch={branch} />
          ) : (
            <Empty>Select a project.</Empty>
          )
        ) : !branch || !repo ? (
          <Empty>Select a branch.</Empty>
        ) : rightTab === "files" ? (
          <FilesTab key={branch.id} branch={branch} />
        ) : rightTab === "changes" ? (
          <ChangesTab key={branch.id} repo={repo} branch={branch} onOpenDiff={openDiff} />
        ) : (
          <DiffTab repo={repo} branch={branch} path={diffPath} />
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
