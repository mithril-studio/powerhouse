import {
  useAppStore,
  resolveChatTransport,
  type Branch,
} from "../../store/appStore";
import { flushPersistence } from "../../store/persist";
import {
  gitEnsureTaskWorktree,
  gitWorktreeDirty,
  queueEnqueue,
  queueDismiss,
} from "../../lib/ipc";
import {
  acknowledgeSessionError,
  startSession,
  useSessions,
} from "../../lib/agentSessionService";
import { cloudCancel, type CloudRunRecord } from "../../lib/cloud";
import { importCloudResult } from "../../lib/actions";
import { createTask, updateTask } from "./taskStore";
import { taskPresentation } from "./taskState";
const launches = new Map<string, Promise<void>>();
export function taskContext(id: string) {
  const state = useAppStore.getState();
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error("Task no longer exists.");
  const repo = state.repos.find((r) => r.id === task.repoId);
  if (!repo) throw new Error("Project no longer exists.");
  const branch = repo.branches.find((b) => b.id === task.branchId);
  return { state, task, repo, branch };
}
export function openTask(id: string) {
  const { task, branch } = taskContext(id);
  updateTask(id, { seenAt: Date.now() });
  if (branch) useAppStore.getState().select(task.repoId, branch.id);
}
export async function startTask(id: string, open = false): Promise<void> {
  const pending = launches.get(id);
  if (pending) return pending;
  const run = (async () => {
    let { task, repo, branch } = taskContext(id);
    if (task.cloudRunId && !branch)
      throw new Error(
        "Import the cloud result before starting a local conversation.",
      );
    const profile = useAppStore
      .getState()
      .settings.agents.find((a) => a.id === task.agentId);
    if (!profile)
      throw new Error(
        "The selected agent is unavailable. Choose an installed ACP agent.",
      );
    if (
      resolveChatTransport(useAppStore.getState().settings, {
        agentId: task.agentId,
      }) !== "acp"
    )
      throw new Error(
        "Background tasks require an ACP agent. Existing terminal workspaces remain available through Open workspace.",
      );
    const activeQueue = useAppStore
      .getState()
      .queues[
        repo.id
      ]?.some((q) => q.branch === branch?.name && ["queued", "validating", "merging"].includes(q.state));
    if (activeQueue)
      throw new Error(
        "Wait for or cancel the merge checks before restarting work.",
      );
    const branchName =
      task.launch.branchName ??
      `task/${
        task.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 40)
          .replace(/^-|-$/g, "") || "work"
      }-${task.id.slice(0, 8)}`;
    updateTask(id, {
      archivedAt: null,
      parked: false,
      launch: {
        stage: "preparing",
        attemptId: task.launch.attemptId ?? crypto.randomUUID(),
        branchName,
      },
      lastActivityAt: Date.now(),
    });
    try {
      await flushPersistence();
      if (!branch) {
        const worktreePath = await gitEnsureTaskWorktree(
          repo.path,
          task.id,
          branchName,
          repo.defaultBranch,
        );
        branch = {
          id: `task-${id}`,
          name: branchName,
          worktreePath,
          chats: [],
          activeChatId: null,
        };
        // Admission never changes selection, even when Git finishes after navigation.
        useAppStore.setState((s) => ({
          repos: s.repos.map((r) =>
            r.id === repo.id ? { ...r, branches: [...r.branches, branch!] } : r,
          ),
        }));
        updateTask(id, { branchId: branch.id });
        await flushPersistence();
      }
      let chat = branch.chats.find((c) => c.id === task.primaryChatId);
      const alreadyStarted = Boolean(chat);
      if (!chat) {
        chat = {
          id: crypto.randomUUID(),
          title: task.title,
          agentId: task.agentId,
          initialPrompt: task.description || task.title,
        };
        useAppStore.getState().addChat(repo.id, branch.id, chat);
        updateTask(id, { primaryChatId: chat.id });
        await flushPersistence();
      }
      if (open) openTask(id);
      await startSession(chat.id, alreadyStarted);
      task = taskContext(id).task;
      updateTask(id, {
        launch: { ...task.launch, stage: "ready", error: undefined },
      });
      await flushPersistence();
    } catch (cause) {
      updateTask(id, {
        launch: {
          ...taskContext(id).task.launch,
          stage: "failed",
          error: String(cause),
        },
      });
      await flushPersistence().catch(() => {});
      throw cause;
    }
  })();
  launches.set(id, run);
  try {
    await run;
  } finally {
    launches.delete(id);
  }
}
function presentation(id: string, ignoredQueueId?: string) {
  const c = taskContext(id);
  return taskPresentation(
    c.task,
    c.branch,
    useSessions.getState().sessions,
    (c.state.queues[c.repo.id] ?? []).filter((entry) => entry.id !== ignoredQueueId),
    c.task.cloudRunId ? c.state.cloudRuns[c.task.cloudRunId] : undefined,
  );
}
function assertNoLegacyRun(id: string) {
  const { branch, state } = taskContext(id);
  if (
    branch?.chats.some(
      (chat) =>
        !useSessions.getState().sessions[chat.id] &&
        state.chatStatus[chat.id] === "running",
    )
  )
    throw new Error("Stop the running terminal agent in its workspace first.");
}
export function archiveTask(id: string, archived: boolean) {
  if (archived) assertNoLegacyRun(id);
  if (archived && ["running", "attention"].includes(presentation(id).column))
    throw new Error("Resolve attention and stop active work before archiving.");
  updateTask(id, { archivedAt: archived ? Date.now() : null });
}
export function completeTask(id: string) {
  assertNoLegacyRun(id);
  if (["running", "attention"].includes(presentation(id).column))
    throw new Error(
      "Resolve attention and stop active work before completing.",
    );
  updateTask(id, {
    completion: { kind: "manual", at: Date.now() },
    lastActivityAt: Date.now(),
  });
}
export async function enqueueTask(id: string) {
  return enqueueTaskChecks(id);
}
export async function retryTaskChecks(id: string, entryId: string) {
  const { state, repo, branch } = taskContext(id);
  const previous = state.queues[repo.id]?.find((entry) => entry.id === entryId);
  if (!previous || previous.branch !== branch?.name || !["failed", "interrupted"].includes(previous.state))
    throw new Error("Only this task's failed or interrupted checks can be retried.");
  await enqueueTaskChecks(id, entryId);
  // Keep the failure visible if validation or queue admission fails.
  await queueDismiss(repo.id, entryId);
  useAppStore.getState().dismissQueueEntry(repo.id, entryId);
}
async function enqueueTaskChecks(id: string, retryEntryId?: string) {
  assertNoLegacyRun(id);
  const { task, repo, branch } = taskContext(id);
  if (!branch) throw new Error("This task has no local workspace.");
  const assertReady = () => {
    assertNoLegacyRun(id);
    if (taskContext(id).branch?.id !== branch.id)
      throw new Error("The task workspace changed. Inspect it before running checks.");
    if (["running", "attention"].includes(presentation(id, retryEntryId).column))
      throw new Error("Resolve attention and stop active work before running merge checks.");
  };
  assertReady();
  if (await gitWorktreeDirty(branch.worktreePath))
    throw new Error(
      "Commit the task's working changes before running merge checks.",
    );
  assertReady();
  const entry = await queueEnqueue(
    repo.id,
    repo.path,
    repo.defaultBranch,
    branch.name,
    repo.workflow.map((w) => ({
      name: w.name,
      command: w.command,
      type: w.type,
    })),
    repo.pushOnMerge,
  );
  updateTask(task.id, { queueId: entry.id });
  const current = useAppStore.getState().queues[repo.id] ?? [];
  if (!current.some((q) => q.id === entry.id))
    useAppStore.getState().setQueueEntries(repo.id, [...current, entry]);
}
export function linkCloudTask(run: CloudRunRecord) {
  const s = useAppStore.getState();
  const linked = s.tasks.find((t) => t.cloudRunId === run.run_id);
  if (linked) return linked;
  const local = s.tasks.find(
    (t) =>
      t.repoId === run.repo_id &&
      !t.cloudRunId &&
      s.repos
        .find((r) => r.id === t.repoId)
        ?.branches.some(
          (b) => b.id === t.branchId && b.name === run.source_branch,
        ),
  );
  const task =
    local ??
    createTask({
      repoId: run.repo_id,
      title: run.manifest.task.text.slice(0, 100) || "Cloud task",
      description: run.manifest.task.text,
      agentId: "claude",
    });
  updateTask(task.id, {
    cloudRunId: run.run_id,
    turn: undefined,
    completion: undefined,
    queueId: undefined,
    lastWorkAt: Date.now(),
    lastActivityAt: Date.now(),
    launch: { stage: "ready" },
  });
  return task;
}
export async function importTaskCloudResult(id: string) {
  const { task } = taskContext(id);
  if (!task.cloudRunId) return;
  await importCloudResult(task.cloudRunId);
  const s = useAppStore.getState();
  const run = s.cloudRuns[task.cloudRunId];
  const branch = s.repos
    .find((r) => r.id === task.repoId)
    ?.branches.find((b) => b.worktreePath === run?.imported_worktree);
  if (branch && s.tasks.some((t) => t.id !== id && t.branchId === branch.id))
    throw new Error(
      "The imported worktree already belongs to another task. Open that task to continue.",
    );
  if (branch)
    updateTask(id, {
      branchId: branch.id,
      primaryChatId: branch.activeChatId,
      turn: {
        outcome: "completed",
        at: Date.now(),
        summary: "Cloud result imported",
      },
    });
}
export async function cancelTaskCloud(id: string) {
  const { task } = taskContext(id);
  if (task.cloudRunId)
    useAppStore.getState().setCloudRun(await cloudCancel(task.cloudRunId));
}
export function branchSessions(branch?: Branch) {
  return (branch?.chats ?? []).map((c) => ({
    chat: c,
    session: useSessions.getState().sessions[c.id],
  }));
}

export function acknowledgeTask(id: string) {
  assertNoLegacyRun(id);
  const { task, branch } = taskContext(id);
  if (
    branchSessions(branch).some(
      ({ session }) =>
        session?.busy ||
        session?.permissionCount ||
        session?.connection === "starting",
    )
  )
    throw new Error("Resolve live requests first.");
  branch?.chats.forEach((c) => acknowledgeSessionError(c.id));
  useAppStore.setState((s) => ({
    repos: s.repos.map((r) => ({
      ...r,
      branches: r.branches.map((b) =>
        b.id === branch?.id
          ? {
              ...b,
              chats: b.chats.map((c) => ({
                ...c,
                taskTurn: c.taskTurn
                  ? { ...c.taskTurn, outcome: "cancelled" as const }
                  : undefined,
              })),
            }
          : b,
      ),
    })),
  }));
  updateTask(id, {
    launch: {
      ...task.launch,
      stage: branch ? "ready" : "not_started",
      error: undefined,
    },
    turn: branch ? { outcome: "cancelled", at: Date.now() } : undefined,
  });
}

export function parkTask(id: string) {
  assertNoLegacyRun(id);
  if (["running", "attention"].includes(presentation(id).column))
    throw new Error(
      "Stop active work and resolve attention before returning to backlog.",
    );
  updateTask(id, { parked: true, completion: undefined });
}
export function chooseTaskAgent(id: string, agentId: string) {
  assertNoLegacyRun(id);
  const { branch } = taskContext(id);
  if (
    branchSessions(branch).some(
      ({ session }) =>
        session?.busy ||
        session?.permissionCount ||
        session?.connection === "starting",
    )
  )
    throw new Error(
      "Stop the current agent and resolve its permissions first.",
    );
  updateTask(id, { agentId, primaryChatId: null });
}
