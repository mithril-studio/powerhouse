import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { cloudKeepSessionLocal, isTerminal } from "../../lib/cloud";
import { latestActivity, presentRun } from "../../lib/cloudView";

interface Props {
  runId: string;
}

/** Takes the composer's place while the conversation runs in the cloud. */
export function AcpCloudPanel({ runId }: Props) {
  const run = useAppStore((state) => state.cloudRuns[runId]);
  const setCloudRun = useAppStore((state) => state.setCloudRun);
  const [error, setError] = useState<string | null>(null);
  if (!run) return null;
  const view = presentRun(run);
  const activity = latestActivity(run.events);
  const state = run.snapshot?.state ?? run.receipt?.state;
  // Finished in the cloud: the chat is on its way back (or stuck; offer out).
  const finished = run.phase === "accepted" && state != null && isTerminal(state);

  const keepLocal = async () => {
    setError(null);
    try {
      setCloudRun(await cloudKeepSessionLocal(runId));
    } catch (cause) {
      setError(String(cause));
    }
  };

  return (
    <div className="border-t border-border bg-background font-mono">
      <div className="flex h-12 items-center justify-between gap-4 px-3">
        <p className="min-w-0 truncate text-xs text-foreground">
          <span className="mr-2 text-accent-brand">☁</span>
          {finished ? "Bringing this chat back from the cloud…" : `In the cloud · ${view.label}`}
          {activity && !finished && (
            <span className="ml-2 text-muted-foreground">{activity}</span>
          )}
        </p>
        {finished && (
          <button
            onClick={() => void keepLocal()}
            title="Unlock this chat with the conversation as it was when it was sent"
            className="h-7 shrink-0 border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Continue here instead
          </button>
        )}
      </div>
      {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
