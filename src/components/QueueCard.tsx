import { useEffect, useState } from "react";
import type { QueueEntry, QueueState, StepState } from "../store/appStore";
import { cancelQueueEntry, dismissEntry, retryQueueEntry } from "../lib/actions";
import { StepLog } from "./StepLog";

const LIVE: QueueState[] = ["queued", "validating", "merging"];

const STATE_LABEL: Record<QueueState, string> = {
  queued: "Queued",
  validating: "Validating",
  merging: "Merging",
  merged: "Merged",
  failed: "Failed",
  canceled: "Canceled",
  interrupted: "Interrupted",
};

function stateDot(state: QueueState) {
  switch (state) {
    case "validating":
    case "merging":
      return "animate-pulse bg-accent-brand";
    case "merged":
      return "bg-success";
    case "failed":
    case "interrupted":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

function stepDot(status: StepState["status"]) {
  switch (status) {
    case "running":
      return "animate-pulse bg-accent-brand";
    case "passed":
      return "bg-success";
    case "failed":
      return "bg-destructive";
    case "skipped":
      return "bg-muted-foreground/20";
    default:
      return "bg-muted-foreground/40";
  }
}

const fmtDuration = (ms: number) =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

function StepRow({
  repoId,
  entry,
  idx,
  live,
}: {
  repoId: string;
  entry: QueueEntry;
  idx: number;
  live: boolean;
}) {
  const step = entry.steps[idx];
  const [open, setOpen] = useState(false);

  // Auto-expand the running or failed step.
  useEffect(() => {
    if (step.status === "running" || step.status === "failed") setOpen(true);
  }, [step.status]);

  const right =
    step.status === "failed" && step.exit_code != null
      ? `exit ${step.exit_code}`
      : step.duration_ms != null
        ? fmtDuration(step.duration_ms)
        : "";

  return (
    <div>
      <div
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 cursor-default items-center gap-2 rounded-md px-1 hover:bg-muted/40"
      >
        <span className={`size-1.5 shrink-0 rounded-full ${stepDot(step.status)}`} aria-hidden />
        <span
          className={`min-w-0 flex-1 truncate text-xs ${
            step.status === "skipped" ? "text-muted-foreground/50" : ""
          }`}
        >
          {step.name || step.command}
        </span>
        <span
          className={`shrink-0 font-mono text-[11px] ${
            step.status === "failed" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {right}
        </span>
      </div>
      {open && (
        <StepLog
          repoId={repoId}
          entryId={entry.id}
          step={idx}
          live={live && step.status === "running"}
        />
      )}
    </div>
  );
}

export function QueueCard({
  repoId,
  entry,
  position,
}: {
  repoId: string;
  entry: QueueEntry;
  position: number | null;
}) {
  const [expanded, setExpanded] = useState(true);
  const live = LIVE.includes(entry.state);
  const canRetry = entry.state === "failed" || entry.state === "interrupted";

  return (
    <div className="pi-card p-3">
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${stateDot(entry.state)}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.branch}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {STATE_LABEL[entry.state]}
          {entry.state === "queued" && position != null ? ` · #${position}` : ""}
        </span>
        {entry.merge_commit && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {entry.merge_commit.slice(0, 7)}
          </span>
        )}
        {live ? (
          <button
            onClick={() => void cancelQueueEntry(repoId, entry)}
            title="Cancel"
            aria-label={`Cancel ${entry.branch}`}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-destructive"
          >
            ×
          </button>
        ) : (
          <button
            onClick={() => void dismissEntry(repoId, entry.id)}
            title="Dismiss"
            aria-label={`Dismiss ${entry.branch}`}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground"
          >
            ×
          </button>
        )}
        {entry.steps.length > 0 && (
          <button
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? "Collapse" : "Expand"}
            className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground"
          >
            {expanded ? "⌄" : "›"}
          </button>
        )}
      </div>

      {expanded && entry.steps.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {entry.steps.map((_, idx) => (
            <StepRow key={idx} repoId={repoId} entry={entry} idx={idx} live={live} />
          ))}
        </div>
      )}

      {entry.error && (
        <p className="mt-2 max-h-24 select-text overflow-y-auto whitespace-pre-wrap font-mono text-xs text-destructive">
          {entry.error}
        </p>
      )}

      {canRetry && (
        <button
          onClick={() => void retryQueueEntry(repoId, entry)}
          className="pi-btn pi-btn-primary mt-2 h-7 px-3 text-xs font-medium focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Re-enqueue
        </button>
      )}
    </div>
  );
}
