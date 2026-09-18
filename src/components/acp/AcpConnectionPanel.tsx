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
  "h-8 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40";

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
    <div className="border-t border-border bg-card px-4 py-4">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium">{title}</p>
          {(error || diagnostics) && (
            <details className="mt-1 max-w-2xl text-xs text-destructive">
              <summary className="cursor-default">Details</summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
                {[error, diagnostics.trim()].filter(Boolean).join("\n")}
              </pre>
            </details>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {resumable && (
            <button disabled={state === "starting"} onClick={onResume} className={buttonClass}>
              Resume
            </button>
          )}
          <button
            disabled={state === "starting"}
            onClick={onStartFresh}
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            Start fresh
          </button>
        </div>
      </div>
    </div>
  );
}
