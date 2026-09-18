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
}: {
  permission: PendingPermission;
  onResolve: (response: RequestPermissionResponse) => void;
}) {
  return (
    <section className="border-t border-border bg-background px-3 py-2 font-mono" aria-label="Permission request">
      <div>
        <p className="text-xs text-accent-brand">? permission required</p>
        <p className="mt-1 text-xs text-foreground">{permission.request.toolCall.title}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {permission.request.options.map((option, index) => (
            <button
              key={option.optionId}
              autoFocus={index === 0}
              onClick={() =>
                onResolve({ outcome: { outcome: "selected", optionId: option.optionId } })
              }
              className={`h-7 border px-2 text-xs focus-visible:border-accent-brand ${
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
