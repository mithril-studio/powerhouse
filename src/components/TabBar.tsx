import { resolveAgent, useAppStore, type Branch, type Repo } from "../store/appStore";
import { deleteChat } from "../lib/actions";
import { startHandoff } from "../lib/handoff";

interface Props {
  repo: Repo | null;
  branch: Branch | null;
}

export function TabBar({ repo, branch }: Props) {
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  const openChatPicker = useAppStore((s) => s.openChatPicker);
  const settings = useAppStore((s) => s.settings);
  const pending = useAppStore((s) =>
    branch ? branch.id in s.pendingHandoff : false,
  );
  const activeRunning = useAppStore((s) =>
    branch?.activeChatId
      ? (s.chatStatus[branch.activeChatId] ?? "idle") === "running"
      : false,
  );

  return (
    <div
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2"
    >
      {repo && branch && (
        <>
          <span className="mr-2 max-w-48 truncate pl-1 font-mono text-xs text-muted-foreground">
            {repo.name}/{branch.name}
          </span>
          {branch.chats.map((chat) => {
            const active = chat.id === branch.activeChatId;
            const agent = resolveAgent(settings, chat.agentId);
            return (
              <div
                key={chat.id}
                onClick={() => setActiveChat(repo.id, branch.id, chat.id)}
                className={`group flex h-7 items-center gap-1 rounded-md pl-2.5 pr-1 ${
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <span className="max-w-32 truncate">{chat.title}</span>
                <span className="max-w-20 truncate text-[10px] text-muted-foreground/60">
                  {agent.name}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteChat(repo.id, branch.id, chat.id);
                  }}
                  title="Close chat (⌘W)"
                  aria-label={`Close ${chat.title}`}
                  className="flex size-5 items-center justify-center rounded-sm text-transparent hover:bg-input group-hover:text-muted-foreground hover:!text-foreground"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            onClick={() => openChatPicker()}
            title="New chat (⌘T)"
            aria-label="New chat"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            +
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => void startHandoff(repo.id, branch.id)}
              disabled={!pending && !activeRunning}
              title={
                pending
                  ? "Cancel handoff"
                  : "Hand off this chat to a fresh agent session"
              }
              className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs disabled:opacity-40 ${
                pending
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {pending && (
                <span className="size-2 animate-pulse rounded-full bg-accent-brand" />
              )}
              {pending ? "Handing off…" : "Handoff"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
