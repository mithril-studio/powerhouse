import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { deleteBranch, deleteChat, deleteRepo, retireMergedVms } from "./actions";
import { vmChatRetire, vmChatRemove } from "./vmChats";
import { disposeAcp } from "./acpRegistry";
import { disposeTerminal } from "./terminalRegistry";
import { requestPowerConfirmation } from "./powerConfirm";
import { gitArchiveBranch, gitRemoveWorktree, ptyDeleteTranscript } from "./ipc";
import { useAppStore, type Branch, type Repo } from "../store/appStore";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), message: vi.fn() }));
vi.mock("./powerConfirm", () => ({ requestPowerConfirmation: vi.fn() }));
vi.mock("./acpRegistry", () => ({ disposeAcp: vi.fn() }));
vi.mock("./terminalRegistry", () => ({ disposeTerminal: vi.fn() }));
vi.mock("./vmChats", () => ({
  vmChatCreate: vi.fn(),
  vmChatRemove: vi.fn(),
  vmChatRetire: vi.fn(),
  vmChatDropMirror: vi.fn(),
  vmChatMirror: vi.fn(),
  vmChatCommitPush: vi.fn(),
  mergeCommitMessage: vi.fn(),
}));
vi.mock("./ipc", () => ({
  gitArchiveBranch: vi.fn(),
  gitRemoveWorktree: vi.fn(),
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
  vi.mocked(ptyDeleteTranscript).mockResolvedValue(undefined);
  useAppStore.setState({
    repos: structuredClone([repo]),
    selection: { repoId: "repo", branchId: "one" },
  });
});

afterEach(() => vi.unstubAllGlobals());

function expectBranchDisposed(id: string) {
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
    expect(gitRemoveWorktree).not.toHaveBeenCalled();
  });

  it("disposes and archives only the selected branch", async () => {
    await deleteBranch("repo", "one");
    expectBranchDisposed("one");
    expect(disposeTerminal).toHaveBeenCalledTimes(3);
    expect(disposeAcp).toHaveBeenCalledTimes(1);
    expect(gitRemoveWorktree).toHaveBeenCalledExactlyOnceWith("/repo", "/repo/one");
    expect(gitArchiveBranch).toHaveBeenCalledExactlyOnceWith("/repo", "one", "test");
    expect(useAppStore.getState().repos[0].branches.map((b) => b.id)).toEqual(["two"]);
  });

  it("keeps the branch and skips archival when worktree removal fails", async () => {
    vi.mocked(gitRemoveWorktree).mockRejectedValue(new Error("busy"));
    await deleteBranch("repo", "one");
    expectBranchDisposed("one");
    expect(useAppStore.getState().repos[0].branches).toHaveLength(2);
    expect(gitArchiveBranch).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith("Error: busy", expect.anything());
  });

  it("continues project cleanup after a worktree removal fails", async () => {
    vi.mocked(gitRemoveWorktree).mockRejectedValueOnce(new Error("busy"));
    await deleteRepo("repo");
    expectBranchDisposed("one");
    expectBranchDisposed("two");
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
    expect(clearTimeout).not.toHaveBeenCalled();
    expect(gitRemoveWorktree).not.toHaveBeenCalled();
    expect(useAppStore.getState().repos).toEqual([repo]);
  });
});

describe("cloud branches", () => {
  const cloudRepo = (over: Partial<Branch> = {}): Repo => ({
    ...repo,
    branches: [{ ...branch("one"), location: "cloud", vm: "ph-c-one-1a2b", ...over }],
  });

  it("closing the chat of a cloud branch asks to delete the branch instead of orphaning its VM", async () => {
    vi.mocked(requestPowerConfirmation).mockResolvedValue(false);
    useAppStore.setState({ repos: [cloudRepo()] });
    deleteChat("repo", "one", "one-chat");
    await Promise.resolve();
    expect(requestPowerConfirmation).toHaveBeenCalledOnce();
    expect(useAppStore.getState().repos[0].branches[0].chats).toHaveLength(1);
    expect(vmChatRemove).not.toHaveBeenCalled();
  });

  it("retires a VM only when the queue merged the exact commit pushed for it", async () => {
    vi.mocked(vmChatRetire).mockResolvedValue(true);
    const entry = (sha: string) => ({
      id: sha, repo_id: "repo", branch: "one", state: "merged" as const, steps: [], error: null,
      merge_commit: "m", source_sha: sha, created_at: 1, finished_at: 2,
    });
    // A merged entry for the same branch name but another commit (a recycled name): untouched.
    useAppStore.setState({ repos: [cloudRepo({ merged: true })], queues: { repo: [entry("old")] } });
    retireMergedVms("repo");
    expect(vmChatRetire).not.toHaveBeenCalled();

    useAppStore.setState({ repos: [cloudRepo({ merged: true, mergeSha: "pushed" })], queues: { repo: [entry("old")] } });
    retireMergedVms("repo");
    expect(vmChatRetire).not.toHaveBeenCalled();

    useAppStore.setState({ queues: { repo: [entry("pushed")] } });
    retireMergedVms("repo");
    expect(vmChatRetire).toHaveBeenCalledExactlyOnceWith("ph-c-one-1a2b", "pushed");
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().repos[0].branches[0].vm).toBeUndefined();
  });

  it("keeps the VM and says so when it has work newer than the merge", async () => {
    vi.mocked(vmChatRetire).mockResolvedValue(false);
    useAppStore.setState({
      repos: [cloudRepo({ merged: true, mergeSha: "pushed" })],
      queues: { repo: [{ id: "q", repo_id: "repo", branch: "one", state: "merged", steps: [], error: null, merge_commit: "m", source_sha: "pushed", created_at: 1, finished_at: 2 }] },
    });
    retireMergedVms("repo");
    await new Promise((r) => setTimeout(r, 0));
    const b = useAppStore.getState().repos[0].branches[0];
    expect(b.vm).toBe("ph-c-one-1a2b");
    expect(b.mergeSha).toBeUndefined();
    expect(JSON.stringify(b.chats[0].acpTranscript)).toContain("was kept");
  });
});
