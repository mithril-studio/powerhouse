import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export interface PendingPermission {
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
}

export function AcpPermissionCard({
  permission,
  onResolve,
  autoFocus = true,
}: {
  permission: PendingPermission;
  autoFocus?: boolean;
  onResolve: (response: RequestPermissionResponse) => void;
}) {
  return (
    <section className="shrink-0 px-6 py-2" aria-label="Permission request">
      <div className="chat-column permission-card">
        <p className="text-xs text-accent-brand">Approval needed</p>
        <p className="mt-1 text-xs text-foreground">{permission.request.toolCall.title}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {permission.request.options.map((option, index) => (
            <button
              key={option.optionId}
              autoFocus={autoFocus && index === 0}
              onClick={() =>
                onResolve({ outcome: { outcome: "selected", optionId: option.optionId } })
              }
              className={`pi-btn h-8 text-xs ${
                option.kind.startsWith("reject")
                  ? "border-border text-muted-foreground hover:text-foreground"
                  : "border-accent-brand/50 text-foreground hover:bg-muted"
              }`}
            >
              {option.name}
            </button>
          ))}
          <button
            onClick={() => onResolve({ outcome: { outcome: "cancelled" } })}
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}
