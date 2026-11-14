import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useAppStore } from "./store/appStore";
import App from "./App";

// Render the real App, sidebar and workflow page. Isolate native transports;
// checking the app shell must never start/stop an actual agent or Tauri app.
vi.mock("./store/appStore", async (original) => {
  const actual = await original<typeof import("./store/appStore")>();
  return { ...actual, useAppStore: Object.assign(
    (select: (s: ReturnType<typeof actual.useAppStore.getState>) => unknown) => select(actual.useAppStore.getState()),
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
vi.mock("./components/ProjectSettingsPage", () => ({ ProjectSettingsPage: () => null }));
vi.mock("./components/RightSidebar", () => ({ RightSidebar: () => <div>Project inspector</div> }));
vi.mock("./components/NewChatPicker", () => ({ NewChatPicker: () => null }));
vi.mock("./components/SettingsPage", () => ({ SettingsPage: () => null }));
vi.mock("./components/telemetry/TelemetryPage", () => ({ TelemetryPage: () => null }));

beforeEach(() => {
  useAppStore.getState().hydrate(null);
  useAppStore.setState({
    workspaceView: "home",
    rightSidebarOpen: true,
    settingsOpen: false,
    telemetryOpen: false,
    memoryOpen: false,
  });
});

it("lists only Task board and Mission Control in the sidebar; tools live in Settings", () => {
  const repo = useAppStore.getState().addRepo({ name: "repo", path: "/repo", defaultBranch: "main" });
  useAppStore.getState().addBranch(repo.id, { id: "branch", name: "feature", worktreePath: "/worktree", chats: [{ id: "chat", title: "Chat" }], activeChatId: "chat" });
  useAppStore.getState().setWorkspaceView("board");
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="Main navigation"');
  expect(html).toContain("Task board</button>");
  expect(html).toContain("Mission Control</button>");
  for (const gone of ["Workflows", "Memory", "Telemetry", "Home"]) expect(html).not.toContain(`${gone}</button>`);
  expect(html).toContain('aria-label="Project workspace" inert="" class="hidden');
  expect(html).toContain('data-chat-active="false">Mounted chat');
});

it("returns to the project workspace without removing navigation", () => {
  useAppStore.getState().setWorkspaceView("board");
  useAppStore.getState().setWorkspaceView("home");
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="Main sidebar"');
  expect(html).toContain('aria-label="Project workspace" class="flex');
  expect(html).toContain("Project inspector");
});

it("shows the task board and Mission Control in place of the workspace, keeping chats mounted", () => {
  const repo = useAppStore.getState().addRepo({ name: "repo", path: "/repo", defaultBranch: "main" });
  useAppStore.getState().addBranch(repo.id, { id: "branch", name: "feature", worktreePath: "/worktree", chats: [{ id: "chat", title: "Chat" }], activeChatId: "chat" });
  useAppStore.getState().setWorkspaceView("board");
  useAppStore.setState({ hydrated: true });
  let html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="Task board"');
  for (const label of ["Backlog", "In progress", "Needs you", "Review", "Done"]) expect(html).toContain(label);
  expect(html).toContain('aria-label="Project workspace" inert=""');
  expect(html).toContain('data-chat-active="false">Mounted chat');
  expect(html).not.toContain("Project inspector");

  useAppStore.getState().setWorkspaceView("mission");
  html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="Mission Control"');
  expect(html).toContain("No agents running");
});
