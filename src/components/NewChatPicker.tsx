import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store/appStore";
import { createChat } from "../lib/actions";
import { Dialog } from "./ui/dialog";

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
    if (e.key === "ArrowDown") {
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
    <Dialog title="New chat" onClose={close} width="22rem" onKeyDown={onKeyDown}>
      <div role="listbox" aria-label="Agent" className="p-2 pt-2.5">
        {agents.map((agent, i) => {
          const isDefault = agent.id === settings.defaultAgentId;
          return (
            <div
              key={agent.id}
              role="option"
              aria-selected={i === index}
              onClick={() => pick(agent.id)}
              onMouseEnter={() => setIndex(i)}
              className={`group flex h-9 cursor-default items-center gap-2.5 rounded-[6px] px-2.5 ${
                i === index ? "bg-accent text-foreground" : "text-muted-foreground"
              }`}
            >
              <span className="w-3 text-center font-mono text-xs text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground/70">
                {agent.transport === "acp" ? "ACP" : agent.command}
              </span>
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  setDefaultAgent(agent.id);
                }}
                title={isDefault ? "Default agent" : "Set as default"}
                aria-label={isDefault ? "Default agent" : `Set ${agent.name} as default`}
                className={`flex size-6 shrink-0 items-center justify-center rounded-[5px] ${
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
    </Dialog>
  );
}
