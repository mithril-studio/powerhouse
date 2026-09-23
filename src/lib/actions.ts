// Orchestration shared by components and keyboard shortcuts.
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import {
  useAppStore,
  type Branch,
  type Chat,
  type QueueEntry,
} from "../store/appStore";
import {
  gitCloneRepo,
  gitCreateWorktree,
  gitInitRepo,
  gitRemoveWorktree,
  gitValidateRepo,
  queueCancel,
  queueDismiss,
  queueEnqueue,
  handoffWatchStop,
  ptyDeleteTranscript,
} from "./ipc";
import { disposeTerminal, markAutoSpawn } from "./terminalRegistry";
import { disposeAcp } from "./acpRegistry";
import { cloudImport, cloudSync } from "./cloud";

export async function pickAndAddRepo() {
  const dir = await open({ directory: true, multiple: false, title: "Open project" });
  if (!dir) return;
  try {
    const info = await gitValidateRepo(dir);
    useAppStore.getState().addRepo({
      name: info.name,
      path: info.root,
      defaultBranch: info.default_branch,
    });
  } catch (err) {
    await message(String(err), { title: "Cannot open project", kind: "error" });
  }
}

/** Clone a git/GitHub URL into `destParent` (default ~/conductor/repos) and add
 *  it. Throws with git's message so the modal can show it inline. */
export async function cloneGithubProject(url: string, destParent?: string | null) {
  const info = await gitCloneRepo(url, destParent ?? null);
  useAppStore.getState().addRepo({
    name: info.name,
    path: info.root,
    defaultBranch: info.default_branch,
  });
}

/** Create a brand-new project (git init + initial commit) and add it. Throws
 *  on failure so the modal can show it inline. */
export async function quickStartProject(name: string, destParent?: string | null) {
  const info = await gitInitRepo(name, destParent ?? null);
  useAppStore.getState().addRepo({
    name: info.name,
    path: info.root,
    defaultBranch: info.default_branch,
  });
}

/** Re-open a project from the Recents list; drops it from Recents if it's gone. */
export async function openRecentRepo(path: string) {
  try {
    const info = await gitValidateRepo(path);
    useAppStore.getState().addRepo({
      name: info.name,
      path: info.root,
      defaultBranch: info.default_branch,
    });
  } catch (err) {
    useAppStore.getState().removeRecentRepo(path);
    await message(`${path}\n\n${String(err)}`, { title: "Cannot open project", kind: "error" });
  }
}

export function createChat(
  repoId: string,
  branchId: string,
  agentId?: string,
): Chat | null {
  const s = useAppStore.getState();
  const branch = s.repos
    .find((r) => r.id === repoId)
    ?.branches.find((b) => b.id === branchId);
  if (!branch) return null;
  const numbers = branch.chats.map((c) => Number(/^Chat (\d+)$/.exec(c.title)?.[1] ?? 0));
  const chat: Chat = {
    id: crypto.randomUUID(),
    title: `Chat ${Math.max(0, ...numbers) + 1}`,
    agentId,
  };
  markAutoSpawn(chat.id);
  s.addChat(repoId, branchId, chat);
  s.select(repoId, branchId);
  return chat;
}

/**
 * Spawns a fresh chat that boots the source chat's agent pointed at the handoff
 * doc. Never steals the view: selection is left untouched.
 */
export function createHandoffChat(
  repoId: string,
  branchId: string,
  relPath: string,
): Chat | null {
  const s = useAppStore.getState();
  const branch = s.repos
    .find((r) => r.id === repoId)
    ?.branches.find((b) => b.id === branchId);
  if (!branch) return null;
  const source = branch.chats.find((c) => c.id === branch.activeChatId);
  const numbers = branch.chats.map((c) =>
    Number(/^Handoff (\d+)$/.exec(c.title)?.[1] ?? 0),
  );
  const chat: Chat = {
    id: crypto.randomUUID(),
    title: `Handoff ${Math.max(0, ...numbers) + 1}`,
    agentId: source?.agentId,
    transport: source?.transport,
    initialPrompt: `Read ${relPath} and continue the work described in it.`,
  };
  markAutoSpawn(chat.id);
  s.addChat(repoId, branchId, chat); // sets this branch's activeChatId; no selection change
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
  void disposeAcp(chatId);
  void ptyDeleteTranscript(chatId).catch(() => {});
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

  // Stop the handoff watcher and cancel any in-flight handoff for this branch.
  void handoffWatchStop(branchId).catch(() => {});
  const pendingTimer = s.pendingHandoff[branchId];
  if (pendingTimer !== undefined) {
    window.clearTimeout(pendingTimer);
    s.clearPendingHandoff(branchId);
  }

  for (const chat of branch.chats) {
    disposeTerminal(chat.id);
    void disposeAcp(chat.id);
    void ptyDeleteTranscript(chat.id).catch(() => {});
  }
  // Bottom-panel surfaces (ids mirror BottomPanel's shellId/agentCliId).
  disposeTerminal(`shell-${branchId}`);
  void ptyDeleteTranscript(`shell-${branchId}`).catch(() => {});
  disposeTerminal(`agentcli-${branchId}`);
  void ptyDeleteTranscript(`agentcli-${branchId}`).catch(() => {});
  try {
    await gitRemoveWorktree(repo.path, branch.worktreePath);
  } catch (err) {
    await message(String(err), { title: "Could not remove worktree", kind: "error" });
    return;
  }
  useAppStore.getState().removeBranch(repoId, branchId);
}

/**
 * Remove a project from the app: tear down every branch's worktree, terminals,
 * and transcripts, then drop the repo from the store. Best-effort per branch —
 * a worktree that won't remove is reported but doesn't abort the rest.
 */
export async function deleteRepo(repoId: string) {
  const s = useAppStore.getState();
  const repo = s.repos.find((r) => r.id === repoId);
  if (!repo) return;

  const confirmed = await ask(
    `Remove project “${repo.name}”?\n\n${
      repo.branches.length > 0
        ? `Its ${repo.branches.length} branch worktree${
            repo.branches.length === 1 ? "" : "s"
          } and any uncommitted changes will be removed. `
        : ""
    }The project is removed from the app; the git repository itself is kept.`,
    { title: "Remove project", kind: "warning", okLabel: "Remove" },
  );
  if (!confirmed) return;

  for (const branch of repo.branches) {
    // Stop the handoff watcher and cancel any in-flight handoff for this branch.
    void handoffWatchStop(branch.id).catch(() => {});
    const pendingTimer = s.pendingHandoff[branch.id];
    if (pendingTimer !== undefined) {
      window.clearTimeout(pendingTimer);
      s.clearPendingHandoff(branch.id);
    }

    for (const chat of branch.chats) {
      disposeTerminal(chat.id);
      void disposeAcp(chat.id);
      void ptyDeleteTranscript(chat.id).catch(() => {});
    }
    // Bottom-panel surfaces (ids mirror BottomPanel's shellId/agentCliId).
    disposeTerminal(`shell-${branch.id}`);
    void ptyDeleteTranscript(`shell-${branch.id}`).catch(() => {});
    disposeTerminal(`agentcli-${branch.id}`);
    void ptyDeleteTranscript(`agentcli-${branch.id}`).catch(() => {});
    try {
      await gitRemoveWorktree(repo.path, branch.worktreePath);
    } catch (err) {
      await message(String(err), { title: "Could not remove worktree", kind: "error" });
    }
  }

  useAppStore.getState().removeRepo(repoId);
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
    s.openRightTab("merge");
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

/**
 * Fetch a cloud run's published revision into a brand-new worktree and add it
 * as a branch row. Existing worktrees are never touched; a mismatch between
 * the remote branch and the recorded result is surfaced, not imported.
 */
export async function importCloudResult(runId: string) {
  const s = useAppStore.getState();
  const rec = s.cloudRuns[runId];
  if (!rec) throw new Error("unknown cloud run");
  const repo = s.repos.find((r) => r.id === rec.repo_id);
  if (!repo) throw new Error("the run's repository is no longer in Powerhouse");
  const imported = await cloudImport(runId);
  const branch: Branch = {
    id: crypto.randomUUID(),
    name: imported.branch,
    worktreePath: imported.worktree_path,
    chats: [],
    activeChatId: null,
  };
  s.addBranch(repo.id, branch);
  s.openRightTab("changes");
  // Refresh the record so the card shows the imported worktree.
  useAppStore.getState().setCloudRun(await cloudSync(runId).catch(() => ({ ...rec, imported_worktree: imported.worktree_path })));
}
