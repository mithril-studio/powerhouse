import { useState } from "react";
import { useAppStore } from "../store/appStore";
import { importCloudResult } from "../lib/actions";
import { STATE_LABEL, latestActivity, shortSha } from "../lib/cloudView";
import type { CloudRunRecord } from "../lib/cloud";

/** Outcome dot colour by terminal run state. */
function toneClass(r: CloudRunRecord): string {
  const state = r.snapshot?.state ?? r.receipt?.state;
  if (state === "completed") return "text-success";
  if (state === "failed" || state === "blocked" || state === "interrupted") return "text-destructive";
  return "text-muted-foreground";
}

/** One line describing what integration did with the returned code. */
function integrationSentence(r: CloudRunRecord): string | null {
  const ret = r.returned;
  if (!ret) return null;
  if (ret.kind === "fast_forwarded")
    return `${r.source_branch ?? "Your branch"} fast-forwarded to ${shortSha(ret.sha)}.`;
  if (ret.kind === "diverged") return ret.reason;
  return null; // reported_only: nothing was integrated
}

/**
 * The card a finished cloud run posts back into the chat that sent it. It reads
 * the live record from the store by run id, so it stays current if the record
 * updates (e.g. a pending push finally lands).
 */
export function CloudResultCard({ runId, late }: { runId: string; late: boolean }) {
  const record = useAppStore((s) => s.cloudRuns[runId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState(false);

  if (!record) {
    return (
      <section className="border-l border-border py-1 pl-3 text-xs text-muted-foreground">
        Cloud run {shortSha(runId)} is no longer tracked.
      </section>
    );
  }

  const state = record.snapshot?.state ?? record.receipt?.state;
  const res = record.result;
  const diverged = record.returned?.kind === "diverged";
  const reportedOnly = record.returned?.kind === "reported_only";
  const integration = integrationSentence(record);
  const passed = res?.checks.filter((c) => c.status === "passed").length ?? 0;
  const err = record.snapshot?.error;
  const feedTail = latestActivity(record.events);

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      await importCloudResult(runId);
      setImported(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-border bg-card/60 px-3 py-2 text-xs" aria-label="Cloud run result">
      <header className="flex items-center gap-2">
        <span className={toneClass(record)} aria-hidden>
          ●
        </span>
        <span className="font-medium text-foreground">
          Cloud run {state ? STATE_LABEL[state] : "finished"}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          ☁ {shortSha(runId)}
          {late ? " · arrived while you were away" : ""}
        </span>
      </header>

      {res?.summary && (
        <p className="mt-2 whitespace-pre-wrap break-words text-foreground/90">{res.summary}</p>
      )}

      {res && res.checks_configured && res.checks.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {res.checks.map((c) => (
            <li key={c.name} className="flex items-center gap-2">
              <span className={c.status === "passed" ? "text-success" : "text-destructive"} aria-hidden>
                {c.status === "passed" ? "✓" : "×"}
              </span>
              <span className="text-muted-foreground">{c.name}</span>
            </li>
          ))}
        </ul>
      )}

      {res && (
        <p className="mt-2 text-muted-foreground">
          {res.checks_configured ? `${passed}/${res.checks.length} checks passed · ` : "No validation configured · "}
          {res.changed_files.length} file{res.changed_files.length === 1 ? "" : "s"} changed
        </p>
      )}

      {integration && (
        <p className={`mt-2 ${diverged ? "text-accent-brand" : "text-foreground/90"}`}>{integration}</p>
      )}

      {reportedOnly && (
        <>
          {err && (
            <p className="mt-2 text-destructive">
              {err.stage}: {err.message}
            </p>
          )}
          {feedTail && <p className="mt-1 text-muted-foreground">Last activity: {feedTail}</p>}
          <p className="mt-1 text-muted-foreground">
            Partial work is preserved in the cloud — open the Cloud tab to restore or discard it.
          </p>
        </>
      )}

      {record.return_error && (
        <p className="mt-2 text-accent-brand">{record.return_error}</p>
      )}

      {error && <p className="mt-2 text-destructive">{error}</p>}

      <div className="mt-2 flex gap-3">
        <button
          type="button"
          className="text-accent-brand hover:underline"
          onClick={() => useAppStore.getState().openRightTab("cloud")}
        >
          View diff
        </button>
        {diverged && (
          <button
            type="button"
            className="text-accent-brand hover:underline disabled:opacity-50"
            disabled={busy || imported || !!record.imported_worktree}
            onClick={() => void doImport()}
          >
            {imported || record.imported_worktree ? "Imported" : busy ? "Importing…" : "Import for review"}
          </button>
        )}
      </div>
    </section>
  );
}
