import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { cloudSettingsOf, useAppStore, type Branch, type Repo } from "../store/appStore";
import {
  cloudCancel,
  cloudDiff,
  cloudForget,
  cloudInventory,
  cloudRelease,
  cloudRestore,
  holdsResources,
  isRunActive,
  refreshCloudRun,
  runLifecycleTick,
  type CloudRunRecord,
  type Inventory,
} from "../lib/cloud";
import { describeEvent, fmtAgo, latestActivity, presentMachine, presentRun, shortSha, type Tone } from "../lib/cloudView";
import { importCloudResult } from "../lib/actions";
import { quickSubmit } from "../lib/quickSubmit";
import { DiffView } from "./DiffView";

function dot(tone: Tone) {
  switch (tone) {
    case "live":
      return "animate-pulse bg-accent-brand";
    case "ok":
      return "bg-success";
    case "bad":
      return "bg-destructive";
    case "warn":
      return "bg-accent-brand/60";
    default:
      return "bg-muted-foreground/40";
  }
}

const QUICK_STAGES = ["checkpointing", "pushing", "submitting"] as const;

/** Staged progress for a one-click submit that has no run record yet. */
function QuickSubmitCard({ branch, stage }: { branch: string; stage: string }) {
  const at = QUICK_STAGES.indexOf(stage as (typeof QUICK_STAGES)[number]);
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${dot("live")}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">Sending {branch} to cloud</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 pl-4 text-[11px]">
        {QUICK_STAGES.map((s, i) => (
          <span
            key={s}
            className={
              i < at
                ? "text-muted-foreground line-through decoration-muted-foreground/40"
                : i === at
                  ? "animate-pulse text-accent-brand"
                  : "text-muted-foreground/60"
            }
          >
            {s}
            {i < QUICK_STAGES.length - 1 ? " →" : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

export function CloudPane({ repo, branch }: { repo: Repo; branch?: Branch | null }) {
  const runs = useAppStore((s) => s.cloudRuns);
  const quickStages = useAppStore((s) => s.cloudQuickStages);
  const quickErrors = useAppStore((s) => s.cloudQuickErrors);
  const setCloudQuickError = useAppStore((s) => s.setCloudQuickError);
  const pending = useMemo(
    () =>
      Object.entries(quickStages)
        .filter(([k]) => k.startsWith(`${repo.id}:`))
        .map(([k, stage]) => ({ branch: k.slice(repo.id.length + 1), stage })),
    [quickStages, repo.id],
  );
  const failures = useMemo(
    () =>
      Object.entries(quickErrors)
        .filter(([k]) => k.startsWith(`${repo.id}:`))
        .map(([k, reason]) => ({ branch: k.slice(repo.id.length + 1), reason })),
    [quickErrors, repo.id],
  );
  const list = useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.repo_id === repo.id)
        .sort((a, b) => b.created_at_ms - a.created_at_ms),
    [runs, repo.id],
  );
  const sourcePath = branch?.worktreePath ?? repo.path;
  const sourceLabel = branch?.name ?? repo.defaultBranch;
  const settings = useAppStore((s) => s.settings);
  const cloud = cloudSettingsOf(settings);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const loadInventory = useCallback(async () => {
    setInventoryBusy(true);
    try {
      setInventory(await cloudInventory(cloud.baseSnapshot, cloud.machineCeiling));
      setInventoryError(null);
    } catch (e) {
      setInventoryError(String(e));
    } finally {
      setInventoryBusy(false);
    }
  }, [cloud.baseSnapshot, cloud.machineCeiling]);
  // Machine states change on lifecycle events; refresh the footer when any run's machine changes.
  const machineKey = useMemo(() => list.map((r) => `${r.run_id}:${r.machine}:${r.vm_released}:${r.park_snapshot?.name ?? ""}`).join("|"), [list]);
  useEffect(() => {
    void loadInventory();
  }, [loadInventory, machineKey]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-4 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{repo.name}</span>
          <button
            onClick={() => void quickSubmit(repo, sourcePath, sourceLabel)}
            title={`Send ${sourceLabel} to the cloud: checkpoint, push, and run the plan doc on a boxd VM`}
            className="h-7 shrink-0 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Send to cloud
          </button>
        </div>
        {failures.map((f) => (
          <div key={f.branch} className="mb-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-destructive">
                <span className="font-mono">{f.branch}</span> was not sent: {f.reason}
              </p>
              <button
                onClick={() => setCloudQuickError(repo.id, f.branch, null)}
                title="Dismiss"
                className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground"
              >
                ×
              </button>
            </div>
            <p className="mt-1 text-muted-foreground">
              Credentials and run defaults live in Settings; per-repo env vars in the repo's workflow settings.
            </p>
          </div>
        ))}
        {pending.length > 0 && (
          <div className="mb-2 space-y-2">
            {pending.map((p) => (
              <QuickSubmitCard key={p.branch} branch={p.branch} stage={p.stage} />
            ))}
          </div>
        )}
        {list.length === 0 && pending.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No cloud runs yet. A cloud run checks out a pushed commit on an isolated boxd VM, lets the agent work
            unattended, runs your checks, and publishes a branch for review.
          </p>
        ) : (
          <div className="space-y-2">
            {list.map((r) => (
              <CloudRunCard key={r.run_id} record={r} />
            ))}
          </div>
        )}
      </div>
      <InventoryFooter inventory={inventory} error={inventoryError} busy={inventoryBusy} onRefresh={() => void loadInventory()} />
    </div>
  );
}

/** What Powerhouse holds in boxd right now, against the org's machine slots. */
function InventoryFooter({
  inventory,
  error,
  busy,
  onRefresh,
}: {
  inventory: Inventory | null;
  error: string | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="font-semibold uppercase tracking-wider">boxd</span>
        {inventory ? (
          <span>
            {inventory.total_machines}/{inventory.org_slots} machines in the org (ceiling {inventory.ceiling}) ·{" "}
            {inventory.machines.length} Powerhouse VM{inventory.machines.length === 1 ? "" : "s"} · {inventory.snapshots.length} snapshot
            {inventory.snapshots.length === 1 ? "" : "s"}
          </span>
        ) : error ? (
          <span className="truncate text-destructive" title={error}>
            unavailable
          </span>
        ) : (
          <span>loading…</span>
        )}
        <button
          onClick={onRefresh}
          disabled={busy}
          title="Refresh boxd inventory"
          className="ml-auto h-5 rounded-md px-1.5 hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          ↻
        </button>
      </div>
      {inventory && (inventory.machines.length > 0 || inventory.snapshots.length > 0) && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
          {inventory.machines.map((m) => (
            <span key={`m-${m.name}`} title={`machine · ${m.status}`}>
              {m.name} <span className="text-muted-foreground/60">{m.status}</span>
            </span>
          ))}
          {inventory.snapshots.map((s) => (
            <span key={`s-${s.name}`} title={`snapshot · ${s.status}`}>
              {s.name} <span className="text-muted-foreground/60">{s.version ?? ""} {s.size ?? ""}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CloudRunCard({ record: r }: { record: CloudRunRecord }) {
  const [expanded, setExpanded] = useState(isRunActive(r));
  const [tab, setTab] = useState<"activity" | "checks" | "diff">("activity");
  const [busy, setBusy] = useState<string | null>(null);
  const p = presentRun(r);
  const m = presentMachine(r);
  const active = isRunActive(r);
  const state = r.snapshot?.state ?? r.receipt?.state;
  const canCancel = r.phase === "accepted" && active && !r.snapshot?.cancel_requested;
  // A result equal to the source commit made no changes: there is no output
  // branch on the remote to fetch, so don't offer an import that would 404.
  const noResultChanges = !!r.result?.result_sha && r.result.result_sha === r.manifest.source.commit_sha;
  const canFetch = !!r.result?.published && !!r.result?.result_sha && !noResultChanges;
  const held = holdsResources(r);
  const canDiscard = held && !active && r.machine !== "restoring" && r.machine !== "provisioning";
  const canRestore = r.machine === "parked";
  const activity = latestActivity(r.events);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      await message(String(e), { title: label, kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const cancel = () =>
    run("Cancel run", async () => {
      const ok = await ask(
        "Cancel this cloud run? The agent and its checks will be stopped in the VM. Partial work stays on the VM.",
        { title: "Cancel cloud run", kind: "warning", okLabel: "Cancel run" },
      );
      if (!ok) return;
      useAppStore.getState().setCloudRun(await cloudCancel(r.run_id));
    });

  const forget = () =>
    run("Forget run", async () => {
      if (held) {
        const discard = await ask(
          "This run still holds a VM or snapshot in boxd. Discard its workspace first? Nothing would be left behind; the published branch (if any) stays on the remote.",
          { title: "Discard before forgetting", kind: "warning", okLabel: "Discard workspace" },
        );
        if (!discard) return;
        useAppStore.getState().setCloudRun(await cloudRelease(r.run_id));
      }
      const ok = await ask(
        active
          ? "This run may still be active. Forgetting it here does not stop it; you would lose the local record."
          : "Remove this run from the list? The published branch stays on the remote until you delete it.",
        { title: "Forget cloud run", kind: "warning", okLabel: "Forget" },
      );
      if (!ok) return;
      await cloudForget(r.run_id, active);
      useAppStore.getState().removeCloudRun(r.run_id);
    });

  const discard = () =>
    run("Discard workspace", async () => {
      const ok = await ask(
        r.machine === "parked"
          ? "Delete this run's park snapshot? The workspace on it cannot be restored afterwards."
          : "Destroy this run's VM (and park snapshot, if any)? Partial work on the VM is lost; the published branch stays on the remote.",
        { title: "Discard workspace", kind: "warning", okLabel: "Discard" },
      );
      if (!ok) return;
      useAppStore.getState().setCloudRun(await cloudRelease(r.run_id));
      void runLifecycleTick();
    });

  const restore = () =>
    run("Restore", async () => {
      useAppStore.getState().setCloudRun(await cloudRestore(r.run_id));
    });

  return (
    <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${dot(p.tone)}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs" title={r.manifest.task.text}>
          {r.manifest.task.text.split("\n")[0]}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{p.label}</span>
        <button
          onClick={() => setExpanded((e) => !e)}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-input hover:text-foreground"
        >
          {expanded ? "⌄" : "›"}
        </button>
      </div>
      <p className="mt-1 truncate text-[11px] text-muted-foreground">
        <span className="font-mono">{r.source_branch ?? "detached"}@{shortSha(r.manifest.source.commit_sha)}</span>
        {r.task_vm && (
          <>
            {" · "}
            <span className="font-mono">{r.task_vm.name}</span>
          </>
        )}
        {" · "}
        {fmtAgo(r.created_at_ms)}
        {r.snapshot && ` · synced ${fmtAgo(r.snapshot.updated_at_ms)}`}
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground" title={m.detail ?? undefined}>
        <span className={`size-1.5 shrink-0 rounded-full ${dot(m.tone)}`} aria-hidden />
        <span>{m.label}</span>
        {m.detail && <span className="min-w-0 truncate text-muted-foreground/70">· {m.detail}</span>}
      </p>
      {p.detail && (
        <p className={`mt-1 select-text whitespace-pre-wrap text-xs ${p.tone === "bad" ? "text-destructive" : "text-muted-foreground"}`}>
          {p.detail}
        </p>
      )}
      {active && activity && p.detached && (
        <p className="mt-1 truncate text-xs text-foreground/80" title={activity}>
          {activity}
        </p>
      )}
      {r.result?.summary && !active && (
        <p className="mt-2 select-text whitespace-pre-wrap text-xs">
          <span className="text-muted-foreground">Agent summary (unverified): </span>
          {r.result.summary}
        </p>
      )}
      {noResultChanges && r.result?.published && !active && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          No changes to fetch — the result matches your source commit ({shortSha(r.manifest.source.commit_sha)}).
        </p>
      )}
      {r.result && r.result.concerns.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {r.result.concerns.map((c, i) => (
            <li key={i}>⚠ {c}</li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {canFetch && (
          <button
            onClick={() => void run("Fetch changes", () => importCloudResult(r.run_id))}
            disabled={!!busy || !!r.imported_worktree}
            title={r.imported_worktree ? `Imported to ${r.imported_worktree}` : `Fetch ${shortSha(r.result?.result_sha)} into a new local worktree`}
            className="h-7 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all active:translate-y-px disabled:opacity-50"
          >
            {r.imported_worktree ? "Fetched" : busy === "Fetch changes" ? "Fetching…" : "Fetch changes"}
          </button>
        )}
        {canCancel && (
          <button
            onClick={() => void cancel()}
            disabled={!!busy}
            className="h-7 rounded-lg border border-border px-3 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        {canRestore && (
          <button
            onClick={() => void restore()}
            disabled={!!busy}
            title="Create a VM from the park snapshot to inspect the workspace (held for an hour, then parked again)"
            className="h-7 rounded-lg border border-border px-3 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {busy === "Restore" ? "Restoring…" : "Restore"}
          </button>
        )}
        {canDiscard && (
          <button
            onClick={() => void discard()}
            disabled={!!busy}
            title="Remove this run's VM and park snapshot from boxd"
            className="h-7 rounded-lg border border-border px-3 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
          >
            {busy === "Discard workspace" ? "Discarding…" : "Discard workspace"}
          </button>
        )}
        {r.phase === "accepted" && (
          <button
            onClick={() => void run("Refresh", () => refreshCloudRun(r.run_id))}
            disabled={!!busy}
            title="Ask the runner for the current state"
            className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            ↻ Refresh
          </button>
        )}
        <button
          onClick={() => void forget()}
          disabled={!!busy}
          className="ml-auto h-7 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          Forget
        </button>
      </div>

      {expanded && r.phase === "accepted" && (
        <div className="mt-3 border-t border-border pt-2">
          <div className="mb-1.5 flex gap-1">
            {(["activity", "checks", "diff"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`h-6 rounded-md px-2 text-[11px] ${
                  tab === t ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {t === "activity" ? `Activity (${r.events.length})` : t === "checks" ? "Checks" : "Diff"}
              </button>
            ))}
            {state && <span className="ml-auto self-center font-mono text-[10px] text-muted-foreground">{state}</span>}
          </div>
          {tab === "activity" && <Activity record={r} />}
          {tab === "checks" && <Checks record={r} />}
          {tab === "diff" && <Diff record={r} />}
        </div>
      )}
    </div>
  );
}

/** The live feed: cached runner events as a scrolling log that follows the
 * tail while the reader stays at the bottom (scrolling up stops the follow). */
function Activity({ record: r }: { record: CloudRunRecord }) {
  const lines = useMemo(
    () =>
      r.events
        .map((e) => ({ seq: e.seq, ts: e.ts_ms, text: describeEvent(e) }))
        .filter((l): l is { seq: number; ts: number; text: string } => !!l.text)
        .slice(-500),
    [r.events],
  );
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastSeq = lines.length ? lines[lines.length - 1].seq : 0;
  useEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lastSeq]);
  if (lines.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">No events cached yet.</p>;
  }
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-72 select-text overflow-y-auto rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
    >
      {lines.map((l) => (
        <div key={l.seq} className="flex gap-2">
          <span className="shrink-0 text-muted-foreground/50">{new Date(l.ts).toLocaleTimeString()}</span>
          <span className="min-w-0 break-words">{l.text}</span>
        </div>
      ))}
      {r.event_cursor < (r.snapshot?.last_event_seq ?? 0) && (
        <p className="mt-1 text-muted-foreground/60">
          {(r.snapshot?.last_event_seq ?? 0) - r.event_cursor} more events on the VM — refreshing…
        </p>
      )}
    </div>
  );
}

function Checks({ record: r }: { record: CloudRunRecord }) {
  const res = r.result;
  if (!res) return <p className="py-2 text-xs text-muted-foreground">Checks appear once the run has a result.</p>;
  if (!res.checks_configured) return <p className="py-2 text-xs text-muted-foreground">No validation configured for this run.</p>;
  return (
    <div className="space-y-1">
      {res.tree_changed_after_checks && (
        <p className="text-xs text-destructive">Tracked files changed while checks ran; the published revision is the tree that was tested.</p>
      )}
      {res.checks.map((c, i) => (
        <details key={i} className="rounded-md bg-background/60 px-2 py-1">
          <summary className="flex cursor-default items-center gap-2 text-xs">
            <span
              className={`size-1.5 shrink-0 rounded-full ${
                c.status === "passed" ? "bg-success" : c.status === "failed" ? "bg-destructive" : "bg-muted-foreground/30"
              }`}
            />
            <span className="min-w-0 flex-1 truncate">{c.name || c.command}</span>
            <span className={`font-mono text-[11px] ${c.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
              {c.status}
              {c.exit_code != null && c.status === "failed" ? ` · exit ${c.exit_code}` : ""}
              {c.duration_ms != null ? ` · ${(c.duration_ms / 1000).toFixed(1)}s` : ""}
            </span>
          </summary>
          <pre className="mt-1 max-h-48 select-text overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
            {c.output_truncated ? "… (truncated)\n" : ""}
            {c.output_tail || "no output"}
          </pre>
        </details>
      ))}
    </div>
  );
}

function Diff({ record: r }: { record: CloudRunRecord }) {
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const available = !!r.result?.result_sha;
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    cloudDiff(r.run_id)
      .then((d) => {
        if (cancelled) return;
        setPatch(d.patch);
        setTruncated(d.truncated);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [r.run_id, available]);
  if (!available) return <p className="py-2 text-xs text-muted-foreground">The diff appears once a result revision exists.</p>;
  if (error) return <p className="select-text py-2 font-mono text-xs text-destructive">{error}</p>;
  if (patch === null) return <p className="py-2 text-xs text-muted-foreground">Loading diff from the VM…</p>;
  if (!patch) return <p className="py-2 text-xs text-muted-foreground">No changes: the result revision equals the source.</p>;
  return (
    <div className="max-h-96 overflow-auto rounded-md bg-background/60 py-1">
      {truncated && <p className="px-2 text-[11px] text-muted-foreground">Diff truncated; fetch the branch for the full change.</p>}
      <DiffView diff={patch} />
    </div>
  );
}
