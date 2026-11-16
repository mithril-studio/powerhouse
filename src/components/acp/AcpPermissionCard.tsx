import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { WarningIcon } from "../ui/icons";

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
  onResolve: (response: RequestPermissionResponse) => void;
  /** Off where several requests can be on screen at once (task board). */
  autoFocus?: boolean;
}) {
  const firstAllow = permission.request.options.findIndex((option) => !option.kind.startsWith("reject"));
  return (
    <section className="permission-card" aria-label="Permission request">
      <p className="permission-title">
        <WarningIcon className="size-3.5 text-attention" />
        Permission needed
      </p>
      <p className="permission-detail">{permission.request.toolCall.title}</p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {permission.request.options.map((option, index) => (
          <button
            key={option.optionId}
            autoFocus={autoFocus && index === 0}
            onClick={() =>
              onResolve({ outcome: { outcome: "selected", optionId: option.optionId } })
            }
            className={`ph-btn h-7 px-2.5 text-xs ${index === firstAllow ? "ph-btn-primary" : ""}`}
          >
            {option.name}
          </button>
        ))}
        <button
          onClick={() => onResolve({ outcome: { outcome: "cancelled" } })}
          className="ph-btn ph-btn-ghost h-7 px-2.5 text-xs"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
