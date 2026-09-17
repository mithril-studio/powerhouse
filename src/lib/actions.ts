// Orchestration shared by components and keyboard shortcuts.
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import {
  useAppStore,
  type Branch,
  type Chat,
} from "../store/appStore";
import { gitCreateWorktree, gitRemoveWorktree, gitValidateRepo } from "./ipc";
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
