import { useEffect } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { selectedBranch, selectedRepo, useAppStore } from "./store/appStore";
import { hydrateFromDisk, startPersistence } from "./store/persist";
import { startQueueSync } from "./lib/queueSync";
import { acpKillAll, githubAccount, ptyKillAll } from "./lib/ipc";
import { initHandoff } from "./lib/handoff";
import { startDockBadge } from "./lib/attention";
import { startCloudSync } from "./lib/cloud";
import { useShortcuts } from "./hooks/useShortcuts";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { ChatPane } from "./components/ChatPane";
import { BottomPanel } from "./components/BottomPanel";
import { NewBranchModal } from "./components/NewBranchModal";
import { WorkflowModal } from "./components/WorkflowModal";
import { RightSidebar } from "./components/RightSidebar";
import { NewChatPicker } from "./components/NewChatPicker";
import { SettingsPage } from "./components/SettingsPage";
import { TelemetryPage } from "./components/telemetry/TelemetryPage";
import { WorkflowsPage } from "./features/workflows/WorkflowsPage";

let booted = false;

async function checkForUpdates() {
  try {
    const update = await check();
    if (!update) return;

    const install = await ask(`Version ${update.version} is ready to install.`, {
      title: "Update Powerhouse",
      kind: "info",
      okLabel: "Install and relaunch",
      cancelLabel: "Later",
    });
    if (!install) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (error) {
    console.warn("Unable to check for updates:", error);
  }
}

/** The keychain is the source of truth for GitHub auth: validate any stored
 *  token on boot and settle the persisted connection to match. */
async function reconcileGithub() {
  try {
    const account = await githubAccount();
    useAppStore.getState().setGithubConnection(
      account
        ? { status: "connected", login: account.login, avatarUrl: account.avatar_url }
        : { status: "disconnected" },
    );
  } catch {
    /* leave the persisted connection as-is if the check fails */
  }
}

export default function App() {
  const hydrated = useAppStore((s) => s.hydrated);
  const repos = useAppStore((s) => s.repos);
  const repo = useAppStore(selectedRepo);
  const branch = useAppStore(selectedBranch);
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen);
  const theme = useAppStore((s) => s.settings.theme);
  const workspaceView = useAppStore((s) => s.workspaceView);
  const homeVisible = workspaceView === "home";

  useShortcuts();

  // Apply the color theme to <html> (light overrides live under `:root.light`).
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  useEffect(() => {
    if (booted) return; // StrictMode double-invoke guard
    booted = true;
    void (async () => {
      // Dev-reload hygiene: neither transport should leave orphan sessions.
      await Promise.all([
        ptyKillAll().catch(() => {}),
        acpKillAll().catch(() => {}),
      ]);
      await hydrateFromDisk();
      startPersistence();
      startQueueSync();
      startDockBadge();
      void initHandoff();
      void reconcileGithub();
      // Cloud runs live in their VMs; this only observes and reconciles.
      void startCloudSync();
      void checkForUpdates();
    })();
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      {/* Keep chats and terminals mounted while another workspace is visible. */}
      <main aria-label="Project workspace" inert={!homeVisible} className={`${homeVisible ? "flex" : "hidden"} min-w-0 flex-1 flex-col`}>
        <TabBar repo={repo} branch={branch} />
        <div className="relative flex-1 overflow-hidden">
          {hydrated &&
            repos.flatMap((r) =>
              r.branches.flatMap((b) =>
                b.chats.map((chat) => (
                  <ChatPane
                    key={chat.id}
                    repoId={r.id}
                    branch={b}
                    chat={chat}
                    active={
                      homeVisible &&
                      r.id === repo?.id &&
                      b.id === branch?.id &&
                      chat.id === b.activeChatId
                    }
                  />
                )),
              ),
            )}
          {hydrated && (!branch || branch.chats.length === 0) && (
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
        <BottomPanel />
      </main>
      {!homeVisible && <WorkflowsPage />}
      {homeVisible && hydrated && rightSidebarOpen && <RightSidebar repo={repo} branch={branch} />}
      <NewBranchModal />
      <WorkflowModal />
      <NewChatPicker />
      <SettingsPage />
      <TelemetryPage />
    </div>
  );
}
