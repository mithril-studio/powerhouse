// Orchestration shared by components and keyboard shortcuts.
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import {
  useAppStore,
  type Branch,
  type Chat,
  type QueueEntry,
} from "../store/appStore";
import {
  gitCreateWorktree,
  gitRemoveWorktree,
  gitValidateRepo,
  queueCancel,
  queueDismiss,
  queueEnqueue,
} from "./ipc";
import { disposeTerminal, markAutoSpawn } from "./terminalRegistry";

export async function pickAndAddRepo() {
  const dir = await open({ directory: true, multiple: false, title: "Add project" });
  if (!dir) return;
  try {
    const info = await gitValidateRepo(dir);
    useAppStore.getState().addRepo({
      name: info.name,
      path: info.root,
      defaultBranch: info.default_branch,
    });
  } catch (err) {
    await message(String(err), { title: "Cannot add project", kind: "error" });
  }
}

export function createChat(repoId: string, branchId: string): Chat | null {
  const s = useAppStore.getState();
  const branch = s.repos
    .find((r) => r.id === repoId)
    ?.branches.find((b) => b.id === branchId);
  if (!branch) return null;
  const numbers = branch.chats.map((c) => Number(/^Chat (\d+)$/.exec(c.title)?.[1] ?? 0));
  const chat: Chat = {
    id: crypto.randomUUID(),
    title: `Chat ${Math.max(0, ...numbers) + 1}`,
  };
  markAutoSpawn(chat.id);
  s.addChat(repoId, branchId, chat);
  s.select(repoId, branchId);
  return chat;
}

/** Creates the worktree + branch row + its first chat. Throws with git's stderr. */
export async function createBranch(repoId: string, name: string) {
  const s = useAppStore.getState();
  const repo = s.repos.find((r) => r.id === repoId);
  if (!repo) throw new Error("repository not found");
  const worktreePath = await gitCreateWorktree(repo.path, name, repo.defaultBranch);
  const branch: Branch = {
    id: crypto.randomUUID(),
    name,
    worktreePath,
    chats: [],
    activeChatId: null,
  };
  s.addBranch(repoId, branch);
  createChat(repoId, branch.id);
}

export function deleteChat(repoId: string, branchId: string, chatId: string) {
  disposeTerminal(chatId);
  useAppStore.getState().removeChat(repoId, branchId, chatId);
}

export async function deleteBranch(repoId: string, branchId: string) {
  const s = useAppStore.getState();
  const repo = s.repos.find((r) => r.id === repoId);
  const branch = repo?.branches.find((b) => b.id === branchId);
  if (!repo || !branch) return;

  const confirmed = await ask(
    `Delete branch “${branch.name}”?\n\nIts worktree and any uncommitted changes will be removed. The git branch itself is kept.`,
    { title: "Delete branch", kind: "warning", okLabel: "Delete" },
  );
  if (!confirmed) return;

  for (const chat of branch.chats) disposeTerminal(chat.id);
  try {
    await gitRemoveWorktree(repo.path, branch.worktreePath);
  } catch (err) {
    await message(String(err), { title: "Could not remove worktree", kind: "error" });
    return;
  }
  useAppStore.getState().removeBranch(repoId, branchId);
}

/** Snapshot the repo's workflow config and enqueue the branch for validation. */
export async function enqueueBranch(repoId: string, branchId: string) {
  const s = useAppStore.getState();
  const repo = s.repos.find((r) => r.id === repoId);
  const branch = repo?.branches.find((b) => b.id === branchId);
  if (!repo || !branch) return;
  try {
    await queueEnqueue(
      repo.id,
      repo.path,
      repo.defaultBranch,
      branch.name,
      repo.workflow.map((w) => ({ name: w.name, command: w.command, type: w.type })),
      repo.pushOnMerge,
    );
    s.selectQueue(repoId);
  } catch (err) {
    await message(String(err), { title: "Could not enqueue", kind: "error" });
  }
}

export async function cancelQueueEntry(repoId: string, entry: QueueEntry) {
  if (entry.state === "validating" || entry.state === "merging") {
    const ok = await ask(
      `Cancel validation of “${entry.branch}”? The running check will be killed.`,
      { title: "Cancel entry", kind: "warning", okLabel: "Cancel entry" },
    );
    if (!ok) return;
  }
  await queueCancel(repoId, entry.id).catch(() => {});
}

/** Dismiss a finished entry and re-enqueue its branch (guards deleted branches). */
export async function retryQueueEntry(repoId: string, entry: QueueEntry) {
  const s = useAppStore.getState();
  const repo = s.repos.find((r) => r.id === repoId);
  const branch = repo?.branches.find((b) => b.name === entry.branch);
  if (!repo || !branch) {
    await message(
      `Branch “${entry.branch}” no longer exists.`,
      { title: "Cannot re-enqueue", kind: "error" },
    );
    return;
  }
  await queueDismiss(repoId, entry.id).catch(() => {});
  s.dismissQueueEntry(repoId, entry.id);
  await enqueueBranch(repoId, branch.id);
}

export async function dismissEntry(repoId: string, entryId: string) {
  await queueDismiss(repoId, entryId).catch(() => {});
  useAppStore.getState().dismissQueueEntry(repoId, entryId);
}
