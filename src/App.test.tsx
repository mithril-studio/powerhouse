import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppStore } from "./store/appStore";
import App from "./App";

// Render the real App and sidebar. Isolate native transports;
// checking the app shell must never start/stop an actual agent or Tauri app.
vi.mock("./store/appStore", async (original) => {
  const actual = await original<typeof import("./store/appStore")>();
  return { ...actual, useAppStore: Object.assign(
    (select?: (s: ReturnType<typeof actual.useAppStore.getState>) => unknown) => select ? select(actual.useAppStore.getState()) : actual.useAppStore.getState(),
    actual.useAppStore,
  ) };
});
vi.mock("./store/persist", () => ({ hydrateFromDisk: vi.fn(), startPersistence: vi.fn() }));
vi.mock("./lib/actions", () => ({ pickAndAddRepo: vi.fn() }));
vi.mock("./lib/queueSync", () => ({ startQueueSync: vi.fn() }));
vi.mock("./lib/ipc", () => ({ acpKillAll: vi.fn(), githubAccount: vi.fn(), ptyKillAll: vi.fn() }));
vi.mock("./lib/handoff", () => ({ initHandoff: vi.fn() }));
vi.mock("./lib/cloud", () => ({ startCloudSync: vi.fn() }));
vi.mock("./hooks/useShortcuts", () => ({ useShortcuts: vi.fn() }));
vi.mock("./components/RepoItem", () => ({ RepoItem: () => <div>Project shortcut</div> }));
vi.mock("./components/TabBar", () => ({ TabBar: () => null }));
vi.mock("./components/ChatPane", () => ({ ChatPane: ({ active }: { active: boolean }) => <div data-chat-active={active}>Mounted chat</div> }));
vi.mock("./components/BottomPanel", () => ({ BottomPanel: () => <div>Mounted terminal panel</div> }));
vi.mock("./components/NewBranchModal", () => ({ NewBranchModal: () => null }));
vi.mock("./components/WorkflowModal", () => ({ WorkflowModal: () => null }));
vi.mock("./components/RightSidebar", () => ({ RightSidebar: () => <div>Project inspector</div> }));
vi.mock("./components/NewChatPicker", () => ({ NewChatPicker: () => null }));
vi.mock("./components/SettingsPage", () => ({ SettingsPage: () => useAppStore.getState().settingsOpen ? <div>Settings content</div> : null }));

beforeEach(() => {
  useAppStore.getState().hydrate(null);
  useAppStore.setState({ settingsOpen: false, settingsSection: "general", rightSidebarOpen: true });
});

it("opens directly into the project workspace with only project navigation", () => {
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="Main sidebar"');
  expect(html).toContain('aria-label="Project workspace" class="flex');
  expect(html).toContain("Project inspector");
  expect(html).toContain('aria-label="Settings"');
  for (const label of ["Home", "Workflows", "Memory", "Telemetry"]) {
    expect(html).not.toContain(`>${label}<`);
  }
});

it("keeps chats and terminals mounted but inactive while settings is open", () => {
  const repo = useAppStore.getState().addRepo({ name: "repo", path: "/repo", defaultBranch: "main" });
  useAppStore.getState().addBranch(repo.id, { id: "branch", name: "feature", worktreePath: "/worktree", chats: [{ id: "chat", title: "Chat" }], activeChatId: "chat" });
  useAppStore.getState().select(repo.id, "branch");
  useAppStore.getState().openSettings("telemetry");
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="Project workspace" inert=""');
  expect(html).toContain("Mounted terminal panel");
  expect(html).toContain('data-chat-active="false">Mounted chat');
  expect(html).toContain("Settings content");
  useAppStore.getState().closeSettings();
  expect(renderToStaticMarkup(<App />)).toContain('data-chat-active="true">Mounted chat');
  expect(useAppStore.getState().selection).toEqual({ repoId: repo.id, branchId: "branch" });
});

it("board navigation keeps chats mounted and disables the project workspace", () => {
  const r = useAppStore.getState().addRepo({ name: "r", path: "/r", defaultBranch: "main" });
  useAppStore.getState().addBranch(r.id, { id: "b", name: "f", worktreePath: "/b", chats: [{ id: "c", title: "C" }], activeChatId: "c" });
  useAppStore.setState({ workspaceView: "board" });
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="Task board"');
  expect(html).toContain('aria-label="Project workspace" inert=""');
  expect(html).toContain('data-chat-active="false">Mounted chat');
  for (const label of ["Backlog", "In Progress", "Needs You", "Review", "Done"]) expect(html).toContain(label);
  expect(html).not.toContain("Project inspector");
});
