import { resolveAgent, useAppStore, type Branch, type Repo } from "../store/appStore";
import { deleteChat } from "../lib/actions";
import { startHandoff } from "../lib/handoff";
import { useEffect, useState } from "react";
import {
  cloudReadiness,
  isCloudBusy,
  sendChatToCloud,
  workspaceForBranch,
  type Readiness,
} from "../lib/cloud";
import { ActivityDot } from "./ActivityDot";
import { FileIcon } from "./RightSidebar";

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
  const pending = useAppStore((s) =>
    branch ? branch.id in s.pendingHandoff : false,
  );
  const chatActivity = useAppStore((s) => s.chatActivity);
  const activeRunning = useAppStore((s) =>
    branch?.activeChatId
      ? (s.chatStatus[branch.activeChatId] ?? "idle") === "running"
      : false,
  );
  const cloud = useAppStore((s) =>
    branch ? workspaceForBranch(s.cloudWorkspaces, branch.id) : null,
  );
  const cloudBusy = cloud ? isCloudBusy(cloud) : false;
  // One workspace per branch; a failed start may be retried.
  const cloudLocked = cloud ? cloud.status !== "failed" || cloud.turn > 0 : false;

  // Missing keys show before the click. Rechecked when the branch changes and
  // when a settings page closes, since that is where keys get fixed.
  const settingsOpen = useAppStore((s) => s.settingsOpen || s.projectSettingsRepoId !== null);
  const envNames = (repo?.cloudEnvNames ?? []).join(",");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  useEffect(() => {
    setReadiness(null);
    if (!repo || !branch || settingsOpen) return;
    let live = true;
    void cloudReadiness(repo.id, branch.worktreePath, repo.cloudEnvNames ?? [])
      .then((r) => live && setReadiness(r))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.id, branch?.id, branch?.worktreePath, envNames, settingsOpen]);
  const notReady = !cloudLocked && readiness !== null && !readiness.ready;

  return (
    <div
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-card px-2"
    >
      {repo && branch && (
        <>
          <span className="mr-2 max-w-48 truncate pl-1 font-mono text-xs text-muted-foreground">
            {repo.name}/{branch.name}
          </span>
          {branch.chats.map((chat) => {
            const active = chat.id === branch.activeChatId && !branch.activeFile;
            const agent = resolveAgent(settings, chat.agentId);
            const activity = chatActivity[chat.id];
            return (
              <div
                key={chat.id}
                onClick={() => setActiveChat(repo.id, branch.id, chat.id)}
                className={`group flex h-11 items-center gap-2 border-b-2 pl-3 pr-1 ${
                  active
                    ? "border-accent-brand text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                {activity && <ActivityDot activity={activity} />}
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
          {(branch.files ?? []).map((path) => {
            const active = path === branch.activeFile;
            const name = path.split("/").pop();
            return (
              <div
                key={path}
                onClick={() => openFile(repo.id, branch.id, path)}
                title={path}
                className={`group flex h-11 items-center gap-2 border-b-2 pl-3 pr-1 ${
                  active
                    ? "border-accent-brand text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <FileIcon />
                <span className="max-w-32 truncate font-mono text-xs">{name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeFile(repo.id, branch.id, path);
                  }}
                  title="Close file (⌘W)"
                  aria-label={`Close ${name}`}
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
        </>
      )}

      <span className="flex-1" />

      {repo && branch && (
        <>
          <button
            onClick={() => void sendChatToCloud(repo, branch)}
            disabled={cloudLocked || !branch.activeChatId}
            title={
              cloud
                ? `This branch is in the cloud on ${cloud.vmName}`
                : notReady
                  ? `Not ready for the cloud:\n${readiness.missing.join("\n")}`
                  : "Continue this chat and its branch on a cloud machine"
            }
            className="flex h-7 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            {cloudBusy && (
              <span className="size-2 animate-pulse rounded-full bg-background/70" />
            )}
            {notReady && (
              <span aria-label="Not ready" className="size-2 rounded-full bg-amber-500" />
            )}
            {cloudBusy ? "In cloud…" : cloudLocked ? "In cloud" : "Cloud"}
          </button>
          <button
            onClick={() => void startHandoff(repo.id, branch.id)}
            disabled={!pending && !activeRunning}
            title={
              pending
                ? "Cancel handoff"
                : "Hand off this chat to a fresh agent session"
            }
            className="flex h-7 items-center gap-1.5 rounded-md bg-foreground px-2.5 text-xs font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            {pending && (
              <span className="size-2 animate-pulse rounded-full bg-background/70" />
            )}
            {pending ? "Handing off…" : "Handoff"}
          </button>
        </>
      )}

      {repo && (
        <button
          onClick={toggleRightSidebar}
          title="Toggle right sidebar"
          aria-label="Toggle right sidebar"
          aria-pressed={rightSidebarOpen}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
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
