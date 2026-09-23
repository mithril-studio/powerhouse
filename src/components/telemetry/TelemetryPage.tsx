import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store/appStore";
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
        className={`flex w-full items-center gap-2 border px-2 py-1 text-left text-[11px] ${
          failures.length > 0 ? "border-destructive text-destructive" : "border-border"
        }`}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            failures.length > 0 ? "bg-destructive" : "bg-success"
          }`}
        />
        <span className={failures.length > 0 ? "" : "text-muted-foreground"}>
          {failures.length > 0
            ? `${failures.length} invariant check${failures.length === 1 ? "" : "s"} failing`
            : `health: ${checks.filter((c) => c.status === "pass").length} checks passing`}
        </span>
        {heartbeat && (
          <span className="text-muted-foreground/70">· {heartbeat.detail}</span>
        )}
        <span className="ml-auto text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>
      {(open || failures.length > 0) && (
        <div className="border border-t-0 border-border px-2 py-1">
          {(open ? checks : failures).map((check) => (
            <div key={check.id} className="flex items-baseline gap-2 py-0.5">
              <span
                className={`text-[10px] ${
                  check.status === "fail"
                    ? "text-destructive"
                    : check.status === "pass"
                      ? "text-success"
                      : "text-muted-foreground"
                }`}
              >
                {check.status === "fail" ? "✗" : check.status === "pass" ? "✓" : "·"}
              </span>
              <span className="shrink-0 text-[11px] text-foreground">{check.label}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
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
    <div className="pi-card flex-1 px-3 py-2">
      <div className={`text-base ${alert ? "text-destructive" : "text-foreground"}`}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

export function TelemetryPage() {
  const open = useAppStore((s) => s.telemetryOpen);
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
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeTelemetry();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, closeTelemetry]);

  if (!open) return null;

  const loadOlder = () => {
    const oldest = runs[runs.length - 1];
    if (!oldest) return;
    telemetryListRuns(RUNS_PAGE, oldest.startedAt)
      .then((older) => setRuns((prev) => [...prev, ...older]))
      .catch(() => {});
  };

  return (
    <div className="fixed inset-y-0 right-0 left-60 z-40 flex flex-col border-l border-border bg-background">
      {/* Draggable title strip (traffic-light overlay) with a close affordance. */}
      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center justify-end px-3"
      >
        <button
          onClick={() => closeTelemetry()}
          title="Close telemetry"
          aria-label="Close telemetry"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-8 pb-16 pt-2">
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-foreground">Telemetry</h1>
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
              className="pi-btn text-[11px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Rebuild projections
            </button>
          </div>

          <div className="mb-4 flex gap-4 border-b border-border">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`-mb-px border-b pb-1.5 text-[11px] font-semibold uppercase tracking-wider ${
                  tab === t
                    ? "border-accent-brand text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {!unavailable && <HealthStrip checks={checks} />}

          {unavailable ? (
            <p className="text-xs text-muted-foreground">
              Telemetry database unavailable — check the dev console for details.
            </p>
          ) : tab === "Tasks" ? (
            <TasksView refreshKey={refreshKey} />
          ) : tab === "Proposals" ? (
            <ProposalsView refreshKey={refreshKey} />
          ) : (
            <>
              {stats && (
                <div className="mb-4 flex gap-2">
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
                  <h2 className="mb-1 border-b border-border pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                      className="pi-btn mt-2 text-[11px]"
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
