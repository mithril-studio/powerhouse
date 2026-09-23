import type {
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
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

export function AcpFooter({
  agentName,
  branchName,
  busy,
  modes,
  configOptions,
  commandCount,
  nativeCliOpen,
  usage,
}: {
  agentName: string;
  branchName: string;
  busy: boolean;
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  commandCount: number;
  nativeCliOpen: boolean;
  /** Latest context-window reading; absent until the agent reports one. */
  usage: AcpUsageItem | null;
}) {
  const mode = modes?.availableModes.find(
    (item) => item.id === modes.currentModeId,
  )?.name;
  const settings = configOptions
    .filter((option) => ["model", "thought_level"].includes(option.category ?? ""))
    .map(selectedLabel)
    .filter(Boolean);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 px-3 font-mono text-[10px] text-muted-foreground">
      <span className="truncate">{branchName}</span>
      <span className={busy ? "text-accent-brand" : "text-success"}>
        {busy ? "● working" : "● ready"}
      </span>
      <span className="flex-1" />
      {usage && (
        <ContextUsageMeter used={usage.used} size={usage.size} barClassName="w-10" />
      )}
      {commandCount > 0 && <span>{commandCount} commands</span>}
      {[mode, ...settings].filter(Boolean).map((value) => (
        <span key={value}>{value}</span>
      ))}
      <span className={nativeCliOpen ? "text-accent-brand" : ""}>
        {nativeCliOpen ? "ACP + CLI" : "ACP"}
      </span>
      <span className="text-foreground/80">{agentName}</span>
      <span>⌘⇧P</span>
    </footer>
  );
}
