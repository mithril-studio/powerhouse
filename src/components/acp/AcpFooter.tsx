import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpUsageItem } from "../../lib/acpTranscript";
import { ContextUsageMeter } from "./ContextUsageMeter";

function selectedLabel(option: SessionConfigOption): string | null {
  if (option.type === "boolean") return option.currentValue ? option.name : null;
  for (const entry of option.options) {
    if ("group" in entry) {
      const selected = entry.options.find(
        (value) => value.value === option.currentValue,
      );
      if (selected) return selected.name;
    } else if (entry.value === option.currentValue) {
      return entry.name;
    }
  }
  return option.currentValue;
}

/** Branch on the left; context usage, model and thinking level on the right. */
export function AcpFooter({
  branchName,
  configOptions,
  usage,
}: {
  branchName: string;
  configOptions: SessionConfigOption[];
  /** Latest context-window reading; absent until the agent reports one. */
  usage: AcpUsageItem | null;
}) {
  const settings = configOptions
    .filter((option) => ["model", "thought_level"].includes(option.category ?? ""))
    .map(selectedLabel)
    .filter(Boolean);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 px-3 font-mono text-[10px] text-muted-foreground">
      <span className="truncate">{branchName}</span>
      <span className="flex-1" />
      {usage && (
        <ContextUsageMeter used={usage.used} size={usage.size} barClassName="w-10" />
      )}
      {settings.map((value) => (
        <span key={value}>{value}</span>
      ))}
    </footer>
  );
}
