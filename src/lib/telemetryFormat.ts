// Pure display helpers for the telemetry view. The load-bearing rule lives
// here: unknown usage renders as "—" and must never be shown as 0.
import type { DigestReport, MetricSample, RunSummary, TaskRow } from "./ipc";

export type RunStatus = "running" | "ok" | "failed" | "killed" | "interrupted";

export function runStatus(run: RunSummary): RunStatus {
  if (run.endReason === "interrupted") return "interrupted";
  if (run.endedAt == null && run.endReason == null) return "running";
  if (run.endReason === "killed" || run.endReason === "app-shutdown") return "killed";
  if (run.exitCode != null && run.exitCode !== 0) return "failed";
  return "ok";
}

/** Badges surfacing evidence gaps — shown, never hidden. */
export function coverageBadges(run: RunSummary): string[] {
  const badges: string[] = [];
  if (run.coverage !== "instrumented") badges.push(run.coverage);
  if (run.endReason === "interrupted") badges.push("interrupted");
  if (run.resumed) badges.push("resumed");
  if (run.droppedEvents > 0) badges.push(`${run.droppedEvents} dropped`);
  if (run.parseErrors > 0) badges.push(`${run.parseErrors} unparsed`);
  return badges;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtCost(cost: number | null | undefined): string {
  if (cost == null) return "—";
  return `$${cost.toFixed(cost < 0.1 ? 4 : 2)}`;
}

/** Share of instrumented runs that produced any usage evidence. */
export function usageCoveragePct(instrumented: number, withUsage: number): string {
  if (instrumented === 0) return "—";
  return `${Math.round((withUsage / instrumented) * 100)}%`;
}

/** Delivery truth for a task: only a merge counts as delivered. */
export type TaskOutcome = "delivered" | "failed" | "unattempted";

export function taskOutcome(task: TaskRow): TaskOutcome {
  if (task.delivered) return "delivered";
  if (task.queueAttempts > 0) return "failed";
  return "unattempted";
}

/** "42% (n=12)" — a rate is meaningless without its denominator. */
export function fmtMetricSample(sample: MetricSample | null | undefined): string {
  if (!sample || sample.value == null) return `— (n=${sample?.n ?? 0})`;
  return `${(sample.value * 100).toFixed(0)}% (n=${sample.n})`;
}

/**
 * The compact failure digest as markdown — the evidence bundle a future
 * learning loop (or a human review) consumes. Every unknown stays "—" and
 * every failure item cites its run id.
 */
export function digestToMarkdown(digest: DigestReport): string {
  const iso = new Date(digest.generatedAt).toISOString();
  const lines = [
    `# Powerhouse telemetry digest — last ${digest.windowDays}d`,
    ``,
    `Generated ${iso}. Delivery = merged via queue; a rejected attempt never counts.`,
    ``,
    `## Tasks (repo+branch)`,
    `- total: ${digest.tasksTotal}, delivered: ${digest.tasksDelivered}, failed: ${digest.tasksFailed}, unattempted: ${digest.tasksUnattempted}`,
    ``,
    `## Agent activity`,
    `- runs: ${digest.agentRuns} (${digest.interruptedRuns} interrupted, ${digest.uninstrumentedRuns} uninstrumented)`,
    `- turns closed: ${digest.closedTurns}, error turns: ${digest.errorTurns}`,
    `- tool calls: ${digest.toolCalls}, failed: ${digest.toolFailures}`,
    ``,
    `## Usage (coverage: ${digest.runsWithUsage}/${digest.instrumentedRuns} instrumented runs reported usage)`,
    `- tokens in/out: ${fmtTokens(digest.inputTokens)}/${fmtTokens(digest.outputTokens)}, cost: ${fmtCost(digest.costUsd)}`,
    `- evidence gaps: ${digest.droppedEvents} dropped events, ${digest.parseErrors} unparsed lines`,
  ];
  if (digest.failures.length > 0) {
    lines.push(``, `## Failures (${digest.failures.length} most recent, run ids cited)`);
    for (const failure of digest.failures) {
      const where = [failure.repoLabel, failure.branch].filter(Boolean).join("/");
      lines.push(
        `- [${failure.kind}] ${where || "unknown"}: ${failure.detail} (run ${failure.runId.slice(0, 8)})`,
      );
    }
  }
  return lines.join("\n");
}

export function fmtWhen(ts: number, now: number): string {
  const delta = now - ts;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
