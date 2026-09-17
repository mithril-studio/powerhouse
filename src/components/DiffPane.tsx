import { useCallback, useEffect, useState } from "react";
import type { Branch, Repo } from "../store/appStore";
import { gitChangedFiles, gitFileDiff, type ChangedFile } from "../lib/ipc";

function statusColor(status: string) {
  const letter = status[0];
  if (letter === "A") return "text-success";
  if (letter === "D") return "text-destructive";
  return "text-accent-brand"; // M / R / C
}

function DiffLine({ line }: { line: string }) {
  let cls = "text-muted-foreground/90";
  if (line.startsWith("@@")) cls = "text-muted-foreground";
  else if (line.startsWith("+++") || line.startsWith("---")) cls = "text-muted-foreground/70";
  else if (line.startsWith("+")) cls = "text-success bg-success/10";
  else if (line.startsWith("-")) cls = "text-destructive bg-destructive/10";
  return <div className={`whitespace-pre px-3 ${cls}`}>{line || " "}</div>;
}

export function DiffPane({ repo, branch, active }: { repo: Repo; branch: Branch; active: boolean }) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    setError(null);
    try {
      const list = await gitChangedFiles(branch.worktreePath, repo.defaultBranch);
      setFiles(list);
      setSelected((prev) => {
        if (prev && list.some((f) => f.path === prev)) return prev;
        return list[0]?.path ?? null;
      });
    } catch (err) {
      setError(String(err));
      setFiles([]);
    }
  }, [branch.worktreePath, repo.defaultBranch]);

  // Refetch whenever this pane becomes the visible one.
  useEffect(() => {
    if (active) void loadFiles();
  }, [active, loadFiles]);

  useEffect(() => {
    if (!selected) {
      setDiff("");
      return;
    }
    let cancelled = false;
    void gitFileDiff(branch.worktreePath, repo.defaultBranch, selected)
      .then((d) => !cancelled && setDiff(d))
      .catch((err) => !cancelled && setDiff(String(err)));
    return () => {
      cancelled = true;
    };
  }, [selected, branch.worktreePath, repo.defaultBranch]);

  const lines = diff.split("\n");

  return (
    <div className="absolute inset-0 flex">
      <div className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex h-9 shrink-0 items-center gap-2 px-2">
          <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {files.length} changed
          </span>
          <button
            onClick={() => void loadFiles()}
            title="Refresh"
            aria-label="Refresh changed files"
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
              onClick={() => setSelected(f.path)}
              title={f.path}
              className={`flex h-7 cursor-default items-center gap-2 rounded-md px-1.5 ${
                selected === f.path
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
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

      <div className="min-w-0 flex-1 overflow-auto py-1.5">
        {selected ? (
          <div className="select-text font-mono text-xs leading-relaxed">
            {lines.map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground">Select a file to view its diff</p>
          </div>
        )}
      </div>
    </div>
  );
}
