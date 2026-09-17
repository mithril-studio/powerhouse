import { useAppStore, type Branch, type Repo } from "../store/appStore";
import { createChat, deleteChat, enqueueBranch } from "../lib/actions";

interface Props {
  repo: Repo | null;
  branch: Branch | null;
}

function MergeButton({ repo, branch }: { repo: Repo; branch: Branch }) {
  const live = useAppStore((s) =>
    (s.queues[repo.id] ?? []).some(
      (e) =>
        e.branch === branch.name &&
        (e.state === "queued" || e.state === "validating" || e.state === "merging"),
    ),
  );
  return (
    <button
      onClick={() => void enqueueBranch(repo.id, branch.id)}
      disabled={live}
      title={live ? "Already in the queue" : "Enqueue for merge validation"}
      className="h-7 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-all active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
    >
      {live ? "Queued" : "Merge"}
    </button>
  );
}

export function TabBar({ repo, branch }: Props) {
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  const setBranchView = useAppStore((s) => s.setBranchView);
  const isQueueView = useAppStore((s) => s.selection.view === "queue");

  if (repo && isQueueView) {
    return (
      <div
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3"
      >
        <span className="font-mono text-xs text-muted-foreground">
          {repo.name} · merge queue
        </span>
      </div>
    );
  }

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
            const active =
              branch.activeView !== "diff" && chat.id === branch.activeChatId;
            return (
              <div
                key={chat.id}
                onClick={() => {
                  setActiveChat(repo.id, branch.id, chat.id);
                  setBranchView(repo.id, branch.id, "chat");
                }}
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

          <div
            onClick={() => setBranchView(repo.id, branch.id, "diff")}
            className={`ml-1 flex h-7 cursor-default items-center rounded-md px-2.5 ${
              branch.activeView === "diff"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            }`}
          >
            Changes
          </div>

          <span className="flex-1" />
          <MergeButton repo={repo} branch={branch} />
        </>
      )}
    </div>
  );
}
