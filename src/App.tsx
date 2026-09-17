import { useEffect } from "react";
import { selectedBranch, selectedRepo, useAppStore } from "./store/appStore";
import { hydrateFromDisk, startPersistence } from "./store/persist";
import { startQueueSync } from "./lib/queueSync";
import { ptyKillAll } from "./lib/ipc";
import { useShortcuts } from "./hooks/useShortcuts";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { TerminalPane } from "./components/TerminalPane";
import { NewBranchModal } from "./components/NewBranchModal";
import { WorkflowModal } from "./components/WorkflowModal";
import { QueuePane } from "./components/QueuePane";
import { DiffPane } from "./components/DiffPane";

let booted = false;

export default function App() {
  const hydrated = useAppStore((s) => s.hydrated);
  const repos = useAppStore((s) => s.repos);
  const repo = useAppStore(selectedRepo);
  const branch = useAppStore(selectedBranch);
  const queueView = useAppStore((s) => s.selection.view === "queue");

  useShortcuts();

  useEffect(() => {
    if (booted) return; // StrictMode double-invoke guard
    booted = true;
    void (async () => {
      await ptyKillAll().catch(() => {}); // dev-reload hygiene: no orphan sessions
      await hydrateFromDisk();
      startPersistence();
      startQueueSync();
    })();
  }, []);

  const showEmpty =
    hydrated && !queueView && (!branch || branch.chats.length === 0) &&
    branch?.activeView !== "diff";

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <TabBar repo={repo} branch={branch} />
        <div className="relative flex-1 overflow-hidden">
          {hydrated &&
            repos.flatMap((r) =>
              r.branches.flatMap((b) =>
                b.chats.map((chat) => (
                  <TerminalPane
                    key={chat.id}
                    branch={b}
                    chat={chat}
                    active={
                      !queueView &&
                      r.id === repo?.id &&
                      b.id === branch?.id &&
                      b.activeView !== "diff" &&
                      chat.id === b.activeChatId
                    }
                  />
                )),
              ),
            )}

          {hydrated && queueView && repo && <QueuePane repo={repo} />}

          {hydrated && !queueView && repo && branch && branch.activeView === "diff" && (
            <DiffPane key={branch.id} repo={repo} branch={branch} active />
          )}

          {showEmpty && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-muted-foreground">
                {repos.length === 0
                  ? "Add a project to get started"
                  : !repo
                    ? "Select a project"
                    : !branch
                      ? "Create a branch — ⌘D"
                      : "Open a chat — ⌘T"}
              </p>
            </div>
          )}
        </div>
      </main>
      <NewBranchModal />
      <WorkflowModal />
    </div>
  );
}
