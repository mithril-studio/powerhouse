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
    <div className="shrink-0 px-6 pt-1">
      <div className="chat-column connection-card" role="status">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={`ph-dot ${state === "starting" ? "bg-accent-brand animate-pulse" : state === "error" ? "bg-destructive" : "bg-muted-foreground"}`}
          />
          <p className="min-w-0 flex-1 truncate">{title}</p>
          {resumable && (
            <button disabled={state === "starting"} onClick={onResume} className="ph-btn h-7 px-2.5 text-xs">
              Resume
            </button>
          )}
          <button
            disabled={state === "starting"}
            onClick={onStartFresh}
            className={`ph-btn h-7 px-2.5 text-xs ${resumable ? "" : "ph-btn-primary"}`}
          >
            Start fresh
          </button>
        </div>
        {(error || diagnostics) && (
          <details className="mt-2 text-xs text-destructive">
            <summary className="cursor-default text-muted-foreground hover:text-foreground">Details</summary>
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono select-text">
              {[error, diagnostics.trim()].filter(Boolean).join("\n")}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
