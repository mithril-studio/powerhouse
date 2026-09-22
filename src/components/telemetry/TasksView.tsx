import { useEffect, useState } from "react";
import {
  telemetryDigest,
  telemetryTasks,
  type DigestReport,
  type TaskRow,
} from "../../lib/ipc";
import {
  digestToMarkdown,
  fmtCost,
  fmtTokens,
  fmtWhen,
  taskOutcome,
  type TaskOutcome,
} from "../../lib/telemetryFormat";

const WINDOW_DAYS = 14;

function outcomeDot(outcome: TaskOutcome) {
  switch (outcome) {
    case "delivered":
      return "bg-success";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

function outcomeLabel(task: TaskRow): string {
  const outcome = taskOutcome(task);
  if (outcome === "delivered") {
    return task.firstPassMerged ? "merged (first pass)" : `merged (${task.queueAttempts} attempts)`;
  }
  if (outcome === "failed") {
    return `${task.lastOutcome ?? "failed"} (${task.queueAttempts} attempts)`;
  }
  return "no queue attempt";
}

export function TasksView({ refreshKey }: { refreshKey: number }) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [digest, setDigest] = useState<DigestReport | null>(null);
  const [copied, setCopied] = useState(false);
  const now = Date.now();

  useEffect(() => {
    telemetryTasks(WINDOW_DAYS).then(setTasks).catch(() => {});
    telemetryDigest(WINDOW_DAYS).then(setDigest).catch(() => {});
  }, [refreshKey]);

  const copyDigest = () => {
    if (!digest) return;
    void navigator.clipboard.writeText(digestToMarkdown(digest)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {digest && (
        <div className="pi-card flex items-center gap-4 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            last {WINDOW_DAYS}d · {digest.tasksTotal} tasks · {digest.tasksDelivered} delivered ·{" "}
            <span className={digest.tasksFailed > 0 ? "text-destructive" : ""}>
              {digest.tasksFailed} failed
            </span>{" "}
            · {digest.tasksUnattempted} unattempted · {digest.errorTurns}/{digest.closedTurns} error
            turns · {digest.toolFailures}/{digest.toolCalls} tool failures
          </span>
          <button type="button" onClick={copyDigest} className="pi-btn ml-auto shrink-0 text-[11px]">
            {copied ? "Copied" : "Copy digest"}
          </button>
        </div>
      )}

      {tasks.length === 0 ? (
        <p className="px-1 py-4 text-xs text-muted-foreground">
          No tasks in the last {WINDOW_DAYS} days. A task is a repo+branch an agent worked on or
          the queue processed.
        </p>
      ) : (
        <div className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-border px-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span className="w-1.5 shrink-0" />
            <span className="min-w-0 flex-1">task</span>
            <span className="w-24 shrink-0 text-right">agent effort</span>
            <span className="w-20 shrink-0 text-right">tokens</span>
            <span className="w-14 shrink-0 text-right">cost</span>
            <span className="w-36 shrink-0 text-right">delivery</span>
            <span className="w-20 shrink-0 text-right">last activity</span>
          </div>
          {tasks.map((task) => {
            const outcome = taskOutcome(task);
            const lastActivity = Math.max(task.lastAgentAt ?? 0, task.lastQueueAt ?? 0);
            return (
              <div
                key={`${task.repoKey}:${task.branch}`}
                className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5"
              >
                <span className={`size-1.5 shrink-0 rounded-full ${outcomeDot(outcome)}`} />
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {task.repoLabel ? `${task.repoLabel} / ` : ""}
                  {task.branch}
                  {task.models && (
                    <span className="ml-2 text-[10px] text-muted-foreground">{task.models}</span>
                  )}
                </span>
                <span className="w-24 shrink-0 text-right text-[11px] text-muted-foreground">
                  {task.agentRuns > 0
                    ? `${task.agentRuns} runs · ${task.turns}t · ${task.toolCalls} tools`
                    : "queue only"}
                </span>
                <span
                  className="w-20 shrink-0 text-right text-[11px] text-muted-foreground"
                  title={`usage coverage ${task.runsWithUsage}/${task.instrumentedRuns}`}
                >
                  {fmtTokens(task.inputTokens)}/{fmtTokens(task.outputTokens)}
                </span>
                <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
                  {fmtCost(task.costUsd)}
                </span>
                <span
                  className={`w-36 shrink-0 text-right text-[11px] ${
                    outcome === "failed"
                      ? "text-destructive"
                      : outcome === "delivered"
                        ? "text-success"
                        : "text-muted-foreground"
                  }`}
                >
                  {outcomeLabel(task)}
                </span>
                <span className="w-20 shrink-0 text-right text-[10px] text-muted-foreground">
                  {lastActivity > 0 ? fmtWhen(lastActivity, now) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {digest && digest.failures.length > 0 && (
        <div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent failures
          </h3>
          {digest.failures.map((failure) => (
            <div
              key={`${failure.runId}:${failure.at}`}
              className="flex items-center gap-2 border-b border-border/50 px-2 py-1"
            >
              <span className="shrink-0 border border-border px-1 text-[10px] text-muted-foreground">
                {failure.kind}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {[failure.repoLabel, failure.branch].filter(Boolean).join("/")}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                {failure.detail}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/60">
                run {failure.runId.slice(0, 8)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
