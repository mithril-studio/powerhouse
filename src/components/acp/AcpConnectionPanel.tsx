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
  "pi-btn h-8 text-xs";

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
    <div className="shrink-0 px-6 pb-5 pt-3">
      <div className="chat-column connection-card flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs text-foreground">
            <span className="mr-2 text-accent-brand">!</span>
            {title}
          </p>
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
            className="pi-btn pi-btn-primary h-8 text-xs"
          >
            {resumable ? "Start fresh" : `Start ${agentName}`}
          </button>
        </div>
      </div>
    </div>
  );
}
