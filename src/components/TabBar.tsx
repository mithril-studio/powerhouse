import { useAppStore, type Branch, type Repo } from "../store/appStore";
import { createChat, deleteChat } from "../lib/actions";

interface Props {
  repo: Repo | null;
  branch: Branch | null;
}

export function TabBar({ repo, branch }: Props) {
  const setActiveChat = useAppStore((s) => s.setActiveChat);

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
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteChat(repo.id, branch.id, chat.id);
                  }}
                  title="Close chat"
                  aria-label={`Close ${chat.title}`}
                  className="flex size-5 items-center justify-center rounded-sm text-transparent hover:bg-input group-hover:text-muted-foreground hover:!text-foreground"
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            onClick={() => createChat(repo.id, branch.id)}
            title="New chat (⌘T)"
            aria-label="New chat"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            +
          </button>
        </>
      )}
    </div>
  );
}
