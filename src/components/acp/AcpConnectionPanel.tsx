export type AcpConnectionState = "idle" | "starting" | "ready" | "error" | "exited";

interface Props {
  state: AcpConnectionState;
  agentName: string;
  resumable: boolean;
  error: string | null;
  diagnostics: string;
  onResume: () => void;
  onStartFresh: () => void;
}

const buttonClass =
  "h-7 border border-border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:border-accent-brand disabled:opacity-40";

export function AcpConnectionPanel({
  state,
  agentName,
  resumable,
  error,
  diagnostics,
  onResume,
  onStartFresh,
}: Props) {
  const title =
    state === "starting"
      ? `Starting ${agentName}…`
      : state === "exited"
        ? "Agent disconnected"
        : state === "error"
          ? "Could not start the agent"
          : "Agent is not running";

  return (
    <div className="border-t border-border bg-background font-mono">
      {/* Fixed-height base row so this bar lines up with the sidebar's Settings
          bar regardless of whether a Resume button is present. */}
      <div className="flex h-12 items-center justify-between gap-4 px-3">
        <p className="min-w-0 truncate text-xs text-foreground">
          <span className="mr-2 text-accent-brand">!</span>
          {title}
        </p>
        <div className="flex shrink-0 gap-2">
          {resumable && (
            <button disabled={state === "starting"} onClick={onResume} className={buttonClass}>
              Resume
            </button>
          )}
          <button
            disabled={state === "starting"}
            onClick={onStartFresh}
            className="h-7 border border-accent-brand/70 px-2 text-xs text-foreground hover:bg-muted disabled:opacity-40"
          >
            Start fresh
          </button>
        </div>
      </div>
      {(error || diagnostics) && (
        <details className="max-w-2xl px-3 pb-2 text-xs text-destructive">
          <summary className="cursor-default">Details</summary>
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
            {[error, diagnostics.trim()].filter(Boolean).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
