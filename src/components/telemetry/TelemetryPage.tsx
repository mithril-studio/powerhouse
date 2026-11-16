import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store/appStore";
import { ChevronDownIcon } from "../ui/icons";
import {
  telemetryListRuns,
  telemetryRebuild,
  telemetrySelfcheck,
  telemetryStats,
  type CheckResult,
  type RunSummary,
  type TelemetryStats,
} from "../../lib/ipc";
import { fmtCost, fmtTokens, usageCoveragePct } from "../../lib/telemetryFormat";
import { RunsTable } from "./RunsTable";
import { RunDetailPane } from "./RunDetailPane";
import { TasksView } from "./TasksView";
import { ProposalsView } from "./ProposalsView";

const RUNS_PAGE = 50;
const REFETCH_DEBOUNCE_MS = 750;

const TABS = ["Runs", "Tasks", "Proposals"] as const;
type Tab = (typeof TABS)[number];

/** Re-runs on every event batch while the page is open: manual testing
 *  doubles as a soak test, and any invariant drift turns red immediately. */
function HealthStrip({ checks }: { checks: CheckResult[] }) {
  const [open, setOpen] = useState(false);
  if (checks.length === 0) return null;
  const failures = checks.filter((c) => c.status === "fail");
  const heartbeat = checks.find((c) => c.id === "freshness");
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex h-8 w-full items-center gap-2 border px-3 text-left text-xs ${
          open || failures.length > 0 ? "rounded-t-[var(--radius)]" : "rounded-[var(--radius)]"
        } ${failures.length > 0 ? "border-destructive/60 text-destructive" : "border-border hover:bg-accent"}`}
      >
        <span
          className={`ph-dot bg-current ${failures.length > 0 ? "" : "tone-running"}`}
          aria-hidden
        />
        <span className={failures.length > 0 ? "" : "text-muted-foreground"}>
          {failures.length > 0
            ? `${failures.length} invariant check${failures.length === 1 ? "" : "s"} failing`
            : `${checks.filter((c) => c.status === "pass").length} health checks passing`}
        </span>
        {heartbeat && (
          <span className="text-muted-foreground/70">· {heartbeat.detail}</span>
        )}
        <ChevronDownIcon className={`ml-auto size-3.5 text-muted-foreground ${open ? "" : "-rotate-90"}`} />
      </button>
      {(open || failures.length > 0) && (
        <div className="rounded-b-[var(--radius)] border border-t-0 border-border px-3 py-1.5">
          {(open ? checks : failures).map((check) => (
            <div key={check.id} className="flex items-baseline gap-2 py-0.5">
              <span
                className={`text-xs ${
                  check.status === "fail"
                    ? "text-destructive"
                    : check.status === "pass"
                      ? "text-success"
                      : "text-muted-foreground"
                }`}
              >
                {check.status === "fail" ? "✗" : check.status === "pass" ? "✓" : "·"}
              </span>
              <span className="shrink-0 text-xs text-foreground">{check.label}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {check.detail}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-[var(--radius)] border border-border bg-card px-3 py-2">
      <div title={value} className={`truncate font-mono text-[15px] tabular-nums ${alert ? "text-destructive" : "text-foreground"}`}>
        {value}
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

/** Telemetry lives in Settings (`embedded`); the overlay form is kept for tests/legacy callers. */
export function TelemetryPage({ embedded = false }: { embedded?: boolean } = {}) {
  const open = useAppStore((s) => s.telemetryOpen) || embedded;
  const closeTelemetry = useAppStore((s) => s.closeTelemetry);

  const [tab, setTab] = useState<Tab>("Runs");
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [stats, setStats] = useState<TelemetryStats | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const debounceRef = useRef<number | null>(null);

  const refetch = useCallback(() => {
    Promise.all([telemetryStats(), telemetryListRuns(RUNS_PAGE), telemetrySelfcheck()])
      .then(([nextStats, nextRuns, nextChecks]) => {
        setStats(nextStats);
        setRuns(nextRuns);
        setChecks(nextChecks);
        setUnavailable(false);
        setRefreshKey((k) => k + 1);
      })
      .catch(() => setUnavailable(true));
  }, []);

  useEffect(() => {
    if (!open) return;
    refetch();
    const unlisten = listen<string>("telemetry-updated", () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        refetch();
      }, REFETCH_DEBOUNCE_MS);
    });
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      void unlisten.then((fn) => fn());
    };
  }, [open, refetch]);

  useEffect(() => {
    if (!open || embedded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeTelemetry();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, embedded, closeTelemetry]);

  if (!open) return null;

  const loadOlder = () => {
    const oldest = runs[runs.length - 1];
    if (!oldest) return;
    telemetryListRuns(RUNS_PAGE, oldest.startedAt)
      .then((older) => setRuns((prev) => [...prev, ...older]))
      .catch(() => {});
  };

  return (
    <div className={embedded ? "contents" : "fixed inset-y-0 right-0 left-60 z-40 flex flex-col border-l border-border bg-background"}>
      {!embedded && <div data-tauri-drag-region className="h-11 shrink-0 px-3" />}

      <div className={embedded ? "contents" : "flex-1 overflow-y-auto"}>
        <div className={embedded ? "pt-6" : "mx-auto w-full max-w-5xl px-8 pb-16 pt-2"}>
          {!embedded && (
            <div className="ph-page-header mx-0 mb-6 pt-0">
              <h1 className="ph-page-title">Telemetry</h1>
            </div>
          )}

          <div className="mb-4 flex h-10 items-stretch gap-3 border-b border-border">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                data-active={tab === t}
                className="ph-tab px-1 text-[13px]"
              >
                {t}
              </button>
            ))}
            <span className="flex-1" />
            <button
              type="button"
              disabled={(stats?.activeRuns ?? 0) > 0}
              onClick={() => {
                telemetryRebuild()
                  .then(() => refetch())
                  .catch(() => {});
              }}
              title={
                (stats?.activeRuns ?? 0) > 0
                  ? "Wait for active runs to finish before rebuilding"
                  : "Wipe projections and re-derive them from raw events"
              }
              className="ph-btn ph-btn-ghost h-7 self-center px-2.5 text-xs"
            >
              Rebuild projections
            </button>
          </div>

          {!unavailable && <HealthStrip checks={checks} />}

          {unavailable ? (
            <p className="ph-hint">
              Telemetry database unavailable — check the dev console for details.
            </p>
          ) : tab === "Tasks" ? (
            <TasksView refreshKey={refreshKey} />
          ) : tab === "Proposals" ? (
            <ProposalsView refreshKey={refreshKey} />
          ) : (
            <>
              {stats && (
                <div className="mb-4 grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
                  <StatTile label="runs" value={String(stats.totalRuns)} />
                  <StatTile label="active" value={String(stats.activeRuns)} />
                  <StatTile
                    label="failed"
                    value={String(stats.failedRuns + stats.interruptedRuns)}
                    alert={stats.failedRuns + stats.interruptedRuns > 0}
                  />
                  <StatTile label="turns" value={String(stats.totalTurns)} />
                  <StatTile label="tool calls" value={String(stats.totalToolCalls)} />
                  <StatTile
                    label="tokens in/out"
                    value={`${fmtTokens(stats.inputTokens)}/${fmtTokens(stats.outputTokens)}`}
                  />
                  <StatTile label="cost" value={fmtCost(stats.costUsd)} />
                  <StatTile
                    label="usage coverage"
                    value={usageCoveragePct(stats.instrumentedRuns, stats.runsWithUsage)}
                  />
                  {(stats.droppedEvents > 0 || stats.parseErrors > 0) && (
                    <StatTile
                      label="dropped / unparsed"
                      value={`${stats.droppedEvents}/${stats.parseErrors}`}
                      alert
                    />
                  )}
                </div>
              )}

              <div className="flex gap-6">
                <div className="min-w-0 flex-1">
                  <h2 className="ph-section-label mb-2">
                    Runs
                  </h2>
                  <RunsTable
                    runs={runs}
                    selected={selected}
                    onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
                    now={Date.now()}
                  />
                  {runs.length >= RUNS_PAGE && (
                    <button
                      type="button"
                      onClick={loadOlder}
                      className="ph-btn mt-2 h-7 px-2.5 text-xs"
                    >
                      Load older runs
                    </button>
                  )}
                </div>
                {selected && (
                  <div className="w-[26rem] shrink-0">
                    <RunDetailPane runId={selected} refreshKey={refreshKey} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
