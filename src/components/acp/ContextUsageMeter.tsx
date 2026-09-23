import type { Cost } from "@agentclientprotocol/sdk";
import { describeContextUsage, type ContextUsageLevel } from "../../lib/contextUsage";
import { fmtCost } from "../../lib/telemetryFormat";

const tone: Record<ContextUsageLevel, string> = {
  ok: "text-muted-foreground",
  warn: "text-accent-brand",
  critical: "text-destructive",
};
const barTone: Record<ContextUsageLevel, string> = {
  ok: "bg-muted-foreground/60",
  warn: "bg-accent-brand",
  critical: "bg-destructive",
};

/**
 * How full the model's context window is: tokens used out of the window
 * size, a proportional bar, and the percentage. Shared by the live footer
 * indicator and the per-turn markers in the transcript.
 */
export function ContextUsageMeter({
  used,
  size,
  cost,
  label,
  barClassName = "w-16",
}: {
  used: number;
  size: number;
  cost?: Cost | null;
  /** Leading word, e.g. "context"; omitted in tight spaces like the footer. */
  label?: string;
  barClassName?: string;
}) {
  const view = describeContextUsage(used, size);
  const costLabel = cost && cost.currency === "USD" ? fmtCost(cost.amount) : null;
  return (
    <span
      className={`flex items-center gap-2 ${tone[view.level]}`}
      title={`Context window: ${view.tokens} tokens (${view.percentLabel})`}
    >
      <span>
        {label ? `${label} ` : ""}
        {view.tokens}
      </span>
      <span className={`h-1 overflow-hidden rounded-full bg-border ${barClassName}`} aria-hidden>
        <span
          className={`block h-full ${barTone[view.level]}`}
          style={{ width: `${view.percent}%` }}
        />
      </span>
      <span>{view.percentLabel}</span>
      {costLabel && <span className="text-muted-foreground/70">· {costLabel}</span>}
    </span>
  );
}
