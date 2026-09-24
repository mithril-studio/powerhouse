import { useCallback, useEffect, useState } from "react";
import { useAppStore, type Branch, type QueueEntry, type Repo } from "../store/appStore";
import { dismissEntry, enqueueBranch } from "../lib/actions";
import { gitTargetCommits, type TargetCommits } from "../lib/ipc";
import { landedHeading, landedStatus, PRODUCTION_BRANCH } from "../lib/landed";
import { fmtWhen } from "../lib/telemetryFormat";
import { QueueCard } from "./QueueCard";

const LANDED_REFRESH_MS = 60_000;

/** What is on origin/<target> and not yet on production: the session overview.
 *  Refreshes on open, every minute while open, and after a queue entry lands. */
function LandedCommits({ repo }: { repo: Repo }) {
  const [data, setData] = useState<TargetCommits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mergedCount = useAppStore(
    (s) => (s.queues[repo.id] ?? []).filter((e) => e.state === "merged").length,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await gitTargetCommits(repo.path, repo.defaultBranch, PRODUCTION_BRANCH));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [repo.path, repo.defaultBranch]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), LANDED_REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh, mergedCount]);

  const now = Date.now();
  return (
    <section aria-label={landedHeading(repo.defaultBranch, data?.base ?? null)} className="mb-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {landedHeading(repo.defaultBranch, data?.base ?? null)}
        </span>
        <span className="h-px flex-1 bg-border" />
        {data && (
          <span className="text-[11px] text-muted-foreground">
            {landedStatus(data.commits.length, data.fetched)}
          </span>
        )}
        <button
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh commits"
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground disabled:opacity-40"
        >
          ↻
        </button>
      </div>
      {error && <p className="py-2 text-xs text-destructive">{error}</p>}
      {!error && data && data.commits.length === 0 && (
        <p className="py-2 text-xs text-muted-foreground">
          Nothing on {repo.defaultBranch} beyond {data.base ?? "its tip"}.
        </p>
      )}
      {!error && data && data.commits.length > 0 && (
        <ul className="space-y-0.5">
          {data.commits.map((c) => (
            <li
              key={c.sha}
              title={`${c.sha}\n${c.author}`}
              className="flex h-7 items-center gap-2 rounded-md px-1.5 hover:bg-muted/40"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${c.merge ? "bg-muted-foreground/40" : "bg-success"}`}
                aria-hidden
              />
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{c.short}</span>
              <span className="min-w-0 flex-1 truncate text-xs">{c.subject}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {c.author.split(" ")[0]} · {fmtWhen(c.time * 1000, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const isLive = (e: QueueEntry) =>
  e.state === "queued" || e.state === "validating" || e.state === "merging";

// Merged/canceled entries collapse to a one-line row; failed/interrupted keep
// the full card so their error + Re-enqueue stay reachable.
const isCompact = (e: QueueEntry) =>
  e.state === "merged" || e.state === "canceled";

function HistoryRow({ repoId, entry }: { repoId: string; entry: QueueEntry }) {
  return (
    <div className="group flex h-7 items-center gap-2 rounded-md px-1.5 hover:bg-muted/40">
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          entry.state === "merged" ? "bg-success" : "bg-muted-foreground/40"
        }`}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.branch}</span>
      {entry.merge_commit && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {entry.merge_commit.slice(0, 7)}
        </span>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {entry.state === "canceled" ? "canceled" : ""}
      </span>
      <button
        onClick={() => void dismissEntry(repoId, entry.id)}
        title="Dismiss"
        aria-label={`Dismiss ${entry.branch}`}
        className="hidden size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground group-hover:flex"
      >
        ×
      </button>
    </div>
  );
}

export function QueuePane({ repo, branch }: { repo: Repo; branch?: Branch | null }) {
  const entries = useAppStore((s) => s.queues[repo.id] ?? []);
  const openWorkflowModal = useAppStore((s) => s.openWorkflowModal);

  const active = entries
    .filter(isLive)
    .sort((a, b) => a.created_at - b.created_at);
  const history = entries
    .filter((e) => !isLive(e))
    .sort((a, b) => b.created_at - a.created_at);

  const branchLive =
    !!branch && active.some((e) => e.branch === branch.name);

  let queuedSeen = 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3">
        <div className="mb-4 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{repo.name}</span>
          <button
            onClick={() => openWorkflowModal(repo.id)}
            className="h-7 shrink-0 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Edit workflow
          </button>
          {branch && (
            <button
              onClick={() => void enqueueBranch(repo.id, branch.id)}
              disabled={branchLive}
              title={branchLive ? "Already in the queue" : `Enqueue ${branch.name}`}
              className="pi-btn pi-btn-primary h-7 shrink-0 px-3 text-xs font-medium focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {branchLive ? "Queued" : "Merge"}
            </button>
          )}
        </div>

        <LandedCommits repo={repo} />

        {active.length > 0 && (
          <div className="relative space-y-2 pl-4">
            {/* 1px spine joining the active pipeline cards. */}
            <div className="absolute bottom-3 left-[3px] top-3 w-px bg-border" aria-hidden />
            {active.map((entry) => {
              const position = entry.state === "queued" ? ++queuedSeen : null;
              return <QueueCard key={entry.id} repoId={repo.id} entry={entry} position={position} />;
            })}
          </div>
        )}

        {active.length === 0 && history.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing queued. Merge lands the selected branch on{" "}
            <span className="font-mono">{repo.defaultBranch}</span>
            {repo.workflow.length > 0 ? " after the workflow steps pass." : "."}
          </p>
        )}

        {history.length > 0 && (
          <>
            <div className="mb-2 mt-6 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                History
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <div className="space-y-1">
              {history.map((entry) =>
                isCompact(entry) ? (
                  <HistoryRow key={entry.id} repoId={repo.id} entry={entry} />
                ) : (
                  <QueueCard key={entry.id} repoId={repo.id} entry={entry} position={null} />
                ),
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
