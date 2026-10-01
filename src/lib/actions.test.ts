import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { deleteBranch, deleteChat, deleteRepo } from "./actions";
import { disposeAcp } from "./acpRegistry";
import { disposeTerminal } from "./terminalRegistry";
import { requestPowerConfirmation } from "./powerConfirm";
import { gitArchiveBranch, gitRemoveWorktree, handoffWatchStop, ptyDeleteTranscript } from "./ipc";
import { useAppStore, type Branch, type Repo } from "../store/appStore";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), message: vi.fn() }));
vi.mock("./powerConfirm", () => ({ requestPowerConfirmation: vi.fn() }));
vi.mock("./acpRegistry", () => ({ disposeAcp: vi.fn() }));
vi.mock("./terminalRegistry", () => ({ disposeTerminal: vi.fn() }));
vi.mock("./ipc", () => ({
  gitArchiveBranch: vi.fn(),
  gitRemoveWorktree: vi.fn(),
  handoffWatchStop: vi.fn(),
  ptyDeleteTranscript: vi.fn(),
}));

const branch = (id: string): Branch => ({
  id, name: id, worktreePath: `/repo/${id}`,
  chats: [{ id: `${id}-chat`, title: "Chat 1" }], activeChatId: `${id}-chat`,
});
const repo: Repo = {
  id: "repo", name: "Project", path: "/repo", defaultBranch: "test",
  branches: [branch("one"), branch("two")], workflow: [], pushOnMerge: true,
};
const clearTimeout = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { clearTimeout });
  vi.mocked(ask).mockResolvedValue(true);
  vi.mocked(requestPowerConfirmation).mockResolvedValue(true);
  vi.mocked(disposeAcp).mockResolvedValue(undefined);
  vi.mocked(gitRemoveWorktree).mockResolvedValue(undefined);
  vi.mocked(handoffWatchStop).mockResolvedValue(undefined);
  vi.mocked(ptyDeleteTranscript).mockResolvedValue(undefined);
  useAppStore.setState({
    repos: structuredClone([repo]), pendingHandoff: { one: 1, two: 2 },
    selection: { repoId: "repo", branchId: "one" },
  });
});

afterEach(() => vi.unstubAllGlobals());

function expectBranchDisposed(id: string, timer: number) {
  expect(handoffWatchStop).toHaveBeenCalledWith(id);
  expect(clearTimeout).toHaveBeenCalledWith(timer);
  expect(useAppStore.getState().pendingHandoff).not.toHaveProperty(id);
  expect(disposeAcp).toHaveBeenCalledWith(`${id}-chat`);
  for (const surface of [`${id}-chat`, `shell-${id}`, `agentcli-${id}`]) {
    expect(disposeTerminal).toHaveBeenCalledWith(surface);
    expect(ptyDeleteTranscript).toHaveBeenCalledWith(surface);
  }
}

describe("deletion cleanup", () => {
  it("disposes a single chat without removing its branch", () => {
    deleteChat("repo", "one", "one-chat");
    expect(disposeTerminal).toHaveBeenCalledExactlyOnceWith("one-chat");
    expect(disposeAcp).toHaveBeenCalledExactlyOnceWith("one-chat");
    expect(ptyDeleteTranscript).toHaveBeenCalledExactlyOnceWith("one-chat");
    expect(useAppStore.getState().repos[0].branches[0].chats).toEqual([]);
    expect(handoffWatchStop).not.toHaveBeenCalled();
    expect(gitRemoveWorktree).not.toHaveBeenCalled();
  });

  it("disposes and archives only the selected branch", async () => {
    await deleteBranch("repo", "one");
    expectBranchDisposed("one", 1);
    expect(disposeTerminal).toHaveBeenCalledTimes(3);
    expect(disposeAcp).toHaveBeenCalledTimes(1);
    expect(gitRemoveWorktree).toHaveBeenCalledExactlyOnceWith("/repo", "/repo/one");
    expect(gitArchiveBranch).toHaveBeenCalledExactlyOnceWith("/repo", "one", "test");
    expect(useAppStore.getState().repos[0].branches.map((b) => b.id)).toEqual(["two"]);
    expect(useAppStore.getState().pendingHandoff).toEqual({ two: 2 });
  });

  it("keeps the branch and skips archival when worktree removal fails", async () => {
    vi.mocked(gitRemoveWorktree).mockRejectedValue(new Error("busy"));
    await deleteBranch("repo", "one");
    expectBranchDisposed("one", 1);
    expect(useAppStore.getState().repos[0].branches).toHaveLength(2);
    expect(gitArchiveBranch).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith("Error: busy", expect.anything());
  });

  it("continues project cleanup after a worktree removal fails", async () => {
    vi.mocked(gitRemoveWorktree).mockRejectedValueOnce(new Error("busy"));
    await deleteRepo("repo");
    expectBranchDisposed("one", 1);
    expectBranchDisposed("two", 2);
    expect(gitRemoveWorktree).toHaveBeenNthCalledWith(2, "/repo", "/repo/two");
    expect(useAppStore.getState().repos).toEqual([]);
    expect(gitArchiveBranch).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith("Error: busy", expect.anything());
  });

  it("leaves resources intact when deletion is declined", async () => {
    vi.mocked(ask).mockResolvedValue(false);
    vi.mocked(requestPowerConfirmation).mockResolvedValue(false);
    await deleteBranch("repo", "one");
    await deleteRepo("repo");
    expect(disposeTerminal).not.toHaveBeenCalled();
    expect(disposeAcp).not.toHaveBeenCalled();
    expect(ptyDeleteTranscript).not.toHaveBeenCalled();
    expect(handoffWatchStop).not.toHaveBeenCalled();
    expect(clearTimeout).not.toHaveBeenCalled();
    expect(gitRemoveWorktree).not.toHaveBeenCalled();
    expect(useAppStore.getState().repos).toEqual([repo]);
  });
});
