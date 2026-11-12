import { useEffect } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { selectedBranch, selectedRepo, useAppStore } from "./store/appStore";
import { hydrateFromDisk, startPersistence } from "./store/persist";
import { startQueueSync } from "./lib/queueSync";
import { acpKillAll, githubAccount, ptyKillAll } from "./lib/ipc";
import { syncTerminalThemes } from "./lib/terminalRegistry";
import { pickAndAddRepo } from "./lib/actions";
import { initHandoff } from "./lib/handoff";
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
  const settingsOpen = useAppStore((s) => s.settingsOpen);

  useShortcuts();

  // Apply the color theme to <html> (light overrides live under `:root.light`).
  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    syncTerminalThemes();
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
      void initHandoff();
      void reconcileGithub();
      // Cloud runs live in their VMs; this only observes and reconciles.
      void startCloudSync();
      void checkForUpdates();
    })();
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex shrink-0" inert={settingsOpen}><Sidebar /></div>
      {/* Keep chats and terminals mounted while Settings owns focus. */}
      <main aria-label="Project workspace" inert={settingsOpen} className="flex min-w-0 flex-1 flex-col">
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
                      !settingsOpen &&
                      r.id === repo?.id &&
                      b.id === branch?.id &&
                      chat.id === b.activeChatId
                    }
                  />
                )),
              ),
            )}
          {hydrated && (!branch || branch.chats.length === 0) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-8 text-center">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="size-10 text-muted-foreground/40">
                <path strokeLinejoin="round" d="m13 2-9 12h7l-1 8 10-13h-8l1-7Z" />
              </svg>
              <div>
                <h1 className="text-lg font-medium tracking-tight">{repos.length === 0 ? "Your next idea starts here" : !branch ? "Ready when you are" : "Start a conversation"}</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {repos.length === 0 ? "Add a project to start building with your agents." : !repo ? "Choose a project from the sidebar." : !branch ? "Create a branch to give your work a space of its own." : "Open a chat and tell your agent what you want to build."}
                </p>
              </div>
              {repos.length === 0 ? (
                <button onClick={() => void pickAndAddRepo()} className="pi-btn pi-btn-primary gap-2 text-xs"><span aria-hidden="true">+</span> Add project</button>
              ) : repo && (
                <button onClick={() => branch ? useAppStore.getState().openChatPicker() : useAppStore.getState().openBranchModal(repo.id)} className="pi-btn gap-3 text-xs">
                  {branch ? "New chat" : "New branch"}<kbd className="text-muted-foreground">{branch ? "⌘T" : "⌘D"}</kbd>
                </button>
              )}
            </div>
          )}
        </div>
        <BottomPanel />
      </main>
      {!settingsOpen && hydrated && rightSidebarOpen && <RightSidebar repo={repo} branch={branch} />}
      <NewBranchModal />
      <WorkflowModal />
      <NewChatPicker />
      <SettingsPage />
    </div>
  );
}
