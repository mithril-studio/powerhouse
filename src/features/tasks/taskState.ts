import type { Branch, QueueEntry } from "../../store/appStore";
import type { SessionActivity, Task, TaskColumn, TaskFacts } from "./types";

export function hydrateTasks(tasks: Task[] = []): Task[] {
  return tasks.map((task) => {
    const live =
      task.launch.stage === "preparing" || task.turn?.outcome === "running";
    return live
      ? {
          ...task,
          launch: {
            ...task.launch,
            stage: "interrupted" as const,
            error:
              "Local execution interrupted. Resume to inspect the existing session.",
          },
          turn: { outcome: "interrupted" as const, at: Date.now() },
        }
      : task;
  });
}

/** Live attention takes priority over work in another chat. Silence never proves delivery. */
export function taskPresentation(
  task: Task,
  branch: Branch | undefined,
  sessions: Record<string, SessionActivity>,
  queue: QueueEntry[],
  facts?: TaskFacts,
): { column: TaskColumn; reason: string } {
  const live = (branch?.chats ?? []).map((c) => sessions[c.id]).filter(Boolean);
  const pending = live.reduce((n, s) => n + s.permissionCount, 0);
  if (pending)
    return {
      column: "attention",
      reason: `${pending} permission request${pending === 1 ? "" : "s"}`,
    };
  const working = live.some((s) => s.busy || s.connection === "starting");
  if (working)
    return {
      column: "running",
      reason: live.some((s) => s.canceling) ? "Canceling" : "Agent working",
    };
  const latest = queue
    .filter(
      (q) =>
        q.id === task.queueId ||
        (q.branch === branch?.name && q.created_at >= task.lastWorkAt),
    )
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (latest && ["queued", "validating", "merging"].includes(latest.state))
    return {
      column: "running",
      reason:
        latest.state === "validating"
          ? "Running checks"
          : latest.state === "merging"
            ? "Merging"
            : "Queued for checks",
    };
  if (latest && ["failed", "interrupted"].includes(latest.state))
    return {
      column: "attention",
      reason: latest.error || `Checks ${latest.state}`,
    };
  const savedFailure =
    branch?.chats.find(
      (c) =>
        !sessions[c.id]?.busy &&
        ["failed", "interrupted"].includes(c.taskTurn?.outcome ?? ""),
    )?.taskTurn;
  if (savedFailure)
    return {
      column: "attention",
      reason: savedFailure.summary || "A session needs recovery",
    };
  if (task.launch.stage === "failed" || task.launch.stage === "interrupted")
    return {
      column: "attention",
      reason: task.launch.error ?? "Resume needed",
    };
  const error = live.find((s) => s.error)?.error;
  if (
    error ||
    task.turn?.outcome === "failed" ||
    task.turn?.outcome === "interrupted"
  )
    return {
      column: "attention",
      reason: error ?? task.turn?.summary ?? "Execution needs attention",
    };
  if (task.launch.stage === "preparing")
    return { column: "running", reason: "Preparing workspace" };
  if (task.parked)
    return { column: "backlog", reason: "Parked · workspace retained" };
  const sourceSha = task.completion?.sourceSha ?? latest?.source_sha;
  if (
    facts &&
    (task.completion?.kind === "merged" || latest?.state === "merged") &&
    (facts.dirty || (sourceSha && facts.head !== sourceSha))
  )
    return { column: "review", reason: "New changes since the last merge" };
  if (task.completion && task.completion.at >= task.lastWorkAt)
    return {
      column: "done",
      reason:
        task.completion.kind === "merged"
          ? `Merged · ${task.completion.commit?.slice(0, 8) ?? "verified"}`
          : "Completed by you",
    };
  if (
    latest?.state === "merged" &&
    latest.merge_commit &&
    latest.created_at >= task.lastWorkAt
  )
    return {
      column: "done",
      reason: `Merged · ${latest.merge_commit.slice(0, 8)}`,
    };
  if (task.turn?.outcome === "running")
    return {
      column: "attention",
      reason: "Session disconnected — resume to inspect",
    };
  if (branch?.chats.some((c) => c.transport === "pty"))
    return {
      column: "review",
      reason: "Terminal workspace · activity status limited",
    };
  if (task.turn || task.branchId)
    return {
      column: "review",
      reason:
        task.turn?.outcome === "cancelled"
          ? "Stopped"
          : task.turn?.summary || "Ready for review",
    };
  return { column: "backlog", reason: "Not started" };
}
