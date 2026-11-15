// Orchestration shared by components and keyboard shortcuts.
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { requestPowerConfirmation } from "./powerConfirm";
import {
  useAppStore,
  type Branch,
  type BranchLocation,
  type Chat,
  type QueueEntry,
} from "../store/appStore";
import {
  gitCloneRepo,
  gitCreateWorktree,
  gitInitRepo,
  gitArchiveBranch,
  gitPruneArchivedBranches,
  gitRemoveWorktree,
  gitSweepBranches,
  gitValidateRepo,
  queueCancel,
  queueDismiss,
  queueEnqueue,
  ptyDeleteTranscript,
} from "./ipc";
import { disposeTerminal, markAutoSpawn } from "./terminalRegistry";
import { disposeAcp } from "./acpRegistry";
import { appendSystemMessage } from "./acpTranscript";
import {
  mergeCommitMessage,
  vmChatCommitPush,
  vmChatCreate,
  vmChatDropMirror,
  vmChatMirror,
  vmChatRemove,
  vmChatRetire,
} from "./vmChats";

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
 * Creates the worktree + branch row + its first chat. Throws with git's stderr.
 * A cloud branch also gets its own VM; its chat appears once the VM is ready.
 */
export async function createBranch(
  repoId: string,
  name: string,
  base?: string,
  location: BranchLocation = "local",
) {
  const s = useAppStore.getState();
  const repo = s.repos.find((r) => r.id === repoId);
  if (!repo) throw new Error("repository not found");
  const worktreePath = await gitCreateWorktree(
    repo.path,
    name,
    base?.trim() || repo.defaultBranch,
  );
  const branch: Branch = {
    id: crypto.randomUUID(),
    name,
    worktreePath,
    chats: [],
    activeChatId: null,
    ...(location === "cloud" ? { location } : {}),
  };
  s.addBranch(repoId, branch);
  if (location === "cloud") {
    s.select(repoId, branch.id);
    void provisionCloudBranch(repoId, branch.id, base?.trim() || repo.defaultBranch);
  } else {
    createChat(repoId, branch.id);
  }
}

const mirroring = new Map<string, Promise<void>>();
const mirrorAgain = new Set<string>();

/**
 * Makes a cloud branch's local worktree mirror its VM, so Files, Changes and
 * Diff show the agent's work. One run per branch; a request during a run
 * queues exactly one more.
 */
export function mirrorCloudBranch(repoId: string, branchId: string): Promise<void> {
  const running = mirroring.get(branchId);
  if (running) {
    mirrorAgain.add(branchId);
    return running;
  }
  const run = (async () => {
    do {
      mirrorAgain.delete(branchId);
      const branch = useAppStore
        .getState()
        .repos.find((r) => r.id === repoId)
        ?.branches.find((b) => b.id === branchId);
      if (!branch?.vm) return;
      try {
        await vmChatMirror(branch.vm, branch.worktreePath, branch.name);
        useAppStore.getState().setVmMirror(branchId);
      } catch (err) {
        useAppStore.getState().setVmMirror(branchId, String(err));
      }
    } while (mirrorAgain.has(branchId));
  })().finally(() => mirroring.delete(branchId));
  mirroring.set(branchId, run);
  return run;
}

const retiring = new Set<string>();

/**
 * A merged cloud branch is done: its work is pushed and landed. Delete its VM
 * and mirror ref so it stops costing anything; the chat keeps its transcript.
 * Only when the queue merged exactly the commit pushed for this branch (names
 * get reused), and only when the VM has nothing newer: work done after the
 * merge push keeps the VM.
 */
export function retireMergedVms(repoId: string) {
  const s = useAppStore.getState();
  const repo = s.repos.find((r) => r.id === repoId);
  const merged = new Set(
    (s.queues[repoId] ?? []).filter((e) => e.state === "merged" && e.source_sha).map((e) => e.source_sha!),
  );
  for (const branch of repo?.branches ?? []) {
    const sha = branch.mergeSha;
    if (!branch.vm || !sha || !merged.has(sha) || retiring.has(branch.id)) continue;
    const vm = branch.vm;
    retiring.add(branch.id);
    void vmChatRetire(vm, sha)
      .then((removed) => {
        const now = useAppStore.getState();
        now.setBranchMergeSha(repoId, branch.id, null);
        if (removed) {
          for (const chat of branch.chats) void disposeAcp(chat.id);
          now.setBranchVm(repoId, branch.id, null);
          void vmChatDropMirror(repo!.path, branch.name).catch(() => {});
        } else {
          const chat = branch.chats[0];
          if (chat) {
            now.updateChatAcpTranscript(repoId, branch.id, chat.id, (items) =>
              appendSystemMessage(
                items,
                `Merged. ${vm} has changes made after the merge, so it was kept; merge again or delete the branch when you are done.`,
              ),
            );
          }
        }
      })
      .catch(() => {}) // VM unreachable: retried on the next queue sync
      .finally(() => retiring.delete(branch.id));
  }
}

/** Creates a cloud branch's VM, then its one chat. Safe to call again after a failure. */
export async function provisionCloudBranch(repoId: string, branchId: string, base?: string) {
  const s = useAppStore.getState();
  const repo = s.repos.find((r) => r.id === repoId);
  const branch = repo?.branches.find((b) => b.id === branchId);
  // A VM that exists may hold unpushed work: never create over it.
  if (!repo || !branch || branch.vm || s.vmCreating[branchId]) return;
  s.setVmCreating(branchId, true);
  s.setBranchVm(repoId, branchId, null);
  try {
    const vm = await vmChatCreate({
      repoId,
      repoPath: repo.path,
      branch: branch.name,
      base: base ?? repo.defaultBranch,
      envNames: repo.cloudEnvNames ?? [],
      writeEnvFile: repo.cloudWriteEnvFile ?? false,
    });
    const now = useAppStore.getState();
    now.setBranchVm(repoId, branchId, vm);
    const current = now.repos.find((r) => r.id === repoId)?.branches.find((b) => b.id === branchId);
    if (current && current.chats.length === 0) createChat(repoId, branchId);
  } catch (err) {
    useAppStore.getState().setBranchVm(repoId, branchId, null, String(err));
  } finally {
    useAppStore.getState().setVmCreating(branchId, false);
  }
}

function disposeChat(chatId: string) {
  disposeTerminal(chatId);
  void disposeAcp(chatId);
  void ptyDeleteTranscript(chatId).catch(() => {});
}

function disposeBranch(branch: Branch) {
  for (const chat of branch.chats) disposeChat(chat.id);
  // Bottom-panel surfaces (ids mirror BottomPanel's shellId/agentCliId).
  for (const id of [`shell-${branch.id}`, `agentcli-${branch.id}`]) {
    disposeTerminal(id);
    void ptyDeleteTranscript(id).catch(() => {});
  }
}

export function deleteChat(repoId: string, branchId: string, chatId: string) {
  const branch = useAppStore
    .getState()
    .repos.find((r) => r.id === repoId)
    ?.branches.find((b) => b.id === branchId);
  // A cloud branch's one chat owns its VM: closing it means deleting the
  // branch (which asks first), never leaving the VM orphaned.
  if (branch?.location === "cloud") {
    void deleteBranch(repoId, branchId);
    return;
  }
  disposeChat(chatId);
  useAppStore.getState().removeChat(repoId, branchId, chatId);
}

export async function deleteBranch(repoId: string, branchId: string) {
  const s = useAppStore.getState();
  const repo = s.repos.find((r) => r.id === repoId);
  const branch = repo?.branches.find((b) => b.id === branchId);
  if (!repo || !branch) return;

  const confirmed = await requestPowerConfirmation({
    title: "Hey, are you sure?",
    message: `Delete branch “${branch.name}”?\n\nIts worktree and any uncommitted changes will be removed. The git branch is archived for 3 days, then deleted.${branch.vm ? ` Its VM ${branch.vm} is deleted too, with any work not pushed from it.` : ""}`,
    confirmLabel: "Delete",
    shortcutLabel: "⌘W",
  });
  if (!confirmed) return;

  disposeBranch(branch);
  if (branch.vm) {
    void vmChatRemove(branch.vm).catch(() => {});
    void vmChatDropMirror(repo.path, branch.name).catch(() => {});
  }
  try {
    await gitRemoveWorktree(repo.path, branch.worktreePath);
  } catch (err) {
    await message(String(err), { title: "Could not remove worktree", kind: "error" });
    return;
  }
  useAppStore.getState().removeBranch(repoId, branchId);
  try {
    await gitArchiveBranch(repo.path, branch.name, repo.defaultBranch);
  } catch (err) {
    await message(String(err), { title: "Could not archive git branch", kind: "error" });
  }
}

const ARCHIVE_SWEEP_MS = 60 * 60 * 1000;

/**
 * Archive stale branches (landed on the target, upstream gone, worktree gone)
 * and delete archives past their 3 days, now and hourly after.
 */
export function startArchivedBranchSweep() {
  const sweep = () => {
    for (const repo of useAppStore.getState().repos) {
      void gitSweepBranches(repo.path, repo.defaultBranch, true)
        .catch(() => {})
        .then(() => gitPruneArchivedBranches(repo.path))
        .catch(() => {});
    }
  };
  sweep();
  window.setInterval(sweep, ARCHIVE_SWEEP_MS);
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
    disposeBranch(branch);
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
  if (branch.vm) {
    if (branch.chats.some((c) => s.chatActivity[c.id] === "working")) {
      await message("The agent is still working on this branch. Merge once its turn is done.", {
        title: "Not yet",
        kind: "info",
      });
      return;
    }
    // The work lives on the VM: commit whatever is left, push the branch, and
    // point the local branch at it. The queue then merges as usual.
    try {
      const pushed = await vmChatCommitPush(
        branch.vm,
        branch.worktreePath,
        branch.name,
        mergeCommitMessage(branch.name, branch.chats[0]),
      );
      useAppStore.getState().setBranchMergeSha(repo.id, branch.id, pushed);
      useAppStore.getState().setVmMirror(branch.id);
    } catch (err) {
      await message(String(err), { title: "Could not push the VM's work", kind: "error" });
      return;
    }
  }
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
