import { useEffect, useMemo, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { useAppStore, type Branch, type Repo } from "../store/appStore";
import {
  cloudCancel,
  cloudDiff,
  cloudForget,
  isRunActive,
  refreshCloudRun,
  type CloudRunRecord,
} from "../lib/cloud";
import { describeEvent, fmtAgo, latestActivity, presentRun, shortSha, type Tone } from "../lib/cloudView";
import { importCloudResult } from "../lib/actions";
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

export function CloudPane({ repo, branch }: { repo: Repo; branch?: Branch | null }) {
  const runs = useAppStore((s) => s.cloudRuns);
  const openCloudModal = useAppStore((s) => s.openCloudModal);
  const list = useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.repo_id === repo.id)
        .sort((a, b) => b.created_at_ms - a.created_at_ms),
    [runs, repo.id],
  );
  const sourcePath = branch?.worktreePath ?? repo.path;
  const sourceLabel = branch?.name ?? repo.defaultBranch;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3">
        <div className="mb-4 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{repo.name}</span>
          <button
            onClick={() => openCloudModal(repo.id, sourcePath, sourceLabel)}
            title={`Run a task in the cloud from ${sourceLabel}`}
            className="h-7 shrink-0 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Run in cloud
          </button>
        </div>
        {list.length === 0 ? (
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
    </div>
  );
}

function CloudRunCard({ record: r }: { record: CloudRunRecord }) {
  const [expanded, setExpanded] = useState(isRunActive(r));
  const [tab, setTab] = useState<"activity" | "checks" | "diff">("activity");
  const [busy, setBusy] = useState<string | null>(null);
  const p = presentRun(r);
  const active = isRunActive(r);
  const state = r.snapshot?.state ?? r.receipt?.state;
  const canCancel = r.phase === "accepted" && active && !r.snapshot?.cancel_requested;
  const canFetch = !!r.result?.published && !!r.result?.result_sha;
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
      const ok = await ask(
        active
          ? "This run may still be active. Forgetting it here does not stop it or delete the VM; you would lose the local record."
          : "Remove this run from the list? The VM, branch and artifacts are kept until you clean them up.",
        { title: "Forget cloud run", kind: "warning", okLabel: "Forget" },
      );
      if (!ok) return;
      await cloudForget(r.run_id, active);
      useAppStore.getState().removeCloudRun(r.run_id);
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

function Activity({ record: r }: { record: CloudRunRecord }) {
  const lines = useMemo(
    () =>
      r.events
        .map((e) => ({ seq: e.seq, ts: e.ts_ms, text: describeEvent(e) }))
        .filter((l): l is { seq: number; ts: number; text: string } => !!l.text)
        .slice(-200),
    [r.events],
  );
  if (lines.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">No events cached yet.</p>;
  }
  return (
    <div className="max-h-72 select-text overflow-y-auto rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
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
