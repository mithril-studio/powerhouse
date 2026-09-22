import type { RunSummary } from "../../lib/ipc";
import {
  coverageBadges,
  fmtDuration,
  fmtTokens,
  fmtWhen,
  runStatus,
  type RunStatus,
} from "../../lib/telemetryFormat";

function statusDot(status: RunStatus) {
  switch (status) {
    case "running":
      return "animate-pulse bg-accent-brand";
    case "ok":
      return "bg-success";
    case "failed":
    case "interrupted":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

function runLabel(run: RunSummary) {
  const parts = [run.repoLabel, run.branchLabel].filter(Boolean);
  if (parts.length > 0) return parts.join(" / ");
  return run.agentName ?? run.chatId ?? run.runId.slice(0, 8);
}

export function RunsTable({
  runs,
  selected,
  onSelect,
  now,
}: {
  runs: RunSummary[];
  selected: string | null;
  onSelect: (runId: string) => void;
  now: number;
}) {
  if (runs.length === 0) {
    return (
      <p className="px-1 py-4 text-xs text-muted-foreground">
        No runs recorded yet. Start an agent chat and its events will appear here.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {runs.map((run) => {
        const status = runStatus(run);
        const duration =
          run.endedAt != null ? fmtDuration(run.endedAt - run.startedAt) : null;
        return (
          <button
            key={run.runId}
            type="button"
            onClick={() => onSelect(run.runId)}
            className={`flex items-center gap-2 border-b border-border px-2 py-1.5 text-left hover:bg-muted/50 ${
              selected === run.runId ? "bg-muted/60" : ""
            }`}
          >
            <span className={`size-1.5 shrink-0 rounded-full ${statusDot(status)}`} />
            <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
              {run.source}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {runLabel(run)}
            </span>
            {coverageBadges(run).map((badge) => (
              <span
                key={badge}
                className="shrink-0 border border-border px-1 text-[10px] text-muted-foreground"
              >
                {badge}
              </span>
            ))}
            <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
              {run.turnCount > 0 ? `${run.turnCount} turn${run.turnCount === 1 ? "" : "s"}` : ""}
            </span>
            <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
              {run.toolCallCount > 0 ? `${run.toolCallCount} tool${run.toolCallCount === 1 ? "" : "s"}` : ""}
            </span>
            <span
              className="w-16 shrink-0 text-right text-[11px] text-muted-foreground"
              title="input / output tokens"
            >
              {run.coverage === "instrumented"
                ? `${fmtTokens(run.inputTokens)}/${fmtTokens(run.outputTokens)}`
                : "—"}
            </span>
            <span className="w-12 shrink-0 text-right text-[11px] text-muted-foreground">
              {duration ?? ""}
            </span>
            <span className="w-20 shrink-0 text-right text-[10px] text-muted-foreground">
              {fmtWhen(run.startedAt, now)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
