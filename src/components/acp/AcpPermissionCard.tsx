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
    <section className="border-t border-border bg-card px-4 py-3" aria-label="Permission request">
      <div className="mx-auto max-w-4xl">
        <p className="text-xs font-medium">Permission required</p>
        <p className="mt-1 text-xs text-muted-foreground">{permission.request.toolCall.title}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {permission.request.options.map((option, index) => (
            <button
              key={option.optionId}
              autoFocus={index === 0}
              onClick={() =>
                onResolve({ outcome: { outcome: "selected", optionId: option.optionId } })
              }
              className={`h-8 rounded-md border px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring/60 ${
                option.kind.startsWith("reject")
                  ? "border-border text-muted-foreground hover:text-foreground"
                  : "border-accent-brand/40 bg-accent-brand/10 text-foreground"
              }`}
            >
              {option.name}
            </button>
          ))}
          <button
            onClick={() => onResolve({ outcome: { outcome: "cancelled" } })}
            className="h-8 rounded-md px-3 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}
