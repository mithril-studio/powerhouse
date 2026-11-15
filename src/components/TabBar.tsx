import { resolveAgent, useAppStore, type Branch, type Repo } from "../store/appStore";
import { deleteChat } from "../lib/actions";
import { ActivityDot } from "./ActivityDot";
import { FileIcon } from "./RightSidebar";
import { CloseIcon, PlusIcon } from "./ui/icons";

interface Props {
  repo: Repo | null;
  branch: Branch | null;
}

export function TabBar({ repo, branch }: Props) {
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  const openFile = useAppStore((s) => s.openFile);
  const closeFile = useAppStore((s) => s.closeFile);
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const openChatPicker = useAppStore((s) => s.openChatPicker);
  const settings = useAppStore((s) => s.settings);
  const chatActivity = useAppStore((s) => s.chatActivity);

  return (
    <div data-tauri-drag-region className="ph-tabbar">
      {repo && branch && (
        <>
          {branch.chats.map((chat) => {
            const active = chat.id === branch.activeChatId && !branch.activeFile;
            const agent = resolveAgent(settings, chat.agentId);
            const activity = chatActivity[chat.id];
            return (
              <div
                key={chat.id}
                data-active={active}
                onClick={() => setActiveChat(repo.id, branch.id, chat.id)}
                className="ph-tab"
              >
                {activity && <ActivityDot activity={activity} />}
                <span className="max-w-40 truncate">{chat.title}</span>
                <span className="ph-tab-meta max-w-24 truncate">{agent.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteChat(repo.id, branch.id, chat.id);
                  }}
                  title="Close chat (⌘W)"
                  aria-label={`Close ${chat.title}`}
                  className="ph-tab-close"
                >
                  <CloseIcon className="size-3" />
                </button>
              </div>
            );
          })}
          {(branch.files ?? []).map((path) => {
            const active = path === branch.activeFile;
            const name = path.split("/").pop();
            return (
              <div
                key={path}
                data-active={active}
                onClick={() => openFile(repo.id, branch.id, path)}
                title={path}
                className="ph-tab"
              >
                <FileIcon />
                <span className="max-w-40 truncate font-mono text-xs">{name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeFile(repo.id, branch.id, path);
                  }}
                  title="Close file (⌘W)"
                  aria-label={`Close ${name}`}
                  className="ph-tab-close"
                >
                  <CloseIcon className="size-3" />
                </button>
              </div>
            );
          })}
          {branch.location !== "cloud" && (
            <button
              onClick={() => openChatPicker()}
              title="New chat (⌘T)"
              aria-label="New chat"
              className="ph-icon-btn ml-1"
            >
              <PlusIcon className="size-4" />
            </button>
          )}
        </>
      )}

      <span data-tauri-drag-region className="flex-1 self-stretch" />

      {branch?.vm && (
        <span
          title="This branch's agent runs on its own VM and keeps working while this Mac sleeps."
          className="mr-1 truncate font-mono text-[11px] text-muted-foreground"
        >
          {branch.vm}
        </span>
      )}

      {repo && (
        <button
          onClick={toggleRightSidebar}
          title="Toggle right sidebar"
          aria-label="Toggle right sidebar"
          aria-pressed={rightSidebarOpen}
          className="ph-icon-btn"
        >
          {/* right-panel glyph */}
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
            <rect x="1.5" y="2.5" width="12" height="10" rx="1.5" stroke="currentColor" />
            <line x1="9.5" y1="2.5" x2="9.5" y2="12.5" stroke="currentColor" />
          </svg>
        </button>
      )}
    </div>
  );
}
