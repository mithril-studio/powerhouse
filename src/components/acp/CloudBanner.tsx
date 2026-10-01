import {
  bringCloudBack,
  isCloudBusy,
  openCloudShell,
  stopCloud,
  type CloudWorkspace,
} from "../../lib/cloud";

const LABEL: Record<CloudWorkspace["status"], string> = {
  creating: "Starting",
  ready: "Ready for your first message",
  running: "Agent working",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** Sits above the composer while the chat lives in the cloud. */
export function CloudBanner({ workspace }: { workspace: CloudWorkspace }) {
  const busy = isCloudBusy(workspace);
  const label = workspace.stage && busy ? workspace.stage : LABEL[workspace.status];
  const button =
    "h-6 shrink-0 border border-border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground";
  return (
    <div className="border-t border-border bg-background font-mono" aria-label="Cloud workspace">
      <div className="flex h-9 items-center gap-2 px-3">
        <p className="min-w-0 flex-1 truncate text-xs">
          <span className="mr-2 text-accent-brand">☁</span>
          <span className="text-foreground">{workspace.vmName}</span>
          <span className={`ml-2 ${busy ? "animate-pulse text-accent-brand" : workspace.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
            {label}
            {busy ? "…" : ""}
          </span>
        </p>
        {workspace.status === "running" && (
          <button onClick={() => void stopCloud(workspace)} title="Stop the cloud agent" className={button}>
            Stop
          </button>
        )}
        {workspace.status !== "creating" && (
          <button onClick={() => openCloudShell(workspace)} title="Open a shell on the cloud machine" className={button}>
            Open VM
          </button>
        )}
        <button
          onClick={() => void bringCloudBack(workspace)}
          title="Pull the branch, delete the cloud machine, and continue here"
          className={button}
        >
          Bring back local
        </button>
      </div>
      {workspace.status === "failed" && workspace.lastError && workspace.turn === 0 && (
        <p className="px-3 pb-2 text-xs text-destructive">{workspace.lastError}</p>
      )}
    </div>
  );
}
