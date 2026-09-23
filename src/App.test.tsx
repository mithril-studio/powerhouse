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
vi.mock("./components/WorkflowModal", () => ({ WorkflowModal: () => null }));
vi.mock("./components/RightSidebar", () => ({ RightSidebar: () => <div>Project inspector</div> }));
vi.mock("./components/NewChatPicker", () => ({ NewChatPicker: () => null }));
vi.mock("./components/SettingsPage", () => ({ SettingsPage: () => null }));
vi.mock("./components/telemetry/TelemetryPage", () => ({ TelemetryPage: () => null }));

beforeEach(() => {
  useAppStore.getState().hydrate(null);
  useAppStore.setState({ workspaceView: "home", rightSidebarOpen: true });
});

it("shows Workflows alongside the main navigation, with the project workspace still mounted but inert", () => {
  const repo = useAppStore.getState().addRepo({ name: "repo", path: "/repo", defaultBranch: "main" });
  useAppStore.getState().addBranch(repo.id, { id: "branch", name: "feature", worktreePath: "/worktree", chats: [{ id: "chat", title: "Chat" }], activeChatId: "chat" });
  useAppStore.getState().setWorkspaceView("workflows");
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="Main sidebar"');
  expect(html).toContain('aria-label="Main navigation"');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('id="workflows-title"');
  expect(html).toContain('aria-label="Project workspace" inert="" class="hidden');
  expect(html).toContain("Mounted terminal panel");
  expect(html).toContain('data-chat-active="false">Mounted chat');
  expect(html).not.toContain("Project inspector");
  expect(html).not.toContain("fixed inset-0");
});

it("returns to the project workspace without removing navigation", () => {
  useAppStore.getState().setWorkspaceView("workflows");
  useAppStore.getState().setWorkspaceView("home");
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('aria-label="Main sidebar"');
  expect(html).toContain('aria-label="Project workspace" class="flex');
  expect(html).toContain("Project inspector");
  expect(html).not.toContain('id="workflows-title"');
});
