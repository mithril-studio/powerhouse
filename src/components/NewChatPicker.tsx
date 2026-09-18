import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store/appStore";
import { createChat } from "../lib/actions";

// Mini popover to pick which agent a new chat launches. Default agent sits on
// top and is preselected, so ⌘T → Enter is a one-key "new chat with default".
export function NewChatPicker() {
  const open = useAppStore((s) => s.chatPickerOpen);
  const close = useAppStore((s) => s.closeChatPicker);
  const settings = useAppStore((s) => s.settings);
  const setDefaultAgent = useAppStore((s) => s.setDefaultAgent);
  const selection = useAppStore((s) => s.selection);

  // Default first, then the rest in their stored order.
  const agents = useMemo(() => {
    const def = settings.agents.find((a) => a.id === settings.defaultAgentId);
    const rest = settings.agents.filter((a) => a.id !== settings.defaultAgentId);
    return def ? [def, ...rest] : rest;
  }, [settings]);

  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  if (!open) return null;

  const { repoId, branchId } = selection;
  if (!repoId || !branchId) return null;

  const pick = (agentId: string) => {
    createChat(repoId, branchId, agentId);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => (i + 1) % agents.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (i - 1 + agents.length) % agents.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const agent = agents[index];
      if (agent) pick(agent.id);
    } else if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1;
      if (n < agents.length) {
        e.preventDefault();
        pick(agents[n].id);
      }
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-background/60 pt-32"
      onMouseDown={() => close()}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        tabIndex={-1}
        ref={(el) => el?.focus()}
        className="w-80 rounded-xl bg-card p-2 outline-none ring-1 ring-foreground/10"
      >
        <p className="px-2 pb-1 pt-1 text-xs text-muted-foreground">New chat with…</p>
        {agents.map((agent, i) => {
          const isDefault = agent.id === settings.defaultAgentId;
          return (
            <div
              key={agent.id}
              onClick={() => pick(agent.id)}
              onMouseEnter={() => setIndex(i)}
              className={`group flex h-9 cursor-default items-center gap-2 rounded-lg px-2 ${
                i === index ? "bg-muted text-foreground" : "text-muted-foreground"
              }`}
            >
              <span className="w-4 text-center font-mono text-xs text-muted-foreground">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{agent.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground/70">
                {agent.transport === "acp" ? "ACP" : agent.command}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDefaultAgent(agent.id);
                }}
                title={isDefault ? "Default agent" : "Set as default"}
                aria-label={isDefault ? "Default agent" : `Set ${agent.name} as default`}
                className={`flex size-6 shrink-0 items-center justify-center rounded-sm ${
                  isDefault
                    ? "text-accent-brand"
                    : "text-transparent hover:bg-input hover:text-muted-foreground group-hover:text-muted-foreground/50"
                }`}
              >
                {isDefault ? "★" : "☆"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
