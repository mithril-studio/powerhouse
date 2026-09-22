import { useEffect, useState } from "react";
import {
  telemetryRunDetail,
  telemetryRunEvents,
  type RunDetail,
  type TelemetryEventRow,
  type ToolCallRow,
} from "../../lib/ipc";
import {
  coverageBadges,
  fmtCost,
  fmtDuration,
  fmtTokens,
  runStatus,
} from "../../lib/telemetryFormat";

const EVENT_PAGE = 100;

function toolDot(status: string | null) {
  switch (status) {
    case "completed":
      return "bg-success";
    case "failed":
      return "bg-destructive";
    case "in_progress":
      return "animate-pulse bg-accent-brand";
    default:
      return "bg-muted-foreground/40";
  }
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="truncate text-[11px] text-foreground">{value}</span>
    </div>
  );
}

function ToolRow({ tool, now }: { tool: ToolCallRow; now: number }) {
  const end = tool.endedAt ?? now;
  return (
    <div className="flex items-center gap-2 py-0.5 pl-4">
      <span className={`size-1 shrink-0 rounded-full ${toolDot(tool.status)}`} />
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {tool.title ?? tool.toolCallId}
      </span>
      {tool.kind && (
        <span className="shrink-0 text-[10px] text-muted-foreground/70">{tool.kind}</span>
      )}
      <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground">
        {fmtDuration(Math.max(0, end - tool.startedAt))}
      </span>
    </div>
  );
}

function Evidence({ runId, eventCount }: { runId: string; eventCount: number }) {
  const [events, setEvents] = useState<TelemetryEventRow[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  const loadMore = (after: number) => {
    telemetryRunEvents(runId, after, EVENT_PAGE)
      .then((page) => setEvents((prev) => (after === 0 ? page : [...prev, ...page])))
      .catch(() => {});
  };

  useEffect(() => {
    setEvents([]);
    setExpanded(null);
    loadMore(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const lastSeq = events[events.length - 1]?.seq ?? 0;
  return (
    <div className="flex flex-col">
      {events.map((event) => (
        <div key={event.seq} className="border-b border-border/50">
          <button
            type="button"
            onClick={() => setExpanded((cur) => (cur === event.seq ? null : event.seq))}
            className="flex w-full items-center gap-2 py-0.5 text-left hover:bg-muted/40"
          >
            <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground/60">
              {event.seq}
            </span>
            <span className="w-7 shrink-0 text-[10px] uppercase text-muted-foreground">
              {event.direction}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
              {event.method ?? ""}
              {event.updateKind ? ` · ${event.updateKind}` : ""}
            </span>
            {event.replayed && (
              <span className="shrink-0 text-[10px] text-muted-foreground/70">replayed</span>
            )}
            {event.truncated && (
              <span className="shrink-0 text-[10px] text-destructive">truncated</span>
            )}
            {event.parseStatus !== "ok" && (
              <span className="shrink-0 text-[10px] text-destructive">{event.parseStatus}</span>
            )}
          </button>
          {expanded === event.seq && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all bg-muted/30 p-2 text-[10px] text-muted-foreground">
              {event.rawPreview}
            </pre>
          )}
        </div>
      ))}
      {events.length < eventCount && (
        <button
          type="button"
          onClick={() => loadMore(lastSeq)}
          className="pi-btn mt-2 self-start text-[11px]"
        >
          Load more ({events.length}/{eventCount})
        </button>
      )}
    </div>
  );
}

export function RunDetailPane({ runId, refreshKey }: { runId: string; refreshKey: number }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const now = Date.now();

  useEffect(() => {
    telemetryRunDetail(runId)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [runId, refreshKey]);

  if (!detail) return null;
  const { run, turns, toolCalls } = detail;
  const maxTurnMs = Math.max(
    1,
    ...turns.map((t) => (t.endedAt ?? now) - t.startedAt),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="pi-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground">
            {run.agentName ?? run.source} run
          </span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {runStatus(run)}
          </span>
          {coverageBadges(run).map((badge) => (
            <span
              key={badge}
              className="border border-border px-1 text-[10px] text-muted-foreground"
            >
              {badge}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
          <Fact label="run id" value={run.runId.slice(0, 8)} />
          <Fact label="session" value={run.providerSessionId?.slice(0, 18) ?? "—"} />
          <Fact label="model" value={run.model ?? "—"} />
          <Fact label="mode" value={run.mode ?? "—"} />
          <Fact label="source" value={run.sourceSha?.slice(0, 10) ?? "—"} />
          <Fact
            label="tokens in/out"
            value={
              run.coverage === "instrumented"
                ? `${fmtTokens(run.inputTokens)} / ${fmtTokens(run.outputTokens)}`
                : "not instrumented"
            }
          />
          <Fact label="cached" value={fmtTokens(run.cachedTokens)} />
          <Fact label="cost" value={fmtCost(run.costUsd)} />
          <Fact
            label="duration"
            value={
              run.endedAt != null ? fmtDuration(run.endedAt - run.startedAt) : "running"
            }
          />
          <Fact label="exit" value={run.exitCode != null ? String(run.exitCode) : "—"} />
          <Fact label="events" value={String(detail.eventCount)} />
        </div>
      </div>

      {turns.length > 0 && (
        <div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Turns
          </h3>
          {turns.map((turn) => {
            const ms = (turn.endedAt ?? now) - turn.startedAt;
            const tools = toolCalls.filter((t) => t.turnIdx === turn.turnIdx);
            return (
              <div key={turn.turnIdx} className="border-b border-border/50 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-right text-[10px] text-muted-foreground/60">
                    #{turn.turnIdx + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                    {turn.promptPreview ?? "(no preview)"}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {turn.stopReason ?? (turn.endedAt == null ? "open" : "—")}
                  </span>
                  <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
                    {fmtDuration(Math.max(0, ms))}
                  </span>
                </div>
                <div className="ml-8 mt-1 h-0.5 bg-muted">
                  <div
                    className="h-full bg-accent-brand/60"
                    style={{ width: `${Math.max(2, (ms / maxTurnMs) * 100)}%` }}
                  />
                </div>
                {tools.map((tool) => (
                  <ToolRow key={tool.toolCallId} tool={tool} now={now} />
                ))}
              </div>
            );
          })}
          {/* Tool calls the projector couldn't tie to a turn still show. */}
          {toolCalls.some((t) => t.turnIdx == null) && (
            <div className="pt-1">
              {toolCalls
                .filter((t) => t.turnIdx == null)
                .map((tool) => (
                  <ToolRow key={tool.toolCallId} tool={tool} now={now} />
                ))}
            </div>
          )}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowEvidence((v) => !v)}
          className="pi-btn text-[11px]"
        >
          {showEvidence ? "Hide evidence" : `Evidence (${detail.eventCount} events)`}
        </button>
        {showEvidence && (
          <div className="mt-2">
            <Evidence runId={runId} eventCount={detail.eventCount} />
          </div>
        )}
      </div>
    </div>
  );
}
