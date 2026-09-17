import { useAppStore, type QueueEntry, type Repo } from "../store/appStore";
import { dismissEntry } from "../lib/actions";
import { QueueCard } from "./QueueCard";

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

export function QueuePane({ repo }: { repo: Repo }) {
  const entries = useAppStore((s) => s.queues[repo.id] ?? []);
  const openWorkflowModal = useAppStore((s) => s.openWorkflowModal);

  const active = entries
    .filter(isLive)
    .sort((a, b) => a.created_at - b.created_at);
  const history = entries
    .filter((e) => !isLive(e))
    .sort((a, b) => b.created_at - a.created_at);

  let queuedSeen = 0;

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto max-w-2xl p-4">
        <div className="mb-4 flex items-center gap-2">
          <h1 className="font-medium">Merge queue</h1>
          <span className="text-xs text-muted-foreground">{repo.name}</span>
          <span className="flex-1" />
          <button
            onClick={() => openWorkflowModal(repo.id)}
            className="h-7 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Edit workflow
          </button>
        </div>

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
          <p className="py-16 text-center text-sm text-muted-foreground">
            Nothing queued. Select a branch and hit Merge to validate it against{" "}
            <span className="font-mono">{repo.defaultBranch}</span>.
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
